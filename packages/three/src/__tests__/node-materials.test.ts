import * as PUBLIC from '@forgeax/engine/three';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MeshRenderer, samplerContribution } from '@forgeax/engine-render';
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { projectMaterial, usesFlatShading, validateMaterial } from '../material';
import {
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  NODE_MATERIAL_INPUTS,
} from '../node-materials';
import { SceneProjection } from '../scene';

const pairs = [
  [MeshBasicNodeMaterial, MeshBasicMaterial],
  [MeshStandardNodeMaterial, MeshStandardMaterial],
  [MeshPhysicalNodeMaterial, MeshPhysicalMaterial],
] as const;

it.each(
  pairs,
)('projects ordinary %s properties through the same native material payload', (NodeType, CoreType) => {
  const source = new NodeType({ color: 0x88cc44, opacity: 0.6, transparent: true });
  const core = new CoreType({ color: 0x88cc44, opacity: 0.6, transparent: true });
  expect(
    Object.keys(source).filter(
      (key) =>
        key.endsWith('Node') &&
        !NODE_MATERIAL_INPUTS.includes(key as (typeof NODE_MATERIAL_INPUTS)[number]),
    ),
  ).toEqual([]);
  expect(projectMaterial(validateMaterial(source).unwrap(), {}).unwrap()).toEqual(
    projectMaterial(validateMaterial(core).unwrap(), {}).unwrap(),
  );
  expect(usesFlatShading(source)).toBe(usesFlatShading(core));
  source.dispose();
  core.dispose();
});

it.each(
  pairs,
)('rejects every active graph input and overridden builder hook for %s', (NodeType) => {
  const source = new NodeType();
  for (const field of NODE_MATERIAL_INPUTS) {
    Reflect.set(source, field, new PUBLIC.ConstNode(1));
    expect(() => validateMaterial(source).unwrap(), field).toThrow(`NodeMaterial.${field}`);
    Reflect.set(source, field, null);
  }
  const original = source.setup;
  source.setup = () => {
    throw new Error('must not execute');
  };
  expect(() => validateMaterial(source).unwrap()).toThrow('setup override');
  source.setup = original;
  expect(validateMaterial(source).ok).toBe(true);
  source.dispose();
});

it('rejects custom subclasses and unsupported physical lobes without clamping them', () => {
  class Custom extends MeshBasicNodeMaterial {}
  expect(() => validateMaterial(new Custom()).unwrap()).toThrow('subclass');
  for (const Type of [MeshPhysicalMaterial, MeshPhysicalNodeMaterial]) {
    const source = new Type();
    for (const field of ['dispersion', 'diffuseRoughness', 'retroreflectivity']) {
      Reflect.set(source, field, 0.4);
      expect(() => validateMaterial(source).unwrap(), field).toThrow(
        'MeshPhysicalMaterial dispersion/',
      );
      Reflect.set(source, field, 0);
    }
    Reflect.set(source, 'lights', false);
    if (source instanceof MeshPhysicalNodeMaterial)
      expect(() => validateMaterial(source).unwrap()).toThrow('lights=false');
    source.dispose();
  }
});

it('preserves the public NodeMaterial family and ordinary source copy/JSON', () => {
  for (const Type of [
    PUBLIC.MeshBasicNodeMaterial,
    PUBLIC.MeshStandardNodeMaterial,
    PUBLIC.MeshPhysicalNodeMaterial,
  ]) {
    const source = new Type({ color: 0x8844cc });
    expect(source).toBeInstanceOf(PUBLIC.NodeMaterial);
    expect(source).toBeInstanceOf(PUBLIC.Material);
    expect(source.clone().color).toEqual(source.color);
    expect(source.toJSON()).toMatchObject({ type: source.type, color: 0x8844cc });
    source.dispose();
  }
});

it('keeps native asset handles and quiet-frame revisions stable for a shared NodeMaterial source', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 5;
  const material = new MeshBasicNodeMaterial(),
    geometry = new BoxGeometry();
  const first = new Mesh(geometry, material),
    second = new Mesh(geometry, material);
  scene.add(first, second);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const handle = (mesh: Mesh) => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw new Error('missing mesh');
    return projection.world.get(entity, MeshRenderer).unwrap().materials[0];
  };
  try {
    sync();
    const original = handle(first);
    expect(original).toBe(handle(second));
    const changes = assets.observe().unwrap();
    for (let frame = 0; frame < 20; frame++) sync();
    expect(changes.read().unwrap().changes).toEqual([]);
    material.color.setHex(0xff2200);
    sync();
    expect(handle(first)).toBe(original);
    expect(
      changes
        .read()
        .unwrap()
        .changes.map((change) => change.handle),
    ).toEqual([original]);
    const receipt = handle(first);
    material.colorNode = new PUBLIC.ConstNode<'float', number>(0, 'float');
    expect(sync).toThrow('colorNode');
    expect(handle(first)).toBe(receipt);
    changes.dispose();
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});

it.each(
  pairs,
)('requires exact null source inputs for %s, including deleted or undefined fields', (NodeType) => {
  const source = new NodeType();
  const count =
    source instanceof MeshBasicNodeMaterial
      ? 23
      : source instanceof MeshPhysicalNodeMaterial
        ? 45
        : 26;
  expect(Object.keys(source).filter((key) => key.endsWith('Node'))).toEqual(
    NODE_MATERIAL_INPUTS.slice(0, count),
  );
  Reflect.set(source, 'colorNode', undefined);
  expect(() => validateMaterial(source).unwrap()).toThrow('colorNode');
  Reflect.deleteProperty(source, 'colorNode');
  expect(() => validateMaterial(source).unwrap()).toThrow('colorNode');
  source.colorNode = null;
  expect(validateMaterial(source).ok).toBe(true);
  source.dispose();
});
