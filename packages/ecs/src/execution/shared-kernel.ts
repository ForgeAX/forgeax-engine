import type { Component, SchemaFieldType } from '../component';
import { componentId, componentSchema } from '../component';
import {
  SharedKernelEligibilityError,
  SharedKernelFailureError,
} from '../errors/shared-kernel-errors';
import type { QueryDescriptor, QuerySpan } from '../query/query';
import type { SystemHandle } from '../schedule';
import { worldInternal } from '../world-internal';

export const SHARED_KERNEL_EXECUTOR_RESOURCE_KEY = 'SharedKernelExecutor';

export interface KernelDispatchResult {
  readonly mode: 'forced-inline' | 'shared';
  readonly dispatched: number;
  readonly completed: number;
  readonly waitMs: number;
}

export interface KernelDispatchFailure {
  readonly cause: unknown;
  readonly dispatched: number;
  readonly completed: number;
  readonly partialWrite: boolean;
}

export interface KernelDispatchSpan {
  readonly queryIndex: number;
  readonly span: QuerySpan;
}

export interface SharedKernelExecutor {
  warmup?(kernel: SharedKernelDispatch): void;
  execute(
    kernel: SharedKernelDispatch,
    spans: readonly KernelDispatchSpan[],
  ): KernelDispatchResult | KernelDispatchFailure;
}

export function isKernelDispatchFailure(
  value: KernelDispatchResult | KernelDispatchFailure,
): value is KernelDispatchFailure {
  return 'cause' in value;
}

export const SHARED_KERNEL_ELIGIBILITY_REASONS = [
  'callback-not-module-function',
  'dom-access',
  'missing-access-declaration',
  'descriptor-conflict',
  'object-field',
  'span-unavailable',
] as const;
export type SharedKernelEligibilityReason = (typeof SHARED_KERNEL_ELIGIBILITY_REASONS)[number];

export type WorldExecutionHealth = 'healthy' | 'poisoned';

export interface WorldExecutionFault {
  readonly code: 'shared-kernel-failed';
  readonly kernelName: string;
  readonly cause: unknown;
  readonly partialWrite: boolean;
  readonly retryable: false;
}

export interface WorldExecutionState {
  readonly identity: string;
  readonly health: WorldExecutionHealth;
  readonly fault: WorldExecutionFault | null;
}

let nextWorldIdentity = 1;

export function createWorldIdentity(): string {
  const identity = `world-${nextWorldIdentity}`;
  nextWorldIdentity += 1;
  return identity;
}

export function healthyWorldExecutionState(identity: string): WorldExecutionState {
  return Object.freeze({ identity, health: 'healthy', fault: null });
}

export function poisonedWorldExecutionState(
  identity: string,
  fault: WorldExecutionFault,
): WorldExecutionState {
  return Object.freeze({ identity, health: 'poisoned', fault: Object.freeze(fault) });
}

export interface SharedKernelDefinition<Qs extends readonly QueryDescriptor[]> {
  readonly name: string;
  readonly queries: Qs;
  readonly run: (spans: readonly QuerySpan[]) => void;
  readonly minimumRows?: number;
  readonly before?: readonly (string | import('../schedule-token').ScheduleToken)[];
  readonly after?: readonly (string | import('../schedule-token').ScheduleToken)[];
}

export interface SharedKernelDispatch<
  Qs extends readonly QueryDescriptor[] = readonly QueryDescriptor[],
> {
  readonly kind: 'shared-kernel';
  readonly moduleUrl: string;
  readonly name: string;
  readonly minimumRows: number;
  readonly queries: Qs;
  readonly run: (spans: readonly QuerySpan[]) => void;
}

export interface SharedKernelHandle<
  Qs extends readonly QueryDescriptor[] = readonly QueryDescriptor[],
> extends SystemHandle<Qs>,
    SharedKernelDispatch<Qs> {}

const NUMERIC_FIELDS = new Set<SchemaFieldType>([
  'f32',
  'f64',
  'i32',
  'u32',
  'i16',
  'u16',
  'i8',
  'u8',
  'bool',
  'enum',
  'ref',
  'entity',
]);

function components(descriptor: QueryDescriptor): readonly Component[] {
  return [
    ...(descriptor.read ?? []),
    ...(descriptor.write ?? []),
    ...(descriptor.optional ?? []),
    ...(descriptor.with ?? []),
    ...(descriptor.without ?? []),
    ...(descriptor.changed ?? []),
    ...(descriptor.added ?? []),
  ];
}

function descriptorReason(descriptor: QueryDescriptor): SharedKernelEligibilityReason | undefined {
  if ((descriptor.read?.length ?? 0) + (descriptor.write?.length ?? 0) === 0) {
    return 'missing-access-declaration';
  }
  if (
    (descriptor.optional?.length ?? 0) > 0 ||
    (descriptor.changed?.length ?? 0) > 0 ||
    (descriptor.added?.length ?? 0) > 0
  ) {
    return 'span-unavailable';
  }
  const seen = new Set<number>();
  for (const component of components(descriptor)) {
    if (seen.has(componentId(component))) return 'descriptor-conflict';
    seen.add(componentId(component));
    if (component.storage === 'sparse') return 'span-unavailable';
    if (Object.values(componentSchema(component)).some((field) => !NUMERIC_FIELDS.has(field))) {
      return 'object-field';
    }
  }
  return undefined;
}

export function sharedKernelEligibility(
  moduleUrl: string,
  definition: SharedKernelDefinition<readonly QueryDescriptor[]>,
): SharedKernelEligibilityReason | undefined {
  try {
    new URL(moduleUrl);
  } catch {
    return 'callback-not-module-function';
  }
  const source = Function.prototype.toString.call(definition.run);
  if (definition.run.name.length === 0 || source.includes('=>')) {
    return 'callback-not-module-function';
  }
  if (/\b(?:document|window|globalThis|HTMLElement|GPUDevice|AudioContext)\b/u.test(source)) {
    return 'dom-access';
  }
  for (const query of definition.queries) {
    const reason = descriptorReason(query);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

export function defineSharedKernel<const Qs extends readonly QueryDescriptor[]>(
  moduleUrl: string,
  definition: SharedKernelDefinition<Qs>,
): SharedKernelHandle<Qs> {
  const reason = sharedKernelEligibility(moduleUrl, definition);
  if (reason !== undefined) throw new SharedKernelEligibilityError(definition.name, reason);

  const handle: SharedKernelHandle<Qs> = Object.freeze({
    kind: 'shared-kernel' as const,
    moduleUrl,
    name: definition.name,
    queries: definition.queries,
    minimumRows: definition.minimumRows ?? 16_384,
    run: definition.run,
    ...(definition.before !== undefined ? { before: definition.before } : {}),
    ...(definition.after !== undefined ? { after: definition.after } : {}),
    fn: (world: import('../world').World, queries: Parameters<SystemHandle<Qs>['fn']>[1]) => {
      const dispatchSpans: KernelDispatchSpan[] = [];
      for (const [queryIndex, query] of queries.entries()) {
        const result = query.spans();
        if (!result.ok) throw new SharedKernelEligibilityError(definition.name, 'span-unavailable');
        for (const span of result.value) dispatchSpans.push({ queryIndex, span });
      }
      const spans = dispatchSpans.map((entry) => entry.span);
      const totalRows = spans.reduce((sum, span) => sum + span.length, 0);
      try {
        if (
          totalRows < (definition.minimumRows ?? 16_384) ||
          !world.hasResource(SHARED_KERNEL_EXECUTOR_RESOURCE_KEY)
        ) {
          definition.run(spans);
          return;
        }
        const executor = world.getResource<SharedKernelExecutor>(
          SHARED_KERNEL_EXECUTOR_RESOURCE_KEY,
        );
        const result = executor.execute(handle, dispatchSpans);
        if (isKernelDispatchFailure(result)) {
          if (!result.partialWrite) {
            definition.run(spans);
            return;
          }
          world[worldInternal].poisonExecution({
            code: 'shared-kernel-failed',
            kernelName: definition.name,
            cause: result.cause,
            partialWrite: result.partialWrite,
            retryable: false,
          });
          throw new SharedKernelFailureError(
            definition.name,
            world.execution.identity,
            result.cause,
            result.partialWrite,
          );
        }
      } catch (cause) {
        world[worldInternal].poisonExecution({
          code: 'shared-kernel-failed',
          kernelName: definition.name,
          cause,
          partialWrite: true,
          retryable: false,
        });
        if (cause instanceof SharedKernelFailureError) throw cause;
        throw new SharedKernelFailureError(definition.name, world.execution.identity, cause, true);
      }
    },
  });
  return handle;
}

export type SharedFieldView =
  | Float32Array
  | Float64Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array;

export interface SharedSpanBinding {
  readonly entities: Readonly<Uint32Array>;
  readonly length: number;
  readonly read: Readonly<Record<string, Readonly<Record<string, SharedFieldView>>>>;
  readonly write: Readonly<Record<string, Readonly<Record<string, SharedFieldView>>>>;
}

function sliceFields(
  fields: Readonly<Record<string, SharedFieldView>>,
  start: number,
  end: number,
): Readonly<Record<string, SharedFieldView>> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, view]) => [name, view.subarray(start, end)]),
  );
}

export function bindSharedSpan(
  kernel: SharedKernelDispatch,
  span: QuerySpan,
  queryIndex: number,
): SharedSpanBinding {
  const descriptor = kernel.queries[queryIndex];
  if (descriptor === undefined) throw new Error(`Missing query descriptor ${queryIndex}.`);
  const read = Object.fromEntries(
    (descriptor.read ?? []).map((component) => [
      component.name,
      span.get(component) as unknown as Record<string, SharedFieldView>,
    ]),
  );
  const write = Object.fromEntries(
    (descriptor.write ?? []).map((component) => [
      component.name,
      span.mut(component) as unknown as Record<string, SharedFieldView>,
    ]),
  );
  return { entities: span.entities, length: span.length, read, write };
}

export function splitSharedSpan(
  binding: SharedSpanBinding,
  shardCount: number,
): readonly SharedSpanBinding[] {
  if (binding.length === 0 || shardCount <= 0) return [];
  const count = Math.min(binding.length, shardCount);
  const shards: SharedSpanBinding[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((binding.length * index) / count);
    const end = Math.floor((binding.length * (index + 1)) / count);
    shards.push({
      entities: binding.entities.subarray(start, end),
      length: end - start,
      read: Object.fromEntries(
        Object.entries(binding.read).map(([component, fields]) => [
          component,
          sliceFields(fields, start, end),
        ]),
      ),
      write: Object.fromEntries(
        Object.entries(binding.write).map(([component, fields]) => [
          component,
          sliceFields(fields, start, end),
        ]),
      ),
    });
  }
  return shards;
}

export function isSharedSpan(binding: SharedSpanBinding): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (!(binding.entities.buffer instanceof SharedArrayBuffer)) return false;
  return [...Object.values(binding.read), ...Object.values(binding.write)].every((fields) =>
    Object.values(fields).every((view) => view.buffer instanceof SharedArrayBuffer),
  );
}
