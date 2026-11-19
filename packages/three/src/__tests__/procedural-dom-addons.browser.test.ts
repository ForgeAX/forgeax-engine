import {
  Mesh,
  MeshBasicMaterial,
  type Object3DEventMap,
  PerspectiveCamera,
  PlaneGeometry,
  type Vector2,
} from '@forgeax/engine/three';
import { InteractiveGroup } from '@forgeax/engine/three/addons/interactive/InteractiveGroup.js';
import { NRRDLoader } from '@forgeax/engine/three/addons/loaders/NRRDLoader.js';
import { Volume } from '@forgeax/engine/three/addons/misc/Volume.js';
import { VolumeSlice } from '@forgeax/engine/three/addons/misc/VolumeSlice.js';
import { expect, it } from 'vitest';
import { bytes, nrrd } from './data-addons.fixture';

it('extracts actual NRRD canvas slices and refreshes source voxels and thresholds explicitly', () => {
  const volume = new NRRDLoader().parse(bytes(nrrd));
  expect(volume).toBeInstanceOf(Volume);
  const slice = volume.extractSlice('z', 0);
  try {
    expect(slice).toBeInstanceOf(VolumeSlice);
    expect(slice.volume).toBe(volume);
    expect(slice.matrix.elements).toHaveLength(16);
    expect([slice.iLength, slice.jLength]).toEqual([2, 2]);
    const before = Array.from(slice.ctxBuffer.getImageData(0, 0, 2, 2).data);
    volume.map((v) => 5 - v);
    volume.repaintAllSlices();
    const after = Array.from(slice.ctxBuffer.getImageData(0, 0, 2, 2).data);
    expect(after).not.toEqual(before);
    volume.lowerThreshold = 100;
    expect(slice.geometryNeedsUpdate).toBe(true);
    slice.repaint();
    const hidden = slice.ctxBuffer.getImageData(0, 0, 2, 2).data;
    expect(Array.from(hidden).filter((_, i) => i % 4 === 3)).toEqual([0, 0, 0, 0]);
  } finally {
    slice.geometry.dispose();
    slice.mesh.material.map?.dispose();
    slice.mesh.material.dispose();
  }
});

it('picks direct children with actual DOM events and releases pointer listeners on disconnect', () => {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px';
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  const group = new InteractiveGroup(),
    camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 3;
  camera.updateMatrixWorld();
  const geometry = new PlaneGeometry(2, 2),
    material = new MeshBasicMaterial(),
    mesh = new Mesh<
      PlaneGeometry,
      MeshBasicMaterial,
      Object3DEventMap & { click: { data: Vector2 } }
    >(geometry, material);
  group.add(mesh);
  group.updateMatrixWorld(true);
  // The original addon dispatches pointer events to an ordinary Mesh.
  const hits: Vector2[] = [];
  mesh.addEventListener('click', (event) => {
    hits.push(event.data.clone());
  });
  const click = () =>
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 64, clientY: 64, bubbles: true }));
  try {
    expect(group.element).toBeNull();
    group.listenToPointerEvents({ domElement: canvas }, camera);
    click();
    expect(hits).toHaveLength(1);
    expect(hits[0]?.toArray()).toEqual([0.5, 0.5]);
    group.disconnect();
    click();
    expect(hits).toHaveLength(1);
    expect(group.camera).toBeNull();
    expect(group.element).toBeNull();
    expect(group.controllers).toHaveLength(0);
  } finally {
    group.disconnect();
    geometry.dispose();
    material.dispose();
    canvas.remove();
  }
});
