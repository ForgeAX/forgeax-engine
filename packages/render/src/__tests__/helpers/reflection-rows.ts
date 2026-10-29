import { mat4 } from '@forgeax/engine-math';
import type { ReflectionProbePrimitiveCenter } from '../../reflection/projection';
import { MaterialFrame } from '../../scene/material-dispatch';
import { MeshFrame } from '../../scene/mesh-frame';
import type { RenderSceneSlot } from '../../scene/render-scene-types';
import type { RowContent } from '../../scene/row-contents';
import type { ProjectedRows } from '../../scene/row-projection';
import { SceneSlots } from '../../scene/scene-slots';

/** Retained scene rows whose reflection-probe selection input is an explicit center. */
export function primitiveRows(
  primitives: readonly {
    readonly worldId: number;
    readonly entityKey: number;
    readonly center: ReflectionProbePrimitiveCenter;
  }[],
) {
  const slots = new SceneSlots();
  const centers = new Map<number, ReflectionProbePrimitiveCenter>();
  primitives.forEach(({ worldId, entityKey, center }, slot) => {
    slots.write(slot, {
      worldId,
      entityKey,
      generation: 1,
      content: { materials: [] } as unknown as RowContent,
      pose: mat4.identity(mat4.create()),
    });
    centers.set(slot, center);
  });
  const identity = {};
  return {
    rows: (): ProjectedRows => ({
      identity,
      slots: slots.capture(),
      materials: new MaterialFrame(undefined),
      meshes: new MeshFrame(),
    }),
    centerOf: (slot: RenderSceneSlot) => centers.get(slot.slot),
    /** Move one row: a pose write is its row change evidence. */
    move(slot: number, center: ReflectionProbePrimitiveCenter) {
      centers.set(slot, center);
      slots.writePose(slot, mat4.identity(mat4.create()));
    },
  };
}
