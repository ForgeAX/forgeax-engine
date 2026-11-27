import {
  type BindGroup,
  type BindGroupLayout,
  type Buffer,
  err,
  ok,
  type Result,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import type { GpuScene, GpuSceneTableBindingTarget } from '../gpu-scene';

export interface ViewInputBuffers {
  readonly batches: Buffer;
  readonly view: Buffer;
  readonly counters: Buffer;
  readonly visible: Buffer;
  readonly indirect: Buffer;
  readonly skinIndirect?: Buffer;
}

export interface GpuViewInputPreparation {
  isCurrent(): boolean;
  /** After the actual Inputs handoff; publishes no read or topology facts. */
  publish(): Result<void, RhiError>;
  release(): void;
}

export interface InputBindingFacts {
  readonly scene: GpuScene;
  readonly viewScene: GpuScene | undefined;
  readonly input: Buffer | undefined;
  readonly cull: BindGroup | undefined;
  readonly skin: BindGroup | undefined;
  readonly finalize: BindGroup | undefined;
  readonly skinLayout: BindGroupLayout | undefined;
  readonly buffers: ViewInputBuffers;
  readonly storage: readonly [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer | undefined];
  readonly tables: readonly [Buffer, Buffer, Buffer, Buffer];
  readonly tableIdentity: object;
  readonly target?: GpuSceneTableBindingTarget;
  readonly viewTables: readonly [
    Buffer | undefined,
    Buffer | undefined,
    Buffer | undefined,
    Buffer | undefined,
  ];
}
export interface InputBindingGroups {
  readonly cull: BindGroup;
  readonly skin: BindGroup | undefined;
  readonly finalize: BindGroup | undefined;
}
export interface PreparingInputBindings {
  readonly target: Buffer;
  readonly bytes: number;
  facts: InputBindingFacts | undefined;
  groups: InputBindingGroups | undefined;
}

function bufferBinding(buffer: Buffer): {
  readonly kind: 'buffer';
  readonly value: { readonly buffer: Buffer };
} {
  return { kind: 'buffer', value: { buffer } };
}

export function createInputBindingGroups(
  device: RhiDevice,
  layout: BindGroupLayout,
  labelPrefix: string,
  facts: InputBindingFacts,
  inputBuffer: Buffer,
  current: () => boolean,
): Result<InputBindingGroups, RhiError> {
  if (!current()) return err(staleBindings());
  const tables: readonly [Buffer, Buffer, Buffer] =
    facts.target === undefined
      ? [facts.tables[0], facts.tables[1], facts.tables[2]]
      : [facts.target.primitiveBuffer, facts.target.instanceBuffer, facts.target.transformBuffer];
  const entries = [
    { binding: 0, resource: bufferBinding(tables[0]) },
    { binding: 1, resource: bufferBinding(tables[1]) },
    { binding: 2, resource: bufferBinding(tables[2]) },
    { binding: 3, resource: bufferBinding(inputBuffer) },
    { binding: 4, resource: bufferBinding(facts.storage[0]) },
    { binding: 5, resource: bufferBinding(facts.storage[1]) },
    { binding: 6, resource: bufferBinding(facts.storage[2]) },
    { binding: 7, resource: bufferBinding(facts.storage[3]) },
    { binding: 8, resource: bufferBinding(facts.storage[4]) },
  ];
  const binding = device.createBindGroup({
    label: `${labelPrefix}-bg`,
    layout: layout,
    entries,
  });
  if (!binding.ok) return binding;
  if (!current()) return err(staleBindings());
  let skin: BindGroup | undefined;
  let finalize: BindGroup | undefined;
  if (facts.skinLayout !== undefined) {
    const taskBinding = device.createBindGroup({
      label: `${labelPrefix}-skin-bg`,
      layout: facts.skinLayout,
      entries: entries.slice(0, 8),
    });
    if (!taskBinding.ok) return taskBinding;
    if (!current()) return err(staleBindings());
    skin = taskBinding.value;
    const args = facts.storage[5];
    if (args === undefined)
      return err(
        new RhiError({
          code: 'rhi-descriptor-invalid',
          expected: 'dedicated Skin dispatch arguments for the prepared view',
          hint: 'prepare the matching Skin buffer generation',
        }),
      );
    const finalizeBinding = device.createBindGroup({
      label: `${labelPrefix}-skin-finalize-bg`,
      layout,
      entries: entries.map((entry) =>
        entry.binding === 8 ? { binding: 8, resource: bufferBinding(args) } : entry,
      ),
    });
    if (!finalizeBinding.ok) return finalizeBinding;
    if (!current()) return err(staleBindings());
    finalize = finalizeBinding.value;
  }
  return ok({ cull: binding.value, skin, finalize });
}

function staleBindings(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'unchanged binding facts and target after native creation',
    hint: 'release this private pair and prepare against the current Inputs and View',
  });
}

export function inputBindingStorageMatches(facts: InputBindingFacts): boolean {
  const buffers = facts.buffers;
  return (
    buffers.batches === facts.storage[0] &&
    buffers.view === facts.storage[1] &&
    buffers.counters === facts.storage[2] &&
    buffers.visible === facts.storage[3] &&
    buffers.indirect === facts.storage[4] &&
    buffers.skinIndirect === facts.storage[5]
  );
}

/** Accept only the captured table root or the exact prepared successor, with unchanged View pointers. */
export function inputBindingTablesMatch(
  facts: InputBindingFacts,
  primitive: Buffer | undefined,
  instance: Buffer | undefined,
  transform: Buffer | undefined,
  material: Buffer | undefined,
): boolean {
  const original = facts.scene.tableBindingIdentity === facts.tableIdentity;
  const accepted =
    facts.target !== undefined &&
    facts.scene.capacityTargetMatches(facts.target) &&
    facts.scene.tableBindingIdentity === facts.target.identity;
  return (
    (original || accepted) &&
    primitive === facts.viewTables[0] &&
    instance === facts.viewTables[1] &&
    transform === facts.viewTables[2] &&
    material === facts.viewTables[3]
  );
}

/** Source-owned table/storage facts paired with the View's own binding pointers. */
export function inputBindingSceneFacts(
  scene: GpuScene,
  buffers: ViewInputBuffers,
  target: GpuSceneTableBindingTarget | undefined,
): Pick<
  InputBindingFacts,
  'scene' | 'buffers' | 'storage' | 'tables' | 'tableIdentity' | 'target'
> {
  return {
    scene,
    buffers,
    storage: [
      buffers.batches,
      buffers.view,
      buffers.counters,
      buffers.visible,
      buffers.indirect,
      buffers.skinIndirect,
    ],
    tables: [
      scene.primitiveBuffer,
      scene.instanceBuffer,
      scene.transformBuffer,
      scene.materialBuffer,
    ],
    tableIdentity: scene.tableBindingIdentity,
    ...(target === undefined ? {} : { target }),
  };
}
