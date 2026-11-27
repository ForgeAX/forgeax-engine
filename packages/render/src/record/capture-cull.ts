import { box3, frustum, mat4 } from '@forgeax/engine-math';
import type { CameraSnapshot } from '../render-contract';
import type { RenderableSnapshot, ResidualCameraAdmission } from '../render-system-extract';
import type { MaterialFrame } from '../scene/material-dispatch';
import { cameraBoundsVisible, cullSceneSlots, type SlotCullState } from '../scene/persistent-cull';
import type {
  PersistentGpuDrivenState,
  PersistentShadowCasterProjection,
} from '../scene/render-scene';
import { computeViewProjectionMatrix } from './helpers';

interface CaptureVisibility {
  readonly admission: ResidualCameraAdmission;
  readonly visible: (source: RenderableSnapshot) => boolean;
}

/** One retained capture view uses the same native bounds and row-delta cull as a display view. */
export class CaptureCull {
  private state: SlotCullState | undefined;
  private readonly matrix = mat4.create();

  prepare(
    camera: CameraSnapshot,
    scene: Pick<PersistentGpuDrivenState, 'draws' | 'skin'>,
    materials: MaterialFrame,
    boundsOf: PersistentShadowCasterProjection['worldBoundsOf'],
  ): CaptureVisibility | undefined {
    const draws = scene.draws;
    const slots = draws?.slots;
    const candidates = slots?.indexedSlots('raster');
    // Ownerless/custom roots grant no fixed membership proof. Keep their existing no-cull path.
    if (draws === undefined || slots === undefined || candidates === undefined) {
      this.state = undefined;
      return undefined;
    }
    const planes = this.planes(camera);
    const unavailable = draws.unavailable;
    const records = function* () {
      for (const slot of candidates.borrowKeys()) {
        if (unavailable.has(slot)) continue;
        const row = slots.slotAt(slot);
        if (row !== undefined) yield row;
      }
    };
    const state = cullSceneSlots(
      {
        planes,
        slots,
        candidates,
        records,
        materials,
        meshes: draws.meshes,
        skin: scene.skin,
        unavailable,
        boundsOf: (source, _index, out, row) => boundsOf(source, out, row),
      },
      this.state,
    );
    this.state = state;
    const admission = state.admission;
    // Returned predicates hold this preparation's fixed roots, not the next frame's state.
    const scratch = box3.create();
    return {
      admission,
      visible(source) {
        const slot = slots.identitySlot(source.entityKey);
        if (
          slot !== undefined &&
          candidates.has(slot) &&
          !unavailable.has(slot) &&
          source.terrainSection === undefined &&
          source.generatedMesh === undefined
        )
          return !admission.hidden.has(slot);
        // View-generated geometry has its own bounds even when it shares a source entity.
        return !boundsOf(source, scratch) || cameraBoundsVisible(planes, scratch);
      },
    };
  }

  private planes(camera: CameraSnapshot): readonly Float32Array[] {
    if (
      camera.near >= camera.far ||
      (camera.projection === 'perspective' && (camera.fov <= 0 || camera.aspect <= 0))
    )
      return [];
    // Captures use their actual oblique/off-axis projection, including the mirror clip plane.
    computeViewProjectionMatrix(camera, this.matrix);
    const planes = frustum.fromViewProjection(frustum.create(), this.matrix);
    return planes.every(Number.isFinite) ? [planes] : [];
  }
}
