import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MeshRenderer, samplerContribution } from '@forgeax/engine-render';
import {
  BoxGeometry,
  Color,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { projectMaterial, validateMaterial } from '../material';
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from '../node-materials';
import { ReferenceBaseNode, ReferenceNode, UserDataNode } from '../reference-nodes';
import { SceneProjection } from '../scene';

const families = ['reference', 'base', 'userdata'] as const;
function input<T extends string>(
  family: (typeof families)[number],
  property: string,
  type: T,
  data?: Record<string, unknown>,
) {
  return family === 'userdata'
    ? new UserDataNode(property, type, data)
    : family === 'base'
      ? new ReferenceBaseNode(property, type, data)
      : new ReferenceNode(property, type, data);
}
it.each(
  families,
)('projects direct %s parameter stores and keeps source caches untouched', (family) => {
  const parameters = { tint: new Color(0.2, 0.4, 0.6), alpha: 0.5 };
  const material = new MeshBasicNodeMaterial(),
    color = input(family, 'tint', 'color', parameters),
    alpha = input(family, 'alpha', 'float', parameters);
  material.colorNode = color;
  material.opacityNode = alpha;
  const read = () =>
    projectMaterial(validateMaterial(material).unwrap(), {}).unwrap().values?.baseColor;
  expect(read()).toEqual([0.2, 0.4, 0.6, 0.5]);
  parameters.tint = new Color(0.7, 0.3, 0.1);
  parameters.alpha = 0.8;
  expect(read()).toEqual([0.7, 0.3, 0.1, 0.8]);
  expect(color.reference).toBe(parameters);
  expect(color.node).toBeNull();
  // Source selectors may be replaced without changing the stale initial .reference/.object.
  const replacement = { tint: new Color(0.9, 0.2, 0.3) };
  Reflect.set(color, family === 'userdata' ? 'userData' : 'object', replacement);
  expect(read()).toEqual([0.9, 0.2, 0.3, 0.8]);
  expect(color.reference).toBe(parameters);
  expect(color.node).toBeNull();
  material.dispose();
});
it.each(
  families,
)('rejects implicit %s frame targets, paths, array uniforms and Sprite pose', (family) => {
  const material = new MeshBasicNodeMaterial();
  material.colorNode = input(family, 'tint', 'color');
  expect(() => validateMaterial(material).unwrap()).toThrow('explicit reference');
  material.colorNode = input(family, 'value.tint', 'color', { value: { tint: new Color('red') } });
  expect(() => validateMaterial(material).unwrap()).toThrow('direct value');
  material.colorNode = input(family, 'tint', 'color', { tint: [1, 0, 0] });
  expect(() => validateMaterial(material).unwrap()).toThrow('three-unsupported');
  const node = input(family, 'tint', 'color', { tint: new Color('red') });
  node.count = 4;
  material.colorNode = node;
  expect(() => validateMaterial(material).unwrap()).toThrow('direct value');
  node.count = null;
  node.update = () => {
    throw Error('must not run');
  };
  expect(() => validateMaterial(material).unwrap()).toThrow('override');
  const sprite = new SpriteNodeMaterial();
  sprite.positionNode = input(family, 'position', 'vec3', { position: new Vector3() });
  expect(() => validateMaterial(sprite).unwrap()).toThrow('pose path');
  material.dispose();
  sprite.dispose();
});
it.each(
  families,
)('ignores manually populated %s uniform caches when the explicit target changes', (family) => {
  const material = new MeshBasicNodeMaterial(),
    a = { tint: new Color(0.2, 0.4, 0.6) },
    b = { tint: new Color(0.7, 0.3, 0.1) };
  const node = input(family, 'tint', 'color', a);
  material.colorNode = node;
  Reflect.apply(node.updateReference, node, [{ object: b }]);
  Reflect.apply(node.update, node, []);
  const cached = node.node;
  Reflect.set(node, family === 'userdata' ? 'userData' : 'object', b);
  expect(
    projectMaterial(validateMaterial(material).unwrap(), {}).unwrap().values?.baseColor,
  ).toEqual([0.7, 0.3, 0.1, 1]);
  expect(node.reference).toBe(a);
  expect(node.node).toBe(cached);
  material.dispose();
});
it('updates existing native material handles from an external store and publishes nothing on quiet sync', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const data = { tint: new Color('red') },
    material = new MeshBasicNodeMaterial(),
    geometry = new BoxGeometry();
  material.colorNode = new ReferenceNode('tint', 'color', data);
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    sync();
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw Error('missing entity');
    const before = projection.world.get(entity, MeshRenderer).unwrap().materials[0],
      observer = assets.observe().unwrap();
    for (let i = 0; i < 20; i++) sync();
    expect(observer.read().unwrap().changes).toEqual([]);
    data.tint = new Color('green');
    sync();
    expect(projection.world.get(entity, MeshRenderer).unwrap().materials[0]).toEqual(before);
    expect(observer.read().unwrap().changes.length).toBeGreaterThan(0);
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});
