import * as PUBLIC from '@forgeax/engine/three';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  BufferGeometry,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  Mesh,
  MeshLambertMaterial,
  MeshMatcapMaterial,
  MeshNormalMaterial,
  NoToneMapping,
  PerspectiveCamera,
  PointsMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { cameraData } from '../camera';
import { projectGeometry } from '../geometry';
import { lineStyle } from '../lines';
import { materialTextures, projectMaterial, usesFlatShading, validateMaterial } from '../material';
import {
  LineBasicNodeMaterial,
  LineDashedNodeMaterial,
  MeshLambertNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  NODE_MATERIAL_INPUTS,
  PointsNodeMaterial,
  SpriteNodeMaterial,
} from '../node-materials';
import { SceneProjection } from '../scene';

const pairs = [
  [MeshLambertNodeMaterial, MeshLambertMaterial, ['emissiveNode']],
  [MeshNormalNodeMaterial, MeshNormalMaterial, []],
  [MeshMatcapNodeMaterial, MeshMatcapMaterial, []],
  [LineBasicNodeMaterial, LineBasicMaterial, []],
  [
    LineDashedNodeMaterial,
    LineDashedMaterial,
    ['offsetNode', 'dashScaleNode', 'dashSizeNode', 'gapSizeNode'],
  ],
  [PointsNodeMaterial, PointsMaterial, ['rotationNode', 'scaleNode', 'sizeNode']],
  [SpriteNodeMaterial, SpriteMaterial, ['rotationNode', 'scaleNode']],
] as const;

it.each(pairs)('shares the native ordinary model for %s', (NodeType, CoreType) => {
  const source = new NodeType(),
    core = new CoreType();
  // PointsNodeMaterial inherits transparent=true from SpriteNodeMaterial in r187.
  core.transparent = source.transparent;
  expect(validateMaterial(source).ok).toBe(true);
  expect(usesFlatShading(source)).toBe(usesFlatShading(core));
  expect(materialTextures(validateMaterial(source).unwrap())).toEqual(
    materialTextures(validateMaterial(core).unwrap()),
  );
  if (!(source instanceof MeshMatcapNodeMaterial))
    expect(projectMaterial(validateMaterial(source).unwrap(), {}).unwrap()).toEqual(
      projectMaterial(validateMaterial(core).unwrap(), {}).unwrap(),
    );
  source.dispose();
  core.dispose();
});

it.each(
  pairs,
)('pins all %s inputs and rejects authored graphs, missing fields and hooks', (NodeType, _CoreType, extra) => {
  const source = new NodeType();
  const inputs = [...NODE_MATERIAL_INPUTS.slice(0, 23), ...extra];
  expect(Object.keys(source).filter((key) => key.endsWith('Node'))).toEqual(inputs);
  for (const field of inputs) {
    Reflect.set(source, field, new PUBLIC.ConstNode(1));
    expect(() => validateMaterial(source).unwrap(), field).toThrow(`NodeMaterial.${field}`);
    Reflect.set(source, field, undefined);
    expect(() => validateMaterial(source).unwrap(), field).toThrow(`NodeMaterial.${field}`);
    Reflect.deleteProperty(source, field);
    expect(() => validateMaterial(source).unwrap(), field).toThrow(`NodeMaterial.${field}`);
    Reflect.set(source, field, null);
  }
  const hook = source.setup;
  source.setup = () => {
    throw new Error('must not execute');
  };
  expect(() => validateMaterial(source).unwrap()).toThrow('setup override');
  source.setup = hook;
  const lights = source.lights;
  source.lights = !lights;
  expect(() => validateMaterial(source).unwrap()).toThrow('lighting variant');
  source.lights = lights;
  expect(validateMaterial(source).ok).toBe(true);
  source.dispose();
});

it('preserves public constructor families and copy/JSON for every additional model', () => {
  expect(new PUBLIC.PointsNodeMaterial().transparent).toBe(true);
  for (const Type of [
    PUBLIC.MeshLambertNodeMaterial,
    PUBLIC.MeshNormalNodeMaterial,
    PUBLIC.MeshMatcapNodeMaterial,
    PUBLIC.LineBasicNodeMaterial,
    PUBLIC.LineDashedNodeMaterial,
    PUBLIC.PointsNodeMaterial,
    PUBLIC.SpriteNodeMaterial,
  ]) {
    const source = new Type();
    expect(source).toBeInstanceOf(PUBLIC.NodeMaterial);
    expect(source.clone()).toBeInstanceOf(Type);
    expect(source.toJSON().type).toBe(source.type);
    source.dispose();
  }
});

it('projects NodeMaterial dashOffset with positive, negative and constant source distances', () => {
  const geometry = new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(2, 0, 0)]);
  const material = new LineDashedNodeMaterial({ dashSize: 0.2, gapSize: 0.3, dashOffset: 0.1 });
  const line = new Line(geometry, material);
  line.computeLineDistances();
  const mesh = projectGeometry(geometry, false, undefined, 'line-strip').unwrap();
  if (mesh === undefined) throw new Error('missing projected line');
  try {
    expect(lineStyle(line, mesh, [material])).toEqual({
      dashSize: 0.2,
      gapSize: 0.3,
      dashOffset: 0.1,
    });
    material.scale = -2;
    expect(lineStyle(line, mesh, [material])).toEqual({
      dashSize: 0.1,
      gapSize: 0.15,
      dashOffset: 0.05,
    });
    material.scale = 0;
    material.dashOffset = 0.3;
    expect(lineStyle(line, mesh, [material])).toBeNull();
    material.dashOffset = 0.1;
    expect(lineStyle(line, mesh, [material])).toEqual({ dashSize: 1, gapSize: 0, dashOffset: 0 });
    geometry.deleteAttribute('lineDistance');
    material.dashOffset = 0.3;
    expect(lineStyle(line, mesh, [material])).toBeNull();
    material.dashOffset = Number.NaN;
    expect(() => lineStyle(line, mesh, [material])).toThrow('dashOffset');
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

it('rejects NodeMaterial topology changes before publishing native entities', () => {
  const assets = new AssetRegistry(),
    projection = new SceneProjection(assets);
  const scene = new Scene(),
    camera = new PerspectiveCamera();
  const geometry = new BufferGeometry();
  const spriteSource = new SpriteNodeMaterial(),
    pointsSource = new PointsNodeMaterial();
  const meshes = [new Mesh(geometry, spriteSource), new Sprite(pointsSource)];
  try {
    for (const object of meshes) {
      // Give the mesh actual positions so source admission cannot disappear as an empty draw.
      if (object instanceof Mesh)
        object.geometry.setFromPoints([
          new Vector3(0, 0, 0),
          new Vector3(1, 0, 0),
          new Vector3(0, 1, 0),
        ]);
      scene.add(object);
      expect(() => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1))).toThrow(
        object instanceof Sprite
          ? 'PointsNodeMaterial requires Points'
          : 'SpriteNodeMaterial requires a Sprite',
      );
      expect(projection.entityFor(object)).toBeUndefined();
      scene.remove(object);
    }
  } finally {
    projection.dispose();
    assets.dispose();
    geometry.dispose();
    spriteSource.dispose();
    pointsSource.dispose();
  }
});
