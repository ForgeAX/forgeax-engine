import type { MaterialAsset } from '@forgeax/engine-types';
import {
  isParticleTopologyRenderer,
  type ParticleRendererSourceV3,
  type VfxGpuTickIntent,
} from '@forgeax/engine-vfx';
import type { ParticleRenderCamera } from './camera.js';
import { eventInputCapacity } from './event-resources.js';

/** Byte size of the per-dispatch runtime uniform shared by simulation and projection. */
export const RUNTIME_BYTES = 76 * 4;

type ParticleRenderer = ParticleRendererSourceV3;
type RuntimeIntent = Pick<
  VfxGpuTickIntent,
  'delta' | 'phaseTick' | 'seed' | 'playCycle' | 'emitter' | 'spawnCount' | 'firstParticleId'
>;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function rendererSortingMode(renderer: ParticleRenderer | undefined): 0 | 1 | 2 | 3 | 4 | 5 {
  if (renderer === undefined || isParticleTopologyRenderer(renderer)) return 0;
  switch (renderer.sorting ?? 'none') {
    case 'view-depth':
      return 2;
    case 'view-distance':
      return 5;
    case 'custom-ascending':
      return 3;
    case 'custom-descending':
      return 4;
    case 'none':
      return 0;
  }
}

function writeVector(
  target: Float32Array,
  offset: number,
  value: unknown,
  fallback: number,
  size: number,
): void {
  const source = Array.isArray(value) ? value : undefined;
  for (let index = 0; index < size; index++)
    target[offset + index] = finite(source?.[index], fallback);
}

export function createRuntimeStorage() {
  const storage = new ArrayBuffer(RUNTIME_BYTES);
  return {
    floats: new Float32Array(storage),
    words: new Uint32Array(storage),
    bytes: new Uint8Array(storage),
  };
}

export function runtimeData(
  target: ReturnType<typeof createRuntimeStorage> | undefined,
  intent: RuntimeIntent,
  camera: ParticleRenderCamera,
  material: MaterialAsset | undefined,
  localToWorld: Float32Array,
  renderer?: ParticleRenderer,
  rendererIndex = 0,
  particleInputLanes = renderer?.materialInputs?.length ?? 0,
  meshDraw?: { readonly count: number; readonly firstIndex: number },
  /** Projection runtime: the latest intent with no simulation delta or spawn. */
  projection = false,
): Uint8Array {
  const data = target ?? createRuntimeStorage();
  const { floats, words } = data;
  if (target !== undefined) data.bytes.fill(0);
  floats[0] = projection ? 0 : intent.delta;
  words[1] = intent.phaseTick;
  words[2] = intent.seed;
  words[3] = intent.playCycle;
  words[4] = intent.emitter.capacity;
  words[5] = projection ? 0 : intent.spawnCount;
  words[6] = intent.firstParticleId;
  words[7] = intent.emitter.renderers.length;
  floats.set(camera.viewProjection, 8);
  floats.set(camera.right, 24);
  floats.set(camera.up, 28);
  floats.set(camera.position, 72);
  const values = material?.values ?? {};
  writeVector(floats, 32, values.baseColor, 1, 4);
  writeVector(floats, 36, values.emissive, 0, 3);
  floats[39] = finite(values.emissiveIntensity, 0);
  floats[40] = finite(values.metallic, 0);
  floats[41] = finite(values.roughness, 0.5);
  floats[42] = finite(values.clearcoat, 0);
  floats[43] = finite(values.clearcoatRoughness, 0.5);
  floats.set(localToWorld, 44);
  words[60] = rendererIndex;
  words[61] = rendererElementCount(intent, renderer, meshDraw);
  words[62] =
    renderer !== undefined && isParticleTopologyRenderer(renderer)
      ? renderer.capacity
      : intent.emitter.capacity;
  words[63] = meshDraw?.firstIndex ?? 0;
  words[75] = rendererSortingMode(renderer);
  writeRendererShape(floats, renderer);
  // The projection shader derives its instance stride from this reflected
  // material-input lane count; undeclared inputs therefore allocate nothing.
  floats[67] = particleInputLanes;
  return data.bytes;
}

/** Simulation reads its event input capacity; projection reads trail history or mesh draw count. */
function rendererElementCount(
  intent: RuntimeIntent,
  renderer: ParticleRenderer | undefined,
  meshDraw: { readonly count: number } | undefined,
): number {
  if (
    renderer === undefined &&
    ((intent.emitter.reflection.resources ?? []).includes('eventBuffer') ||
      (intent.emitter.reflection.entryPoints ?? []).includes('forgeax_vfx_event_main'))
  )
    return eventInputCapacity(intent.emitter);
  return renderer?.kind === 'trail' ? renderer.historyLength : (meshDraw?.count ?? 0);
}

/** Billboard pivot, soft-particle fade and texture sheet, or topology width. */
function writeRendererShape(floats: Float32Array, renderer: ParticleRenderer | undefined): void {
  floats[64] =
    renderer?.kind === 'billboard'
      ? (renderer.pivot?.[0] ?? 0)
      : renderer !== undefined && isParticleTopologyRenderer(renderer)
        ? (renderer.width ?? 0.1)
        : 0.1;
  floats[65] = renderer?.kind === 'billboard' ? (renderer.pivot?.[1] ?? 0) : 0;
  floats[66] = renderer?.kind === 'billboard' ? (renderer.softParticle?.fadeDistance ?? 0) : 0;
  const sheet = renderer?.kind === 'billboard' ? renderer.textureSheet : undefined;
  floats[68] = sheet?.columns ?? 1;
  floats[69] = sheet?.rows ?? 1;
  floats[70] = sheet?.frameRate ?? 0;
  floats[71] = sheet?.frameCount ?? (sheet === undefined ? 1 : sheet.columns * sheet.rows);
}
