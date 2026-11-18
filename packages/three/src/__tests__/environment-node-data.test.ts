import { expect, it } from 'vitest';
import * as THREE from '../cpu';
import { validateMaterial } from '../material';

it('preserves environment/lightmap input identities without driving their GPU setup', () => {
  const input = new THREE.UniformNode(new THREE.Color('red'));
  const nodes = [
    new THREE.BasicEnvironmentNode(input),
    new THREE.BasicLightMapNode(input),
    new THREE.EnvironmentNode(input),
  ];
  expect(Reflect.get(nodes[0] ?? {}, 'envNode')).toBe(input);
  expect(Reflect.get(nodes[1] ?? {}, 'lightMapNode')).toBe(input);
  expect(Reflect.get(nodes[2] ?? {}, 'envNode')).toBe(input);
  for (const node of nodes) {
    expect(node).toBeInstanceOf(THREE.LightingNode);
    node.dispose();
  }
});

it('keeps cube/PMREM descriptions CPU-owned and does not perform environment conversion', () => {
  const source = new THREE.Texture(),
    textureNode = new THREE.TextureNode(source);
  const cube = new THREE.CubeMapNode(textureNode),
    pmrem = new THREE.PMREMNode(source);
  expect(cube.envNode).toBe(textureNode);
  expect(pmrem.value).toBe(source);
  expect(Reflect.get(pmrem, '_generator')).toBeNull();
  const target = new THREE.CubeRenderTarget(16);
  expect(target.texture).toBeInstanceOf(THREE.CubeTexture);
  expect(target.width).toBe(16);
  target.setSize(8, 8);
  expect(target.height).toBe(8);
  cube.dispose();
  pmrem.dispose();
  target.dispose();
  source.dispose();
});

it('preserves shadow source identity and explicit shared CPU shadow-material retirement', () => {
  const light = new THREE.DirectionalLight(),
    point = new THREE.PointLight();
  const base = new THREE.ShadowBaseNode(light),
    shadow = new THREE.ShadowNode(light),
    pointShadow = new THREE.PointShadowNode(point);
  expect(base.light).toBe(light);
  expect(shadow.shadow).toBe(light.shadow);
  expect(pointShadow.light).toBe(point);
  const material = base.getShadowMaterial();
  expect(material).toBe(shadow.getShadowMaterial());
  expect(material).toBeInstanceOf(THREE.NodeMaterial);
  expect(Reflect.get(shadow, 'shadowMap')).toBeNull();
  base.disposeShadowMaterial();
  expect(base.getShadowMaterial()).not.toBe(material);
  base.disposeShadowMaterial();
  for (const node of [base, shadow, pointShadow]) node.dispose();
  light.dispose();
  point.dispose();
});

it('keeps viewport sharing and depth descriptors while rejecting them as native material leaves', () => {
  const owned = new THREE.ViewportTextureNode(),
    a = new THREE.ViewportSharedTextureNode(),
    b = new THREE.ViewportSharedTextureNode();
  const depth = new THREE.ViewportDepthTextureNode();
  expect(a.value).toBe(b.value);
  expect(owned.value).not.toBe(a.value);
  expect(Reflect.get(owned.value, 'isFramebufferTexture')).toBe(true);
  expect(Reflect.get(depth.value, 'isDepthTexture')).toBe(true);
  const material = new THREE.MeshBasicNodeMaterial();
  for (const node of [owned, a, depth]) {
    material.colorNode = node;
    expect(() => validateMaterial(material).unwrap()).toThrow('NodeMaterial.colorNode');
  }
  for (const node of [owned, a, b, depth]) node.dispose();
  material.dispose();
});

it('retains pass scene/camera, attachment identities, CPU sizing and explicit disposal', () => {
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera();
  const pass = new THREE.PassNode(THREE.PassNode.COLOR, scene, camera);
  expect(pass.scene).toBe(scene);
  expect(pass.camera).toBe(camera);
  pass.setSize(64, 32);
  pass.setResolutionScale(0.5);
  pass.setSize(64, 32);
  expect(pass.renderTarget.width).toBe(32);
  expect(pass.renderTarget.height).toBe(16);
  expect(pass.getTexture('output')).toBe(pass.renderTarget.texture);
  expect(pass.getTextureNode().value).toBe(pass.renderTarget.texture);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = pass.getTextureNode();
  expect(() => validateMaterial(material).unwrap()).toThrow('NodeMaterial.colorNode');
  pass.dispose();
  material.dispose();
});

it('updates original velocity history only through an explicit caller frame', () => {
  const node = new THREE.VelocityNode(),
    frame = new THREE.NodeFrame(),
    object = new THREE.Object3D(),
    camera = new THREE.PerspectiveCamera();
  frame.object = object;
  frame.camera = camera;
  frame.frameId = 1;
  object.position.x = 2;
  object.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  node.update(frame);
  node.updateAfter(frame);
  object.position.x = 5;
  object.updateMatrixWorld(true);
  frame.frameId = 2;
  node.update(frame);
  expect(Reflect.get(node.previousModelWorldMatrix, 'value').elements[12]).toBe(2);
  const projection = new THREE.Matrix4().makeScale(2, 3, 1);
  node.setProjectionMatrix(projection);
  frame.frameId = 3;
  node.update(frame);
  expect(Reflect.get(node.currentProjectionMatrix, 'value').elements).toEqual(projection.elements);
  expect(node.projectionMatrix).toBe(projection);
  node.dispose();
});
