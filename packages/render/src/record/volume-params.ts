import { vec3 } from '@forgeax/engine-math';
import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { SpotLightProjectorFrameContext, VolumetricFogFrameContext } from '../render-contract';
import type { ExtractedLights, ExtractedVolumetricFog } from '../render-system-extract';
import { VOLUMETRIC_FOG_PARAMS_BYTES } from '../volume/resources';
import type { RenderFrameState, VolumetricFogParamsState } from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

export function emptyVolumetricFogParams(): VolumetricFogParamsState {
  return { buffers: [null, null], pending: null, accepted: null };
}

/** Accept the pending slot; called only after its queue submission succeeded. */
export function promoteVolumetricFogParams(state: VolumetricFogParamsState): void {
  if (state.pending === null) return;
  state.accepted = state.pending;
  state.pending = null;
}

function nextVolumetricFogParamsSlot(state: VolumetricFogParamsState): 0 | 1 {
  const { accepted, pending } = state;
  if (pending !== null && pending.slot !== accepted?.slot) return pending.slot;
  return accepted?.slot === 0 ? 1 : 0;
}

export function stageVolumetricFogParams(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  params: Float32Array,
): Buffer | undefined {
  const state = frameState.volumetricFogParams;
  const slot = nextVolumetricFogParamsSlot(state);
  let buffer = state.buffers[slot];
  if (buffer === null) {
    const created = internals.device.createBuffer({
      label: `volumetric-fog-params-${slot}`,
      size: VOLUMETRIC_FOG_PARAMS_BYTES,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!created.ok) {
      internals.errorRegistry.fire(created.error);
      return undefined;
    }
    buffer = created.value;
    state.buffers[slot] = buffer;
  }
  const written = internals.device.queue.writeBuffer(buffer, 0, params);
  if (!written.ok) {
    internals.errorRegistry.fire(written.error);
    return undefined;
  }
  state.pending = { slot, params: new Float32Array(params) };
  return buffer;
}

/**
 * Resolve the authored density POD into the renderer-owned GPU resources used
 * by the graph.  This is deliberately a pull operation: a missing/stale
 * handle or failed upload produces a structured error and leaves the graph
 * candidate disabled for this frame rather than binding a synthetic density.
 */
function prepareVolumetricFogMember(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  fog: ExtractedVolumetricFog | undefined,
  lights: ExtractedLights,
  volumeCapability: boolean,
  projector: SpotLightProjectorFrameContext | undefined,
):
  | (Omit<VolumetricFogFrameContext, 'paramsBuffer'> & { readonly params: Float32Array })
  | undefined {
  if (
    !volumeCapability ||
    fog?.status !== 'available' ||
    fog.fog === undefined ||
    fog.densityHandle === undefined ||
    fog.densityAsset === undefined ||
    (fog.lightKind === 'spot'
      ? lights.spot.find((light) => light.entity === fog.lightEntity) === undefined
      : fog.lightKind === 'point'
        ? lights.point.find((light) => light.entity === fog.lightEntity) === undefined
        : lights.directional === undefined)
  ) {
    return undefined;
  }
  const ownerWorld = worlds[fog.worldId ?? 0] ?? world;
  const resident = internals.gpuStore.ensureResident(
    fog.densityHandle,
    fog.densityAsset,
    ownerWorld,
  );
  if (!resident.ok || !('texture' in resident.value)) {
    if (!resident.ok) {
      internals.errorRegistry.fire(
        resident.error instanceof RhiError
          ? resident.error
          : new RhiError({
              code: 'webgpu-runtime-error',
              expected: 'volumetric density residency to resolve a GPU texture',
              hint: 'repair the authored TextureAsset payload and retry the next frame',
              detail: { error: resident.error },
            }),
      );
    }
    return undefined;
  }
  const params = new Float32Array(36);
  params.set(fog.fog.bounds.min, 0);
  params.set(fog.fog.bounds.max, 4);
  params[7] = fog.fog.sampling === 'density-albedo' ? 2 : fog.fog.sampling === 'density' ? 1 : 0;
  params.set(fog.fog.extinction, 8);
  params.set(fog.fog.albedo, 12);
  params.set(fog.fog.emission, 16);
  const selectedPoint =
    fog.pointLightEntity === undefined
      ? undefined
      : lights.point.find((light) => light.entity === fog.pointLightEntity);
  const selectedSpot =
    fog.spotLightEntity === undefined
      ? fog.lightKind === 'spot'
        ? lights.spot.find((light) => light.entity === fog.lightEntity)
        : undefined
      : lights.spot.find((light) => light.entity === fog.spotLightEntity);
  const lightDirection =
    selectedSpot?.direction ?? lights.directional?.direction ?? vec3.create(0, -1, 0);
  const lightColor = selectedSpot?.color ?? lights.directional?.color ?? vec3.create(0, 0, 0);
  if (lightDirection === undefined || lightColor === undefined) return undefined;
  params.set(lightDirection, 20);
  // Reserved padding: render frame identity must not move volume samples.
  params[23] = 0;
  const selectedPointIndex =
    selectedPoint === undefined
      ? -1
      : lights.point.findIndex((light) => light.entity === selectedPoint.entity);
  const selectedSpotIndex =
    selectedSpot === undefined
      ? -1
      : lights.spot.findIndex((light) => light.entity === selectedSpot.entity);
  // Cluster light_data is one point/spot/rect array. Point slots are emitted
  // first, so volume stores the global slot rather than a per-kind array index.
  const selectedSpotClusterIndex =
    selectedSpotIndex < 0 ? -1 : lights.point.length + selectedSpotIndex;
  params.set(lightColor, 24);
  params[19] = selectedPointIndex;
  params[27] = selectedSpotClusterIndex;
  params[28] = fog.fog.maxDistance;
  params[29] = fog.fog.anisotropy;
  params[30] =
    selectedPoint !== undefined && selectedSpot !== undefined
      ? 3
      : selectedPoint !== undefined
        ? 1
        : selectedSpot !== undefined
          ? 2
          : 0;
  // The temporal shader reads this lane after the record stage resolves the
  // accepted graph/slot. It is overwritten on the next queue-visible frame;
  // the first candidate deliberately starts with history disabled.
  params[31] =
    frameState.temporalFrame !== undefined && frameState.temporalFrame.resetReason === 'none'
      ? 1
      : 0;
  // RenderResourceScope elapsed time is the sole authored-medium clock.
  params[32] = fog.worldTimeSeconds ?? 0;
  return {
    densityTexture: resident.value.texture.handle,
    densityView: resident.value.view,
    params,
    densityGeneration: resident.value.receipt.generation,
    historyReadSlot: null,
    historyWriteSlot: 0,
    historyValid: false,
    ...(projector === undefined
      ? {}
      : {
          projectorTexture: projector.texture,
          projectorView: projector.view,
          projectorSampler: projector.sampler,
        }),
  };
}

export function prepareVolumetricFogFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  worlds: readonly RenderResourceScope[],
  fog: ExtractedVolumetricFog | undefined,
  lights: ExtractedLights,
  volumeCapability: boolean,
  projector: SpotLightProjectorFrameContext | undefined,
): VolumetricFogFrameContext | undefined {
  if (fog === undefined) return undefined;
  const sources = [fog, ...(fog.additional ?? [])];
  const members = [];
  for (const source of sources) {
    const member = prepareVolumetricFogMember(
      internals,
      frameState,
      world,
      worlds,
      { ...source, worldId: fog.worldId ?? 0 },
      lights,
      volumeCapability,
      projector,
    );
    if (member === undefined) return undefined;
    members.push(member);
  }
  const first = members[0];
  if (first === undefined) return undefined;
  const params = new Float32Array(VOLUMETRIC_FOG_PARAMS_BYTES / 4);
  params.set(first.params);
  params[3] = members.length;
  for (const [index, member] of members.entries()) {
    params.set(member.params, (index + 1) * first.params.length);
    for (let axis = 0; axis < 3; axis++) {
      params[axis] = Math.min(params[axis] ?? 0, member.params[axis] ?? 0);
      params[axis + 4] = Math.max(params[axis + 4] ?? 0, member.params[axis + 4] ?? 0);
    }
    params[28] = Math.max(params[28] ?? 0, member.params[28] ?? 0);
  }
  const paramsBuffer = stageVolumetricFogParams(internals, frameState, params);
  if (paramsBuffer === undefined) return undefined;
  const { params: ignored, ...context } = first;
  void ignored;
  return { ...context, paramsBuffer, additional: members.slice(1) };
}
