import * as THREE from '@forgeax/engine/three';
import { FBXLoader } from '@forgeax/engine/three/addons/loaders/FBXLoader.js';
import { PCDLoader } from '@forgeax/engine/three/addons/loaders/PCDLoader.js';
import { TGALoader } from '@forgeax/engine/three/addons/loaders/TGALoader.js';
import { VTKLoader } from '@forgeax/engine/three/addons/loaders/VTKLoader.js';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { bytes, fbx, paddedVtk, pcd, tga } from './data-addons.fixture';
import { displayPixels, readyFrames, verifyReplay } from './render.fixture';
import { brokenBox, loftGeometry, nurbsGeometry } from './surface-addons.fixture';
export type DataEvidence = (
  name: string,
  frame: THREE.ThreeFrameCapture,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
) => Promise<void>;
export async function verifyDataGallery(renderer: THREE.WebGPURenderer, evidence: DataEvidence) {
  await renderer.init();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 6;
  const imported = new FBXLoader().parse(bytes(fbx), '');
  let fbxGeometry: THREE.BufferGeometry | undefined;
  imported.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      fbxGeometry = o.geometry;
      if (Array.isArray(o.material)) {
        for (const m of o.material) m.dispose();
      } else o.material.dispose();
    }
  });
  if (fbxGeometry === undefined) throw Error('missing FBX mesh');
  const fragments = brokenBox(),
    parsed = new TGALoader().parse(tga());
  if (parsed.data === undefined) throw Error('missing TGA data');
  const image = new THREE.DataTexture(parsed.data, parsed.width, parsed.height);
  image.colorSpace = THREE.SRGBColorSpace;
  image.flipY = parsed.flipY ?? false;
  image.magFilter = image.minFilter = THREE.NearestFilter;
  image.needsUpdate = true;
  const geometries = [
    new VTKLoader().parse(bytes(paddedVtk)),
    fbxGeometry,
    loftGeometry(),
    nurbsGeometry(),
    fragments.left.geometry,
    fragments.right.geometry,
    new THREE.PlaneGeometry(),
  ];
  fragments.material.dispose();
  const materials: THREE.MeshBasicMaterial[] = [];
  geometries.forEach((geometry, i) => {
    const material = new THREE.MeshBasicMaterial({
      color: i === 6 ? 0xffffff : i % 2 ? 0x3366dd : 0x22cc44,
      side: THREE.DoubleSide,
      ...(i === 6 ? { map: image } : {}),
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(((i % 4) - 1.5) * 1.2, i < 4 ? 0.8 : -0.8, 0);
    scene.add(mesh);
  });
  const points = new PCDLoader().parse(bytes(pcd));
  points.position.set(1.8, -0.8, 0);
  scene.add(points);
  const capture = async (phase: string) => {
    const frame = await renderer.captureFrame(scene, camera);
    await evidence(phase, frame, scene, camera);
    return frame;
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    const initial = await capture('initial');
    verifyGalleryCells(displayPixels(initial), camera);
    verifyParsedPointColors(displayPixels(initial), points, camera);
    for (const material of materials) material.color.setHex(0xdd3344);
    parsed.data[0] = 0;
    image.needsUpdate = true;
    const edited = await capture('edited');
    expect(equalBytes(displayPixels(initial), displayPixels(edited))).toBe(false);
    await verifyReplay(edited, 'r187-data-addon-gallery');
  } finally {
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    image.dispose();
    points.geometry.dispose();
    points.material.dispose();
  }
}
function verifyGalleryCells(pixels: Uint8Array, camera: THREE.PerspectiveCamera): void {
  const p = new THREE.Vector3();
  for (let i = 0; i < 7; i++) {
    p.set(((i % 4) - 1.5) * 1.2, i < 4 ? 0.8 : -0.8, 0).project(camera);
    const x = Math.floor((p.x * 0.5 + 0.5) * 128),
      y = Math.floor((0.5 - p.y * 0.5) * 128);
    let foreground = 0;
    for (let dy = -7; dy <= 7; dy++)
      for (let dx = -7; dx <= 7; dx++)
        if ((pixels[((y + dy) * 128 + x + dx) * 4 + 3] ?? 0) > 0) foreground++;
    expect(foreground, `loaded/generated geometry ${i} is visible in its cell`).toBeGreaterThan(20);
  }
}
function verifyParsedPointColors(
  pixels: Uint8Array,
  points: THREE.Points,
  camera: THREE.PerspectiveCamera,
): void {
  const p = new THREE.Vector3();
  for (let i = 0; i < 3; i++) {
    p.fromBufferAttribute(points.geometry.getAttribute('position'), i)
      .applyMatrix4(points.matrixWorld)
      .project(camera);
    const x = Math.floor((p.x * 0.5 + 0.5) * 128),
      y = Math.floor((0.5 - p.y * 0.5) * 128);
    let colored = false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const o = ((y + dy) * 128 + x + dx) * 4;
        colored ||= (pixels[o + i] ?? 0) > 100 && (pixels[o + ((i + 1) % 3)] ?? 255) < 5;
      }
    expect(colored, `PCD color ${i} reaches the native tint stream`).toBe(true);
  }
}
