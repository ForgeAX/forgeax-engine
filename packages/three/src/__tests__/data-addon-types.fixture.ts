import { Color, type Mesh, Object3D, Plane } from '@forgeax/engine/three';
import { NRRDLoader } from '@forgeax/engine/three/addons/loaders/NRRDLoader.js';
import { VTKLoader } from '@forgeax/engine/three/addons/loaders/VTKLoader.js';
import { ColorConverter } from '@forgeax/engine/three/addons/math/ColorConverter.js';
import {
  ConvexObjectBreaker,
  type CutByPlaneOutput,
} from '@forgeax/engine/three/addons/misc/ConvexObjectBreaker.js';
import { radixSort } from '@forgeax/engine/three/addons/utils/SortUtils.js';
/** Compile-only probes; parsing incomplete buffers is intentionally not executed. */
export function dataAddonTypeContracts() {
  const cut: CutByPlaneOutput = { object1: null, object2: null };
  const fragment: Mesh | null = cut.object1;
  void fragment;
  // @ts-expect-error Cutting requires mesh geometry, not an arbitrary Object3D.
  new ConvexObjectBreaker().cutByPlane(new Object3D(), new Plane(), cut);
  radixSort(new Uint32Array([3, 1]), { aux: new Uint32Array(2) });
  const vtk = new VTKLoader(),
    volume = new NRRDLoader();
  vtk.setPath('/data/').parse(new ArrayBuffer(256)).computeBoundingBox();
  volume.setPath('/data/').parse(new ArrayBuffer(256)).data;
  const result: void = volume.setSegmentation(true);
  void result;
  const hsv = ColorConverter.getHSV(new Color(), { h: 0, s: 0, v: 0, label: 'retained' as const });
  const label: 'retained' = hsv.label;
  void label;
  // @ts-expect-error The runtime VTK parser consumes a byte buffer, not a string.
  vtk.parse('vtk text');
  // @ts-expect-error The runtime NRRD parser consumes a byte buffer, not a string.
  volume.parse('nrrd text');
  // @ts-expect-error Field parser helpers are module-private, not instance methods.
  volume.parseChars([]);
  // @ts-expect-error HSV output requires v; the pinned HSL target declaration is wrong.
  ColorConverter.getHSV(new Color(), { h: 0, s: 0, l: 0 });
}
