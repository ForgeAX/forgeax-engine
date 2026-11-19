import * as THREE from '@forgeax/engine/three';
import { BVHLoader } from '@forgeax/engine/three/addons/loaders/BVHLoader.js';
import { DDSLoader } from '@forgeax/engine/three/addons/loaders/DDSLoader.js';
import { EXRLoader } from '@forgeax/engine/three/addons/loaders/EXRLoader.js';
import { FBXLoader } from '@forgeax/engine/three/addons/loaders/FBXLoader.js';
import { IESLoader } from '@forgeax/engine/three/addons/loaders/IESLoader.js';
import { KTXLoader } from '@forgeax/engine/three/addons/loaders/KTXLoader.js';
import { LUT3dlLoader } from '@forgeax/engine/three/addons/loaders/LUT3dlLoader.js';
import { LUTCubeLoader } from '@forgeax/engine/three/addons/loaders/LUTCubeLoader.js';
import { MDDLoader } from '@forgeax/engine/three/addons/loaders/MDDLoader.js';
import { NRRDLoader } from '@forgeax/engine/three/addons/loaders/NRRDLoader.js';
import { PCDLoader } from '@forgeax/engine/three/addons/loaders/PCDLoader.js';
import { PDBLoader } from '@forgeax/engine/three/addons/loaders/PDBLoader.js';
import { TGALoader } from '@forgeax/engine/three/addons/loaders/TGALoader.js';
import { VTKLoader } from '@forgeax/engine/three/addons/loaders/VTKLoader.js';
import { expect, it } from 'vitest';
import * as fixture from './data-addons.fixture';

it('parses VTK triangles and original FBX scene objects with public geometry and materials', () => {
  const vtk = new VTKLoader().parse(fixture.bytes(fixture.paddedVtk));
  const group = new FBXLoader().parse(fixture.bytes(fixture.fbx), '');
  expect(group).toBeInstanceOf(THREE.Group);
  let meshes = 0;
  try {
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        meshes++;
        expect(object.geometry).toBeInstanceOf(THREE.BufferGeometry);
        expect(object.geometry.getAttribute('position').count).toBe(3);
        object.geometry.dispose();
        if (Array.isArray(object.material)) {
          for (const m of object.material) m.dispose();
        } else object.material.dispose();
      }
    });
    expect(meshes).toBe(1);
    expect(vtk).toBeInstanceOf(THREE.BufferGeometry);
    expect(vtk.index?.count).toBe(3);
  } finally {
    vtk.dispose();
  }
});
it('retains PCD positions and RGB colors on original public Points', () => {
  const points = new PCDLoader().parse(fixture.bytes(fixture.pcd));
  try {
    expect(points).toBeInstanceOf(THREE.Points);
    expect(points.geometry.getAttribute('position').count).toBe(3);
    const c = points.geometry.getAttribute('color');
    expect(c.getX(0)).toBe(1);
    expect(c.getY(1)).toBe(1);
    expect(c.getZ(2)).toBe(1);
  } finally {
    points.geometry.dispose();
    points.material.dispose();
  }
});
it('parses actual TGA texels and compressed DDS/KTX block descriptors', () => {
  const tga = new TGALoader().parse(fixture.tga());
  expect([tga.width, tga.height]).toEqual([2, 2]);
  if (tga.data === undefined) throw Error('missing TGA data');
  expect([...tga.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  for (const result of [
    new DDSLoader().parse(fixture.dds(), true),
    new KTXLoader().parse(fixture.ktx(), true),
  ]) {
    expect([result.width, result.height, result.format]).toEqual([
      4,
      4,
      THREE.RGB_S3TC_DXT1_Format,
    ]);
    expect(result.mipmaps[0]?.data.byteLength).toBe(8);
  }
});
it('parses Cube/3DL LUTs and IES textures without installing renderer effects', () => {
  const cube = new LUTCubeLoader().parse(fixture.cubeLut),
    lut = new LUT3dlLoader().parse(fixture.threeDl),
    ies = new IESLoader().parse(fixture.ies);
  try {
    expect(cube.texture3D).toBeInstanceOf(THREE.Data3DTexture);
    expect(lut.texture3D).toBeInstanceOf(THREE.Data3DTexture);
    expect(cube.size).toBe(2);
    expect(lut.size).toBe(2);
    expect(ies).toBeInstanceOf(THREE.DataTexture);
    expect(ies.image.width * ies.image.height).toBeGreaterThan(0);
  } finally {
    cube.texture3D.dispose();
    lut.texture3D.dispose();
    ies.dispose();
  }
});
it('parses original BVH skeleton/clip and MDD morph frames', () => {
  const bvh = new BVHLoader().parse(fixture.bvh),
    mdd = new MDDLoader().parse(fixture.mdd());
  try {
    expect(bvh.skeleton).toBeInstanceOf(THREE.Skeleton);
    expect(bvh.skeleton.bones[0]).toBeInstanceOf(THREE.Bone);
    expect(bvh.clip).toBeInstanceOf(THREE.AnimationClip);
    expect(bvh.clip.tracks.length).toBeGreaterThan(0);
    expect(mdd.clip).toBeInstanceOf(THREE.AnimationClip);
    expect(mdd.morphTargets).toHaveLength(2);
    expect(mdd.morphTargets[1]?.getX(0)).toBe(1);
  } finally {
    bvh.skeleton.dispose();
  }
});
it('parses scientific volume and molecular geometry with actual numeric data', () => {
  const loader = new NRRDLoader();
  expect(loader.setSegmentation(false)).toBeUndefined();
  expect(loader.segmentation).toBe(false);
  const volume = loader.setPath('/').parse(fixture.bytes(fixture.nrrd)),
    pdb = new PDBLoader().parse(fixture.pdb);
  expect([...volume.data]).toEqual([1, 2, 3, 4]);
  expect([volume.xLength, volume.yLength, volume.zLength]).toEqual([2, 2, 1]);
  try {
    expect(pdb.geometryAtoms).toBeInstanceOf(THREE.BufferGeometry);
    expect(pdb.geometryAtoms.getAttribute('position').count).toBe(2);
    expect(pdb.geometryBonds.getAttribute('position').count).toBe(2);
  } finally {
    pdb.geometryAtoms.dispose();
    pdb.geometryBonds.dispose();
  }
});

it('decodes own uncompressed float EXR channel samples', () => {
  const result = new EXRLoader().setDataType(THREE.FloatType).parse(fixture.exr());
  expect([result.width, result.height]).toEqual([1, 1]);
  expect(result.data).toBeInstanceOf(Float32Array);
  if (!(result.data instanceof Float32Array)) throw Error('missing float EXR data');
  expect([...result.data]).toEqual([1, 0.5, 0.25, 1]);
});
