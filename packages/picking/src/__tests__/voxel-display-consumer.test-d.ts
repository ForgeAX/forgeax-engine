// Public Voxel L1/L6 consumer contract.
//
// Voxel owns grab/split and target succession. Engine owns the submitted
// display mapping; this fixture keeps both routes typechecked without importing
// a private renderer or creating a second spatial transform.
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { FrameReceipt } from '@forgeax/engine-render';
import { mapSceneToDisplay } from '@forgeax/engine-render';
import { computeDisplayScreenRay, pickDisplay, pickVertexDisplay } from '../index';

declare const world: World;
declare const camera: EntityHandle;
declare const target: EntityHandle;
declare const receipt: FrameReceipt;
declare const outputWidth: number;
declare const outputHeight: number;
declare const pointerX: number;
declare const pointerY: number;

const mapping = receipt.barrelDistortion;
if (mapping !== undefined) {
  const ray = computeDisplayScreenRay(
    world,
    camera,
    pointerX,
    pointerY,
    mapping,
    outputWidth,
    outputHeight,
  );
  const entityHit = pickDisplay(world, pointerX, pointerY, mapping, outputWidth, outputHeight);
  const vertexHits = pickVertexDisplay(
    world,
    camera,
    pointerX,
    pointerY,
    mapping,
    outputWidth,
    outputHeight,
    { limit: 8, radius: 6 },
  );
  const label = { x: 0, y: 0 };
  const labelVisible = mapSceneToDisplay(label, mapping, pointerX, pointerY);
  void ray;
  void entityHit;
  void vertexHits;
  void target;
  void labelVisible;
}
