import {
  AssetError,
  type AssetHandle,
  type AssetPreparationContext,
  err,
  ok,
  type Result,
  sha256,
  stripWgslComments,
} from '@forgeax/engine-types';
import { parseParticleEffectSourceV3 } from './code-source-v3.js';
import { validateVfxEffectReflection } from './effect-contract.js';
import { validateVfxForceFields } from './force-fields.js';
import {
  VFX_GPU_PROGRAM_FORMAT,
  type VfxGpuEffectAsset,
  type VfxGpuEmitterProgram,
} from './gpu-program.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(path: string, expected = 'a complete, consistent Program v3 GPU effect') {
  return err(
    new AssetError({
      code: 'asset-invalid-value',
      expected,
      hint: `repair ${path} before submitting the effect`,
    }),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

// WGSL is immutable source data; edits to bounded numeric metadata never rescan or rehash it.
const programs = new Map<
  string,
  { digest: string; entries: ReadonlySet<string>; bindings: ReadonlySet<string> }
>();
let programBytes = 0;
function program(source: string) {
  let result = programs.get(source);
  if (result !== undefined) return result;
  const stripped = stripWgslComments(source);
  result = {
    digest: sha256(source),
    entries: new Set(
      [...stripped.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(
        (match) => match[1] ?? '',
      ),
    ),
    bindings: new Set(
      [...stripped.matchAll(/@group\(\s*(\d+)\s*\)\s*@binding\(\s*(\d+)\s*\)/g)].map(
        (match) => `${match[1]}:${match[2]}`,
      ),
    ),
  };
  if (source.length <= 8 * 1024 * 1024) {
    programs.set(source, result);
    programBytes += source.length * 2;
    while (programs.size > 128 || programBytes > 16 * 1024 * 1024) {
      const oldest = programs.keys().next().value;
      if (oldest === undefined) break;
      programs.delete(oldest);
      programBytes -= oldest.length * 2;
    }
  }
  return result;
}

function validInstanceCompute(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    record(value) &&
    typeof value.format === 'string' &&
    value.format !== 'forgeax-vfx-instance-compute-1'
  )
    return true;
  if (
    !record(value) ||
    value.format !== 'forgeax-vfx-instance-compute-1' ||
    value.jobBytes !== 336 ||
    typeof value.wgsl !== 'string' ||
    value.wgsl.length === 0 ||
    !Array.isArray(value.bindings) ||
    value.bindings.length !== 1
  )
    return false;
  const group = value.bindings[0];
  if (!record(group) || !Array.isArray(group.entries) || group.entries.length !== 9) return false;
  const slots = [0, 1, 2, 3, 4, 5, 6, 11, 12];
  return group.entries.every(
    (entry: unknown, index: number) =>
      record(entry) &&
      entry.binding === slots[index] &&
      entry.visibility === 4 &&
      record(entry.buffer) &&
      entry.buffer.type ===
        (slots[index] === 1 ? 'read-only-storage' : slots[index] === 12 ? 'uniform' : 'storage') &&
      entry.buffer.hasDynamicOffset !== true,
  );
}

const REQUIRED_ENTRY_POINTS = [
  'forgeax_vfx_spawn_main',
  'forgeax_vfx_update_main',
  'forgeax_vfx_compact_main',
  'forgeax_vfx_billboard_main',
  'forgeax_vfx_mesh_main',
  'forgeax_vfx_ribbon_main',
  'forgeax_vfx_trail_main',
  'forgeax_vfx_beam_main',
];

/** The cooked reflection tables a runtime emitter is admitted against. */
interface ReflectionTables extends Record<string, unknown> {
  readonly entryPoints: unknown[];
  readonly bindings: unknown[];
  readonly resources: unknown[];
  readonly dataInterfaces: unknown[];
  readonly renderers: unknown[];
  readonly stages: unknown[];
}

/** The reflected entry points exist in the executable WGSL and every reflection table is present. */
function reflectionShapeValid(
  reflection: Record<string, unknown>,
  rendererCount: number,
  executable: ReturnType<typeof program>,
): reflection is ReflectionTables {
  const entryPoints = reflection.entryPoints;
  return (
    Array.isArray(entryPoints) &&
    REQUIRED_ENTRY_POINTS.every((name) => entryPoints.includes(name)) &&
    entryPoints.every((name) => typeof name === 'string' && executable.entries.has(name)) &&
    Array.isArray(reflection.bindings) &&
    Array.isArray(reflection.resources) &&
    Array.isArray(reflection.dataInterfaces) &&
    Array.isArray(reflection.renderers) &&
    reflection.renderers.length === rendererCount &&
    Array.isArray(reflection.stages)
  );
}

/** Reflected bindings cover the executable WGSL bindings exactly once. */
function reflectedBindingKeys(
  bindings: readonly unknown[],
  executable: ReturnType<typeof program>,
  path: string,
): Result<Set<string>, AssetError> {
  const bindingKeys = new Set<string>();
  for (const group of bindings) {
    if (!record(group) || typeof group.label !== 'string' || !Array.isArray(group.entries))
      return invalid(`${path}.bindings`);
    const groupIndex = /^@group\((\d+)\)$/.exec(group.label)?.[1];
    if (groupIndex === undefined) return invalid(`${path}.bindings`);
    for (const entry of group.entries) {
      if (!record(entry) || !Number.isSafeInteger(entry.binding) || (entry.binding as number) < 0)
        return invalid(`${path}.bindings`);
      const key = `${groupIndex}:${entry.binding}`;
      if (bindingKeys.has(key) || !executable.bindings.has(key))
        return invalid(
          `${path}.bindings`,
          'reflected bindings present exactly once in executable WGSL',
        );
      bindingKeys.add(key);
    }
  }
  if (bindingKeys.size !== executable.bindings.size)
    return invalid(
      `${path}.bindings`,
      'complete reflected coverage of canonical cooked WGSL bindings',
    );
  return ok(bindingKeys);
}

/** Force fields are valid and declared exactly when the reflection requires the force-field binding. */
function forceFieldsMatchReflection(
  fields: unknown,
  dataInterfaces: readonly unknown[],
  bindingKeys: ReadonlySet<string>,
  path: string,
): boolean {
  if (fields !== undefined && !validateVfxForceFields(fields, `${path}.forceFields`, true).ok)
    return false;
  const requirements = dataInterfaces.filter(
    (entry) => record(entry) && entry.kind === 'force-fields',
  );
  return !(fields === undefined
    ? requirements.length !== 0
    : requirements.length !== 1 ||
      !record(requirements[0]) ||
      requirements[0].token !== 'vfx:force-fields' ||
      requirements[0].binding !== 17 ||
      requirements[0].bindingType !== 'read-only-storage' ||
      !bindingKeys.has('0:17'));
}

function linkReference(
  value: unknown,
  kind: 'material' | 'mesh' | 'texture',
  context: AssetPreparationContext | undefined,
): Result<string | AssetHandle, AssetError> {
  if (typeof value !== 'string' && typeof value !== 'number')
    return invalid(kind, `a ${kind} GUID or owned handle`);
  return context === undefined
    ? ok(value as string | AssetHandle)
    : context.reference(value as string | AssetHandle, kind);
}

/** Renderers matching the cooked topology, with material and mesh references linked. */
function linkRenderers(
  renderers: readonly unknown[],
  reflected: readonly unknown[],
  path: string,
  context: AssetPreparationContext | undefined,
): Result<Record<string, unknown>[], AssetError> {
  const linked = [];
  for (const [rendererIndex, renderer] of renderers.entries()) {
    if (!record(renderer)) return invalid(`${path}.renderers`);
    const projection = reflected[rendererIndex];
    if (!record(projection) || projection.topology !== renderer.kind)
      return invalid(
        `${path}.renderers[${rendererIndex}]`,
        'renderer topology matching the cooked projection',
      );
    const material = linkReference(renderer.material, 'material', context);
    if (!material.ok) return material;
    let mesh: string | AssetHandle | { readonly source: 'player' } | undefined;
    if (renderer.kind === 'mesh') {
      if (
        record(renderer.mesh) &&
        renderer.mesh.source === 'player' &&
        Object.keys(renderer.mesh).length === 1
      )
        mesh = { source: 'player' };
      else {
        const resolved = linkReference(renderer.mesh, 'mesh', context);
        if (!resolved.ok) return resolved;
        mesh = resolved.value;
      }
    }
    linked.push({
      ...renderer,
      material: material.value,
      ...(mesh === undefined ? {} : { mesh }),
    });
  }
  return ok(linked);
}

/** Force fields with their vector-field texture references linked. */
function linkForceFields(
  fields: unknown,
  context: AssetPreparationContext | undefined,
): Result<unknown[], AssetError> {
  const linkedFields = [];
  for (const field of (fields ?? []) as NonNullable<VfxGpuEmitterProgram['forceFields']>) {
    if (field.kind !== 'vector') {
      linkedFields.push(field);
      continue;
    }
    const texture = linkReference(field.texture, 'texture', context);
    if (!texture.ok) return texture;
    linkedFields.push({ ...field, texture: texture.value });
  }
  return ok(linkedFields);
}

/** The author-source projection the Program v3 validator re-checks. */
function authorEmitterSource(normalized: Record<string, unknown>): Record<string, unknown> {
  // Reuse the author validator for schedules, bounds, renderer controls, channels and cross-emitter references.
  const {
    wgsl: _wgsl,
    instanceCompute: _instanceCompute,
    reflection: _reflection,
    module,
    channels,
    events,
    ...metadata
  } = normalized;
  return {
    ...metadata,
    program: { module },
    ...(Array.isArray(channels) && channels.length > 0 ? { channels } : {}),
    ...(Array.isArray(events) && events.length > 0 ? { events } : {}),
  };
}

/** The fingerprint identity: executable WGSL is replaced by its digest. */
function emitterIdentity(
  normalized: Record<string, unknown>,
  instanceCompute: unknown,
  digest: string,
): unknown {
  return {
    ...normalized,
    wgsl: digest,
    ...(record(instanceCompute) && typeof instanceCompute.wgsl === 'string'
      ? {
          instanceCompute: {
            ...instanceCompute,
            wgsl: program(instanceCompute.wgsl).digest,
          },
        }
      : {}),
  };
}

interface PreparedRuntimeEmitter {
  readonly layoutKey: string;
  readonly emitter: Record<string, unknown>;
  readonly source: Record<string, unknown>;
  readonly identity: unknown;
}

/** Validate one cooked emitter against its executable WGSL and link its references. */
function prepareRuntimeEmitter(
  value: unknown,
  path: string,
  layoutIdentity: string | undefined,
  context: AssetPreparationContext | undefined,
): Result<PreparedRuntimeEmitter, AssetError> {
  if (
    !record(value) ||
    typeof value.wgsl !== 'string' ||
    value.wgsl.length === 0 ||
    value.wgsl.length > 8 * 1024 * 1024 ||
    !record(value.reflection) ||
    !Array.isArray(value.renderers)
  )
    return invalid(path);
  if (!validInstanceCompute(value.instanceCompute)) return invalid(`${path}.instanceCompute`);
  const reflection = value.reflection;
  const layout = validateVfxEffectReflection(reflection.layout);
  if (!layout.ok) return invalid(`${path}.${layout.error.detail.path}`, layout.error.expected);
  const layoutKey = canonical({
    ...layout.value,
    fingerprint: undefined,
    dataInterfaces: undefined,
  });
  if (layoutIdentity !== undefined && layoutIdentity !== layoutKey)
    return invalid(`${path}.layout`, 'one shared Parameters/Custom layout across effect emitters');
  const executable = program(value.wgsl);
  if (!reflectionShapeValid(reflection, value.renderers.length, executable))
    return invalid(`${path}.reflection`);
  const bindingKeys = reflectedBindingKeys(reflection.bindings, executable, path);
  if (!bindingKeys.ok) return bindingKeys;
  const fields = value.forceFields;
  if (!forceFieldsMatchReflection(fields, reflection.dataInterfaces, bindingKeys.value, path))
    return invalid(`${path}.forceFields`);
  const renderers = linkRenderers(value.renderers, reflection.renderers, path, context);
  if (!renderers.ok) return renderers;
  const linkedFields = linkForceFields(fields, context);
  if (!linkedFields.ok) return linkedFields;
  const linked = fields === undefined ? {} : { forceFields: linkedFields.value };
  const emitter: Record<string, unknown> = {
    ...value,
    renderers: renderers.value,
    ...linked,
    reflection: {
      ...reflection,
      layout: { ...layout.value, fingerprint: `sha256:${sha256(layoutKey)}` },
    },
  };
  return ok({
    layoutKey,
    emitter,
    source: authorEmitterSource(emitter),
    identity: emitterIdentity(emitter, value.instanceCompute, executable.digest),
  });
}

/** Synchronous runtime owner admission, also used after source artifact verification. */
export function prepareRuntimeParticleEffect(
  input: unknown,
  context?: AssetPreparationContext,
): Result<VfxGpuEffectAsset, AssetError> {
  if (
    !record(input) ||
    input.kind !== 'particle-effect' ||
    input.schemaVersion !== 3 ||
    !record(input.program) ||
    input.program.format !== VFX_GPU_PROGRAM_FORMAT ||
    !Array.isArray(input.program.emitters) ||
    input.program.emitters.length === 0
  )
    return invalid('program');
  const sourceEmitters: Record<string, unknown>[] = [];
  const emitters: VfxGpuEmitterProgram[] = [];
  const identities: unknown[] = [];
  let layoutIdentity: string | undefined;
  for (const [index, value] of input.program.emitters.entries()) {
    const prepared = prepareRuntimeEmitter(
      value,
      `program.emitters[${index}]`,
      layoutIdentity,
      context,
    );
    if (!prepared.ok) return prepared;
    layoutIdentity = prepared.value.layoutKey;
    sourceEmitters.push(prepared.value.source);
    emitters.push(prepared.value.emitter as unknown as VfxGpuEmitterProgram);
    identities.push(prepared.value.identity);
  }
  const source = parseParticleEffectSourceV3({ schemaVersion: 3, emitters: sourceEmitters }, true);
  if (!source.ok) return invalid(source.error.detail.path, source.error.expected);
  const fingerprint = `sha256:${sha256(canonical({ format: VFX_GPU_PROGRAM_FORMAT, emitters: identities }))}`;
  return ok({
    ...input,
    kind: 'particle-effect',
    schemaVersion: 3,
    emitters: emitters.map((emitter) => ({ id: emitter.id, capacity: emitter.capacity })),
    programFingerprint: fingerprint,
    program: { format: VFX_GPU_PROGRAM_FORMAT, fingerprint, emitters },
  } as unknown as VfxGpuEffectAsset);
}
