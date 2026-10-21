import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

function fixture() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'main', program: { module: 'forgeax::unlit' } }],
      values: { baseColor: [1, 1, 1, 1] },
    })
    .unwrap();
  return { world, mesh, material };
}

describe('Bug 1: registerComponent before spawn does not break render query', () => {
  it('entities are included in renderables when an unrelated component is pre-registered', () => {
    const { world, mesh, material } = fixture();

    defineComponent('Bug1Unrelated', { value: 'f32' });

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();

    const frame = extractFrame(world, prepareExtractContext(world, { cull: 'none' }));
    expect(frame.renderables.length).toBe(1);
  });

  it('query still matches when the render component itself is pre-registered', () => {
    const { world, mesh, material } = fixture();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();

    const frame = extractFrame(world, prepareExtractContext(world, { cull: 'none' }));
    expect(frame.renderables.length).toBe(1);
  });
});

describe('Bug 2: ChildOf entities are included in renderables', () => {
  it('entity with ChildOf + Transform + MeshFilter + MeshRenderer is rendered', () => {
    const { world, mesh, material } = fixture();

    const parent = world
      .spawn({
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      })
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [1, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
        { component: ChildOf, data: { parent } },
      )
      .unwrap();

    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.renderables.length).toBe(1);
  });

  it('multiple ChildOf entities all appear in renderables', () => {
    const { world, mesh, material } = fixture();

    const parent = world
      .spawn({
        component: Transform,
        data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
      })
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    for (let n = 0; n < 3; n++) {
      world
        .spawn(
          {
            component: Transform,
            data: { pos: [n, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();
    }

    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.renderables.length).toBe(3);
  });
});

describe('Bug 3: unlit material renders without DirectionalLight', () => {
  it('extractFrame returns renderables for unlit entities even with zero lights', () => {
    const { world, mesh, material } = fixture();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();

    const frame = extractFrame(world, prepareExtractContext(world));
    // No lights spawned - but unlit material should still produce renderables.
    expect(frame.lights.directional).toBeUndefined();
    expect(frame.lights.directionalCount).toBe(0);
    expect(frame.renderables.length).toBe(1);
  });

  it('extractFrame does not early-return when no light entity exists', () => {
    const { world, mesh, material } = fixture();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();

    world
      .spawn(
        {
          component: Transform,
          data: { pos: [2, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();

    const frame = extractFrame(world, prepareExtractContext(world));
    expect(frame.renderables.length).toBe(2);
    expect(frame.cameras.length).toBe(1);
  });
});
