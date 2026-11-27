import * as THREE from '@forgeax/engine/three';
import { SynchronousTransform } from '@forgeax/engine-scene/internal';
import { expect, it, vi } from 'vitest';
import { dawnRendererFixture } from './dawn-renderer.fixture';
import { displayPixels, readyFrames, SIZE } from './render.fixture';

const getRenderer = dawnRendererFixture();

it('keeps tracked material, geometry and transform edits visible in submitted pixels', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer();
  const stop = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry(1, 1);
  const attributes = geometry.attributes;
  const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const texels = new Uint8Array([255, 0, 0, 255]);
  const texture = new THREE.DataTexture(texels, 1, 1);
  texture.needsUpdate = true;
  const mesh = new THREE.Mesh(geometry, material);
  const children = scene.children;
  scene.add(mesh);
  stop();
  const center = async () => {
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
    return [...pixels.subarray(offset, offset + 3)];
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(renderer.inspect().sourceWork).toMatchObject({
      mode: 'tracked',
      poseAuthority: 'ecs',
      sourceNodes: 0,
      meshPlans: 0,
      foreignInputChecks: 0,
    });
    expect(await center()).toEqual([255, 0, 0]);
    const index = geometry.index;
    if (!index) throw new Error('Missing plane indices');
    const original = index.array.slice();
    index.array.fill(0);
    expect(await center()).toEqual([255, 0, 0]);
    index.needsUpdate = true;
    expect(await center()).toEqual([0, 0, 0]);
    index.array.set(original);
    index.needsUpdate = true;
    expect(await center()).toEqual([255, 0, 0]);
    material.color.setRGB(0, 1, 0);
    expect(await center()).toEqual([0, 255, 0]);
    material.color.setRGB(1, 1, 1);
    material.map = texture;
    await readyFrames(renderer, scene, camera, 2);
    expect(await center()).toEqual([255, 0, 0]);
    expect(renderer.inspect().sourceWork).toMatchObject({
      residentNodes: 1,
      foreignInputChecks: 0,
    });
    texels.set([0, 0, 255, 255]);
    texture.needsUpdate = true;
    expect(await center()).toEqual([0, 0, 255]);
    mesh.visible = false;
    expect(await center()).toEqual([0, 0, 0]);
    texels.set([255, 0, 0, 255]);
    texture.needsUpdate = true;
    expect(await center()).toEqual([0, 0, 0]);
    mesh.visible = true;
    expect(await center()).toEqual([255, 0, 0]);
    mesh.rotation.z = 0.4;
    mesh.scale.set(0.8, 0.6, 1);
    scene.rotation.z = -0.2;
    await center();
    mesh.position.set(0.12, 0.23, 0);
    await center();
    const expected = new THREE.Matrix4().multiplyMatrices(
      scene.matrixWorld,
      new THREE.Matrix4().compose(mesh.position, mesh.quaternion, mesh.scale),
    );
    for (let lane = 0; lane < 16; lane++)
      expect(mesh.matrixWorld.elements[lane]).toBeCloseTo(expected.elements[lane] as number, 6);
    expect(renderer.inspect().sourceWork?.poseAuthority).toBe('ecs');
    mesh.rotation.z = scene.rotation.z = 0;
    mesh.scale.set(1, 1, 1);
    mesh.position.y = 0;
    mesh.position.x = 3;
    expect(await center()).toEqual([0, 0, 0]);
    mesh.position.x = 0;
    const position = geometry.getAttribute('position').clone();
    for (let i = 0; i < position.count; i++) position.setX(i, position.getX(i) + 3);
    attributes.position = position;
    expect(await center()).toEqual([0, 0, 0]);
    expect(scene.children).toBe(children);
    THREE.setThreeSceneTracking(scene, false);
    expect(await center()).toEqual([0, 0, 0]);
  } finally {
    texture.dispose();
    geometry.dispose();
    material.dispose();
  }
});

it('publishes tracked point bytes without rebuilding the draw', { timeout: 120000 }, async () => {
  const renderer = await getRenderer();
  const stop = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const position = new THREE.Float32BufferAttribute([0, 0, 0], 3);
  const color = new THREE.Float32BufferAttribute([1, 0, 0], 3);
  const geometry = new THREE.BufferGeometry()
    .setAttribute('position', position)
    .setAttribute('color', color);
  const material = new THREE.PointsMaterial({ size: 8, vertexColors: true });
  scene.add(new THREE.Points(geometry, material));
  stop();
  const pixel = (pixels: Uint8Array, x: number) => {
    const offset = ((SIZE / 2) * SIZE + x) * 4;
    return Array.from(pixels.subarray(offset, offset + 3));
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const before = displayPixels(await renderer.captureFrame(scene, camera));
    expect(pixel(before, SIZE / 2)).toEqual([255, 0, 0]);
    position.setX(0, 0.5);
    color.setXYZ(0, 0, 0, 1);
    position.needsUpdate = true;
    color.needsUpdate = true;
    const after = displayPixels(await renderer.captureFrame(scene, camera));
    expect(pixel(after, SIZE / 2)).toEqual([0, 0, 0]);
    expect(pixel(after, (SIZE * 3) / 4)).toEqual([0, 0, 255]);
    expect(renderer.inspect().sourceWork).toMatchObject({ meshPlans: 0, materialUses: 0 });
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

it('publishes a shared texture revision while native Render culls both consumers', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer(),
    stop = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene(),
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const pixels = new Uint8Array([255, 0, 0, 255]);
  const map = new THREE.DataTexture(pixels, 1, 1);
  map.needsUpdate = true;
  let uploads = 0;
  map.onUpdate = () => {
    uploads++;
  };
  const material = new THREE.MeshBasicMaterial({ map, transparent: true });
  const geometry = new THREE.PlaneGeometry(1, 1);
  const first = new THREE.Mesh(geometry, material),
    other = new THREE.Mesh(geometry, material);
  scene.add(first, other);
  stop();
  const center = async () => {
    const image = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE * SIZE) / 2 + SIZE / 2) * 4;
    return Array.from(image.subarray(offset, offset + 3));
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(await center()).toEqual([255, 0, 0]);
    first.position.x = 3;
    other.position.x = -3;
    expect(await center()).toEqual([0, 0, 0]);
    const before = uploads;
    pixels.set([0, 255, 0, 255]);
    map.needsUpdate = true;
    expect(await center()).toEqual([0, 0, 0]);
    expect(uploads).toBe(before + 1);
    expect(renderer.inspect().sourceWork?.meshPlans).toBe(0);
    other.position.x = 0;
    expect(await center()).toEqual([0, 255, 0]);
    expect(uploads).toBe(before + 1);
    pixels.set([0, 0, 255, 255]);
    map.needsUpdate = true;
    expect(await center()).toEqual([0, 0, 255]);
    expect(uploads).toBe(before + 2);
    camera.position.x = 3;
    expect(await center()).toEqual([0, 0, 255]);
    expect(renderer.inspect().sourceWork?.meshPlans).toBe(0);
  } finally {
    geometry.dispose();
    material.dispose();
    map.dispose();
  }
});

it('restores a tracked Sprite with its latest material through a view transition', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer();
  const stop = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const material = new THREE.SpriteMaterial({ color: 0xff0000 });
  const sprite = new THREE.Sprite(material);
  scene.add(sprite);
  stop();
  const center = async () => {
    const image = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE * SIZE) / 2 + SIZE / 2) * 4;
    return Array.from(image.subarray(offset, offset + 3));
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(await center()).toEqual([255, 0, 0]);
    sprite.position.x = 3;
    material.color.setRGB(0, 1, 0);
    material.rotation = 0.3;
    expect(await center()).toEqual([0, 0, 0]);
    expect(renderer.inspect().sourceWork?.meshPlans).toBe(0);
    camera.position.x = 3;
    expect(await center()).toEqual([0, 255, 0]);
    expect(renderer.inspect().sourceWork?.meshPlans).toBe(0);
  } finally {
    material.dispose();
  }
});

it('matches strict pixels when a tracked transparent draw changes order and a light changes intensity', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer();
  const end = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene(),
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const geo = new THREE.PlaneGeometry(1, 1);
  const red = new THREE.MeshStandardMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });
  const blue = new THREE.MeshBasicMaterial({
    color: 0x0000ff,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  const front = new THREE.Mesh(geo, red),
    back = new THREE.Mesh(geo, blue);
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambient, back, front);
  front.position.z = 0.2;
  end();
  const center = async () => {
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
    return Array.from(pixels.subarray(offset, offset + 3));
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const first = await center();
    expect(first[0]).toBeGreaterThan(0);
    expect(first[2]).toBeGreaterThan(0);
    front.position.z = -0.2;
    ambient.intensity = 0.25;
    const edited = await center();
    expect(edited).not.toEqual(first);
    THREE.setThreeSceneTracking(scene, false);
    expect(await center()).toEqual(edited);
  } finally {
    geo.dispose();
    red.dispose();
    blue.dispose();
  }
});

it('updates retained LOD selection on camera and level edits', { timeout: 120000 }, async () => {
  const renderer = await getRenderer();
  const end = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20);
  const lod = new THREE.LOD(),
    geometry = new THREE.PlaneGeometry(1, 1);
  const red = new THREE.MeshBasicMaterial({ color: 0xff0000 }),
    blue = new THREE.MeshBasicMaterial({ color: 0x0000ff });
  lod.addLevel(new THREE.Mesh(geometry, red), 0);
  lod.addLevel(new THREE.Mesh(geometry, blue), 4);
  scene.add(lod);
  camera.position.z = 2;
  end();
  const center = async () => {
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
    return Array.from(pixels.subarray(offset, offset + 3));
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(await center()).toEqual([255, 0, 0]);
    camera.position.z = 6;
    expect(await center()).toEqual([0, 0, 255]);
    const far = lod.levels[1];
    if (!far) throw new Error('Missing far level');
    far.distance = 8;
    expect(await center()).toEqual([255, 0, 0]);
    const near = lod.levels[0];
    if (!near) throw new Error('Missing near level');
    near.object.visible = false;
    expect(await center()).toEqual([255, 0, 0]);
  } finally {
    geometry.dispose();
    red.dispose();
    blue.dispose();
  }
});

it('publishes a changed leaf to both meshes sharing a tracked skeleton', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer();
  const end = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene(),
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 3;
  const geometry = new THREE.PlaneGeometry(0.8, 0.8);
  const count = geometry.getAttribute('position').count;
  const indices = new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4);
  const weights = new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4);
  for (let i = 0; i < count; i++) {
    indices.setX(i, 15);
    weights.setX(i, 1);
  }
  geometry.setAttribute('skinIndex', indices);
  geometry.setAttribute('skinWeight', weights);
  const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const left = new THREE.SkinnedMesh(geometry, material),
    right = new THREE.SkinnedMesh(geometry, material);
  left.frustumCulled = right.frustumCulled = false;
  const bones = Array.from({ length: 16 }, () => new THREE.Bone());
  left.add(...bones);
  const skeleton = new THREE.Skeleton(bones);
  left.bind(skeleton);
  right.bind(skeleton);
  scene.add(left, right);
  end();
  const pixels = async () => {
    const rgba = displayPixels(await renderer.captureFrame(scene, camera));
    const i = ((SIZE * SIZE) / 2 + SIZE / 2) * 4;
    return [...rgba.subarray(i, i + 3)];
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(await pixels()).toEqual([255, 0, 0]);
    expect(renderer.inspect().sourceWork).toMatchObject({ jointReads: 0, meshPlans: 0 });
    const leaf = bones[15],
      inverse = skeleton.boneInverses[15];
    if (!leaf || !inverse) throw new Error('Missing final joint');
    leaf.position.x = 2;
    expect(await pixels()).toEqual([0, 0, 0]);
    expect(renderer.inspect().sourceWork).toMatchObject({ jointReads: 0, meshPlans: 0 });
    expect(await pixels()).toEqual([0, 0, 0]);
    expect(renderer.inspect().sourceWork).toMatchObject({ jointReads: 0, meshPlans: 0 });
    inverse.makeTranslation(-2, 0, 0);
    expect(await pixels()).toEqual([255, 0, 0]);
    scene.onBeforeRender = () => {};
    await readyFrames(renderer, scene, camera, 2);
    leaf.position.x = 0;
    left.updateMatrixWorld(true);
    expect(await pixels()).toEqual([0, 0, 0]);
    expect(renderer.inspect().sourceWork).toMatchObject({ poseAuthority: 'three', jointReads: 0 });
    leaf.position.x = 2;
    expect(await pixels()).toEqual([255, 0, 0]);
    THREE.setThreeSceneTracking(scene, false);
    expect(await pixels()).toEqual([255, 0, 0]);
  } finally {
    skeleton.dispose();
    material.dispose();
    geometry.dispose();
  }
});

it('keeps authored matrix arrays and retained NodeMaterial values live', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer();
  const stop = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xff0000 });
  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  stop();
  const matrix = mesh.matrix.elements;
  const center = async () => {
    const pixels = displayPixels(await renderer.captureFrame(scene, camera));
    const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
    return [...pixels.subarray(offset, offset + 3)];
  };
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    expect(await center()).toEqual([255, 0, 0]);
    expect(renderer.inspect().sourceWork).toMatchObject({ mode: 'tracked', meshPlans: 0 });
    material.color.setRGB(0, 1, 0);
    expect(await center()).toEqual([0, 255, 0]);
    expect(renderer.inspect().sourceWork).toMatchObject({ meshPlans: 0, materialUses: 0 });
    mesh.matrixAutoUpdate = false;
    mesh.matrix.multiplyMatrices(mesh.matrix, new THREE.Matrix4().makeTranslation(2, 0, 0));
    expect(mesh.matrix.elements).toBe(matrix);
    expect(await center()).toEqual([0, 0, 0]);
    matrix[12] = 0;
    expect(await center()).toEqual([0, 255, 0]);
  } finally {
    material.dispose();
    geometry.dispose();
  }
});

it('visits edited child arrays and preserves caller-owned proxy reads in both stock updates', () => {
  const stop = THREE.enableThreeSourceTracking();
  const root = new THREE.Group();
  const first = new THREE.Group(),
    second = new THREE.Group(),
    replacement = new THREE.Group();
  stop();
  root.add(first, second);
  for (const parentUpdate of [false, true]) {
    const visits: string[] = [];
    const children = root.children;
    children[1] = second;
    const method = parentUpdate ? 'updateWorldMatrix' : 'updateMatrixWorld';
    first[method] = () => {
      visits.push('first');
      children[1] = replacement;
    };
    second[method] = () => {
      visits.push('second');
    };
    replacement[method] = () => {
      visits.push('replacement');
    };
    const run = () =>
      parentUpdate ? root.updateWorldMatrix(false, true) : root.updateMatrixWorld(true);
    run();
    expect(visits).toEqual(['first', 'replacement']);
    const reads: PropertyKey[] = [];
    root.children = new Proxy(children, {
      get(target, key, receiver) {
        reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      visits.length = 0;
      run();
      expect(visits).toEqual(['first', 'replacement']);
      expect(reads).toEqual(['length', '0', '1']);
    } finally {
      root.children = children;
    }
  }
});

it('reuses stock source bone matrices across synchronous animation reads', {
  timeout: 120000,
}, async () => {
  const renderer = await getRenderer();
  const end = THREE.enableThreeSourceTracking();
  const scene = new THREE.Scene();
  const rig = new THREE.Group();
  const hip = new THREE.Bone();
  const foot = new THREE.Bone();
  const sibling = new THREE.Bone();
  const detached = new THREE.Group();
  // Exercise the tracked source-driven render route, including synchronous
  // source reads from applications that use scene render callbacks.
  scene.onBeforeRender = () => {};
  foot.position.x = 1;
  hip.add(foot, sibling);
  rig.add(hip);
  scene.add(rig, detached);
  end();
  const camera = new THREE.PerspectiveCamera();
  camera.position.z = 5;
  const original = foot.matrixWorld;
  const position = new THREE.Vector3();
  try {
    await renderer.init();
    await readyFrames(renderer, scene, camera, 60);
    const resolve = vi.spyOn(SynchronousTransform.prototype, 'resolve');
    try {
      rig.updateMatrixWorld(true);
      resolve.mockClear();
      rig.updateMatrixWorld(true);
      expect(resolve).toHaveBeenCalled();
      expect(resolve.mock.results.every((r) => r.type === 'return' && r.value === false)).toBe(
        true,
      );
      expect(Object.hasOwn(foot, 'updateWorldMatrix')).toBe(false);
      const inheritedUpdate = foot.updateWorldMatrix;
      const calls: number[] = [];
      foot.updateWorldMatrix = function (parents, children, force) {
        calls.push(this.id);
        inheritedUpdate.call(this, parents, children, force);
      };
      foot.getWorldPosition(position);
      expect(calls).toEqual([foot.id]);
      Reflect.deleteProperty(foot, 'updateWorldMatrix');
      hip.rotation.z = Math.PI / 2;
      expect(foot.getWorldPosition(position).x).toBeCloseTo(0);
      expect(position.y).toBeCloseTo(1);
      expect(foot.matrixWorld).toBe(original);
      resolve.mockClear();
      foot.getWorldPosition(position);
      expect(resolve.mock.results.every((r) => r.type === 'return' && r.value === false)).toBe(
        true,
      );
      hip.matrixWorld.makeTranslation(4, 0, 0);
      foot.updateWorldMatrix(false, false);
      expect(foot.matrixWorld.elements[12]).toBe(5);
      expect(foot.getWorldPosition(position).y).toBeCloseTo(1);
      detached.position.x = 6;
      detached.add(foot);
      expect(foot.getWorldPosition(position).x).toBeCloseTo(7);
      foot.matrixAutoUpdate = false;
      foot.matrix.makeTranslation(3, 0, 0);
      foot.updateMatrixWorld(true);
      expect(foot.getWorldPosition(position).x).toBeCloseTo(9);
    } finally {
      resolve.mockRestore();
    }
  } finally {
    renderer.dispose();
  }
});

it('reads owned and borrowed pose elements through their public array receivers', () => {
  const stop = THREE.enableThreeSourceTracking();
  const bone = new THREE.Bone();
  stop();
  const matrix = bone.matrixWorld;
  matrix.makeScale(-2, 3, 4).setPosition(5, 6, 7);
  const owned = matrix.elements;
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  let receiver: unknown;
  Object.defineProperty(owned, '12', {
    configurable: true,
    get() {
      receiver = this;
      return 11;
    },
  });
  expect(position.setFromMatrixPosition(matrix)).toBe(position);
  expect(position.toArray()).toEqual([11, 6, 7]);
  expect(receiver).toBe(owned);
  // Change a later lane mid-query. Each subsequent read still sees the current descriptor.
  Object.defineProperty(position, 'x', {
    configurable: true,
    set() {
      Object.defineProperty(owned, '13', {
        configurable: true,
        get() {
          receiver = this;
          return 19;
        },
      });
    },
  });
  const determinant = vi.spyOn(matrix, 'determinantAffine');
  expect(matrix.decompose(position, rotation, scale)).toBe(matrix);
  expect(determinant.mock.instances).toEqual([matrix]);
  expect(receiver).toBe(owned);
  expect(position.y).toBe(19);
  expect(scale.toArray()).toEqual([-2, 3, 4]);
  const reads: PropertyKey[] = [];
  let determinantReceiver: unknown;
  Object.defineProperty(owned, '0', {
    configurable: true,
    get() {
      determinantReceiver = this;
      return -2;
    },
  });
  expect(matrix.determinantAffine()).toBe(-24);
  expect(determinantReceiver).toBe(owned);
  const borrowed = new Proxy([...owned] as typeof owned, {
    get(target, key, self) {
      reads.push(key);
      return Reflect.get(target, key, self);
    },
  });
  matrix.elements = borrowed;
  expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([11, 19, 7]);
  expect(reads).toEqual(['12', '13', '14']);
  expect(matrix.determinantAffine()).toBe(-24);
});

it('preserves live operand and destination receivers through stock matrix multiplication', () => {
  const release = THREE.enableThreeSourceTracking();
  const left = new THREE.Bone().matrixWorld,
    right = new THREE.Bone().matrixWorld;
  const output = new THREE.Bone().matrixWorld;
  release();
  const receivers: unknown[] = [];
  Object.defineProperty(left.elements, 0, {
    configurable: true,
    get() {
      receivers.push(this);
      Object.defineProperty(right.elements, 0, {
        configurable: true,
        get() {
          receivers.push(this);
          return 1;
        },
      });
      return 1;
    },
  });
  Object.defineProperty(output.elements, 0, {
    configurable: true,
    set() {
      receivers.push(this);
    },
  });
  output.multiplyMatrices(left, right);
  expect(receivers).toHaveLength(3);
  expect(receivers[0]).toBe(left.elements);
  expect(receivers[1]).toBe(right.elements);
  expect(receivers[2]).toBe(output.elements);
});
