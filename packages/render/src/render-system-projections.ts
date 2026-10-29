import type { World } from '@forgeax/engine-ecs';
import type { RenderReadLease } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { LodOcclusionInspectionRow, LodOcclusionWorldInspection } from './inspection-types';
import type { RenderResourceScope } from './publication/resource-scope';
import { lodLevelHistogram } from './record/cpu-lod';
import { worldEntityKey } from './record/frame-snapshot';
import { computeViewProjectionMatrix } from './record/helpers';
import type { CameraSnapshot, DrawOwnerOptions } from './render-contract';
import type { RenderableSnapshot } from './render-system-extract';
import type { FrameList } from './scene/frame-list';

export function canonicalizeWorldComposition(
  worlds: readonly World[],
  owners: Pick<DrawOwnerOptions, 'cameraOwner' | 'resourceOwner' | 'cameraEntityKey'>,
  leases: readonly RenderReadLease[] | undefined,
): {
  readonly worlds: readonly World[];
  readonly owners: Pick<DrawOwnerOptions, 'cameraOwner' | 'resourceOwner' | 'cameraEntityKey'>;
  readonly leases: readonly RenderReadLease[] | undefined;
} {
  const order = worlds
    .map((world, index) => ({ world, index }))
    .sort((left, right) => left.world.identity.localeCompare(right.world.identity));
  const indexByOriginal = new Map(order.map((entry, index) => [entry.index, index]));
  return {
    worlds: Object.freeze(order.map((entry) => entry.world)),
    owners: {
      cameraOwner: indexByOriginal.get(owners.cameraOwner) ?? owners.cameraOwner,
      resourceOwner: indexByOriginal.get(owners.resourceOwner) ?? owners.resourceOwner,
      ...(owners.cameraEntityKey === undefined ? {} : { cameraEntityKey: owners.cameraEntityKey }),
    },
    leases:
      leases === undefined
        ? undefined
        : Object.freeze(
            order.map((entry) => leases[entry.index]).filter((lease) => lease !== undefined),
          ),
  };
}

export function createLodWorldInspections(
  worlds: readonly RenderResourceScope[],
  renderables: FrameList<RenderableSnapshot>,
  submittedRenderables: FrameList<RenderableSnapshot>,
  camera: CameraSnapshot,
  frameId: number,
  worldKeys: readonly number[],
  slots: ReadonlyMap<number, { readonly slot: number; readonly generation: number }>,
  levelOf: (renderable: RenderableSnapshot) => number = () => 0,
): readonly LodOcclusionWorldInspection[] {
  // The CPU projection knows which renderables belong to each World, but it
  // does not receive the GPU selector counters split by World from the
  // same submit. Keep these rows available for diagnostics while explicitly
  // marking their attribution unavailable; producers must not promote them
  // to World-reorder evidence by inferring facts from array order.
  const attribution = Object.freeze({
    status: 'unavailable' as const,
    reason: 'projection-only' as const,
  });
  const submitted = new Set(submittedRenderables);
  const sampleLimit = 64;
  const accumulators = worlds.map(() => ({
    allCount: 0,
    allVisible: 0,
    allSamples: [] as RenderableSnapshot[],
    lodCount: 0,
    lodVisible: 0,
    lodSamples: [] as RenderableSnapshot[],
    lodLevels: [] as number[],
  }));
  // Keep this projection bounded: the old implementation filtered the full
  // 100k renderable list twice per World on every frame and retained another
  // Set-backed traversal just to derive the six counters below. One pass is
  // enough because the inspection only needs counts, the first row identity,
  // and at most 64 detached samples.
  for (const renderable of renderables) {
    const accumulator = accumulators[renderable.worldId];
    if (accumulator === undefined) continue;
    const visible = submitted.has(renderable);
    accumulator.allCount += 1;
    if (visible) accumulator.allVisible += 1;
    if (accumulator.allSamples.length < sampleLimit) accumulator.allSamples.push(renderable);
    if ((renderable.lods?.length ?? 0) > 0) {
      accumulator.lodCount += 1;
      if (visible) accumulator.lodVisible += 1;
      accumulator.lodLevels.push(levelOf(renderable));
      if (accumulator.lodSamples.length < sampleLimit) accumulator.lodSamples.push(renderable);
    }
  }
  const result: LodOcclusionWorldInspection[] = [];
  for (let worldId = 0; worldId < worlds.length; worldId += 1) {
    const world = worlds[worldId];
    if (world === undefined) continue;
    const accumulator = accumulators[worldId];
    if (accumulator === undefined || accumulator.allCount === 0) {
      result.push(
        Object.freeze({ attachmentId: world.identity, rows: Object.freeze([]), attribution }),
      );
      continue;
    }
    const usesLod = accumulator.lodCount > 0;
    const candidateCount = usesLod ? accumulator.lodCount : accumulator.allCount;
    const visible = usesLod ? accumulator.lodVisible : accumulator.allVisible;
    const samples = usesLod ? accumulator.lodSamples : accumulator.allSamples;
    const first = samples[0];
    const slot =
      first === undefined
        ? undefined
        : slots.get(worldEntityKey(worldKeys[first.worldId] ?? first.worldId, first.entityKey));
    const row: LodOcclusionInspectionRow = {
      root: {
        guid: first === undefined ? 'none' : `asset-handle:${first.assetHandle}`,
        sourceKey: `render-world:${world.identity}`,
      },
      view: {
        attachmentId: world.identity,
        cameraEntity: world === worlds[camera.worldId ?? 0] ? (camera.entityKey ?? 0) : 0,
        viewRole: 'main',
        viewGeneration: camera.historyVersion ?? 0,
      },
      slot: { primitiveSlot: slot?.slot ?? 0, slotGeneration: slot?.generation ?? 0 },
      generation: frameId,
      count: { candidates: candidateCount, visible, occluded: candidateCount - visible },
      lodHistogram: usesLod
        ? lodLevelHistogram(accumulator.lodLevels)
        : [{ level: 0, count: candidateCount }],
      samples: samples.map((candidate, index) => ({
        primitiveSlot:
          slots.get(
            worldEntityKey(worldKeys[candidate.worldId] ?? candidate.worldId, candidate.entityKey),
          )?.slot ?? index,
        level: levelOf(candidate),
        visible: submitted.has(candidate),
      })),
    };
    result.push(
      Object.freeze({
        attachmentId: world.identity,
        rows: Object.freeze([row]),
        attribution,
      }),
    );
  }
  return Object.freeze(
    result.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId)),
  );
}

/**
 * Capture-only snapshots keep the selected camera's geometry and clear color
 * but omit display companions, so captures restore the author configuration.
 */
export function captureOnlyCameras(
  cameras: readonly CameraSnapshot[],
  cameraEntityKey: number | undefined,
): CameraSnapshot[] {
  return cameras
    .filter((camera, index) =>
      cameraEntityKey === undefined ? index === 0 : camera.entityKey === cameraEntityKey,
    )
    .map((camera) => ({
      position: camera.position,
      world: camera.world,
      fov: camera.fov,
      aspect: camera.aspect,
      near: camera.near,
      far: camera.far,
      projection: camera.projection,
      ...(camera.projectionOffset === undefined
        ? {}
        : { projectionOffset: camera.projectionOffset }),
      orthoLeft: camera.orthoLeft,
      orthoRight: camera.orthoRight,
      orthoBottom: camera.orthoBottom,
      orthoTop: camera.orthoTop,
      tonemap: 'none' as const,
      exposure: 1,
      whitePoint: 1,
      antialias: 'none' as const,
      bloom: 'off' as const,
      bloomThreshold: 1,
      bloomIntensity: 0,
      bloomSmoothWidth: 0,
      bloomRadius: 0,
      clearColor: camera.clearColor,
      ...(camera.entityKey === undefined ? {} : { entityKey: camera.entityKey }),
      ...(camera.worldId === undefined ? {} : { worldId: camera.worldId }),
    }));
}

/** The selected display camera and its view basis as seen by render features. */
export function featureCameraSelection(camera: CameraSnapshot | undefined) {
  if (camera === undefined) return {};
  return {
    selectedCamera: camera,
    selectedView: {
      position: new Float32Array(camera.position),
      right: vec3.create(camera.world[0] ?? 1, camera.world[1] ?? 0, camera.world[2] ?? 0),
      up: vec3.create(camera.world[4] ?? 0, camera.world[5] ?? 1, camera.world[6] ?? 0),
      viewProjection: computeViewProjectionMatrix(camera, mat4.create()),
    },
  };
}

/**
 * World attachment identity per stable world key; an ambiguous key clears
 * the table so a readback never attributes rows to the wrong World.
 */
export function lodWorldAttachments(
  worlds: readonly RenderResourceScope[],
  worldKeys: readonly number[],
): ReadonlyMap<number, string> {
  const attachments = new Map<number, string>();
  for (let worldId = 0; worldId < worlds.length; worldId += 1) {
    const world = worlds[worldId];
    if (world === undefined) continue;
    const worldKey = worldKeys[worldId] ?? worldId;
    if (attachments.has(worldKey)) {
      attachments.clear();
      break;
    }
    attachments.set(worldKey, world.identity);
  }
  return attachments;
}
