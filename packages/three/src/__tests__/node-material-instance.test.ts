import { Sprite as PublicSprite } from '@forgeax/engine/three';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MeshRenderer, samplerContribution } from '@forgeax/engine-render';
import UniformNode from 'three/src/nodes/core/UniformNode.js';
import {
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sprite,
  Vector3,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { projectMaterial, validateMaterial } from '../material';
import { NodeMaterialInstance } from '../node-material-instance';
import {
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  SpriteNodeMaterial,
} from '../node-materials';
import { SceneProjection } from '../scene';
import { spriteMatrix } from '../sprite';

it.each([
  ['basic', MeshBasicNodeMaterial],
  ['standard', MeshStandardNodeMaterial],
] as const)('projects instance data through the original %s model without copying its graph', (_name, Type) => {
  const base = new Type({ color: 0x112233 });
  const instance = new NodeMaterialInstance(base);
  instance.color = new Color(0x88cc44);
  const ordinary = new Type({ color: 0x88cc44 });
  expect(projectMaterial(validateMaterial(instance).unwrap(), {}).unwrap()).toEqual(
    projectMaterial(validateMaterial(ordinary).unwrap(), {}).unwrap(),
  );
  const tint = new UniformNode<'color', Color>(new Color(0.2, 0.4, 0.6));
  base.colorNode = tint;
  expect(instance.colorNode).toBe(tint);
  expect(
    projectMaterial(validateMaterial(instance).unwrap(), {}).unwrap().values?.baseColor,
  ).toEqual([0.2, 0.4, 0.6, 1]);
  tint.value.setRGB(0.7, 0.3, 0.1);
  expect(
    projectMaterial(validateMaterial(instance).unwrap(), {}).unwrap().values?.baseColor,
  ).toEqual([0.7, 0.3, 0.1, 1]);
  expect(base.color.getHex()).toBe(0x112233);
  for (const material of [base, instance, ordinary]) material.dispose();
});

it('retains original instance clone, shared node definition and caller-owned userData', () => {
  const base = new MeshBasicNodeMaterial();
  base.userData = { tint: new Color('red') };
  const instance = new NodeMaterialInstance(base),
    copy = instance.clone();
  expect(copy.nodeMaterial).toBe(base);
  expect(copy.uuid).not.toBe(instance.uuid);
  expect(copy.userData.tint).toBeInstanceOf(Color);
  expect(copy.userData.tint).not.toBe(instance.userData.tint);
  const version = instance.version;
  base.needsUpdate = true;
  expect(instance.version).toBe(version + 1);
  for (const material of [instance, copy, base]) material.dispose();
});

it('rejects instance shader hooks, nested or invalid definitions before native admission', () => {
  const base = new MeshBasicNodeMaterial(),
    instance = new NodeMaterialInstance(base);
  instance.build = () => {
    throw Error('must not run');
  };
  expect(() => validateMaterial(instance).unwrap()).toThrow('NodeMaterialInstance.build');
  instance.build = NodeMaterialInstance.prototype.build;
  const key = instance.customProgramCacheKey;
  instance.customProgramCacheKey = () => 'custom';
  expect(() => validateMaterial(instance).unwrap()).toThrow(
    'NodeMaterialInstance.customProgramCacheKey',
  );
  instance.customProgramCacheKey = key;
  base.setup = () => {
    throw Error('must not run');
  };
  expect(() => validateMaterial(instance).unwrap()).toThrow('setup override');
  Reflect.set(instance, 'nodeMaterial', null);
  expect(() => validateMaterial(instance).unwrap()).toThrow('three-unsupported');
  expect(() => new NodeMaterialInstance(new MeshBasicMaterial() as never)).toThrow(TypeError);
  const physical = new NodeMaterialInstance(new MeshPhysicalNodeMaterial());
  expect(Reflect.get(physical, 'clearcoat')).toBeUndefined();
  expect(() => validateMaterial(physical).unwrap()).toThrow('Physical prototype accessors');
  physical.dispose();
  physical.nodeMaterial.dispose();
  const standard = new MeshStandardNodeMaterial();
  const changed = new NodeMaterialInstance(new MeshBasicNodeMaterial());
  const old = changed.nodeMaterial;
  Reflect.set(changed, 'nodeMaterial', standard);
  expect(() => validateMaterial(changed).unwrap()).toThrow('changed model definition');
  changed.dispose();
  old.dispose();
  standard.dispose();
  const plain = new MeshBasicNodeMaterial();
  const nested = new NodeMaterialInstance(new NodeMaterialInstance(plain) as never);
  expect(() => validateMaterial(nested).unwrap()).toThrow('subclass');
  for (const material of [instance, nested, plain, base]) material.dispose();
});

it('keeps independent source identities and native handles quiet across shared uniform edits', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const base = new MeshBasicNodeMaterial(),
    tint = new UniformNode<'color', Color>(new Color('red'));
  base.colorNode = tint;
  const a = new NodeMaterialInstance(base),
    b = new NodeMaterialInstance(base);
  const geometry = new BoxGeometry(),
    left = new Mesh(geometry, a),
    right = new Mesh(geometry, b);
  right.position.x = 2;
  scene.add(left, right);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const handle = (mesh: Mesh) => {
      const entity = projection.entityFor(mesh);
      if (entity === undefined) throw Error('missing source entity');
      return projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    };
    const handles = [handle(left), handle(right)],
      observer = assets.observe().unwrap();
    expect(handles[0]).not.toEqual(handles[1]);
    for (let i = 0; i < 20; i++) sync();
    expect(observer.read().unwrap().changes).toEqual([]);
    tint.value.setHex(0x00ff00);
    sync();
    expect([handle(left), handle(right)]).toEqual(handles);
    expect(observer.read().unwrap().changes.length).toBeGreaterThan(0);
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    for (const material of [base, a, b]) material.dispose();
  }
});

function instanceTypes() {
  const instance = new NodeMaterialInstance(new MeshStandardNodeMaterial());
  instance.roughness = 0.4;
  instance.clone().copy(instance).metalness = 0.6;
  // @ts-expect-error The original instance has a getter-only graph input.
  instance.colorNode = null;
  // @ts-expect-error Shader setup methods remain on the shared definition.
  instance.setup();
}
void instanceTypes;

it.each([
  true,
  false,
])('reads Sprite size attenuation from its shared definition: %s', (enabled) => {
  const definition = new SpriteNodeMaterial({ sizeAttenuation: enabled });
  const instance = new NodeMaterialInstance(definition);
  const camera = new PerspectiveCamera(),
    sprite = new Sprite();
  sprite.position.z = -5;
  sprite.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  expect(Reflect.get(instance, 'sizeAttenuation')).toBeUndefined();
  expect(spriteMatrix(sprite, camera, instance as never).elements).toEqual(
    spriteMatrix(sprite, camera, definition).elements,
  );
  instance.dispose();
  definition.dispose();
});

function spriteConsumerTypes() {
  type Events = import('three/src/Three.Core.js').Object3DEventMap & { ready: { value: number } };
  const instance = new NodeMaterialInstance(new SpriteNodeMaterial());
  // The accessor configures the shared shader, not the copied instance data.
  // @ts-expect-error sizeAttenuation is definition-owned in r187.
  instance.sizeAttenuation = false;
  const sprite = new PublicSprite<Events>(instance);
  const child = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  const axis = new Vector3(0, 1, 0);
  const result: import('three/src/Three.Core.js').Sprite<Events> = sprite
    .applyQuaternion(new Quaternion())
    .rotateOnAxis(axis, 0.1)
    .rotateOnWorldAxis(axis, 0.1)
    .rotateX(0.1)
    .rotateY(0.1)
    .rotateZ(0.1)
    .translateOnAxis(axis, 1)
    .translateX(1)
    .translateY(1)
    .translateZ(1)
    .add(child)
    .remove(child)
    .removeFromParent()
    .clear()
    .attach(child)
    .clone()
    .copy(sprite);
  result.addEventListener('ready', (event) => {
    const n: number = event.value;
    void n;
  });
}
void spriteConsumerTypes;

it('rejects distinct instance scene overrides before touching getter-only coverage inputs', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  const geometry = new BoxGeometry(),
    material = new MeshBasicNodeMaterial();
  const definition = new MeshBasicNodeMaterial(),
    override = new NodeMaterialInstance(definition);
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  scene.overrideMaterial = override;
  try {
    expect(() => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1))).toThrow(
      'NodeMaterialInstance scene override',
    );
    const pending = projection.entityFor(mesh);
    if (pending === undefined) throw new Error('expected a projected pose');
    expect(projection.world.hasComponent(pending, MeshRenderer)).toBe(false);
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    for (const m of [material, override, definition]) m.dispose();
  }
});

it.each([
  'null',
  'cycle',
] as const)('rejects invalid Sprite instance definitions before transform getters: %s', (mode) => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  const definition = new SpriteNodeMaterial(),
    instance = new NodeMaterialInstance(definition);
  const sprite = new Sprite(instance as never);
  scene.add(sprite);
  Reflect.set(instance, 'nodeMaterial', mode === 'null' ? null : instance);
  try {
    expect(() => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1))).toThrow(
      'three-unsupported',
    );
    const pending = projection.entityFor(sprite);
    if (pending === undefined) throw new Error('expected a projected pose');
    expect(projection.world.hasComponent(pending, MeshRenderer)).toBe(false);
  } finally {
    Reflect.set(instance, 'nodeMaterial', definition);
    projection.dispose();
    assets.dispose();
    instance.dispose();
    definition.dispose();
  }
});
