import { type Object3D, PerspectiveCamera } from '@forgeax/engine/three';
import { FirstPersonControls } from '@forgeax/engine/three/addons/controls/FirstPersonControls.js';
import { FlyControls } from '@forgeax/engine/three/addons/controls/FlyControls.js';
import type { AnimationPathHelper } from '@forgeax/engine/three/addons/helpers/AnimationPathHelper.js';
import { SelectionHelper } from '@forgeax/engine/three/addons/interactive/SelectionHelper.js';
import { VOXLoader } from '@forgeax/engine/three/addons/loaders/VOXLoader.js';
/** Compile-only public controls contracts. */
export function controlAddonTypes(canvas: HTMLCanvasElement, pathHelper: AnimationPathHelper) {
  const vox = new VOXLoader().parse(new ArrayBuffer(8));
  if (vox) {
    const scene: Object3D | null = vox.scene;
    void scene;
  }
  // @ts-expect-error A valid legacy file can omit scene nodes.
  const scene: Object3D = vox?.scene;
  void scene;
  const missingPath = pathHelper.line;
  // @ts-expect-error A helper with no UUID.position track has no line.
  missingPath.geometry;
  const camera = new PerspectiveCamera(),
    fly = new FlyControls(camera, canvas),
    first = new FirstPersonControls(camera, canvas);
  fly.update(1 / 60);
  first.update(1 / 60);
  // @ts-expect-error The original time-scaled update requires a delta.
  fly.update();
  // @ts-expect-error The original time-scaled update requires a delta.
  first.update();
  const helper = new SelectionHelper({ domElement: canvas }, 'selection');
  helper.element.style.width = '10px';
  helper.dispose();
  // @ts-expect-error The original selection helper needs a browser HTML canvas.
  new SelectionHelper({ domElement: new OffscreenCanvas(1, 1) }, 'selection');
  // @ts-expect-error Private vector scratch is not a public instance field.
  helper.startPoint;
  // @ts-expect-error Only private _onSelectStart exists in r187.
  helper.onSelectStart;
}
