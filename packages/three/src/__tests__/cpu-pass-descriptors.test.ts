import { Color, Object3D, PerspectiveCamera, Scene, Texture } from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { GLSLNodeParser, ReflectorNode, ToonOutlinePassNode } from '../cpu';
import { validateMaterial } from '../material';
import { MeshBasicNodeMaterial } from '../node-materials';
import { RTTNode } from '../node-rtt';
import { uniform } from '../tsl';

it('parses independent GLSL signatures and code without a runtime NodeBuilder', () => {
  const parser = new GLSLNodeParser();
  const a = parser.parseFunction(
    'highp vec3 tint(in vec3 value, const float amount) { return value * amount; }',
  );
  expect(a.name).toBe('tint');
  expect(a.type).toBe('vec3');
  expect(a.precision).toBe('highp');
  expect(
    a.inputs.map((v) => ({
      name: v.name,
      type: v.type,
      qualifier: v.qualifier,
      isConst: v.isConst,
    })),
  ).toEqual([
    { name: 'value', type: 'vec3', qualifier: 'in', isConst: false },
    { name: 'amount', type: 'float', qualifier: '', isConst: true },
  ]);
  expect(a.getCode('renamed')).toContain('renamed');
  const b = parser.parseFunction('float scalar(float value) { return value; }');
  expect(b.name).toBe('scalar');
  expect(a.name).toBe('tint');
  expect(() => parser.parseFunction('not a function')).toThrow();
});
it('owns RTT CPU texture identity, resolution updates and disposal without admitting a native graph', () => {
  const input = uniform(new Color('red')),
    node = new RTTNode(input, 40, 20, { resolutionScale: 0.5, autoUpdate: false });
  expect(node.node).toBe(input);
  expect(node.value).toBe(node.renderTarget.texture);
  expect(node.autoResize).toBe(false);
  node.setResolutionScale(0.5);
  expect(node.renderTarget.width).toBe(20);
  expect(node.renderTarget.height).toBe(10);
  node.setSize(60, 30);
  expect(node.renderTarget.width).toBe(30);
  expect(node.renderTarget.height).toBe(15);
  expect(node.textureNeedsUpdate).toBe(true);
  expect(node.autoUpdate).toBe(false);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = node;
  expect(() => validateMaterial(material).unwrap()).toThrow('three-unsupported');
  let disposed = 0;
  node.renderTarget.addEventListener('dispose', () => disposed++);
  node.dispose();
  expect(disposed).toBe(1);
  material.dispose();
});
it('shares reflector color/depth views and caches virtual cameras and CPU targets', () => {
  const target = new Object3D(),
    node = new ReflectorNode({
      target,
      depth: true,
      samples: 4,
      generateMipmaps: true,
      resolutionScale: 0.5,
    });
  const camera = new PerspectiveCamera(),
    other = new PerspectiveCamera(),
    depth = node.getDepthNode();
  expect(node.target).toBe(target);
  expect(depth.reflector).toBe(node.reflector);
  expect(node.getDepthNode()).toBe(depth);
  expect(node.reflector.getVirtualCamera(camera)).toBe(node.reflector.getVirtualCamera(camera));
  expect(node.reflector.getVirtualCamera(camera)).not.toBe(camera);
  const a = node.reflector.getRenderTarget(camera),
    b = node.reflector.getRenderTarget(other);
  expect(node.reflector.getRenderTarget(camera)).toBe(a);
  expect(a).not.toBe(b);
  expect(a.samples).toBe(4);
  expect(a.depthTexture).toBeInstanceOf(Texture);
  let disposed = 0;
  a.addEventListener('dispose', () => disposed++);
  b.addEventListener('dispose', () => disposed++);
  node.dispose();
  expect(disposed).toBe(2);
  const noDepth = new ReflectorNode();
  expect(() => noDepth.getDepthNode()).toThrow('depth');
  noDepth.dispose();
});
it('retains toon pass CPU inputs, target sizes and disposal without rendering it', () => {
  const scene = new Scene(),
    camera = new PerspectiveCamera(),
    color = uniform(new Color('black')),
    thickness = uniform(0.01),
    alpha = uniform(0.5);
  const node = new ToonOutlinePassNode(scene, camera, color, thickness, alpha);
  expect(node.scene).toBe(scene);
  expect(node.camera).toBe(camera);
  expect(node.colorNode).toBe(color);
  expect(node.thicknessNode).toBe(thickness);
  expect(node.alphaNode).toBe(alpha);
  node.setSize(40, 20);
  expect(node.renderTarget.width).toBe(40);
  expect(node.renderTarget.height).toBe(20);
  let disposed = 0;
  node.renderTarget.addEventListener('dispose', () => disposed++);
  node.dispose();
  expect(disposed).toBe(1);
});
