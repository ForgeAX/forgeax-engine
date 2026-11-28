import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { SpotLightProjectorFrameContext, VolumetricFogFrameContext } from '../render-contract';
import type { ExtractedVolumetricFog } from '../render-system-extract';
import { volumetricFogSamplingLane } from '../volume/component';
import { VOLUMETRIC_FOG_MEMBER_WORDS, VOLUMETRIC_FOG_PARAMS_BYTES } from '../volume/resources';
import type { ViewLights } from '../world/render-lights';
import { recordContext } from '../world/view-record-context';
import { clusterLocalLights } from './cluster-local-lights';
import type {
  RenderFrameState,
  VolumetricFogParamsSlot,
  VolumetricFogParamsState,
} from './frame-snapshot';
import type { RenderSystemInternals } from './render-context';

export function emptyVolumetricFogParams(): VolumetricFogParamsState {
  return { slots: [null, null], pending: null, accepted: null };
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

function writableVolumeParams(
  internals: RenderSystemInternals,
  state: VolumetricFogParamsState,
): VolumetricFogParamsSlot | undefined {
  const slot = nextVolumetricFogParamsSlot(state);
  const existing = state.slots[slot];
  if (existing !== null) return existing;
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
  const next = {
    slot,
    buffer: created.value,
    params: new Float32Array(VOLUMETRIC_FOG_PARAMS_BYTES / 4),
  };
  state.slots[slot] = next;
  return next;
}

function uploadVolumeParams(
  internals: RenderSystemInternals,
  state: VolumetricFogParamsState,
  slot: VolumetricFogParamsSlot,
): Buffer | undefined {
  const written = internals.device.queue.writeBuffer(slot.buffer, 0, slot.params);
  if (!written.ok) {
    internals.errorRegistry.fire(written.error);
    return undefined;
  }
  state.pending = slot;
  return slot.buffer;
}

export function stageVolumetricFogParams(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  params: Float32Array,
): Buffer | undefined {
  const state = frameState.volumetricFogParams;
  const slot = writableVolumeParams(internals, state);
  if (slot === undefined) return undefined;
  slot.params.set(params);
  return uploadVolumeParams(internals, state, slot);
}

const DEFAULT_VOLUME_LIGHT_DIRECTION = [0, -1, 0] as const;
const DEFAULT_VOLUME_LIGHT_COLOR = [0, 0, 0] as const;

/**
 * Resolve the authored density POD into the renderer-owned GPU resources used
 * by the graph.  This is deliberately a pull operation: a missing/stale
 * handle or failed upload produces a structured error and leaves the graph
 * candidate disabled for this frame rather than binding a synthetic density.
 * Only an authored `uniform` medium binds the renderer's unit volume: its
 * density is constant by declaration, not substituted for a missing source.
 */
function prepareVolumetricFogMember(
  internals: RenderSystemInternals,
  world: RenderResourceScope,
  sourceScope: RenderResourceScope,
  fog: ExtractedVolumetricFog,
  lights: ViewLights,
  cluster: ReturnType<typeof clusterLocalLights>['kept'],
  params: Float32Array,
  offset: number,
): ReturnType<typeof residentVolumeDensity> {
  if (
    fog.status !== 'available' ||
    fog.fog === undefined ||
    (fog.fog.sampling !== 'uniform' &&
      (fog.densityHandle === undefined || fog.densityAsset === undefined)) ||
    (fog.lightKind === 'spot'
      ? lights.spot.find((light) => light.entity === fog.lightEntity) === undefined
      : fog.lightKind === 'point'
        ? lights.point.find((light) => light.entity === fog.lightEntity) === undefined
        : lights.directional === undefined)
  ) {
    return undefined;
  }
  const density = residentVolumeDensity(internals, sourceScope ?? world, fog);
  if (density === undefined) return undefined;
  params.set(fog.fog.bounds.min, offset);
  params.set(fog.fog.bounds.max, offset + 4);
  params[offset + 7] = volumetricFogSamplingLane(fog.fog.sampling);
  params.set(fog.fog.extinction, offset + 8);
  params.set(fog.fog.albedo, offset + 12);
  params.set(fog.fog.emission, offset + 16);
  writeVolumeLightParams(params, offset, fog, lights, cluster);
  params[offset + 28] = fog.fog.maxDistance;
  params[offset + 29] = fog.fog.anisotropy;
  params[offset + 32] = fog.worldTimeSeconds ?? 0;
  return density;
}

function writeVolumeLightParams(
  params: Float32Array,
  offset: number,
  fog: ExtractedVolumetricFog,
  lights: ViewLights,
  cluster: ReturnType<typeof clusterLocalLights>['kept'],
): void {
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
    selectedSpot?.direction ?? lights.directional?.direction ?? DEFAULT_VOLUME_LIGHT_DIRECTION;
  const lightColor = selectedSpot?.color ?? lights.directional?.color ?? DEFAULT_VOLUME_LIGHT_COLOR;
  params.set(lightDirection, offset + 20);
  // Reserved padding: render frame identity must not move volume samples.
  params[offset + 23] = 0;
  // Slots address the Cluster's admitted lights; a light dropped over the
  // limit has no slot and the volume treats it as unselected.
  const selectedPointIndex =
    selectedPoint === undefined
      ? -1
      : cluster.point.findIndex((light) => light.entity === selectedPoint.entity);
  const selectedSpotIndex =
    selectedSpot === undefined
      ? -1
      : cluster.spot.findIndex((light) => light.entity === selectedSpot.entity);
  // Cluster light_data is one point/spot/rect array. Point slots are emitted
  // first, so volume stores the global slot rather than a per-kind array index.
  const selectedSpotClusterIndex =
    selectedSpotIndex < 0 ? -1 : cluster.point.length + selectedSpotIndex;
  params.set(lightColor, offset + 24);
  params[offset + 19] = selectedPointIndex;
  params[offset + 27] = selectedSpotClusterIndex;
  params[offset + 30] =
    selectedPoint !== undefined && selectedSpot !== undefined
      ? 3
      : selectedPoint !== undefined
        ? 1
        : selectedSpot !== undefined
          ? 2
          : 0;
}

/** The bound density volume: the authored TextureAsset, or the unit volume for `uniform`. */
function residentVolumeDensity(
  internals: RenderSystemInternals,
  ownerWorld: RenderResourceScope,
  fog: ExtractedVolumetricFog,
):
  | Pick<VolumetricFogFrameContext, 'densityTexture' | 'densityView' | 'densityGeneration'>
  | undefined {
  if (fog.fog?.sampling === 'uniform') {
    const state = recordContext(internals).getPipelineState();
    if (state?.defaultWhite3dTexture === undefined || state.defaultWhite3dTextureView === undefined)
      return undefined;
    return {
      densityTexture: state.defaultWhite3dTexture,
      densityView: state.defaultWhite3dTextureView,
      densityGeneration: 0,
    };
  }
  if (fog.densityHandle === undefined || fog.densityAsset === undefined) return undefined;
  const resident = internals.gpuStore.ensureResident(
    fog.densityHandle,
    fog.densityAsset,
    ownerWorld,
  );
  if (!resident.ok || !('texture' in resident.value)) {
    if (!resident.ok && resident.error.code !== 'asset-not-ready') {
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
  return {
    densityTexture: resident.value.texture.handle,
    densityView: resident.value.view,
    densityGeneration: resident.value.receipt.generation,
  };
}

function extendVolumeBounds(params: Float32Array, offset: number): void {
  for (let axis = 0; axis < 3; axis++) {
    params[axis] = Math.min(params[axis] ?? 0, params[offset + axis] ?? 0);
    params[axis + 4] = Math.max(params[axis + 4] ?? 0, params[offset + axis + 4] ?? 0);
  }
  params[28] = Math.max(params[28] ?? 0, params[offset + 28] ?? 0);
}

export function prepareVolumetricFogFrame(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  world: RenderResourceScope,
  sourceScope: RenderResourceScope,
  fog: ExtractedVolumetricFog | undefined,
  lights: ViewLights,
  volumeCapability: boolean,
  projector: SpotLightProjectorFrameContext | undefined,
): VolumetricFogFrameContext | undefined {
  if (!volumeCapability || fog?.status !== 'available') return undefined;
  const state = frameState.volumetricFogParams;
  const slot = writableVolumeParams(internals, state);
  if (slot === undefined) return undefined;
  const cluster = clusterLocalLights(internals, lights).kept;
  const { params } = slot;
  params.fill(0);
  const first = prepareVolumetricFogMember(
    internals,
    world,
    sourceScope,
    fog,
    lights,
    cluster,
    params,
    VOLUMETRIC_FOG_MEMBER_WORDS,
  );
  if (first === undefined) return undefined;
  params.copyWithin(0, VOLUMETRIC_FOG_MEMBER_WORDS, 2 * VOLUMETRIC_FOG_MEMBER_WORDS);
  const additional = fog.additional;
  let members: NonNullable<ReturnType<typeof residentVolumeDensity>>[] | undefined;
  const count = 1 + (additional?.length ?? 0);
  params[3] = count;
  if (additional !== undefined) {
    for (let i = 0; i < additional.length; i++) {
      const source = additional[i];
      if (source === undefined) return undefined;
      const offset = (i + 2) * VOLUMETRIC_FOG_MEMBER_WORDS;
      const member = prepareVolumetricFogMember(
        internals,
        world,
        sourceScope,
        source,
        lights,
        cluster,
        params,
        offset,
      );
      if (member === undefined) return undefined;
      members ??= [];
      members.push(member);
      extendVolumeBounds(params, offset);
    }
  }
  const paramsBuffer = uploadVolumeParams(internals, state, slot);
  if (paramsBuffer === undefined) return undefined;
  return {
    ...first,
    paramsBuffer,
    historyReadSlot: null,
    historyWriteSlot: 0,
    historyValid: false,
    ...(members === undefined ? {} : { additional: members }),
    ...(projector === undefined
      ? {}
      : {
          projectorTexture: projector.texture,
          projectorView: projector.view,
          projectorSampler: projector.sampler,
        }),
  };
}
