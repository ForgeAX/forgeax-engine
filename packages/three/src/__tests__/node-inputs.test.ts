import * as PUBLIC from '@forgeax/engine/three';
import { physicalTextureRecipe } from '@forgeax/engine/three/build';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { MeshRenderer, samplerContribution } from '@forgeax/engine-render';
import TextureNode from 'three/src/nodes/accessors/TextureNode.js';
import UniformNode from 'three/src/nodes/core/UniformNode.js';
import {
  BoxGeometry,
  Color,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { materialTextures, materialValues, projectMaterial, validateMaterial } from '../material';
import {
  MeshBasicNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from '../node-materials';
import { SceneProjection } from '../scene';

it('projects uniform Color/vec3/vec4 and opacity without mutating ordinary properties', () => {
  const source = new MeshBasicNodeMaterial({ color: 0x112233, opacity: 0.2, transparent: true });
  const color = new UniformNode<'color', Color>(new Color(0.3, 0.5, 0.7)),
    opacity = new UniformNode(0.6);
  source.colorNode = color;
  source.opacityNode = opacity;
  const projected = () => projectMaterial(validateMaterial(source).unwrap(), {}).unwrap().values;
  expect(projected()?.baseColor).toEqual([0.3, 0.5, 0.7, 0.6]);
  color.value = new Color(0.8, 0.2, 0.4);
  expect(projected()?.baseColor).toEqual([0.8, 0.2, 0.4, 0.6]);
  source.colorNode = new UniformNode<'vec3', Vector3>(new Vector3(0.1, 0.2, 0.3));
  expect(projected()?.baseColor).toEqual([0.1, 0.2, 0.3, 0.6]);
  source.colorNode = new UniformNode<'vec4', Vector4>(new Vector4(0.1, 0.2, 0.3, 0.5));
  expect(projected()?.baseColor).toEqual([0.1, 0.2, 0.3, 0.3]);
  expect(source.color.getHex()).toBe(0x112233);
  expect(source.opacity).toBe(0.2);
  source.dispose();
});

it('selects node textures over map/alphaMap and removes ignored bindings for uniform leaves', () => {
  const source = new MeshPhysicalNodeMaterial();
  const map = new Texture(),
    alphaMap = new Texture(),
    color = new Texture(),
    opacity = new Texture();
  source.map = map;
  source.alphaMap = alphaMap;
  source.colorNode = new TextureNode(color);
  source.opacityNode = new TextureNode(opacity);
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual([
    ['baseColorTexture', color],
    ['alphaTexture', opacity],
  ]);
  source.colorNode = new UniformNode<'color', Color>(new Color('red'));
  source.opacityNode = new UniformNode(0.5);
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual([]);
  source.colorNode = null;
  source.opacityNode = null;
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual([
    ['baseColorTexture', map],
    ['alphaTexture', alphaMap],
  ]);
  for (const texture of [map, alphaMap, color, opacity]) texture.dispose();
  source.dispose();
});

it('keeps the public TSL constructor family and build-only Physical recipe selection aligned', () => {
  const source = new PUBLIC.MeshPhysicalNodeMaterial({
    map: new PUBLIC.Texture(),
    alphaMap: new PUBLIC.Texture(),
  });
  source.colorNode = PUBLIC.TSL.uniform(new PUBLIC.Color('red'));
  source.opacityNode = PUBLIC.TSL.uniform(0.5);
  expect(source.colorNode).toBeInstanceOf(PUBLIC.UniformNode);
  expect(physicalTextureRecipe(source)).toEqual([]);
  const texture = new PUBLIC.Texture();
  source.colorNode = PUBLIC.TSL.texture(texture);
  expect(source.colorNode).toBeInstanceOf(PUBLIC.TextureNode);
  expect(physicalTextureRecipe(source)).toEqual(['map']);
  source.opacityNode = PUBLIC.TSL.texture(texture);
  expect(physicalTextureRecipe(source)).toEqual(['alphaMap', 'map']);
  source.map?.dispose();
  source.alphaMap?.dispose();
  texture.dispose();
  source.dispose();
});

it('rejects update callbacks, custom hooks, shape overrides and invalid values before publication', () => {
  const source = new MeshBasicNodeMaterial();
  const uniform = new UniformNode<'color', Color>(new Color('red'));
  source.colorNode = uniform;
  uniform.onFrameUpdate(() => new Color('blue'));
  expect(() => validateMaterial(source).unwrap()).toThrow('without update callbacks');
  source.colorNode = new UniformNode<'vec2', Vector2>(new Vector2(1, 2));
  expect(() => validateMaterial(source).unwrap()).toThrow('requires a Color');
  source.colorNode = new UniformNode<'color', Color>(new Color(Number.NaN, 0, 0));
  expect(() => validateMaterial(source).unwrap()).toThrow('three-invalid-value');
  source.colorNode = new UniformNode<'color', Color>(new Color('red'));
  source.opacityNode = new UniformNode(Number.NaN);
  expect(() => validateMaterial(source).unwrap()).toThrow('three-invalid-value');
  source.opacityNode = null;
  const original = new UniformNode<'color', Color>(new Color('red'));
  source.colorNode = original;
  original.generate = () => 'must-not-execute';
  expect(() => validateMaterial(source).unwrap()).toThrow('generate override');
  const tex = new TextureNode(new Texture());
  source.colorNode = tex;
  for (const field of [
    'uvNode',
    'levelNode',
    'biasNode',
    'compareNode',
    'depthNode',
    'gradNode',
    'gatherNode',
    'offsetNode',
    'referenceNode',
  ]) {
    Reflect.set(tex, field, new UniformNode(1));
    expect(() => validateMaterial(source).unwrap(), field).toThrow(field);
    Reflect.set(tex, field, null);
  }
  Reflect.set(tex, 'referenceNode', tex);
  expect(() => validateMaterial(source).unwrap()).toThrow('referenceNode');
  Reflect.set(tex, 'referenceNode', null);
  tex.sampler = false;
  expect(() => validateMaterial(source).unwrap()).toThrow('ordinary sampled');
  tex.sampler = true;
  tex.updateMatrix = false;
  expect(() => validateMaterial(source).unwrap()).toThrow('ordinary sampled');
  tex.updateMatrix = true;
  Reflect.set(tex.value, 'isRenderTargetTexture', true);
  expect(() => validateMaterial(source).unwrap()).toThrow('2D image texture');
  tex.value.dispose();
  source.dispose();
});

it('retains Normal/Matcap input boundaries and detects value edits in material revisions', () => {
  for (const Type of [MeshNormalNodeMaterial, MeshMatcapNodeMaterial]) {
    const source = new Type();
    source.opacityNode = new UniformNode(0.5);
    expect(() => validateMaterial(source).unwrap()).toThrow('Normal/Matcap');
    source.dispose();
  }
  const source = new MeshBasicNodeMaterial();
  const uniform = new UniformNode(0.5);
  source.opacityNode = uniform;
  const before = materialValues(validateMaterial(source).unwrap());
  uniform.value = 0.7;
  expect(materialValues(validateMaterial(source).unwrap())).not.toEqual(before);
  source.dispose();
});

it('keeps shared native handles and quiet revisions, admits uniform edits and rejects graphs atomically', () => {
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera(50, 1, 0.1, 100);
  const geometry = new BoxGeometry(),
    material = new MeshStandardNodeMaterial();
  const color = new UniformNode<'color', Color>(new Color('red'));
  material.colorNode = color;
  const roughness = new UniformNode(0.3);
  material.roughnessNode = roughness;
  const first = new Mesh(geometry, material),
    second = new Mesh(geometry, material);
  scene.add(first, second);
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  const handle = (mesh: Mesh) => {
    const entity = projection.entityFor(mesh);
    if (entity === undefined) throw Error('missing entity');
    return projection.world.get(entity, MeshRenderer).unwrap().materials[0];
  };
  try {
    sync();
    const original = handle(first);
    expect(original).toBe(handle(second));
    const changes = assets.observe().unwrap();
    for (let frame = 0; frame < 20; frame++) sync();
    expect(changes.read().unwrap().changes).toEqual([]);
    color.value.set('blue');
    sync();
    expect(handle(first)).toBe(original);
    expect(
      changes
        .read()
        .unwrap()
        .changes.map((c) => c.handle),
    ).toEqual([original]);
    roughness.value = 0.6;
    sync();
    expect(handle(first)).toBe(original);
    expect(
      changes
        .read()
        .unwrap()
        .changes.map((c) => c.handle),
    ).toEqual([original]);
    material.colorNode = new UniformNode<'color', Color>(new Color(Number.NaN, 0, 0));
    expect(sync).toThrow('three-invalid-value');
    expect(handle(first)).toBe(original);
    changes.dispose();
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    material.dispose();
  }
});

it('projects ten lit uniform inputs, suppresses replaced maps and preserves source properties', () => {
  const source = new MeshPhysicalNodeMaterial({
    roughness: 0.9,
    metalness: 0.8,
    emissiveIntensity: 5,
    sheen: 0,
  });
  const fields = {
    roughnessNode: [0.2, 'roughness', 'roughnessMap'],
    metalnessNode: [0.3, 'metallic', 'metalnessMap'],
    clearcoatNode: [0.4, 'clearcoat', 'clearcoatMap'],
    clearcoatRoughnessNode: [0.25, 'clearcoatRoughness', 'clearcoatRoughnessMap'],
    sheenRoughnessNode: [0.6, 'sheenRoughness', 'sheenRoughnessMap'],
    specularIntensityNode: [0.7, 'specular', 'specularIntensityMap'],
    iorNode: [1.7, 'ior', null],
  } as const;
  const ignored = new Texture();
  for (const [field, [value, , map]] of Object.entries(fields)) {
    Reflect.set(source, field, new UniformNode(value));
    if (map !== null) Reflect.set(source, map, ignored);
  }
  for (const [field, map] of [
    ['emissiveNode', 'emissiveMap'],
    ['sheenNode', 'sheenColorMap'],
    ['specularColorNode', 'specularColorMap'],
  ] as const) {
    Reflect.set(source, field, new UniformNode<'color', Color>(new Color(0.1, 0.2, 0.3)));
    Reflect.set(source, map, ignored);
  }
  const values = projectMaterial(validateMaterial(source).unwrap(), {}).unwrap().values;
  for (const [, [value, parameter]] of Object.entries(fields))
    expect(values?.[parameter]).toBe(value);
  for (const field of ['emissive', 'sheenColor', 'specularColor'])
    expect(values?.[field]).toEqual([0.1, 0.2, 0.3]);
  expect(values?.emissiveIntensity).toBe(1);
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual([]);
  expect(source.roughness).toBe(0.9);
  expect(source.sheen).toBe(0);
  for (const [field, [value]] of Object.entries(fields)) {
    const before = materialValues(validateMaterial(source).unwrap());
    Reflect.set(source, field, new UniformNode(value + 0.05));
    expect(materialValues(validateMaterial(source).unwrap()), field).not.toEqual(before);
  }
  source.dispose();
  ignored.dispose();
});

it('rejects out-of-model, invalid and texture-valued lit uniforms before publication', () => {
  const basic = new MeshBasicNodeMaterial();
  Reflect.set(basic, 'roughnessNode', new UniformNode(0.4));
  expect(() => validateMaterial(basic).unwrap()).toThrow('roughnessNode');
  const source = new MeshPhysicalNodeMaterial();
  for (const field of [
    'roughnessNode',
    'metalnessNode',
    'clearcoatNode',
    'clearcoatRoughnessNode',
    'sheenRoughnessNode',
    'specularIntensityNode',
    'iorNode',
  ]) {
    for (const value of [NaN, Infinity, -1]) {
      Reflect.set(source, field, new UniformNode(value));
      expect(() => validateMaterial(source).unwrap(), field).toThrow('three-invalid-value');
    }
    Reflect.set(source, field, new TextureNode(new Texture()));
    expect(() => validateMaterial(source).unwrap(), field).toThrow('scalar float uniform');
    Reflect.set(source, field, null);
  }
  for (const field of ['emissiveNode', 'sheenNode', 'specularColorNode']) {
    Reflect.set(source, field, new UniformNode(0.5));
    expect(() => validateMaterial(source).unwrap(), field).toThrow('Color or vec3');
    Reflect.set(source, field, null);
  }
  source.dispose();
  basic.dispose();
});

it('projects seven optical uniforms, replaces maps and keeps node-driven transmission ordering at zero', () => {
  const source = new MeshPhysicalNodeMaterial({ transmission: 0, side: PUBLIC.DoubleSide });
  source.iridescenceNode = new UniformNode(0.8);
  source.iridescenceIORNode = new UniformNode(1.7);
  source.iridescenceThicknessNode = new UniformNode(250);
  source.transmissionNode = new UniformNode(0);
  source.thicknessNode = new UniformNode(0.4);
  source.attenuationDistanceNode = new UniformNode(2);
  source.attenuationColorNode = new UniformNode<'color', Color>(new Color(0.2, 0.4, 0.8));
  const ignored = new Texture();
  source.iridescenceMap =
    source.iridescenceThicknessMap =
    source.transmissionMap =
    source.thicknessMap =
      ignored;
  const project = () => projectMaterial(validateMaterial(source).unwrap(), {}).unwrap();
  expect(project().values).toMatchObject({
    iridescence: 0.8,
    iridescenceIor: 1.7,
    iridescenceThicknessMinimum: 250,
    iridescenceThicknessMaximum: 250,
    transmission: 0,
    thickness: 0.4,
    attenuationDistance: 2,
    attenuationColor: [0.2, 0.4, 0.8],
  });
  expect(project().passes?.find((p) => p.name === 'forward')?.renderState?.queue).toBe(3000);
  expect(project().passes?.some((p) => p.name === 'transmission-back')).toBe(true);
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual([]);
  const before = materialValues(validateMaterial(source).unwrap());
  source.transmissionNode = new UniformNode(0.75);
  expect(project().values?.transmission).toBe(0.75);
  expect(materialValues(validateMaterial(source).unwrap())).not.toEqual(before);
  source.transmissionNode = null;
  source.transmissionMap = null;
  expect(project().passes?.find((p) => p.name === 'forward')?.renderState?.queue).toBe(2000);
  expect(project().passes?.some((p) => p.name === 'transmission-back')).toBe(false);
  expect(source.transmission).toBe(0);
  source.dispose();
  ignored.dispose();
});

it('rejects invalid optical uniform ranges, texture leaves and unrelated model fields', () => {
  const source = new MeshPhysicalNodeMaterial();
  for (const [field, values] of [
    ['iridescenceNode', [-1, 2, NaN]],
    ['iridescenceIORNode', [0.5, Infinity]],
    ['iridescenceThicknessNode', [-1, NaN]],
    ['transmissionNode', [-1, 2]],
    ['thicknessNode', [-1, Infinity]],
    ['attenuationDistanceNode', [0, -1, Infinity]],
  ] as const) {
    for (const value of values) {
      Reflect.set(source, field, new UniformNode(value));
      expect(() => validateMaterial(source).unwrap(), field).toThrow('three-invalid-value');
    }
    Reflect.set(source, field, new TextureNode(new Texture()));
    expect(() => validateMaterial(source).unwrap(), field).toThrow('scalar float uniform');
    Reflect.set(source, field, null);
  }
  for (const value of [new Color(-1, 0, 0), new Color(2, 0, 0), new Color(NaN, 0, 0)]) {
    source.attenuationColorNode = new UniformNode<'color', Color>(value);
    expect(() => validateMaterial(source).unwrap()).toThrow('three-invalid-value');
  }
  const other = new MeshStandardNodeMaterial();
  Reflect.set(other, 'transmissionNode', new UniformNode(0.5));
  expect(() => validateMaterial(other).unwrap()).toThrow('transmissionNode');
  source.dispose();
  other.dispose();
});
