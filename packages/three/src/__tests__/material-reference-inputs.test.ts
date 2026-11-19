import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MeshRenderer, samplerContribution } from '@forgeax/engine-render';
import {
  BoxGeometry,
  Color,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector4,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { materialTextures, projectMaterial, validateMaterial } from '../material';
import { MaterialReferenceNode } from '../node-code';
import { NodeMaterialInstance } from '../node-material-instance';
import {
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  SpriteNodeMaterial,
} from '../node-materials';
import { SceneProjection } from '../scene';

it('reads one shared reference from each selected instance without updating the source node cache', () => {
  const base = new MeshStandardNodeMaterial();
  const color = new MaterialReferenceNode('tint', 'color'),
    opacity = new MaterialReferenceNode('alpha', 'float');
  base.colorNode = color;
  base.opacityNode = opacity;
  const a = new NodeMaterialInstance(base),
    b = new NodeMaterialInstance(base);
  Reflect.set(a, 'tint', new Color(0.2, 0.4, 0.6));
  Reflect.set(a, 'alpha', 0.5);
  Reflect.set(b, 'tint', new Color(0.7, 0.3, 0.1));
  Reflect.set(b, 'alpha', 0.8);
  const read = (m: typeof a) =>
    projectMaterial(validateMaterial(m).unwrap(), {}).unwrap().values?.baseColor;
  expect(read(a)).toEqual([0.2, 0.4, 0.6, 0.5]);
  expect(read(b)).toEqual([0.7, 0.3, 0.1, 0.8]);
  expect(read(a)).toEqual([0.2, 0.4, 0.6, 0.5]);
  expect(color.reference).toBeNull();
  expect(color.node).toBeNull();
  expect(opacity.reference).toBeNull();
  expect(opacity.node).toBeNull();
  for (const m of [base, a, b]) m.dispose();
});

it('uses explicit material targets and current field replacements for scalar and vec4 inputs', () => {
  const target = new MeshBasicNodeMaterial();
  Reflect.set(target, 'value', new Vector4(0.2, 0.4, 0.6, 0.5));
  const source = new MeshBasicNodeMaterial({ opacity: 0.8 });
  source.colorNode = new MaterialReferenceNode('value', 'vec4', target);
  const read = () =>
    projectMaterial(validateMaterial(source).unwrap(), {}).unwrap().values?.baseColor;
  expect(read()).toEqual([0.2, 0.4, 0.6, 0.4]);
  Reflect.set(target, 'value', new Vector4(0.7, 0.3, 0.1, 1));
  expect(read()).toEqual([0.7, 0.3, 0.1, 0.8]);
  source.dispose();
  target.dispose();
});

it('projects lit and Physical reference data through the existing parameter and map selectors', () => {
  const source = new MeshPhysicalNodeMaterial(),
    ignoredMap = new Texture();
  source.roughnessMap = ignoredMap;
  Reflect.set(source, 'amount', 0.4);
  Reflect.set(source, 'glow', new Color(0.1, 0.2, 0.3));
  for (const field of [
    'roughnessNode',
    'metalnessNode',
    'clearcoatNode',
    'iridescenceNode',
    'transmissionNode',
  ] as const)
    source[field] = new MaterialReferenceNode('amount', 'float');
  source.emissiveNode = new MaterialReferenceNode('glow', 'color');
  const result = projectMaterial(validateMaterial(source).unwrap(), {}).unwrap().values;
  expect(result?.roughness).toBe(0.4);
  expect(result?.metallic).toBe(0.4);
  expect(result?.clearcoat).toBe(0.4);
  expect(result?.emissive).toEqual([0.1, 0.2, 0.3]);
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual([]);
  source.roughnessNode = null;
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual([
    ['roughnessTexture', ignoredMap],
  ]);
  Reflect.set(source, 'amount', 2);
  expect(() => validateMaterial(source).unwrap()).toThrow('three-invalid-value');
  source.dispose();
  ignoredMap.dispose();
});

it('rejects path/array/texture references, callbacks, stale selectors and Sprite pose inputs', () => {
  const source = new MeshBasicNodeMaterial();
  Reflect.set(source, 'tint', new Color('red'));
  for (const node of [
    new MaterialReferenceNode('userData.tint', 'color'),
    new MaterialReferenceNode('tint', 'texture'),
  ]) {
    source.colorNode = node as never;
    expect(() => validateMaterial(source).unwrap()).toThrow('NodeMaterial.colorNode');
  }
  const reference = new MaterialReferenceNode('tint', 'color');
  source.colorNode = reference;
  reference.properties = ['other'];
  expect(() => validateMaterial(source).unwrap()).toThrow('NodeMaterial.colorNode');
  reference.properties = ['tint'];
  reference.update = () => {
    throw Error('must not run');
  };
  expect(() => validateMaterial(source).unwrap()).toThrow('override');
  const sprite = new SpriteNodeMaterial();
  sprite.rotationNode = new MaterialReferenceNode('rotation', 'float');
  expect(() => validateMaterial(sprite).unwrap()).toThrow('NodeMaterial.rotationNode');
  source.dispose();
  sprite.dispose();
});

it('retains native instance handles and quiet publication while reference values change', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const base = new MeshBasicNodeMaterial();
  base.colorNode = new MaterialReferenceNode('tint', 'color');
  const instance = new NodeMaterialInstance(base);
  Reflect.set(instance, 'tint', new Color('red'));
  const geometry = new BoxGeometry(),
    mesh = new Mesh(geometry, instance);
  scene.add(mesh);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw Error('missing entity');
    const handle = () => projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    const before = handle(),
      observer = assets.observe().unwrap();
    for (let i = 0; i < 20; i++) sync();
    expect(observer.read().unwrap().changes).toEqual([]);
    Reflect.set(instance, 'tint', new Color('green'));
    sync();
    expect(handle()).toEqual(before);
    expect(observer.read().unwrap().changes.length).toBeGreaterThan(0);
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    instance.dispose();
    base.dispose();
  }
});

it('ignores stale upstream material caches and rejects nonuniform cached graphs', () => {
  const a = new MeshBasicNodeMaterial(),
    b = new MeshBasicNodeMaterial();
  Reflect.set(a, 'tint', new Color(0.2, 0.4, 0.6));
  Reflect.set(b, 'tint', new Color(0.7, 0.3, 0.1));
  const reference = new MaterialReferenceNode('tint', 'color');
  a.colorNode = reference;
  Reflect.apply(reference.updateReference, reference, [{ material: b }]);
  Reflect.apply(reference.update, reference, []);
  const cached = reference.node;
  expect(projectMaterial(validateMaterial(a).unwrap(), {}).unwrap().values?.baseColor).toEqual([
    0.2, 0.4, 0.6, 1,
  ]);
  expect(reference.reference).toBe(b);
  expect(reference.node).toBe(cached);
  if (cached === null) throw Error('missing reference cache');
  Reflect.set(cached, 'update', () => {
    throw Error('must not run');
  });
  expect(() => validateMaterial(a).unwrap()).toThrow('override');
  reference.node = null;
  Reflect.set(a, 'tint', undefined);
  expect(() => validateMaterial(a).unwrap()).toThrow('three-unsupported');
  a.dispose();
  b.dispose();
});
