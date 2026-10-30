import * as THREE from '@forgeax/engine/three';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { comparePixels, displayPixels, readyFrames, verifyReplay } from './render.fixture';

export async function verifyTextures(
  renderer: THREE.WebGPURenderer,
  oracle?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<Uint8Array>,
  evidence?: (
    name: string,
    capture: THREE.ThreeFrameCapture,
    expected?: Uint8Array,
  ) => Promise<void>,
) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry(1.5, 1.5);
  const uv = geometry.getAttribute('uv');
  for (let channel = 1; channel <= 3; channel++) {
    const coordinates = uv.clone();
    for (let i = 0; i < coordinates.count; i++) {
      const x = uv.getX(i),
        y = uv.getY(i);
      coordinates.setXY(
        i,
        channel === 1 ? y : 1 - x,
        channel === 1 ? x : channel === 3 ? 1 - y : y,
      );
    }
    geometry.setAttribute(`uv${channel}`, coordinates);
  }
  const mapBytes = new Uint8Array([
    240, 30, 50, 255, 30, 220, 60, 255, 40, 70, 240, 255, 220, 190, 40, 255,
  ]);
  const map = new THREE.DataTexture(mapBytes.slice(), 2, 2);
  map.needsUpdate = true;
  const materials = [
    new THREE.MeshBasicMaterial({ map }),
    new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 }),
    new THREE.MeshPhysicalMaterial({ map, roughness: 1, metalness: 0 }),
  ] as const;
  const mesh: THREE.Mesh = new THREE.Mesh(geometry, materials[0]);
  scene.add(mesh, new THREE.AmbientLight(0xffffff, Math.PI));
  const textures: THREE.Texture[] = [map];
  await renderer.init();
  const frame = async (name: string) => {
    await readyFrames(renderer, scene, camera);
    const capture = await renderer.captureFrame(scene, camera);
    const expected = await oracle?.(scene, camera);
    await evidence?.(`texture-${name}`, capture, expected);
    const pixels = displayPixels(capture);
    if (expected !== undefined) comparePixels(pixels, expected);
    expect(pixels.some((value, index) => index % 4 !== 3 && value > 50)).toBe(true);
    return { pixels, capture };
  };
  try {
    await readyFrames(renderer, scene, camera, 60);
    for (const material of materials) {
      mesh.material = material;
      map.channel = 0;
      material.needsUpdate = true;
      const baseline = await frame(`${material.type}-uv0`);
      for (const channel of [1, 2, 3]) {
        map.channel = channel;
        material.needsUpdate = true;
        const selected = await frame(`${material.type}-uv${channel}`);
        expect(equalBytes(selected.pixels, baseline.pixels)).toBe(false);
      }
      map.channel = 0;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.needsUpdate = true;
      material.needsUpdate = true;
      const identity = await frame(`${material.type}-transform-identity`);
      map.offset.set(0.17, -0.21);
      map.repeat.set(2, 3);
      map.center.set(0.3, 0.7);
      const tiled = await frame(`${material.type}-offset-repeat`);
      expect(equalBytes(tiled.pixels, identity.pixels)).toBe(false);
      map.repeat.set(2, 2);
      map.rotation = 0.37;
      const rotated = await frame(`${material.type}-rotation-center`);
      expect(equalBytes(rotated.pixels, tiled.pixels)).toBe(false);
      map.matrixAutoUpdate = false;
      map.matrix.set(-1, 0, 0.2, 0, 2, -0.3, 0, 0, 1);
      const manual = await frame(`${material.type}-manual-matrix`);
      expect(equalBytes(manual.pixels, rotated.pixels)).toBe(false);
      await verifyReplay(manual.capture);
      map.matrixAutoUpdate = true;
      map.offset.set(0, 0);
      map.repeat.set(1, 1);
      map.center.set(0, 0);
      map.rotation = 0;
    }
    mesh.material = materials[0];
    const basic = materials[0];
    if (basic === undefined) throw new Error('missing basic material');
    for (const [format, channels] of [
      [THREE.RedFormat, 1],
      [THREE.RGFormat, 2],
      [THREE.RGBAFormat, 4],
    ] as const) {
      for (const type of [THREE.UnsignedByteType, THREE.HalfFloatType]) {
        const values =
          type === THREE.HalfFloatType
            ? Uint16Array.from(
                [0.125, 0.5, 0.75, 1].slice(0, channels),
                THREE.DataUtils.toHalfFloat,
              )
            : Uint8Array.from([32, 128, 192, 255].slice(0, channels));
        const texture = new THREE.DataTexture(values, 1, 1, format, type);
        textures.push(texture);
        texture.needsUpdate = true;
        basic.map = texture;
        basic.needsUpdate = true;
        await frame(`data-${channels}-${type}`);
      }
    }
    const levelZero = { width: 128, height: 128, data: new Uint8Array(128 * 128 * 4).fill(255) };
    const mipmap = new THREE.DataTexture(levelZero.data, levelZero.width, levelZero.height);
    mipmap.mipmaps = [
      levelZero,
      ...[64, 32, 16, 8, 4, 2, 1].map((size) => ({
        width: size,
        height: size,
        data: Uint8Array.from(
          { length: size * size * 4 },
          (_, i) => [20, 210, 70, 255][i % 4] ?? 0,
        ),
      })),
    ];
    mipmap.minFilter = THREE.NearestMipmapNearestFilter;
    mipmap.needsUpdate = true;
    textures.push(mipmap);
    basic.map = mipmap;
    basic.needsUpdate = true;
    mesh.scale.setScalar(0.2);
    const mip = await frame('authored-mips');
    mipmap.minFilter = THREE.NearestFilter;
    mipmap.needsUpdate = true;
    const sameMips = await frame('nearest-filter-keeps-mips');
    expect(equalBytes(mip.pixels, sameMips.pixels)).toBe(true);
    const authored = mipmap.mipmaps;
    mipmap.mipmaps = [];
    mipmap.generateMipmaps = false;
    mipmap.needsUpdate = true;
    const base = await frame('base-level-only');
    expect(equalBytes(mip.pixels, base.pixels)).toBe(false);
    mipmap.mipmaps = authored;
    await verifyReplay(mip.capture);
    mipmap.minFilter = THREE.LinearMipmapLinearFilter;
    mipmap.magFilter = THREE.LinearFilter;
    mipmap.anisotropy = 8;
    mipmap.needsUpdate = true;
    await frame('anisotropy');
    mesh.scale.setScalar(1);
    basic.map = map;
    map.channel = 0;
    basic.needsUpdate = true;
    const before = await frame('before-update');
    if (map.image.data === null) throw new Error('missing source bytes');
    map.image.data.fill(255);
    map.needsUpdate = true;
    const after = await frame('byte-update');
    expect(equalBytes(after.pixels, before.pixels)).toBe(false);
    map.dispose();
    const reused = await frame('dispose-reuse');
    expect(equalBytes(reused.pixels, after.pixels)).toBe(true);
    await verifyReplay(reused.capture);

    camera.near = 0;
    camera.updateProjectionMatrix();
    mesh.castShadow = mesh.receiveShadow = true;
    const zeroNear = await frame('zero-near-shadow-flags');
    expect(equalBytes(zeroNear.pixels, reused.pixels)).toBe(true);
    map.image.data.set(mapBytes);
    map.needsUpdate = true;
    geometry.deleteAttribute('normal');
    const noNormals = await frame('missing-normal-basic');
    expect(equalBytes(noNormals.pixels, before.pixels)).toBe(true);
    geometry.setAttribute('gameWeight', new THREE.Float32BufferAttribute([7], 1));
    expect(equalBytes((await frame('unused-attribute')).pixels, noNormals.pixels)).toBe(true);
    // Lit WebGPU materials derive triangle normals when the attribute is missing.
    for (const material of materials.slice(1)) {
      mesh.material = material;
      await frame(`missing-normal-${material.type}`);
    }
    mesh.material = basic;
    const restored = await frame('basic-after-flat-normals');
    expect(equalBytes(restored.pixels, noNormals.pixels)).toBe(true);
    await verifyReplay(restored.capture);
  } finally {
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    geometry.dispose();
  }
}
