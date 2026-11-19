import * as THREE from '@forgeax/engine/three';
import { CSMFrustum } from '@forgeax/engine/three/addons/csm/CSMFrustum.js';
import { ColorEnvironment } from '@forgeax/engine/three/addons/environments/ColorEnvironment.js';
import { DebugEnvironment } from '@forgeax/engine/three/addons/environments/DebugEnvironment.js';
import { RoomEnvironment } from '@forgeax/engine/three/addons/environments/RoomEnvironment.js';
import { USDZExporter } from '@forgeax/engine/three/addons/exporters/USDZExporter.js';
import { LWOLoader } from '@forgeax/engine/three/addons/loaders/LWOLoader.js';
import { USDLoader } from '@forgeax/engine/three/addons/loaders/USDLoader.js';
import { USDZLoader } from '@forgeax/engine/three/addons/loaders/USDZLoader.js';
import { Gyroscope } from '@forgeax/engine/three/addons/misc/Gyroscope.js';
import { MD2Character } from '@forgeax/engine/three/addons/misc/MD2Character.js';
import { MD2CharacterComplex } from '@forgeax/engine/three/addons/misc/MD2CharacterComplex.js';
import { MorphAnimMesh } from '@forgeax/engine/three/addons/misc/MorphAnimMesh.js';
import { MorphBlendMesh } from '@forgeax/engine/three/addons/misc/MorphBlendMesh.js';
import {
  RollerCoasterGeometry,
  RollerCoasterLiftersGeometry,
  RollerCoasterShadowGeometry,
  SkyGeometry,
  TreesGeometry,
} from '@forgeax/engine/three/addons/misc/RollerCoaster.js';
import { TubePainter } from '@forgeax/engine/three/addons/misc/TubePainter.js';
import { Volume } from '@forgeax/engine/three/addons/misc/Volume.js';
import { MarchingCubes } from '@forgeax/engine/three/addons/objects/MarchingCubes.js';
import { ShadowMesh } from '@forgeax/engine/three/addons/objects/ShadowMesh.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { expect, it, vi } from 'vitest';
import { lwoTriangle, morphTriangle, usdTriangle } from './procedural-addons.fixture';
import { disposeScene } from './scene-format-addons-render.fixture';

it('regenerates marching geometry only on explicit update and preserves original field storage', () => {
  const material = new THREE.MeshBasicMaterial(),
    mesh = new MarchingCubes(12, material, true, true, 2000);
  try {
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const field = mesh.field,
      positions = mesh.positionArray;
    mesh.update();
    mesh.addBall(0.5, 0.5, 0.5, 0.8, 12, new THREE.Color('red'));
    expect(mesh.geometry.drawRange.count).toBe(0);
    mesh.update();
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(30);
    expect(mesh.uvArray).toBeInstanceOf(Float32Array);
    expect(mesh.colorArray).toBeInstanceOf(Float32Array);
    expect(mesh.positionArray).toBe(positions);
    mesh.reset();
    mesh.update();
    expect(mesh.field).toBe(field);
    expect(mesh.geometry.drawRange.count).toBe(0);
    expect('generateGeometry' in mesh).toBe(false);
  } finally {
    mesh.geometry.dispose();
    material.dispose();
  }
});

it('draws tube segments through real public methods and updates the existing attribute buffers', () => {
  const painter = new TubePainter();
  try {
    expect(painter.mesh).toBeInstanceOf(THREE.Mesh);
    const position = painter.mesh.geometry.getAttribute('position');
    if (!(position instanceof THREE.BufferAttribute)) throw Error('expected painter buffer');
    painter.setSize(8);
    painter.setColor(new THREE.Color('green'));
    painter.moveTo(new THREE.Vector3(-0.4, 0, 0));
    painter.lineTo(new THREE.Vector3(0.4, 0, 0));
    painter.update();
    expect(painter.mesh.geometry.drawRange.count).toBeGreaterThan(30);
    expect(painter.mesh.geometry.getAttribute('position')).toBe(position);
    expect(position.version).toBeGreaterThan(0);
    expect('stroke' in painter).toBe(false);
  } finally {
    painter.mesh.geometry.dispose();
    painter.mesh.material.dispose();
  }
});

it('creates clips from named BufferAttributes without obsolete vertex-array fields or input mutation', () => {
  const geometry = morphTriangle(),
    targets = geometry.morphAttributes.position ?? [];
  try {
    const names = targets.map((target) => target.name);
    const clip = THREE.AnimationClip.CreateFromMorphTargetSequence('idle', targets, 3);
    expect(clip).toBeInstanceOf(THREE.AnimationClip);
    expect(clip.tracks).toHaveLength(3);
    expect(THREE.AnimationClip.CreateClipsFromMorphTargetSequences(targets, 3)[0]?.name).toBe(
      'idle',
    );
    expect(targets.map((target) => target.name)).toEqual(names);
    expect(clip.tracks[0]?.name).toBe('.morphTargetInfluences[idle0]');
  } finally {
    geometry.dispose();
  }
});

it('advances both morph animation tools explicitly while retaining original geometry and mixers', () => {
  const geometry = morphTriangle(),
    material = new THREE.MeshBasicMaterial();
  const animated = new MorphAnimMesh(geometry, [material]),
    blended = new MorphBlendMesh(geometry, material);
  animated.animations = [
    THREE.AnimationClip.CreateFromMorphTargetSequence(
      'idle',
      geometry.morphAttributes.position ?? [],
      3,
      false,
    ),
  ];
  try {
    expect(animated).toBeInstanceOf(THREE.Mesh);
    expect(animated.mixer).toBeInstanceOf(THREE.AnimationMixer);
    animated.playAnimation('idle', 3);
    animated.updateAnimation(0.15);
    expect(animated.morphTargetInfluences?.some((v) => v > 0)).toBe(true);
    animated.setDirectionBackward();
    expect(animated.mixer.timeScale).toBe(-1);
    animated.setDirectionForward();
    expect(animated.mixer.timeScale).toBe(1);
    blended.autoCreateAnimations(3);
    blended.playAnimation('idle');
    blended.update(0.2);
    expect(blended.getAnimationTime('idle')).toBeCloseTo(0.2);
    expect(blended.morphTargetInfluences?.some((v) => v > 0)).toBe(true);
    blended.stopAnimation('idle');
    const time = blended.getAnimationTime('idle');
    blended.update(0.2);
    expect(blended.getAnimationTime('idle')).toBe(time);
    expect(animated.geometry).toBe(geometry);
  } finally {
    animated.mixer.stopAllAction();
    animated.mixer.uncacheRoot(animated);
    geometry.dispose();
    material.dispose();
  }
});

it('retains local gyroscope orientation and generates coaster geometries from caller curves', () => {
  const parent = new THREE.Object3D(),
    gyro = new Gyroscope(),
    quaternion = new THREE.Quaternion();
  parent.rotation.z = Math.PI / 2;
  parent.position.x = 3;
  gyro.position.x = 2;
  parent.add(gyro);
  parent.updateMatrixWorld(true);
  gyro.matrixWorld.decompose(new THREE.Vector3(), quaternion, new THREE.Vector3());
  expect(quaternion.angleTo(gyro.quaternion)).toBeCloseTo(0);
  expect(
    new THREE.Vector3()
      .setFromMatrixPosition(gyro.matrixWorld)
      .distanceTo(new THREE.Vector3(3, 2, 0)),
  ).toBeLessThan(1e-12);
  const curve = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(-1, 1, 0),
      new THREE.Vector3(0, 2, 1),
      new THREE.Vector3(1, 1, 0),
      new THREE.Vector3(0, 1, -1),
    ],
    true,
  );
  const geometries = [
    new RollerCoasterGeometry(curve, 12),
    new RollerCoasterLiftersGeometry(curve, 12),
    new RollerCoasterShadowGeometry(curve, 12),
    new SkyGeometry(),
  ];
  try {
    for (const g of geometries) {
      expect(g).toBeInstanceOf(THREE.BufferGeometry);
      expect(g.getAttribute('position').count).toBeGreaterThan(0);
      expect(Array.from(g.getAttribute('position').array).every(Number.isFinite)).toBe(true);
    }
    const groundGeometry = new THREE.PlaneGeometry(100000, 100000);
    groundGeometry.rotateX(-Math.PI / 2);
    const groundMaterial = new THREE.MeshBasicMaterial(),
      ground = new THREE.Mesh(groundGeometry, groundMaterial);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const trees = new TreesGeometry(ground);
      expect(trees.getAttribute('position').count).toBeGreaterThan(0);
      trees.dispose();
    } finally {
      random.mockRestore();
      groundGeometry.dispose();
      groundMaterial.dispose();
    }
  } finally {
    for (const g of geometries) g.dispose();
  }
});

it('constructs disposable environment scenes and inert MD2 character managers without new drivers', () => {
  for (const environment of [
    new ColorEnvironment('red'),
    new DebugEnvironment(),
    new RoomEnvironment(),
  ]) {
    try {
      expect(environment).toBeInstanceOf(THREE.Scene);
      let meshes = 0;
      environment.traverse((o) => {
        if (o instanceof THREE.Mesh) meshes++;
      });
      expect(meshes).toBeGreaterThan(0);
    } finally {
      environment.dispose();
    }
  }
  for (const character of [new MD2Character(), new MD2CharacterComplex()]) {
    expect(character.root).toBeInstanceOf(THREE.Object3D);
    expect(character.meshBody).toBeNull();
    expect(character.meshWeapon).toBeNull();
    if (character instanceof MD2CharacterComplex) character.controls = {};
    character.update(0.016);
    expect(character.root.children).toHaveLength(0);
  }
});

it('decodes volume bytes without copies, maps values with actual callback arguments and retains plane accessors', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    volume = new Volume(2, 2, 2, 'uint8', bytes.buffer);
  expect(volume.data.buffer).toBe(bytes.buffer);
  expect(volume.getData(1, 1, 1)).toBe(7);
  expect(volume.reverseAccess(6)).toEqual([0, 1, 1]);
  expect(volume.map((value, index, data) => value + (index === data.length - 1 ? 1 : 0))).toBe(
    volume,
  );
  expect(volume.computeMinMax()).toEqual([0, 8]);
  volume.inverseMatrix = new THREE.Matrix4();
  volume.RASDimensions = [2, 2, 2];
  const plane = volume.extractPerpendicularPlane('z', 1);
  expect(plane.matrix).toBeInstanceOf(THREE.Matrix4);
  expect([plane.iLength, plane.jLength, plane.sliceAccess(0, 0)]).toEqual([2, 2, 6]);
});

it('splits CPU frustums in WebGPU clip space and reuses caller target cascades', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  const frustum = new CSMFrustum({ projectionMatrix: camera.projectionMatrix, maxFar: 40 }),
    target: CSMFrustum[] = [];
  frustum.split([0.25, 1], target);
  const first = target[0];
  expect(frustum.vertices.near[0]?.z).toBeCloseTo(-0.1);
  expect(frustum.vertices.far[0]?.z).toBeCloseTo(-40);
  expect(target[0]?.vertices.far[0]?.z).toBeCloseTo(-10);
  frustum.split([0.5, 1], target);
  expect(target[0]).toBe(first);
  expect(target[0]?.vertices.far[0]?.z).toBeCloseTo(-20);
});

it('projects a planar ShadowMesh with its original stencil material without claiming native stencil support', () => {
  const geometry = new THREE.BoxGeometry(),
    material = new THREE.MeshBasicMaterial(),
    mesh = new THREE.Mesh(geometry, material),
    shadow = new ShadowMesh(mesh);
  try {
    mesh.position.y = 2;
    mesh.updateMatrixWorld();
    shadow.update(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector4(0, 1, 0, 0));
    expect(shadow.geometry).toBe(geometry);
    expect(new THREE.Vector3(1, 2, 3).applyMatrix4(shadow.matrix).y).toBe(0);
    const shadowMaterial = shadow.material as THREE.MeshBasicMaterial;
    expect(shadowMaterial.stencilWrite).toBe(true);
  } finally {
    (shadow.material as THREE.Material).dispose();
    geometry.dispose();
    material.dispose();
  }
});

it('parses a generated LWO2 layer and preserves indexed handedness and the material constructor family', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const result = new LWOLoader().parse(lwoTriangle(), '', 'fixture');
    expect(result.meshes).toHaveLength(1);
    const mesh = result.meshes[0];
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    if (!(mesh instanceof THREE.Mesh)) throw Error('missing LWO mesh');
    try {
      expect(mesh.geometry.getAttribute('position').count).toBe(3);
      expect(mesh.geometry.getAttribute('position').getX(0)).toBe(1);
      expect(mesh.geometry.index?.count).toBe(3);
      expect(result.materials[0]).toBeInstanceOf(THREE.Material);
    } finally {
      disposeScene(mesh);
    }
  } finally {
    warn.mockRestore();
  }
});

it('parses textual USD and legacy USDZ through the same original scene and geometry family', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    for (const loader of [new USDLoader(), new USDZLoader()]) {
      const root = loader.parse(usdTriangle);
      try {
        expect(root).toBeInstanceOf(THREE.Group);
        const mesh = root.getObjectByName('Triangle');
        expect(mesh).toBeInstanceOf(THREE.Mesh);
        if (!(mesh instanceof THREE.Mesh)) throw Error('missing USD mesh');
        expect(mesh.geometry.getAttribute('position').count).toBe(3);
        expect(new THREE.Box3().setFromObject(root).min.x).toBeCloseTo(-0.75);
      } finally {
        disposeScene(root);
      }
    }
  } finally {
    warn.mockRestore();
  }
});

it('exports texture-free USDZ and reloads the archive with source dimensions and transforms', async () => {
  const source = new THREE.Scene(),
    geometry = new THREE.BoxGeometry(1, 2, 0.5),
    material = new THREE.MeshStandardMaterial(),
    mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Box';
  mesh.position.set(0.25, 0.5, 0);
  source.add(mesh);
  source.updateMatrixWorld(true);
  try {
    const bytes = await new USDZExporter().parseAsync(source, {
      includeAnchoringProperties: false,
    });
    expect(Object.keys(unzipSync(bytes))).toContain('model.usda');
    const root = new USDLoader().parse(Uint8Array.from(bytes).buffer);
    try {
      const actual = new THREE.Box3().setFromObject(root),
        expected = new THREE.Box3().setFromObject(source);
      expect(actual.min.distanceTo(expected.min)).toBeLessThan(1e-6);
      expect(actual.max.distanceTo(expected.max)).toBeLessThan(1e-6);
    } finally {
      disposeScene(root);
    }
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
