import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';

const nodeTypes = {
  UniformNode: THREE.UniformNode,
  UniformGroupNode: THREE.UniformGroupNode,
  TextureNode: THREE.TextureNode,
};
const materialTypes = {
  MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial,
};

it('roundtrips original node JSON, texture references and material input identities', () => {
  const color = new THREE.UniformNode<'color', THREE.Color>(new THREE.Color(0.2, 0.4, 0.6));
  const loader = new THREE.NodeLoader().setNodes(nodeTypes);
  const encoded = JSON.parse(JSON.stringify(color.toJSON()));
  const before = JSON.stringify(encoded);
  const parsed = loader.parse(encoded);
  expect(JSON.stringify(encoded)).toBe(before);
  expect(parsed.uuid).toBe(color.uuid);
  expect(parsed).toBeInstanceOf(THREE.UniformNode);
  expect((parsed as THREE.UniformNode<unknown>).getGroup()).toBeInstanceOf(THREE.UniformGroupNode);
  expect((parsed as THREE.UniformNode<unknown>).value).toEqual(color.value);
  const texture = new THREE.Texture(),
    node = new THREE.TextureNode(texture);
  const sampled = loader.setTextures({ [texture.uuid]: texture }).parse(node.toJSON());
  expect((sampled as THREE.TextureNode).value).toBe(texture);
  const source = new THREE.MeshPhysicalNodeMaterial();
  source.emissiveNode = color;
  source.sheenNode = color;
  const json = JSON.parse(JSON.stringify(source.toJSON()));
  const nodes = loader.parseNodes(Reflect.get(json, 'nodes'));
  const material = new THREE.NodeMaterialLoader()
    .setNodes(nodes)
    .setNodeMaterials(materialTypes)
    .parse(json);
  expect(material).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
  expect(Reflect.get(material, 'attenuationDistance')).toBe(Infinity);
  expect(Reflect.get(material, 'emissiveNode')).toBe(Reflect.get(material, 'sheenNode'));
  expect(Reflect.get(material, 'emissiveNode')).not.toBe(color);
  source.dispose();
  material.dispose();
  texture.dispose();
});

it('roundtrips sync and async node scenes with shared material and Uniform references', async () => {
  const scene = new THREE.Scene(),
    geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshPhysicalNodeMaterial();
  material.roughnessNode = new THREE.UniformNode(0.3);
  const firstSource = new THREE.Mesh(geometry, material),
    secondSource = new THREE.Mesh(geometry, material);
  firstSource.position.x = -1;
  secondSource.position.x = 1;
  scene.add(firstSource, secondSource);
  scene.updateMatrixWorld(true);
  const json = JSON.parse(JSON.stringify(scene.toJSON()));
  const loader = new THREE.NodeObjectLoader().setNodes(nodeTypes).setNodeMaterials(materialTypes);
  for (const parsed of [loader.parse(json), await loader.parseAsync(json)]) {
    expect(parsed).toBeInstanceOf(THREE.Scene);
    const [first, second] = parsed.children as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshPhysicalNodeMaterial
    >[];
    if (first === undefined || second === undefined) throw Error('missing parsed meshes');
    expect(first.position.x).toBe(-1);
    expect(second.position.x).toBe(1);
    expect(first.geometry).toBe(second.geometry);
    expect(first.material).toBe(second.material);
    expect(first.material).toBeInstanceOf(THREE.MeshPhysicalNodeMaterial);
    expect(first.material.attenuationDistance).toBe(Infinity);
    expect(first.material.roughnessNode).toBeInstanceOf(THREE.UniformNode);
    expect((first.material.roughnessNode as THREE.UniformNode<unknown>).value).toBe(0.3);
    expect((first.material.roughnessNode as THREE.UniformNode<unknown>).getGroup()).toBeInstanceOf(
      THREE.UniformGroupNode,
    );
    first.geometry.dispose();
    first.material.dispose();
  }
  geometry.dispose();
  material.dispose();
});

it.each([
  ['2d', THREE.StorageTexture],
  ['array', THREE.StorageArrayTexture],
  ['3d', THREE.Storage3DTexture],
] as const)('preserves original %s storage descriptors, resize invalidation and clone', (_name, Type) => {
  const texture = new Type(4, 5, 2);
  expect(texture).toBeInstanceOf(THREE.Texture);
  expect(Reflect.get(texture, 'isStorageTexture')).toBe(true);
  let disposals = 0;
  texture.addEventListener('dispose', () => disposals++);
  texture.setSize(8, 9, 3);
  expect(disposals).toBe(1);
  texture.setSize(8, 9, 3);
  expect(disposals).toBe(1);
  expect(texture.image).toMatchObject({ width: 8, height: 9 });
  const copy = texture.clone();
  expect(copy).toBeInstanceOf(Type);
  expect(copy.image).toEqual(texture.image);
  texture.dispose();
  copy.dispose();
});

// These are public TypeScript admission checks; no runtime registry is changed.
function registryTypes() {
  const loader = new THREE.NodeLoader();
  loader.setPath('').setTextures({}).setNodes({ UniformNode: THREE.UniformNode });
  const loaded: Promise<THREE.Node> = loader.loadAsync('not-executed.json');
  void loaded;
  // @ts-expect-error r187 instantiates registry values, so instances cannot be entries.
  loader.setNodes({ UniformNode: new THREE.UniformNode(0) });
  const materials = new THREE.NodeMaterialLoader();
  materials
    .setTextures({})
    .setNodes({})
    .setNodeMaterials({ MeshPhysicalNodeMaterial: THREE.MeshPhysicalNodeMaterial });
  // @ts-expect-error NodeMaterial registries require constructors.
  materials.setNodeMaterials({ MeshPhysicalNodeMaterial: new THREE.MeshPhysicalNodeMaterial() });
  return loader;
}
void registryTypes;
