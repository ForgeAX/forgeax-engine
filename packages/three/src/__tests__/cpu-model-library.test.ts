import type OriginalObserver from 'three/src/materials/nodes/manager/NodeMaterialObserver.js';
import {
  AmbientLight,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NoToneMapping,
  Scene,
  ShadowMaterial,
  SkinnedMesh,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import {
  BasicNodeLibrary,
  Lighting,
  Line2NodeMaterial,
  MeshPhongNodeMaterial,
  MeshSSSNodeMaterial,
  MeshToonNodeMaterial,
  NodeMaterialObserver,
  ShadowNodeMaterial,
  StandardNodeLibrary,
  VolumeNodeMaterial,
} from '../cpu';
import { validateMaterial } from '../material';
import { MeshBasicNodeMaterial } from '../node-materials';
import { uniform } from '../tsl';

it.each([
  Line2NodeMaterial,
  MeshPhongNodeMaterial,
  MeshSSSNodeMaterial,
  MeshToonNodeMaterial,
  ShadowNodeMaterial,
  VolumeNodeMaterial,
])('preserves original CPU descriptors without substituting native rendering models: %s', (Constructor) => {
  const material = new Constructor(),
    copy = material.clone();
  try {
    expect(material.isNodeMaterial).toBe(true);
    expect(copy.constructor).toBe(Constructor);
    expect(copy.type).toBe(material.type);
    expect(copy.uuid).not.toBe(material.uuid);
    expect(() => validateMaterial(material).unwrap()).toThrow('three-unsupported');
  } finally {
    material.dispose();
    copy.dispose();
  }
});

it('converts authored Core materials with original CPU library classes and preserves the null case', () => {
  const basic = new BasicNodeLibrary(),
    standard = new StandardNodeLibrary();
  const unsupported = new Material();
  expect(basic.fromMaterial(unsupported)).toBeNull();
  expect(standard.fromMaterial(unsupported)).toBeNull();
  const cases = [
    new MeshBasicMaterial({ color: 0x123456 }),
    new MeshStandardMaterial({ roughness: 0.3 }),
    new MeshPhongMaterial({ shininess: 17 }),
    new MeshToonMaterial(),
    new ShadowMaterial(),
  ];
  try {
    for (const source of cases) {
      const converted = standard.fromMaterial(source);
      if (converted === null) throw Error('missing CPU conversion');
      expect(converted.isNodeMaterial).toBe(true);
      expect(converted.type).toBe(source.type.replace('Material', 'NodeMaterial'));
      if ('color' in source) expect(Reflect.get(converted, 'color')).toBe(source.color);
      expect(standard.fromMaterial(converted)).toBe(converted);
      converted.dispose();
    }
    basic.addMaterial(MeshBasicNodeMaterial, 'CustomMaterial');
    expect(basic.getMaterialNodeClass('CustomMaterial')).toBe(MeshBasicNodeMaterial);
    const tone = () => uniform(1);
    basic.addToneMapping(tone, NoToneMapping);
    expect(basic.getToneMappingFunction(NoToneMapping)).toBe(tone);
  } finally {
    unsupported.dispose();
    for (const source of cases) source.dispose();
  }
});

it('owns CPU scene lighting nodes with nested save/restore and disposal', () => {
  const lighting = new Lighting(),
    scene = new Scene(),
    group = new Group();
  const node = lighting.getNode(scene),
    other = lighting.getNode(group),
    first = [new AmbientLight()];
  expect(lighting.getNode(scene)).toBe(node);
  expect(other).not.toBe(node);
  node.setLights(first);
  lighting.beginRender(scene);
  node.setLights([]);
  lighting.beginRender(scene);
  node.setLights([new AmbientLight(0xff0000)]);
  lighting.finishRender(scene);
  expect(node.getLights()).toEqual([]);
  lighting.finishRender(scene);
  expect(node.getLights()).toBe(first);
  let disposed = 0;
  node.addEventListener('dispose', () => disposed++);
  lighting.dispose();
  expect(disposed).toBe(1);
});

it('constructs the CPU observer from its actual authored context without a GPU builder', () => {
  const material = new MeshBasicMaterial(),
    object = new Mesh();
  const context = { material, object, context: {} };
  const plain = new NodeMaterialObserver(context);
  expect(plain.hasNode).toBe(false);
  expect(plain.hasAnimation).toBe(false);
  expect(plain.containsNode({ ...context, context: { getAO: uniform(1) } })).toBe(true);
  const nodeMaterial = new MeshBasicNodeMaterial();
  nodeMaterial.colorNode = uniform(0.5);
  expect(new NodeMaterialObserver({ ...context, material: nodeMaterial }).hasNode).toBe(true);
  expect(new NodeMaterialObserver({ ...context, object: new SkinnedMesh() }).hasAnimation).toBe(
    true,
  );
  material.dispose();
  nodeMaterial.dispose();
  object.geometry.dispose();
  (object.material as Material).dispose();
});

it('retains the original observer constructor contract alongside the minimal CPU input', () => {
  const Observer: typeof OriginalObserver = NodeMaterialObserver;
  expect(Observer).toBe(NodeMaterialObserver);
});
