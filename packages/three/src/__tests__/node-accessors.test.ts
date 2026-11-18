import * as THREE from '@forgeax/engine/three';
import { expect, it } from 'vitest';

it('keeps original buffer, material, renderer and object accessor data in the public family', () => {
  const buffer = new THREE.BufferAttribute(new Float32Array([1, 2, 3]), 3);
  const object = new THREE.Object3D(),
    material = new THREE.MeshBasicMaterial();
  const attribute = new THREE.BufferAttributeNode(buffer, 'vec3');
  const ref = new THREE.ReferenceAttributeNode('position', 'vec3', { position: buffer });
  const materialRef = new THREE.MaterialReferenceNode('opacity', 'float', material);
  const rendererRef = new THREE.RendererReferenceNode('toneMappingExposure', 'float');
  const objectNode = new THREE.Object3DNode(THREE.Object3DNode.WORLD_MATRIX, object);
  const model = new THREE.ModelNode(THREE.ModelNode.WORLD_MATRIX);
  const color = new THREE.MaterialNode(THREE.MaterialNode.COLOR);
  for (const node of [attribute, ref, materialRef, rendererRef, objectNode, model, color])
    expect(node).toBeInstanceOf(THREE.Node);
  expect(attribute.value).toBe(buffer);
  expect(materialRef.material).toBe(material);
  expect(objectNode.object3d).toBe(object);
  expect(color.scope).toBe(THREE.MaterialNode.COLOR);
  material.dispose();
});

it('preserves sampling, packing, varying and range source operands without invoking a builder', () => {
  const input = THREE.TSL.float(0.5),
    integer = THREE.TSL.uint(1),
    vector = THREE.TSL.vec2(0.2, 0.4);
  const pack = new THREE.PackFloatNode('float16', vector),
    unpack = new THREE.UnpackFloatNode('float16', integer);
  const packed = new THREE.Packed4x8IntegerNode(THREE.Packed4x8IntegerNode.PACK4X_U8, integer);
  const bits = new THREE.BitcountNode(THREE.BitcountNode.COUNT_ONE_BITS, integer);
  const sample = new THREE.SampleNode(() => input);
  const varying = new THREE.VaryingNode(input, 'weight');
  const range = new THREE.RangeNode(input, THREE.TSL.float(0.8));
  for (const node of [pack, unpack, packed, bits, sample, varying, range])
    expect(node).toBeInstanceOf(THREE.Node);
  expect(pack.vectorNode).toBe(vector);
  expect(unpack.uintNode).toBe(integer);
  expect(packed.aNode).toBe(integer);
  expect(range.minNode).toBe(input);
  expect(varying.name).toBe('weight');
  expect(pack.encoding).toBe('float16');
  expect(pack.toJSON()).toMatchObject({ type: 'PackFloatNode' });
});

it('keeps texture, normal and display accessor metadata separate from native execution', () => {
  const texture = new THREE.DataTexture(new Uint8Array(16), 2, 2),
    tex = THREE.TSL.texture(texture);
  const size = new THREE.TextureSizeNode(tex),
    mip = new THREE.MaxMipLevelNode(tex);
  const uv = new THREE.PointUVNode(),
    screen = new THREE.ScreenNode(THREE.ScreenNode.UV);
  const depth = new THREE.ViewportDepthNode(THREE.ViewportDepthNode.DEPTH);
  const color = new THREE.ColorSpaceNode(
    THREE.TSL.vec4(1),
    THREE.LinearSRGBColorSpace,
    THREE.SRGBColorSpace,
  );
  const tone = new THREE.ToneMappingNode(THREE.NoToneMapping);
  const bump = new THREE.BumpMapNode(tex),
    normal = new THREE.NormalMapNode(tex);
  for (const node of [size, mip, uv, screen, depth, color, tone, bump, normal])
    expect(node).toBeInstanceOf(THREE.Node);
  expect(size.textureNode).toBe(tex);
  expect(bump.textureNode).toBe(tex);
  expect(normal.node).toBe(tex);
  expect(color.source).toBe(THREE.LinearSRGBColorSpace);
  expect(color.target).toBe(THREE.SRGBColorSpace);
  texture.dispose();
});
