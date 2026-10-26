import {
  type MaterialRenderProjection,
  selectMaterialPassProgram,
} from '@forgeax/engine-assets-runtime';
import type {
  RenderFeatureMaterialShaderBindingContract,
  RenderFeaturePlanContext,
} from '@forgeax/engine-render';
import { meshAttributeChannels } from '@forgeax/engine-render/internal';
import {
  err,
  type MaterialAsset,
  type MaterialParticleInput,
  type MaterialRenderState,
  type MeshAsset,
  ok,
  type Result,
} from '@forgeax/engine-types';
import {
  isParticleTopologyRenderer,
  type ParticleRendererSourceV3,
  type ParticleTopologyRendererSourceV3,
} from '@forgeax/engine-vfx';
import {
  PARTICLE_MESH_DEFAULTS,
  PARTICLE_MESH_GEOMETRY,
} from '../../../render/src/features/particle-mesh-layout';
import { internVfxRenderState } from './shared-graphics-programs.js';

type ParticleRendererKind = ParticleRendererSourceV3['kind'];
type ParticleTopologyKind = ParticleTopologyRendererSourceV3['kind'];

export const PARTICLE_SHADER_IDENTIFIERS = Object.freeze({
  billboard: 'forgeax::vfx-render.particles.billboard',
  mesh: 'forgeax::vfx-render.particles.mesh',
  ribbon: 'forgeax::vfx-render.particles.ribbon',
  trail: 'forgeax::vfx-render.particles.trail',
  beam: 'forgeax::vfx-render.particles.beam',
});

/** Built-in shader variants with one explicit vec4 material-input lane block. */
export const PARTICLE_INPUT_SHADER_IDENTIFIERS = Object.freeze({
  billboard: 'forgeax::vfx-render.particles.billboard-inputs',
  mesh: 'forgeax::vfx-render.particles.mesh-inputs',
  ribbon: 'forgeax::vfx-render.particles.ribbon-inputs',
  trail: 'forgeax::vfx-render.particles.trail-inputs',
  beam: 'forgeax::vfx-render.particles.beam-inputs',
});

export const PARTICLE_UNLIT_MESH_SHADER_IDENTIFIERS = Object.freeze({
  mesh: 'forgeax::vfx-render.particles.mesh-unlit',
  inputs: 'forgeax::vfx-render.particles.mesh-inputs-unlit',
});

export interface TopologyResourcePlan {
  readonly topology: ParticleTopologyKind;
  readonly capacity: number;
  readonly vertexBytes: number;
  readonly indexBytes: number;
  readonly indirectBytes: number;
  readonly resourceKey: string;
  readonly historyLength?: number;
  readonly stripKey?: 'alive-index';
  readonly endpointField?: 'velocity';
}

export interface TopologyResourceError {
  readonly code: 'vfx-topology-resource-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string };
}

export function createTopologyResourcePlan(
  renderer: unknown,
): Result<TopologyResourcePlan, TopologyResourceError> {
  if (renderer === null || typeof renderer !== 'object' || Array.isArray(renderer))
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'a topology renderer object',
      hint: 'declare a ribbon, trail, or beam renderer',
      detail: { path: 'renderer' },
    });
  const value = renderer as ParticleRendererSourceV3;
  if (!isParticleTopologyRenderer(value))
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'ribbon, trail, or beam',
      hint: 'do not alias topology output to billboard or mesh',
      detail: { path: 'renderer.kind' },
    });
  if (
    typeof value.capacity !== 'number' ||
    !Number.isInteger(value.capacity) ||
    value.capacity <= 0 ||
    value.capacity > 65536
  )
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'capacity in the range 1..65536',
      hint: 'bound topology resources before allocating them',
      detail: { path: 'renderer.capacity' },
    });
  const capacity = value.capacity;
  if (value.kind === 'ribbon' && value.stripKey !== 'alive-index')
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: "stripKey 'alive-index'",
      hint: 'use the managed alive-list order until a custom WGSL topology stage owns grouping',
      detail: { path: 'renderer.stripKey' },
    });
  if (
    value.kind === 'trail' &&
    (typeof value.historyLength !== 'number' ||
      !Number.isInteger(value.historyLength) ||
      value.historyLength <= 0 ||
      value.historyLength > 256)
  )
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: 'historyLength in the range 1..256',
      hint: 'bound trail history storage',
      detail: { path: 'renderer.historyLength' },
    });
  if (value.kind === 'beam' && value.endpointField !== 'velocity')
    return err({
      code: 'vfx-topology-resource-invalid',
      expected: "endpointField 'velocity'",
      hint: 'use the managed velocity endpoint until a custom WGSL topology stage owns endpoints',
      detail: { path: 'renderer.endpointField' },
    });
  const vertexStride = 12 * 4;
  const segments =
    value.kind === 'trail' ? capacity * Math.max(1, value.historyLength - 1) : capacity;
  return ok({
    topology: value.kind,
    capacity,
    vertexBytes: Math.max(vertexStride, segments * vertexStride),
    indexBytes: 0,
    indirectBytes: 20,
    resourceKey: `vfx-topology-${value.kind}`,
    ...(value.kind === 'ribbon' ? { stripKey: 'alive-index' as const } : {}),
    ...(value.kind === 'trail' ? { historyLength: value.historyLength } : {}),
    ...(value.kind === 'beam' ? { endpointField: 'velocity' as const } : {}),
  });
}

export interface TopologyCapacityInput {
  readonly requested: number;
  readonly produced: number;
  readonly degenerate?: number;
}

export function topologyCapacitySnapshot(plan: TopologyResourcePlan, input: TopologyCapacityInput) {
  const produced = Math.max(0, Math.min(plan.capacity, input.produced));
  const requested = Math.max(0, input.requested);
  return {
    topology: plan.topology,
    capacity: plan.capacity,
    produced,
    dropped: Math.max(0, requested - produced),
    overflow: Math.max(0, requested - plan.capacity),
    degenerate: Math.max(0, input.degenerate ?? 0),
  } as const;
}

export interface ParticleMaterialPass {
  readonly shader: string;
  readonly sceneDepth?: import('@forgeax/engine-types').MaterialSceneDepth;
  readonly renderState?: MaterialRenderState;
}

type ParticleBlendMode = Extract<ParticleRendererSourceV3, { readonly kind: 'billboard' }>['blend'];

const PARTICLE_PREMULTIPLIED_ALPHA_BLEND: NonNullable<MaterialRenderState['blend']> = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const PARTICLE_ADDITIVE_BLEND: NonNullable<MaterialRenderState['blend']> = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

/**
 * Resolve the one material pass that is meaningful for a particle projection.
 * A regular Forward pass is intentionally ignored: VFX vertex layouts are a
 * different contract, so silently accepting it would compile the wrong input
 * shape and make authored particle shaders appear to work while never running.
 */
export function particleMaterialPass(
  kind: ParticleRendererKind,
  material: MaterialAsset | undefined,
  hasParticleInputs = false,
  publication?: {
    readonly projection: MaterialRenderProjection;
    readonly context: RenderFeaturePlanContext['materialContext'];
  },
  unlitMesh = false,
): ParticleMaterialPass {
  const passName = `particle-${kind}`;
  const cookedPass = publication?.projection.passes.find(
    (candidate) => candidate.name === passName,
  );
  if (cookedPass !== undefined && publication !== undefined) {
    if (publication.context === undefined)
      throw new Error(
        'Published particle material selection requires renderer-owned compiler context',
      );
    const selected = selectMaterialPassProgram(
      publication.projection,
      passName,
      publication.context,
      'direct',
      // Particle layouts provide color, including default white mesh colors.
      true,
    );
    return {
      shader: selected.specializationKey,
      ...(selected.abi?.sceneDepth === undefined ? {} : { sceneDepth: selected.abi.sceneDepth }),
      ...(cookedPass.renderState === undefined
        ? {}
        : { renderState: cookedPass.renderState as MaterialRenderState }),
    };
  }
  const pass = material?.passes?.find((candidate) => candidate.name === passName);
  const renderState =
    pass?.renderState ??
    (kind === 'mesh'
      ? material?.passes?.find((candidate) => {
          const tags = candidate.renderState?.tags;
          return (
            candidate.name === 'forward' ||
            (typeof tags === 'object' &&
              tags !== null &&
              'LightMode' in tags &&
              tags.LightMode === 'Forward')
          );
        })?.renderState
      : undefined);
  return {
    shader:
      pass?.program.module ??
      (kind === 'mesh' && unlitMesh
        ? hasParticleInputs
          ? PARTICLE_UNLIT_MESH_SHADER_IDENTIFIERS.inputs
          : PARTICLE_UNLIT_MESH_SHADER_IDENTIFIERS.mesh
        : hasParticleInputs
          ? PARTICLE_INPUT_SHADER_IDENTIFIERS[kind]
          : PARTICLE_SHADER_IDENTIFIERS[kind]),
    ...(pass?.program.sceneDepth === undefined ? {} : { sceneDepth: pass.program.sceneDepth }),
    ...(renderState === undefined ? {} : { renderState: renderState as MaterialRenderState }),
  };
}

export interface PreparedParticleMaterialInputs {
  /** The exact declarations requested by this renderer, in authored order. */
  readonly definitions: readonly MaterialParticleInput[];
  /** Number of vec4 lanes reserved in the per-particle instance stream. */
  readonly lanes: number;
  /** Byte width of the per-particle input projection. */
  readonly stride: number;
}

export interface ParticleMaterialInputPreparationError {
  readonly code:
    | 'vfx-material-input-missing'
    | 'vfx-material-input-wrong-type'
    | 'vfx-material-input-stale'
    | 'vfx-material-input-duplicate';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly material?: ParticleRendererSourceV3['material'];
    readonly name?: string;
    readonly lane?: number;
    readonly path?: string;
  };
}

const EMPTY_PARTICLE_MATERIAL_INPUTS: PreparedParticleMaterialInputs = Object.freeze({
  definitions: Object.freeze([]),
  lanes: 0,
  stride: 0,
});

function particleInputFailure(
  code: ParticleMaterialInputPreparationError['code'],
  expected: string,
  hint: string,
  detail: ParticleMaterialInputPreparationError['detail'],
): Result<never, ParticleMaterialInputPreparationError> {
  return err({ code, expected, hint, detail });
}

function isParticleInputType(value: unknown): value is MaterialParticleInput['type'] {
  return value === 'f32' || value === 'vec2<f32>' || value === 'vec3<f32>' || value === 'vec4<f32>';
}

function isParticleInputVisibility(value: unknown): value is MaterialParticleInput['visibility'] {
  return value === 'vertex' || value === 'fragment' || value === 'vertex-fragment';
}

function validParticleInput(value: unknown): value is MaterialParticleInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    typeof input.name === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name) &&
    isParticleInputType(input.type) &&
    isParticleInputVisibility(input.visibility) &&
    typeof input.lane === 'number' &&
    Number.isInteger(input.lane) &&
    input.lane >= 0 &&
    input.lane < 4
  );
}

function sameParticleInput(left: MaterialParticleInput, right: MaterialParticleInput): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.visibility === right.visibility &&
    left.lane === right.lane
  );
}

/**
 * Validate and prepare the material-side particle-input bridge.
 *
 * The returned stride is added to the renderer-owned GPU instance stream; no
 * CPU mirror or per-frame upload is created. Reflection is required when the
 * renderer came from a cooked effect so an old material/program pair cannot
 * silently bind a different input layout.
 */
export function prepareParticleMaterialInputs(
  renderer: ParticleRendererSourceV3,
  material: MaterialAsset | undefined,
  reflected?: readonly MaterialParticleInput[],
): Result<PreparedParticleMaterialInputs, ParticleMaterialInputPreparationError> {
  const requested = renderer.materialInputs ?? [];
  if (requested.length === 0) return ok(EMPTY_PARTICLE_MATERIAL_INPUTS);
  if (new Set(requested).size !== requested.length) {
    return particleInputFailure(
      'vfx-material-input-duplicate',
      'unique particle input names per renderer',
      'remove the duplicate renderer material input and recook the effect',
      { material: renderer.material, path: 'renderer.materialInputs' },
    );
  }
  const definitions = material?.particleInputs;
  if (definitions === undefined) {
    return particleInputFailure(
      'vfx-material-input-missing',
      `material ${renderer.material} to declare particleInputs`,
      'add the requested typed input to MaterialAsset and recook the material before the VFX effect',
      { material: renderer.material, path: 'material.particleInputs' },
    );
  }
  const names = new Set<string>();
  const lanes = new Set<number>();
  for (const [index, candidate] of definitions.entries()) {
    if (!validParticleInput(candidate)) {
      return particleInputFailure(
        'vfx-material-input-wrong-type',
        'particleInputs entries with a supported type, visibility, and lane',
        'repair the material particleInputs declaration and recook it',
        { material: renderer.material, path: `material.particleInputs[${index}]` },
      );
    }
    if (names.has(candidate.name) || lanes.has(candidate.lane)) {
      return particleInputFailure(
        'vfx-material-input-duplicate',
        'unique particle input names and lanes',
        'assign one lane to one input name and recook the material',
        { material: renderer.material, name: candidate.name, lane: candidate.lane },
      );
    }
    names.add(candidate.name);
    lanes.add(candidate.lane);
  }
  const selectedDefinitions: MaterialParticleInput[] = [];
  for (const name of requested) {
    const input = definitions.find((candidate) => candidate.name === name);
    if (input === undefined) {
      return particleInputFailure(
        'vfx-material-input-missing',
        `material ${renderer.material} to declare particle input ${name}`,
        'add the requested input to MaterialAsset.particleInputs and recook both assets',
        { material: renderer.material, name, path: 'renderer.materialInputs' },
      );
    }
    selectedDefinitions.push(input);
  }
  if (reflected === undefined) {
    return particleInputFailure(
      'vfx-material-input-stale',
      'cooked renderer reflection to carry the material input declarations',
      'recook the VFX effect with the current material artifact catalog',
      { material: renderer.material, path: 'effect.reflection.renderers.materialInputDefinitions' },
    );
  }
  for (const input of selectedDefinitions) {
    const cooked = reflected.find((candidate) => candidate.name === input.name);
    if (cooked === undefined || !sameParticleInput(input, cooked)) {
      return particleInputFailure(
        'vfx-material-input-stale',
        `the cooked declaration for material input ${input.name} to match MaterialAsset`,
        'recook the VFX effect and material together so names, types, visibility, and lanes agree',
        { material: renderer.material, name: input.name, lane: input.lane },
      );
    }
  }
  const lanesUsed = selectedDefinitions.map((input) => input.lane);
  const lanesCount = Math.max(...lanesUsed, -1) + 1;
  return ok({
    definitions: Object.freeze([...selectedDefinitions]),
    lanes: lanesCount,
    stride: lanesCount * 16,
  });
}

/**
 * Resolve the default pipeline state for a particle renderer.
 *
 * The built-in particle shaders emit premultiplied RGB (`rgb * alpha`). The
 * renderer's explicit blend mode therefore has to become a matching fixed
 * function state; leaving the state undefined makes transparent billboard
 * corners overwrite the scene with their zero RGB (the visible black-box
 * failure). An authored particle pass remains authoritative and bypasses
 * these defaults. It is interned by exact content: a Worker-cloned state is a
 * new object every frame, but one content keeps one program descriptor.
 */
export function particleRendererRenderState(
  kind: ParticleRendererKind,
  blend: ParticleBlendMode,
  authored: MaterialRenderState | undefined,
): MaterialRenderState | undefined {
  if (authored !== undefined) return internVfxRenderState(authored);
  if (kind === 'mesh') return undefined;
  const mode = kind === 'billboard' ? (blend ?? 'alpha') : 'alpha';
  if (mode === 'opaque-cutout') return PARTICLE_CUTOUT_STATE;
  return mode === 'additive' ? PARTICLE_ADDITIVE_STATE : PARTICLE_ALPHA_STATE;
}

function deepFreeze<T extends object>(value: T): T {
  for (const property of Object.values(value))
    if (property !== null && typeof property === 'object') deepFreeze(property);
  return Object.freeze(value);
}

// Stock defaults are immutable shared values, so a graphics program descriptor
// that references them can be reused and keyed once across frames.
const PARTICLE_CUTOUT_STATE: MaterialRenderState = deepFreeze({
  cullMode: 'none',
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
});
const PARTICLE_ALPHA_STATE: MaterialRenderState = deepFreeze({
  cullMode: 'none',
  depthCompare: 'less-equal',
  depthWriteEnabled: false,
  blend: structuredClone(PARTICLE_PREMULTIPLIED_ALPHA_BLEND),
});
const PARTICLE_ADDITIVE_STATE: MaterialRenderState = deepFreeze({
  cullMode: 'none',
  depthCompare: 'less-equal',
  depthWriteEnabled: false,
  blend: structuredClone(PARTICLE_ADDITIVE_BLEND),
});

/** The selected shader contract owns group-1 demand, not unrelated authored material parameters. */
export function particleMaterialUsesBindings(
  contract: RenderFeatureMaterialShaderBindingContract | undefined,
): boolean {
  return (
    contract === 'render-material' ||
    contract === 'render-material-with-scene-depth' ||
    contract === 'render-material-and-scene-depth'
  );
}

/**
 * Return the scene-depth binding slot required by a particle material shader.
 *
 * Custom particle shaders may bind only the sampled depth resource at
 * group(0)/binding(0), while the built-in billboard shader consumes the View
 * (its translucent fog copy) at binding(0) and depth at binding(1). Keep this
 * choice derived from the shader contract instead of assuming every billboard
 * has the built-in layout.
 */
export function particleMaterialSceneDepthBinding(
  contract: RenderFeatureMaterialShaderBindingContract | undefined,
): 0 | 1 | undefined {
  if (contract === 'group-0-resource' || contract === 'render-material-with-scene-depth') return 0;
  if (contract === 'view-and-scene-depth' || contract === 'render-material-and-scene-depth')
    return 1;
  return undefined;
}

function floatAttribute(value: ArrayBuffer | Float32Array | Uint16Array | undefined): Float32Array {
  if (value instanceof Float32Array) return value;
  if (value instanceof Uint16Array) return Float32Array.from(value);
  return value === undefined ? new Float32Array() : new Float32Array(value);
}

export function particleMeshVertices(mesh: MeshAsset): Float32Array {
  // Packed-rows Render copies rebuild their channels exactly from the rows.
  const channels = meshAttributeChannels(mesh);
  const positions = floatAttribute(channels.position);
  if (positions.length % 3 !== 0) return new Float32Array();
  const vertexCount = positions.length / 3;
  const stride = PARTICLE_MESH_GEOMETRY.arrayStride / Float32Array.BYTES_PER_ELEMENT;
  const result = new Float32Array(vertexCount * stride);
  for (const attribute of PARTICLE_MESH_GEOMETRY.attributes) {
    const key = attribute.key as keyof typeof PARTICLE_MESH_DEFAULTS;
    const source = floatAttribute(channels[key]);
    const width = attribute.byteLength / Float32Array.BYTES_PER_ELEMENT;
    if (source.length !== 0 && source.length !== vertexCount * width) return new Float32Array();
    // Direct element copies: no per-vertex views on the per-frame emitter path.
    const defaults = PARTICLE_MESH_DEFAULTS[key];
    const base = attribute.offset / Float32Array.BYTES_PER_ELEMENT;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const output = vertex * stride + base;
      if (source.length >= (vertex + 1) * width) {
        const input = vertex * width;
        for (let lane = 0; lane < width; lane++)
          result[output + lane] = source[input + lane] as number;
      } else
        for (let lane = 0; lane < defaults.length; lane++)
          result[output + lane] = defaults[lane] as number;
    }
  }
  return result;
}

export function particleMeshIndices(mesh: MeshAsset): Uint16Array | Uint32Array | undefined {
  const indices = mesh.indices;
  if (indices === undefined || indices.byteLength % 4 === 0) return indices;
  const aligned = new Uint16Array(indices.length + 1);
  aligned.set(indices);
  return aligned;
}

// Runtime asset publications are ordinary-object frozen snapshots. Keep the
// derived particle vertex stream by that publication identity so a
// VFX feature with several emitters does not rebuild the same mesh projection
// on every frame. Mutable hand-authored meshes deliberately bypass this cache;
// their attribute values remain observable on the next call instead of being
// hidden behind an object-identity assumption.
const particleMeshVertexCache = new WeakMap<MeshAsset, Float32Array>();

export function particleMeshVerticesCached(mesh: MeshAsset): Float32Array {
  if (!Object.isFrozen(mesh)) return particleMeshVertices(mesh);
  const cached = particleMeshVertexCache.get(mesh);
  if (cached !== undefined) return cached;
  const derived = particleMeshVertices(mesh);
  particleMeshVertexCache.set(mesh, derived);
  return derived;
}
