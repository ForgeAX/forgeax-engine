import type { VfxGpuEffectAssetAny, VfxGpuEmitterProgramAny } from './gpu-program.js';

export type VfxAuthoringValue =
  | null
  | string
  | number
  | boolean
  | readonly VfxAuthoringValue[]
  | { readonly [key: string]: VfxAuthoringValue };

export interface VfxAuthoringFieldDescriptor {
  readonly path: string;
  readonly label: string;
  readonly value: VfxAuthoringValue;
  readonly valueType: 'text' | 'number' | 'boolean' | 'vector' | 'object';
}

export type VfxAuthoringNodeRole =
  | 'emitter'
  | 'program'
  | 'parameters'
  | 'custom'
  | 'stage'
  | 'channel'
  | 'event'
  | 'renderer';

export interface VfxAuthoringNodeDescriptor {
  readonly id: string;
  readonly role: VfxAuthoringNodeRole;
  readonly label: string;
  readonly sourcePath: string;
  readonly fields: readonly VfxAuthoringFieldDescriptor[];
  readonly children: readonly VfxAuthoringNodeDescriptor[];
}

export interface VfxAuthoringEmitterDescriptor extends VfxAuthoringNodeDescriptor {
  readonly role: 'emitter';
  readonly module: string;
}

export interface VfxAuthoringTimelineDescriptor {
  readonly emitterId: string;
  readonly rate: number;
  readonly bursts: readonly { readonly time: number; readonly count: number }[];
  readonly loopDuration?: number;
}

export interface VfxAuthoringDependencyDescriptor {
  readonly kind: 'asset' | 'module' | 'data-interface';
  readonly identity: string;
  readonly sourcePath: string;
}

export interface VfxAuthoringCapabilityDescriptor {
  readonly id: string;
  readonly state: 'executable' | 'partial' | 'unavailable';
  readonly reason?: string;
}

export interface VfxAuthoringDescriptor {
  readonly version: 1;
  readonly assetGuid: string;
  readonly schemaVersion: 3;
  readonly artifactFingerprint: string;
  readonly emitters: readonly VfxAuthoringEmitterDescriptor[];
  readonly timeline: readonly VfxAuthoringTimelineDescriptor[];
  readonly dependencies: readonly VfxAuthoringDependencyDescriptor[];
  readonly capabilities: readonly VfxAuthoringCapabilityDescriptor[];
}

const V3_CAPABILITIES: readonly VfxAuthoringCapabilityDescriptor[] = Object.freeze([
  Object.freeze({ id: 'wgsl-behavior', state: 'executable' }),
  Object.freeze({ id: 'multi-emitter', state: 'executable' }),
  Object.freeze({ id: 'deterministic-replay', state: 'executable' }),
  Object.freeze({ id: 'emitter-visibility', state: 'executable' }),
  Object.freeze({ id: 'runtime-parameters', state: 'executable' }),
  Object.freeze({ id: 'custom-attributes', state: 'executable' }),
  Object.freeze({ id: 'force-fields', state: 'executable' }),
  Object.freeze({ id: 'renderer-semantics', state: 'executable' }),
  Object.freeze({ id: 'material-particle-inputs', state: 'executable' }),
  Object.freeze({
    id: 'data-interfaces',
    state: 'partial',
    reason: 'camera, single-sample scene depth, and noise require generation-owned providers',
  }),
]);

/** Narrow an AssetRegistry payload without making editor consumers duplicate
 * the cooked program shape. This deliberately validates the stable producer
 * discriminants only; detailed artifact validation remains the pack loader's
 * responsibility. */
export function isVfxGpuEffectAsset(value: unknown): value is VfxGpuEffectAssetAny {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VfxGpuEffectAssetAny>;
  const program = candidate.program;
  return (
    candidate.kind === 'particle-effect' &&
    candidate.schemaVersion === 3 &&
    typeof candidate.guid === 'string' &&
    candidate.guid.length > 0 &&
    typeof program === 'object' &&
    program !== null &&
    program.format === 'forgeax-vfx-program-4' &&
    typeof program.fingerprint === 'string' &&
    Array.isArray(program.emitters)
  );
}

function label(path: string): string {
  const leaf = path.split('.').at(-1) ?? path;
  return leaf.replaceAll(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (value) => value.toUpperCase());
}

function authoringValue(value: unknown): VfxAuthoringValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(authoringValue));
  if (typeof value === 'object') {
    const out: Record<string, VfxAuthoringValue> = {};
    for (const [key, child] of Object.entries(value)) out[key] = authoringValue(child);
    return Object.freeze(out);
  }
  return String(value);
}

function valueType(value: VfxAuthoringValue): VfxAuthoringFieldDescriptor['valueType'] {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) return 'vector';
  if (typeof value === 'object' && value !== null) return 'object';
  return 'text';
}

function field(path: string, value: unknown): VfxAuthoringFieldDescriptor {
  const normalized = authoringValue(value);
  return Object.freeze({
    path,
    label: label(path),
    value: normalized,
    valueType: valueType(normalized),
  });
}

function fields(
  path: string,
  value: object,
  omit: readonly string[] = [],
): readonly VfxAuthoringFieldDescriptor[] {
  const excluded = new Set(omit);
  return Object.freeze(
    Object.entries(value)
      .filter(([key, child]) => !excluded.has(key) && child !== undefined)
      .map(([key, child]) => field(`${path}.${key}`, child)),
  );
}

function node(
  input: Omit<VfxAuthoringNodeDescriptor, 'children'> & {
    readonly children?: readonly VfxAuthoringNodeDescriptor[];
  },
): VfxAuthoringNodeDescriptor {
  return Object.freeze({ ...input, children: Object.freeze([...(input.children ?? [])]) });
}

function reflectionNodes(
  emitter: VfxGpuEmitterProgramAny,
  path: string,
): VfxAuthoringNodeDescriptor[] {
  const nodes: VfxAuthoringNodeDescriptor[] = [];
  const layout = emitter.reflection.layout;
  if (layout !== undefined && layout.parameters.fields.length > 0) {
    nodes.push(
      node({
        id: `parameters:${emitter.id}`,
        role: 'parameters',
        label: layout.parameters.name,
        sourcePath: `${path}.program`,
        fields: Object.freeze(
          layout.parameters.fields.map((entry) =>
            field(`parameters.${entry.name}`, {
              type: entry.type,
              offset: entry.offset,
              size: entry.size,
              alignment: entry.alignment,
              defaultValue: entry.defaultValue ?? null,
            }),
          ),
        ),
      }),
    );
  }
  if (layout !== undefined && layout.custom.fields.length > 0) {
    nodes.push(
      node({
        id: `custom:${emitter.id}`,
        role: 'custom',
        label: layout.custom.name,
        sourcePath: `${path}.program`,
        fields: Object.freeze(
          layout.custom.fields.map((entry) =>
            field(`custom.${entry.name}`, {
              type: entry.type,
              offset: entry.offset,
              size: entry.size,
              alignment: entry.alignment,
              defaultValue: entry.defaultValue ?? null,
            }),
          ),
        ),
      }),
    );
  }
  for (const stage of emitter.reflection.stages ?? []) {
    nodes.push(
      node({
        id: `stage:${emitter.id}:${stage.id}`,
        role: 'stage',
        label: stage.id,
        sourcePath: `${path}.program`,
        fields: fields(`stages.${stage.id}`, stage, ['id', 'entryPoint']),
      }),
    );
  }
  return nodes;
}

function emitterNode(
  emitter: VfxGpuEmitterProgramAny,
  index: number,
): VfxAuthoringEmitterDescriptor {
  const path = `emitters[${index}]`;
  const children: VfxAuthoringNodeDescriptor[] = [
    node({
      id: `program:${emitter.id}`,
      role: 'program',
      label: emitter.module,
      sourcePath: `${path}.program.module`,
      fields: Object.freeze([
        field(`${path}.program.module`, emitter.module),
        field(`${path}.program.imports`, emitter.reflection.imports),
      ]),
    }),
    ...reflectionNodes(emitter, path),
    ...(emitter.channels ?? []).map((channel, channelIndex) =>
      node({
        id: `channel:${emitter.id}:${channel.id}`,
        role: 'channel',
        label: channel.id,
        sourcePath: `${path}.channels[${channelIndex}]`,
        fields: fields(`${path}.channels[${channelIndex}]`, channel, ['id']),
      }),
    ),
    ...(emitter.events ?? []).map((event, eventIndex) =>
      node({
        id: `event:${emitter.id}:${event.id}`,
        role: 'event',
        label: event.id,
        sourcePath: `${path}.events[${eventIndex}]`,
        fields: fields(`${path}.events[${eventIndex}]`, event, ['id']),
      }),
    ),
    ...emitter.renderers.map((renderer, rendererIndex) =>
      node({
        id: `renderer:${emitter.id}:${rendererIndex}`,
        role: 'renderer',
        label: `${renderer.kind} renderer`,
        sourcePath: `${path}.renderers[${rendererIndex}]`,
        fields: fields(`${path}.renderers[${rendererIndex}]`, renderer, ['kind']),
      }),
    ),
  ];
  return Object.freeze({
    id: `emitter:${emitter.id}`,
    role: 'emitter',
    label: emitter.id,
    module: emitter.module,
    sourcePath: path,
    fields: Object.freeze([
      field(`${path}.capacity`, emitter.capacity),
      field(`${path}.space`, emitter.space),
      field(`${path}.bounds`, emitter.bounds),
      field(`${path}.simulationWhenCulled`, emitter.simulationWhenCulled),
      ...(emitter.forceFields === undefined
        ? []
        : [field(`${path}.forceFields`, emitter.forceFields)]),
    ]),
    children: Object.freeze(children),
  });
}

function dependencies(effect: VfxGpuEffectAssetAny): readonly VfxAuthoringDependencyDescriptor[] {
  const entries: VfxAuthoringDependencyDescriptor[] = [];
  const seen = new Set<string>();
  const add = (entry: VfxAuthoringDependencyDescriptor): void => {
    const key = `${entry.kind}:${entry.identity}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(Object.freeze(entry));
  };
  for (const [emitterIndex, emitter] of effect.program.emitters.entries()) {
    const path = `emitters[${emitterIndex}]`;
    add({ kind: 'module', identity: emitter.module, sourcePath: `${path}.program.module` });
    for (const identity of emitter.reflection.imports) {
      add({ kind: 'module', identity, sourcePath: `${path}.program.imports` });
    }
    for (const [fieldIndex, force] of (emitter.forceFields ?? []).entries()) {
      if (force.kind === 'vector')
        add({
          kind: 'asset',
          identity: force.texture,
          sourcePath: `${path}.forceFields[${fieldIndex}].texture`,
        });
    }
    for (const [rendererIndex, renderer] of emitter.renderers.entries()) {
      add({
        kind: 'asset',
        identity: renderer.material,
        sourcePath: `${path}.renderers[${rendererIndex}].material`,
      });
      if (renderer.kind === 'mesh' && typeof renderer.mesh === 'string') {
        add({
          kind: 'asset',
          identity: renderer.mesh,
          sourcePath: `${path}.renderers[${rendererIndex}].mesh`,
        });
      }
    }
    for (const requirement of emitter.reflection.dataInterfaces ?? []) {
      add({ kind: 'data-interface', identity: requirement.token, sourcePath: `${path}.program` });
    }
  }
  return Object.freeze(entries);
}

/** Project the cooked runtime asset into a compiler-free, UI-neutral authoring read model. */
export function describeVfxGpuEffect(effect: VfxGpuEffectAssetAny): VfxAuthoringDescriptor {
  return Object.freeze({
    version: 1,
    assetGuid: effect.guid,
    schemaVersion: effect.schemaVersion,
    artifactFingerprint: effect.program.fingerprint,
    emitters: Object.freeze(effect.program.emitters.map(emitterNode)),
    timeline: Object.freeze(
      effect.program.emitters.map((emitter) =>
        Object.freeze({
          emitterId: emitter.id,
          rate: emitter.schedule.rate,
          bursts: Object.freeze([...(emitter.schedule.bursts ?? [])]),
          ...(emitter.schedule.loopDuration === undefined
            ? {}
            : { loopDuration: emitter.schedule.loopDuration }),
        }),
      ),
    ),
    dependencies: dependencies(effect),
    capabilities: V3_CAPABILITIES,
  });
}
