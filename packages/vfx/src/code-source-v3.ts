import { type AssetHandle, err, ok, type Result } from '@forgeax/engine-types';
import type {
  ParticleCodeSourceError,
  ParticleEmitterSourceBase,
  ParticleRendererOverflowPolicy,
  ParticleSoftParticleSource,
  ParticleTextureSheetSource,
} from './code-source.js';
import { type VfxForceField, validateVfxForceFields } from './force-fields.js';
import type { VfxParticleCoreAttribute } from './particle-layout.js';

/** Renderer sorting modes in Program v3. Segment topology order is unaffected. */
const PARTICLE_RENDERER_SORTING_MODES_V3 = Object.freeze([
  'none',
  'view-depth',
  'view-distance',
  'custom-ascending',
  'custom-descending',
] as const);

export type ParticleRendererSortingV3 = (typeof PARTICLE_RENDERER_SORTING_MODES_V3)[number];

export function isParticleRendererSortingV3(value: unknown): value is ParticleRendererSortingV3 {
  return (PARTICLE_RENDERER_SORTING_MODES_V3 as readonly unknown[]).includes(value);
}

export type ParticleAttributeRef =
  | { readonly source: 'core'; readonly name: VfxParticleCoreAttribute }
  | { readonly source: 'custom'; readonly name: string };

/**
 * Renderer fields with a concrete Program v3 projection. Keep this union
 * execution-backed; renderer.materialInputs is the separate material bridge.
 */
export type ParticleRendererSemantic =
  | 'position'
  | 'color'
  | 'size'
  | 'rotation'
  | 'subImage'
  | 'age'
  | 'sort'
  | 'orientation'
  | 'scale'
  | 'visibility'
  | 'width'
  | 'taper'
  | 'endpoint';

export type ParticleRendererSemanticMap = Readonly<
  Partial<Record<ParticleRendererSemantic, ParticleAttributeRef>>
>;

export interface ParticleRendererSourceV3Base {
  readonly material: string | AssetHandle<'material'>;
  readonly enabled?: boolean;
  readonly capacity?: number;
  readonly overflow?: ParticleRendererOverflowPolicy;
  readonly width?: number;
  readonly attributes?: ParticleRendererSemanticMap;
  /** Names must match the cooked MaterialShaderArtifact particleInputs declaration. */
  readonly materialInputs?: readonly string[];
}

export type ParticleRendererSourceV3 =
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'billboard';
      readonly blend?: 'additive' | 'alpha' | 'opaque-cutout';
      readonly textureSheet?: ParticleTextureSheetSource;
      readonly pivot?: readonly [number, number];
      readonly softParticle?: ParticleSoftParticleSource;
      readonly sorting?: ParticleRendererSortingV3;
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'mesh';
      readonly sorting?: ParticleRendererSortingV3;
      /** A cooked GUID, or the MeshFilter on this Player's entity. */
      readonly mesh: string | AssetHandle<'mesh'> | { readonly source: 'player' };
      readonly submesh?: number;
      readonly lighting?: 'unlit' | 'standard';
      readonly castShadows?: boolean;
      readonly receiveShadows?: boolean;
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'ribbon';
      readonly stripKey: 'alive-index';
      readonly capacity: number;
      readonly twist?: number;
      readonly facing?: 'camera' | 'velocity' | 'custom';
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'trail';
      readonly historyLength: number;
      readonly capacity: number;
      readonly taper?: number;
    })
  | (ParticleRendererSourceV3Base & {
      readonly kind: 'beam';
      readonly endpointField: 'velocity';
      readonly capacity: number;
      readonly taper?: number;
    });

/** Strip renderers (ribbon/trail/beam) own a topology buffer sized by their required capacity. */
export type ParticleTopologyRendererSourceV3 = Extract<
  ParticleRendererSourceV3,
  { readonly capacity: number }
>;

export function isParticleTopologyRenderer(
  renderer: ParticleRendererSourceV3,
): renderer is ParticleTopologyRendererSourceV3 {
  return renderer.kind === 'ribbon' || renderer.kind === 'trail' || renderer.kind === 'beam';
}

/** The structural emitter with its renderers refined to the v3 renderer vocabulary. */
export interface ParticleEmitterSourceV3 extends ParticleEmitterSourceBase {
  readonly renderers: readonly ParticleRendererSourceV3[];
  readonly forceFields?: readonly VfxForceField[];
}

export interface ParticleEffectSourceV3 {
  readonly schemaVersion: 3;
  readonly emitters: readonly ParticleEmitterSourceV3[];
}

/**
 * Renderer semantic vocabulary shared by source validation and compiler
 * reflection. Keeping the allowed keys here prevents a parser/compiler drift
 * where a typo is accepted by one boundary and ignored by the other.
 */
export const PARTICLE_RENDERER_SEMANTICS: Readonly<
  Record<ParticleRendererSourceV3['kind'], readonly ParticleRendererSemantic[]>
> = Object.freeze({
  billboard: Object.freeze([
    'position',
    'color',
    'size',
    'rotation',
    'age',
    'subImage',
    'sort',
    'visibility',
  ] as const),
  mesh: Object.freeze(['position', 'color', 'orientation', 'scale', 'sort', 'visibility'] as const),
  ribbon: Object.freeze(['position', 'color', 'width'] as const),
  trail: Object.freeze(['position', 'color', 'width', 'taper'] as const),
  beam: Object.freeze(['position', 'endpoint', 'color', 'width'] as const),
});

function coreAttribute(name: VfxParticleCoreAttribute): ParticleAttributeRef {
  return { source: 'core', name };
}

/** Default mapping for fields with implicit runtime behavior; overrides merge in the compiler. */
export function defaultParticleRendererAttributes(
  kind: ParticleRendererSourceV3['kind'],
): ParticleRendererSemanticMap {
  switch (kind) {
    case 'billboard':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
        size: coreAttribute('sprite_size'),
        rotation: coreAttribute('sprite_rotation'),
        age: coreAttribute('age'),
        visibility: coreAttribute('alive'),
      };
    case 'mesh':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
        orientation: coreAttribute('mesh_orientation'),
        scale: coreAttribute('mesh_scale'),
        visibility: coreAttribute('alive'),
      };
    case 'ribbon':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
      };
    case 'trail':
      return {
        position: coreAttribute('position'),
        color: coreAttribute('color'),
      };
    case 'beam':
      return {
        position: coreAttribute('position'),
        endpoint: coreAttribute('velocity'),
        color: coreAttribute('color'),
      };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string): Result<never, ParticleCodeSourceError> {
  return err({
    code: 'vfx-source-invalid',
    expected,
    hint: `repair ${path} and recook the Program v3 particle effect`,
    detail: { path },
  });
}

function unknownField(
  value: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const keys = new Set(allowed);
  return Object.keys(value).find((key) => !keys.has(key));
}

const CORE_NAMES = new Set<VfxParticleCoreAttribute>([
  'position',
  'age',
  'velocity',
  'lifetime',
  'color',
  'sprite_size',
  'sprite_rotation',
  'sub_image',
  'mesh_orientation',
  'mesh_scale',
  'material_random',
  'id',
  'alive',
]);

function invalid(
  path: string,
  expected: string,
  emitterId?: string,
  code: ParticleCodeSourceError['code'] = 'vfx-source-invalid',
): Result<never, ParticleCodeSourceError> {
  return err({
    code,
    expected,
    hint: `repair ${path} and recook the particle effect`,
    detail: emitterId === undefined ? { path } : { path, emitterId },
  });
}

function eventInvalid(
  code: 'vfx-source-channel-invalid' | 'vfx-source-event-invalid',
  path: string,
  expected: string,
  emitterId?: string,
): Result<never, ParticleCodeSourceError> {
  return invalid(path, expected, emitterId, code);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(Math.fround(value));
}

function positiveInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function vector(value: unknown, size: number): value is readonly number[] {
  return Array.isArray(value) && value.length === size && value.every(finite);
}

function validateAttributes(
  value: unknown,
  path: string,
): Result<ParticleRendererSemanticMap | undefined, ParticleCodeSourceError> {
  if (value === undefined) return ok(undefined);
  if (!record(value)) return fail(path, 'a semantic-to-attribute object');
  for (const [semantic, reference] of Object.entries(value)) {
    if (!record(reference) || (reference.source !== 'core' && reference.source !== 'custom')) {
      return fail(`${path}.${semantic}`, "{ source: 'core' | 'custom', name: string }");
    }
    if (typeof reference.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.name)) {
      return fail(`${path}.${semantic}.name`, 'a non-empty identifier');
    }
    if (
      reference.source === 'core' &&
      !CORE_NAMES.has(reference.name as VfxParticleCoreAttribute)
    ) {
      return fail(`${path}.${semantic}.name`, 'a VfxParticle core attribute');
    }
    const referenceExtra = unknownField(reference, ['source', 'name']);
    if (referenceExtra !== undefined)
      return fail(`${path}.${semantic}.${referenceExtra}`, 'source and name only');
  }
  return ok(value as ParticleRendererSemanticMap);
}

function validateMaterialInputs(
  value: unknown,
  path: string,
): Result<readonly string[] | undefined, ParticleCodeSourceError> {
  if (value === undefined) return ok(undefined);
  if (
    !Array.isArray(value) ||
    value.length > 4 ||
    value.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry))
  ) {
    return fail(path, 'at most four unique particle input names');
  }
  if (new Set(value).size !== value.length) return fail(path, 'unique particle input names');
  return ok(Object.freeze([...value]));
}

function rendererAllowed(kind: string): readonly string[] {
  const common = [
    'kind',
    'material',
    'enabled',
    'capacity',
    'overflow',
    'width',
    'attributes',
    'materialInputs',
  ];
  switch (kind) {
    case 'billboard':
      return [...common, 'blend', 'textureSheet', 'pivot', 'softParticle', 'sorting'];
    case 'mesh':
      return [
        'kind',
        'material',
        'mesh',
        'submesh',
        'sorting',
        'enabled',
        'attributes',
        'materialInputs',
        'lighting',
        'castShadows',
        'receiveShadows',
      ];
    case 'ribbon':
      return [...common, 'stripKey', 'twist', 'facing'];
    case 'trail':
      return [...common, 'historyLength', 'taper'];
    case 'beam':
      return [...common, 'endpointField', 'taper'];
    default:
      return ['kind'];
  }
}

/** Topology-independent option fields that any renderer kind may carry. */
function rendererOptionFailure(
  value: Record<string, unknown>,
  path: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (value.lighting !== undefined && value.lighting !== 'unlit' && value.lighting !== 'standard')
    return fail(`${path}.lighting`, 'unlit or standard');
  for (const field of ['castShadows', 'receiveShadows'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean')
      return fail(`${path}.${field}`, 'a boolean');
  }
  for (const field of ['twist', 'taper'] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== 'number' || !Number.isFinite(value[field]))
    )
      return fail(`${path}.${field}`, 'a finite number');
  }
  if (
    value.facing !== undefined &&
    value.facing !== 'camera' &&
    value.facing !== 'velocity' &&
    value.facing !== 'custom'
  )
    return fail(`${path}.facing`, 'camera, velocity, or custom');
  if (
    value.sorting !== undefined &&
    (value.kind === 'billboard' || value.kind === 'mesh') &&
    !isParticleRendererSortingV3(value.sorting)
  )
    return fail(`${path}.sorting`, 'a Program v3 sorting mode');
  return undefined;
}

/** Every mapped semantic must belong to the renderer topology's vocabulary. */
function rendererSemanticFailure(
  kind: string,
  attributes: ParticleRendererSemanticMap | undefined,
  path: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (attributes === undefined) return undefined;
  for (const semantic of Object.keys(attributes)) {
    if (
      !PARTICLE_RENDERER_SEMANTICS[kind as ParticleRendererSourceV3['kind']]?.includes(
        semantic as ParticleRendererSemantic,
      )
    ) {
      return fail(
        `${path}.attributes.${semantic}`,
        'a semantic supported by this renderer topology',
      );
    }
  }
  return undefined;
}

function meshRendererFailure(
  value: Record<string, unknown>,
  path: string,
  id: string,
  runtimeReferences: boolean,
): Result<never, ParticleCodeSourceError> | undefined {
  const playerMesh =
    record(value.mesh) && value.mesh.source === 'player' && Object.keys(value.mesh).length === 1;
  if (
    (!text(value.mesh) && !playerMesh && !(runtimeReferences && typeof value.mesh === 'number')) ||
    (value.submesh !== undefined && !nonNegativeInteger(value.submesh))
  )
    return invalid(
      path,
      'a mesh GUID or { source: "player" }, with a non-negative submesh',
      id,
      'vfx-source-renderer-invalid',
    );
  return undefined;
}

/** Instance-buffer controls shared by billboard and strip renderers. */
function rendererBufferFailure(
  value: Record<string, unknown>,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    return invalid(`${path}.enabled`, 'a boolean enabled flag', id, 'vfx-source-renderer-invalid');
  if (value.capacity !== undefined && (!positiveInteger(value.capacity) || value.capacity > 65536))
    return invalid(
      `${path}.capacity`,
      'a positive capacity no greater than 65536',
      id,
      'vfx-source-renderer-invalid',
    );
  if (
    value.overflow !== undefined &&
    value.overflow !== 'drop-newest' &&
    value.overflow !== 'drop-oldest'
  )
    return invalid(
      `${path}.overflow`,
      'drop-newest or drop-oldest',
      id,
      'vfx-source-renderer-invalid',
    );
  if (value.width !== undefined && (!finite(value.width) || value.width <= 0))
    return invalid(`${path}.width`, 'a positive finite width', id, 'vfx-source-renderer-invalid');
  return undefined;
}

function textureSheetValid(sheet: Record<string, unknown>): boolean {
  return (
    unknownField(sheet, ['columns', 'rows', 'frameRate', 'frameCount']) === undefined &&
    positiveInteger(sheet.columns) &&
    positiveInteger(sheet.rows) &&
    sheet.columns <= 64 &&
    sheet.rows <= 64 &&
    finite(sheet.frameRate) &&
    sheet.frameRate >= 0 &&
    (sheet.frameCount === undefined ||
      (positiveInteger(sheet.frameCount) && sheet.frameCount <= sheet.columns * sheet.rows))
  );
}

function billboardRendererFailure(
  value: Record<string, unknown>,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (
    value.blend !== undefined &&
    value.blend !== 'additive' &&
    value.blend !== 'alpha' &&
    value.blend !== 'opaque-cutout'
  )
    return invalid(
      `${path}.blend`,
      'additive, alpha, or opaque-cutout',
      id,
      'vfx-source-renderer-invalid',
    );
  if (
    value.pivot !== undefined &&
    (!vector(value.pivot, 2) || value.pivot.some((value) => value < -1 || value > 1))
  )
    return invalid(
      `${path}.pivot`,
      'two finite values in the -1..1 range',
      id,
      'vfx-source-renderer-invalid',
    );
  if (value.textureSheet !== undefined) {
    if (!record(value.textureSheet))
      return invalid(
        `${path}.textureSheet`,
        'a texture sheet object',
        id,
        'vfx-source-renderer-invalid',
      );
    if (!textureSheetValid(value.textureSheet))
      return invalid(
        `${path}.textureSheet`,
        'a bounded texture sheet declaration',
        id,
        'vfx-source-renderer-invalid',
      );
  }
  if (value.softParticle !== undefined) {
    if (!record(value.softParticle))
      return invalid(
        `${path}.softParticle`,
        'a soft-particle object',
        id,
        'vfx-source-renderer-invalid',
      );
    if (
      unknownField(value.softParticle, ['fadeDistance']) !== undefined ||
      !finite(value.softParticle.fadeDistance) ||
      value.softParticle.fadeDistance <= 0
    )
      return invalid(
        `${path}.softParticle`,
        'a positive scene-depth fade distance',
        id,
        'vfx-source-renderer-invalid',
      );
  }
  return undefined;
}

/** Ribbon, trail and beam topologies each require their strip declaration. */
function stripRendererFailure(
  value: Record<string, unknown>,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (value.kind === 'ribbon') {
    if (value.stripKey !== 'alive-index' || !positiveInteger(value.capacity))
      return invalid(
        path,
        "stripKey 'alive-index' and positive capacity",
        id,
        'vfx-source-renderer-invalid',
      );
  } else if (value.kind === 'trail') {
    if (
      !positiveInteger(value.historyLength) ||
      value.historyLength > 256 ||
      !positiveInteger(value.capacity)
    )
      return invalid(
        path,
        'a bounded trail historyLength and positive capacity',
        id,
        'vfx-source-renderer-invalid',
      );
  } else if (value.kind === 'beam') {
    if (value.endpointField !== 'velocity' || !positiveInteger(value.capacity))
      return invalid(
        path,
        "endpointField 'velocity' and positive capacity",
        id,
        'vfx-source-renderer-invalid',
      );
  } else {
    return invalid(
      path,
      'billboard, mesh, ribbon, trail, or beam',
      id,
      'vfx-source-renderer-invalid',
    );
  }
  return undefined;
}

/** Topology-specific declaration of a renderer whose common fields already validated. */
function rendererTopologyFailure(
  value: Record<string, unknown>,
  path: string,
  id: string,
  runtimeReferences: boolean,
): Result<never, ParticleCodeSourceError> | undefined {
  if (value.kind === 'mesh') return meshRendererFailure(value, path, id, runtimeReferences);
  const buffer = rendererBufferFailure(value, path, id);
  if (buffer !== undefined) return buffer;
  if (value.kind === 'billboard') return billboardRendererFailure(value, path, id);
  return stripRendererFailure(value, path, id);
}

function validateRenderer(
  value: unknown,
  emitterIndex: number,
  index: number,
  id: string,
  runtimeReferences = false,
): Result<ParticleRendererSourceV3, ParticleCodeSourceError> {
  const path = `emitters[${emitterIndex}].renderers[${index}]`;
  if (
    !record(value) ||
    typeof value.kind !== 'string' ||
    (typeof value.material !== 'string' &&
      !(runtimeReferences && typeof value.material === 'number'))
  ) {
    return fail(path, 'a Program v3 renderer object');
  }
  const unknown = unknownField(value, rendererAllowed(value.kind));
  if (unknown !== undefined)
    return fail(`${path}.${unknown}`, 'a supported Program v3 renderer field');
  const option = rendererOptionFailure(value, path);
  if (option !== undefined) return option;
  const attrs = validateAttributes(value.attributes, `${path}.attributes`);
  if (!attrs.ok) return attrs;
  const semantic = rendererSemanticFailure(value.kind, attrs.value, path);
  if (semantic !== undefined) return semantic;
  const inputs = validateMaterialInputs(value.materialInputs, `${path}.materialInputs`);
  if (!inputs.ok) return inputs;
  if (
    (!text(value.material) && !(runtimeReferences && typeof value.material === 'number')) ||
    !text(value.kind)
  )
    return invalid(path, 'a supported renderer object', id, 'vfx-source-renderer-invalid');
  const topology = rendererTopologyFailure(value, path, id, runtimeReferences);
  if (topology !== undefined) return topology;
  return ok({
    ...(value as unknown as ParticleRendererSourceV3),
    ...(attrs.value === undefined ? {} : { attributes: attrs.value }),
    ...(inputs.value === undefined ? {} : { materialInputs: inputs.value }),
  });
}

function emitterBoundsFailure(
  bounds: unknown,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (!record(bounds)) return invalid(`${path}.bounds`, 'fixed aabb or sphere bounds', id);
  const boundsExtra = unknownField(
    bounds,
    bounds.kind === 'aabb'
      ? ['kind', 'min', 'max']
      : bounds.kind === 'sphere'
        ? ['kind', 'center', 'radius']
        : ['kind'],
  );
  if (boundsExtra !== undefined) {
    return invalid(`${path}.bounds.${boundsExtra}`, 'a supported bounds field', id);
  }
  const boundsOk =
    (bounds.kind === 'aabb' && vector(bounds.min, 3) && vector(bounds.max, 3)) ||
    (bounds.kind === 'sphere' &&
      vector(bounds.center, 3) &&
      finite(bounds.radius) &&
      bounds.radius > 0);
  if (!boundsOk) return invalid(`${path}.bounds`, 'valid fixed aabb or sphere bounds', id);
  return undefined;
}

function emitterScheduleFailure(
  schedule: unknown,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (!record(schedule) || !finite(schedule.rate) || schedule.rate < 0) {
    return invalid(`${path}.schedule`, 'a non-negative spawn schedule', id);
  }
  const scheduleExtra = unknownField(schedule, ['rate', 'bursts', 'loopDuration']);
  if (scheduleExtra !== undefined) {
    return invalid(`${path}.schedule.${scheduleExtra}`, 'a supported schedule field', id);
  }
  if (
    schedule.bursts !== undefined &&
    (!Array.isArray(schedule.bursts) ||
      schedule.bursts.some(
        (burst) =>
          !record(burst) || !finite(burst.time) || burst.time < 0 || !positiveInteger(burst.count),
      ))
  ) {
    return invalid(`${path}.schedule.bursts`, 'non-negative timed positive bursts', id);
  }
  if (Array.isArray(schedule.bursts)) {
    for (const [burstIndex, burst] of schedule.bursts.entries()) {
      if (!record(burst)) continue;
      const burstExtra = unknownField(burst, ['time', 'count']);
      if (burstExtra !== undefined) {
        return invalid(
          `${path}.schedule.bursts[${burstIndex}].${burstExtra}`,
          'a supported burst field',
          id,
        );
      }
    }
  }
  if (
    schedule.loopDuration !== undefined &&
    (!finite(schedule.loopDuration) || schedule.loopDuration <= 0)
  ) {
    return invalid(`${path}.schedule.loopDuration`, 'a positive finite duration', id);
  }
  return undefined;
}

/** The explicit GPU backend policy and WGSL program identity. */
function emitterExecutionFailure(
  value: Record<string, unknown>,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (!record(value.backend) || value.backend.required !== 'gpu') {
    return invalid(`${path}.backend`, "the explicit policy { required: 'gpu' }", id);
  }
  const backendExtra = unknownField(value.backend, ['required']);
  if (backendExtra !== undefined) {
    return invalid(`${path}.backend.${backendExtra}`, 'the required GPU policy', id);
  }
  if (value.space !== 'local' && value.space !== 'world') {
    return invalid(`${path}.space`, 'local or world', id);
  }
  const bounds = emitterBoundsFailure(value.bounds, path, id);
  if (bounds !== undefined) return bounds;
  const schedule = emitterScheduleFailure(value.schedule, path, id);
  if (schedule !== undefined) return schedule;
  if (!record(value.program) || !text(value.program.module)) {
    return invalid(`${path}.program.module`, 'a WGSL module identity', id);
  }
  const programExtra = unknownField(value.program, ['module']);
  if (programExtra !== undefined) {
    return invalid(`${path}.program.${programExtra}`, 'a supported program field', id);
  }
  return undefined;
}

function parseEmitterRenderers(
  value: unknown,
  index: number,
  path: string,
  id: string,
  runtimeReferences: boolean,
): Result<ParticleRendererSourceV3[], ParticleCodeSourceError> {
  if (!Array.isArray(value)) {
    return invalid(
      `${path}.renderers`,
      'an explicit renderer array (empty for simulation only)',
      id,
    );
  }
  const renderers: ParticleRendererSourceV3[] = [];
  for (const [rendererIndex, renderer] of value.entries()) {
    const parsed = validateRenderer(renderer, index, rendererIndex, id, runtimeReferences);
    if (!parsed.ok) return parsed;
    renderers.push(parsed.value);
  }
  return ok(renderers);
}

function emitterChannelsFailure(
  channels: unknown,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (channels === undefined) return undefined;
  if (!Array.isArray(channels) || channels.length === 0) {
    return eventInvalid(
      'vfx-source-channel-invalid',
      `${path}.channels`,
      'a non-empty bounded channel list',
      id,
    );
  }
  const channelIds = new Set<string>();
  for (const [channelIndex, channel] of channels.entries()) {
    const channelPath = `${path}.channels[${channelIndex}]`;
    if (!record(channel)) {
      return eventInvalid('vfx-source-channel-invalid', channelPath, 'a channel object', id);
    }
    const channelExtra = unknownField(channel, ['id', 'payload', 'capacity', 'overflow']);
    if (channelExtra !== undefined) {
      return eventInvalid(
        'vfx-source-channel-invalid',
        `${channelPath}.${channelExtra}`,
        'a supported channel field',
        id,
      );
    }
    if (!text(channel.id) || channelIds.has(channel.id)) {
      return eventInvalid(
        'vfx-source-channel-invalid',
        `${channelPath}.id`,
        'a unique non-empty channel id',
        id,
      );
    }
    if (
      !positiveInteger(channel.capacity) ||
      channel.capacity > 65536 ||
      (channel.payload !== undefined && channel.payload !== 'impact') ||
      (channel.overflow !== 'drop-newest' && channel.overflow !== 'drop-oldest')
    ) {
      return eventInvalid(
        'vfx-source-channel-invalid',
        channelPath,
        'an impact channel with capacity 1..65536 and explicit overflow policy',
        id,
      );
    }
    channelIds.add(channel.id);
  }
  return undefined;
}

function emitterEventsFailure(
  events: unknown,
  path: string,
  id: string,
): Result<never, ParticleCodeSourceError> | undefined {
  if (events === undefined) return undefined;
  if (!Array.isArray(events)) {
    return eventInvalid('vfx-source-event-invalid', `${path}.events`, 'an event list', id);
  }
  const eventIds = new Set<string>();
  for (const [eventIndex, event] of events.entries()) {
    const eventPath = `${path}.events[${eventIndex}]`;
    if (!record(event)) {
      return eventInvalid('vfx-source-event-invalid', eventPath, 'an event object', id);
    }
    const eventExtra = unknownField(event, [
      'id',
      'channel',
      'subEmitter',
      'fanOut',
      'recursionDepth',
    ]);
    if (eventExtra !== undefined) {
      return eventInvalid(
        'vfx-source-event-invalid',
        `${eventPath}.${eventExtra}`,
        'a supported event field',
        id,
      );
    }
    if (!text(event.id) || eventIds.has(event.id)) {
      return eventInvalid('vfx-source-event-invalid', `${eventPath}.id`, 'a unique event id', id);
    }
    if (
      !text(event.channel) ||
      !text(event.subEmitter) ||
      !positiveInteger(event.fanOut) ||
      event.fanOut > 16 ||
      !positiveInteger(event.recursionDepth) ||
      event.recursionDepth > 8
    ) {
      return eventInvalid(
        'vfx-source-event-invalid',
        eventPath,
        'an event with bounded fanOut 1..16 and recursionDepth 1..8',
        id,
      );
    }
    eventIds.add(event.id);
  }
  return undefined;
}

function parseEmitter(
  value: unknown,
  index: number,
  ids: Set<string>,
  runtimeReferences = false,
): Result<ParticleEmitterSourceV3, ParticleCodeSourceError> {
  const path = `emitters[${index}]`;
  if (!record(value)) return invalid(path, 'a Program v3 emitter object');
  const extra = unknownField(value, [
    'id',
    'capacity',
    'backend',
    'space',
    'bounds',
    'schedule',
    'program',
    'renderers',
    'channels',
    'events',
    'simulationWhenCulled',
    'forceFields',
  ]);
  if (extra !== undefined) return invalid(`${path}.${extra}`, 'a Program v3 emitter field');
  if (!text(value.id) || ids.has(value.id)) return invalid(`${path}.id`, 'a unique non-empty id');
  const id = value.id;
  ids.add(id);
  if (value.forceFields !== undefined) {
    const fields = validateVfxForceFields(
      value.forceFields,
      `${path}.forceFields`,
      runtimeReferences,
    );
    if (!fields.ok) return invalid(fields.error.detail.path, fields.error.expected, id);
  }
  if (!positiveInteger(value.capacity))
    return invalid(`${path}.capacity`, 'a positive integer', id);
  const execution = emitterExecutionFailure(value, path, id);
  if (execution !== undefined) return execution;
  const renderers = parseEmitterRenderers(value.renderers, index, path, id, runtimeReferences);
  if (!renderers.ok) return renderers;
  const channels = emitterChannelsFailure(value.channels, path, id);
  if (channels !== undefined) return channels;
  const events = emitterEventsFailure(value.events, path, id);
  if (events !== undefined) return events;
  if (
    value.simulationWhenCulled !== undefined &&
    value.simulationWhenCulled !== 'continue' &&
    value.simulationWhenCulled !== 'pause' &&
    value.simulationWhenCulled !== 'restart-on-visible'
  ) {
    return invalid(`${path}.simulationWhenCulled`, 'continue, pause, or restart-on-visible', id);
  }
  return ok({ ...(value as unknown as ParticleEmitterSourceV3), renderers: renderers.value });
}

/** Parse the single Program v3 source shape. Older source versions are rejected. */
export function parseParticleEffectSourceV3(
  value: unknown,
  runtimeReferences = false,
): Result<ParticleEffectSourceV3, ParticleCodeSourceError> {
  if (!record(value)) return fail('$', 'a Program v3 particle effect source object');
  if (value.schemaVersion !== 3) {
    return err({
      code: 'vfx-source-version-unsupported',
      expected: 'ParticleEffectSource schemaVersion 3',
      hint: 'cold-cook the source with the Program v3 compiler; older versions are not executable',
      detail: { path: 'schemaVersion' },
    });
  }
  const rootExtra = unknownField(value, ['schemaVersion', 'emitters']);
  if (rootExtra !== undefined) return fail(rootExtra, 'schemaVersion and emitters only');
  if (!Array.isArray(value.emitters) || value.emitters.length === 0)
    return fail('emitters', 'at least one Program v3 emitter');
  const ids = new Set<string>();
  const emitters: ParticleEmitterSourceV3[] = [];
  for (const [index, emitter] of value.emitters.entries()) {
    const parsed = parseEmitter(emitter, index, ids, runtimeReferences);
    if (!parsed.ok) return parsed;
    emitters.push(parsed.value);
  }
  for (const [index, emitter] of emitters.entries()) {
    const channels = new Set((emitter.channels ?? []).map((channel) => channel.id));
    for (const event of emitter.events ?? []) {
      if (!channels.has(event.channel)) {
        return eventInvalid(
          'vfx-source-event-invalid',
          `emitters[${index}].events.${event.id}.channel`,
          'the id of a channel declared on the same emitter',
          emitter.id,
        );
      }
      if (!ids.has(event.subEmitter)) {
        return eventInvalid(
          'vfx-source-event-invalid',
          `emitters[${index}].events.${event.id}.subEmitter`,
          'the id of an emitter in the same cooked effect',
          emitter.id,
        );
      }
    }
  }
  return ok(
    Object.freeze({
      schemaVersion: 3,
      emitters: Object.freeze(emitters),
    }),
  );
}

export function defineParticleEffectSourceV3<T extends ParticleEffectSourceV3>(source: T): T {
  const parsed = parseParticleEffectSourceV3(source);
  if (!parsed.ok) throw new TypeError(`${parsed.error.code}: ${parsed.error.expected}`);
  return source;
}
