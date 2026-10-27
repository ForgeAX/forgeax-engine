import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { createRenderTargetHost } from '../../assembly/render-target-host';
import {
  Camera,
  CameraView,
  CubeCamera,
  MeshFilter,
  MeshRenderer,
  PlanarReflection,
  Visibility,
  VisibilityStateValue,
} from '../../components';
import type { RenderResult } from '../../render-contract';
import {
  projectAuxiliaryCamerasForView,
  type RenderableSnapshot,
} from '../../render-system-extract';
import type { RenderTargetDescriptor } from '../../targets/contracts';
import { resolveRenderTargetMaterialSource } from '../../targets/material-source';
import { isCanvasTextureSource } from '../../textures/canvas-texture';
import { isExternalTextureSource } from '../../textures/external-texture';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../record';
import { RenderPublicationTargetOwner, RenderPublicationTargetReceiver } from '../targets';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

function unwrap<T, E>(result: RenderResult<T, E>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 32,
  height: 32,
  format: 'rgba8unorm-srgb',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: false,
};

it('maps auxiliary/cube cameras and distinct material targets into the receiver owner, including resize and retirement', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const source = new RenderPublicationTargetOwner();
  const host = createRenderTargetHost();
  const projection = new RenderPublicationTargetReceiver(host);
  const identity = { source: 'target-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [], source);
  const receiver = new RenderPublicationReceiver(identity);
  const first = unwrap(source.authoring.createRenderTarget(descriptor));
  const second = unwrap(source.authoring.createRenderTarget(descriptor));
  const cube = unwrap(source.authoring.createRenderTarget({ ...descriptor, shape: 'cube' }));
  const target = world.allocSharedRef('RenderTarget', first);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { target } },
    )
    .unwrap();
  const cubeEntity = world
    .spawn(
      { component: Transform, data: {} },
      { component: CubeCamera, data: { target: world.allocSharedRef('RenderTarget', cube) } },
    )
    .unwrap();
  const cubeMesh = assets.create(BUILTIN_CUBE).unwrap();
  for (const target of [first, second]) {
    const texture = unwrap(
      source.authoring.createRenderTargetTextureSource(target, {
        aspect: 'color',
        dimension: '2d',
        mipLevel: 0,
      }),
    );
    const textureRef = { source: texture };
    const material = assets
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::default-standard-pbr' },
            renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
          },
        ],
        values: { baseColorTexture: textureRef },
      })
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: cubeMesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  world.update(0).unwrap();
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const result = projection.apply(receiver.accept(encodeRenderPublication(packet)).unwrap());
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return result;
  };
  const initial = publish();
  expect(initial.packet.templates).toHaveLength(2);
  expect(initial.packet.targetSources).toHaveLength(2);
  const remote = initial.frame.auxiliaryCameras[0]?.target;
  expect(remote).toBeDefined();
  expect(remote).not.toBe(first);
  expect(host.descriptions().find((row) => row.target === remote)?.descriptor).toEqual(descriptor);
  expect(initial.frame.cubeCameras).toHaveLength(1);
  const bindings = initial.frame.renderables.map((row) => {
    const source = row.material.snapshot.textureSources?.get('baseColorTexture');
    if (source === undefined || isCanvasTextureSource(source) || isExternalTextureSource(source))
      throw new Error('Missing published target source');
    return resolveRenderTargetMaterialSource(source);
  });
  expect(bindings.every((binding) => binding !== undefined)).toBe(true);
  expect(bindings[0]?.target).not.toBe(bindings[1]?.target);
  unwrap(source.authoring.resizeRenderTarget(first, { ...descriptor, width: 64 }));
  const resized = publish();
  expect(resized.frame.auxiliaryCameras[0]?.target).toBe(remote);
  expect(host.descriptions().find((row) => row.target === remote)?.descriptor.width).toBe(64);
  world.despawn(camera).unwrap();
  world.despawn(cubeEntity).unwrap();
  unwrap(source.authoring.destroyRenderTarget(cube));
  publish();
  expect(host.descriptions()).toHaveLength(2);
  publisher.dispose();
  source.dispose();
  host.dispose();
  receiver.dispose();
  assets.dispose();
});

it('publishes every display-owned planar target once and rejects duplicate output writers', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const source = new RenderPublicationTargetOwner();
  const host = createRenderTargetHost();
  const identity = { source: 'planar-target-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [], source);
  const receiver = new RenderPublicationReceiver(identity, host);
  const authored = [0, 5].map((x) => {
    const target = unwrap(
      source.authoring.createRenderTarget({ ...descriptor, format: 'rgba8unorm' }),
    );
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [x, 3, 5] } },
        { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
        { component: CameraView, data: {} },
        {
          component: PlanarReflection,
          data: { target: world.allocSharedRef('RenderTarget', target) },
        },
      )
      .unwrap();
    return { entity, target };
  });
  propagateTransforms(world).unwrap();
  const candidate = publisher.prepare(0).unwrap();
  const packet = structuredClone(candidate.packet);
  candidate.accept();
  expect(packet.metadata.auxiliaryCameras).toHaveLength(2);
  expect(packet.targets).toHaveLength(2);
  const invalid = structuredClone(packet);
  const first = invalid.metadata.auxiliaryCameras[0];
  const second = invalid.metadata.auxiliaryCameras[1];
  if (first?.target === undefined || second === undefined)
    throw new Error('Missing capture metadata');
  const duplicate = {
    ...invalid,
    metadata: {
      ...invalid.metadata,
      auxiliaryCameras: [first, { ...second, target: first.target }],
    },
  };
  const rejected = receiver.accept(encodeRenderPublication(duplicate));
  expect(rejected.ok).toBe(false);
  const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
  for (const item of authored) {
    const display = accepted.frame.cameras.find(
      (camera) => camera.entityKey === Number(item.entity),
    );
    const captures = projectAuxiliaryCamerasForView(display, accepted.frame.auxiliaryCameras);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.target).not.toBe(item.target);
    expect(captures[0]?.position[1]).toBe(-3);
    expect(captures[0]?.planarReflection).not.toHaveProperty('target');
  }
  expect(accepted.frame.auxiliaryCameras[0]?.target).not.toBe(
    accepted.frame.auxiliaryCameras[1]?.target,
  );
  publisher.dispose();
  source.dispose();
  host.dispose();
  receiver.dispose();
  assets.dispose();
});

it('keeps a held render-target material bound when a later packet adds a row that references it', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const source = new RenderPublicationTargetOwner();
  const host = createRenderTargetHost();
  const identity = { source: 'held-target-material', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [], source);
  const receiver = new RenderPublicationReceiver(identity, host);
  const target = unwrap(source.authoring.createRenderTarget(descriptor));
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { target: world.allocSharedRef('RenderTarget', target) } },
    )
    .unwrap();
  const texture = unwrap(
    source.authoring.createRenderTargetTextureSource(target, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
    }),
  );
  const material = assets
    .create({
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: { baseColorTexture: { source: texture } },
    })
    .unwrap();
  const cubeMesh = assets.create(BUILTIN_CUBE).unwrap();
  const screen = (x: number) =>
    world
      .spawn(
        { component: Transform, data: { pos: [x, 0, 0] } },
        { component: MeshFilter, data: { assetHandle: cubeMesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  const publish = () => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return { packet, accepted };
  };
  const remoteTarget = (row: {
    material: { snapshot: { textureSources?: ReadonlyMap<string, unknown> } };
  }) => {
    const bound = row.material.snapshot.textureSources?.get('baseColorTexture');
    if (
      bound === undefined ||
      isCanvasTextureSource(bound as never) ||
      isExternalTextureSource(bound as never)
    )
      throw new Error('Missing published target source');
    return resolveRenderTargetMaterialSource(bound as never)?.target;
  };
  screen(0);
  const first = publish();
  expect(first.packet.targetSources).toHaveLength(1);
  const bound = remoteTarget(first.accepted.frame.renderables.at(0) as never);
  expect(bound).toBeDefined();
  expect(bound).not.toBe(target);
  screen(2);
  const second = publish();
  expect(second.packet.materials).toHaveLength(0);
  expect(second.packet.targetSources).toHaveLength(1);
  expect(second.accepted.frame.renderables).toHaveLength(1);
  expect(remoteTarget(second.accepted.frame.renderables.at(0) as never)).toBe(bound);
  publisher.dispose();
  source.dispose();
  host.dispose();
  receiver.dispose();
  assets.dispose();
});

it('keeps a render-target slot override bound when its row is published again', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const source = new RenderPublicationTargetOwner();
  const host = createRenderTargetHost();
  const identity = { source: 'target-slot-override', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [], source);
  const receiver = new RenderPublicationReceiver(identity, host);
  const pass = {
    name: 'Forward',
    program: { module: 'forgeax::default-standard-pbr' },
    renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
  };
  const cubeMesh = assets.create(BUILTIN_CUBE).unwrap();
  const plain = assets.create({ kind: 'material', passes: [pass], values: {} }).unwrap();
  const screen = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: cubeMesh } },
      { component: MeshRenderer, data: { materials: [plain] } },
    )
    .unwrap();
  const publish = () => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const accepted = receiver.accept(encodeRenderPublication(packet)).unwrap();
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return accepted;
  };
  const overrideTarget = (row: RenderableSnapshot | undefined) => {
    const bound = row?.materialOverrides?.[0]?.snapshot.textureSources?.get('baseColorTexture');
    if (bound === undefined || isCanvasTextureSource(bound) || isExternalTextureSource(bound))
      throw new Error('Missing published target source');
    return resolveRenderTargetMaterialSource(bound)?.target;
  };
  publish();
  // A cockpit monitor: the screen already exists, then its slot switches to a
  // material that samples an offscreen camera target.
  const target = unwrap(source.authoring.createRenderTarget(descriptor));
  const texture = unwrap(
    source.authoring.createRenderTargetTextureSource(target, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
    }),
  );
  const monitor = assets
    .create({ kind: 'material', passes: [pass], values: { baseColorTexture: { source: texture } } })
    .unwrap();
  world.set(screen, MeshRenderer, { materials: [monitor] }).unwrap();
  const first = publish();
  const bound = overrideTarget(first.frame.renderables.at(0));
  expect(bound).toBeDefined();
  expect(bound).not.toBe(target);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { target: world.allocSharedRef('RenderTarget', target) } },
    )
    .unwrap();
  world
    .addComponent(screen, {
      component: Visibility,
      data: { state: VisibilityStateValue.hidden },
    })
    .unwrap();
  publish();
  world.set(screen, Visibility, { state: VisibilityStateValue.inherited }).unwrap();
  const shown = publish();
  expect(shown.frame.renderables).toHaveLength(1);
  expect(overrideTarget(shown.frame.renderables.at(0))).toBe(bound);
  world.despawn(screen).unwrap();
  publish();
  publisher.dispose();
  source.dispose();
  host.dispose();
  receiver.dispose();
  assets.dispose();
});
