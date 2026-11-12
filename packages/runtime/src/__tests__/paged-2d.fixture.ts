import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  Camera,
  Instances,
  MeshFilter,
  MeshRenderer,
  type Renderer,
} from '@forgeax/engine-render';
import { SpriteInstances, SpriteRegionOverride, Tilemap } from '@forgeax/engine-render/authoring';
import type { EncodedTape, RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { halfToFloat } from './contact-shadow.fixture';
import { renderValue } from './standard-gbuffer-replay.fixture';

export type Paged2dCase = 'sprite-fold' | 'sprite-instances' | 'instances' | 'tilemap';
const COLS = 32,
  ROWS = 16,
  COUNT = COLS * ROWS;

function buildPagedScene(assets: AssetRegistry, kind: Paged2dCase) {
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const atlas = assets
    .create({
      kind: 'texture',
      format: 'rgba8unorm',
      colorSpace: 'linear',
      shape: { viewDimension: '2d', extent: { width: 2, height: 1 } },
      mips: { kind: 'none' },
      data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
    })
    .unwrap();
  const transforms = new Float32Array(COUNT * 16);
  const regions = new Float32Array(COUNT * 4);
  for (let index = 0; index < COUNT; index++) {
    const offset = index * 16;
    transforms[offset] =
      transforms[offset + 5] =
      transforms[offset + 10] =
      transforms[offset + 15] =
        1;
    transforms[offset + 12] = (index % COLS) + 0.5;
    transforms[offset + 13] = Math.floor(index / COLS) + 0.5;
    regions.set([0, 0, 0.5, 1], index * 4);
  }
  const entities: EntityHandle[] = [];
  const tiles = new Uint32Array(COUNT).fill(1);
  if (kind === 'tilemap') {
    const tileset = assets
      .create({
        kind: 'tileset',
        atlases: [atlas],
        tileWidth: 1,
        tileHeight: 1,
        columns: 2,
        rows: 1,
        regions: [
          { x: 0, y: 0, width: 1, height: 1 },
          { x: 1, y: 0, width: 1, height: 1 },
        ],
        tiles: [{ regionIndex: 0 }, { regionIndex: 1 }],
      })
      .unwrap();
    entities.push(
      world
        .spawn(
          { component: Transform, data: {} },
          { component: Tilemap, data: { tileset, cols: COLS, rows: ROWS, chunkSize: 32, tiles } },
        )
        .unwrap(),
    );
  } else {
    const mesh = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    const sampler = assets
      .create({
        kind: 'sampler',
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      })
      .unwrap();
    const material = assets
      .create({
        kind: 'material',
        passes: [
          {
            name: 'Forward',
            program: { module: 'forgeax::sprite' },
            renderState: {
              tags: { LightMode: 'Forward' },
              cullMode: 'none',
              depthWriteEnabled: false,
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          },
        ],
        values: {
          colorTint: [1, 1, 1, 1],
          region: [0, 0, 0.5, 1],
          pivotAndSize: [0.5, 0.5, 1, 1],
          slicesAndMode: [0, 0, 0, 0],
          flipX: 0,
          flipY: 0,
          baseColorTexture: { texture: atlas, sampler },
        },
      })
      .unwrap();
    if (kind === 'sprite-fold') {
      for (let index = 0; index < COUNT; index++)
        entities.push(
          world
            .spawn(
              {
                component: Transform,
                data: { pos: [(index % COLS) + 0.5, Math.floor(index / COLS) + 0.5, 0] },
              },
              { component: MeshFilter, data: { assetHandle: mesh } },
              { component: MeshRenderer, data: { materials: [material] } },
            )
            .unwrap(),
        );
    } else {
      const entity = world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [material] } },
        )
        .unwrap();
      if (kind === 'instances')
        world.addComponent(entity, { component: Instances, data: { transforms } }).unwrap();
      else
        world
          .addComponent(entity, { component: SpriteInstances, data: { transforms, regions } })
          .unwrap();
      entities.push(entity);
    }
  }
  world
    .spawn(
      { component: Transform, data: { pos: [COLS / 2, ROWS / 2, 5] } },
      {
        component: Camera,
        data: {
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -COLS / 2,
          right: COLS / 2,
          bottom: -ROWS / 2,
          top: ROWS / 2,
          near: 0.1,
          far: 10,
          aspect: 2,
          tonemap: 1,
          bloom: 0,
          antialias: 0,
          clearColor: [0, 0, 0, 1],
        },
      },
    )
    .unwrap();
  const edit = (phase: 1 | 2) => {
    const entity = entities[0];
    if (entity === undefined) throw new Error('Missing 2D source');
    if (kind === 'tilemap') {
      if (phase === 1) {
        tiles[128] = 2;
        tiles[511] = 2;
      } else tiles.fill(0, 0, 257);
      world.set(entity, Tilemap, { tiles }).unwrap();
    } else if (kind === 'sprite-fold') {
      if (phase === 1)
        for (const index of [128, 511])
          world
            .addComponent(entities[index] as EntityHandle, {
              component: SpriteRegionOverride,
              data: { region: [0.5, 0, 0.5, 1] },
            })
            .unwrap();
      else for (const entity of entities.slice(0, 257)) world.despawn(entity).unwrap();
    } else if (kind === 'sprite-instances') {
      if (phase === 1) {
        regions[128 * 4] = 0.5;
        regions[511 * 4] = 0.5;
      }
      world
        .set(entity, SpriteInstances, {
          transforms: phase === 2 ? transforms.slice(257 * 16) : transforms,
          regions: phase === 2 ? regions.slice(257 * 4) : regions,
        })
        .unwrap();
    } else if (phase === 2)
      world.set(entity, Instances, { transforms: transforms.slice(257 * 16) }).unwrap();
  };
  return { world, edit };
}

/** Full public World path, independent per-cell HDR assertions, atlas edits and collection shrink. */
export async function verifyPaged2d(
  renderer: Renderer,
  assets: AssetRegistry,
  recorder: RecorderAttachment,
  kind: Paged2dCase,
  save: (name: string, tape: EncodedTape, pixels: Uint8Array) => Promise<void>,
) {
  const { world, edit } = buildPagedScene(assets, kind);
  const lease = renderValue(renderer.attach(world));
  const errors: unknown[] = [];
  const off = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  try {
    for (let frame = 0; frame < 60; frame++) {
      if (frame === 20) edit(1);
      if (frame === 40) edit(2);
      world.update(1 / 60).unwrap();
      const capture = frame % 20 === 19 || frame === 20 ? recorder.captureFrame() : undefined;
      if (capture) (await recorder.frameBoundary()).unwrap();
      const receipt = await drawReadyFrame(
        renderer,
        { leases: [lease], camera: { lease }, environment: { lease } },
        ['linear-hdr'],
      );
      if (capture) (await recorder.frameBoundary()).unwrap();
      const observation = renderValue(
        await renderer.observe(receipt, { include: ['linear-hdr'] }),
      ).observations?.find((value) => value.domain === 'linear-hdr');
      if (observation === undefined) throw new Error('Missing 2D linear HDR pixels');
      if (capture) await save(`frame-${frame}`, (await capture).unwrap(), observation.bytes);
      const view = new DataView(
        observation.bytes.buffer,
        observation.bytes.byteOffset,
        observation.bytes.byteLength,
      );
      const stride = observation.metadata.bytesPerRow;
      for (let index = 0; index < COUNT; index++) {
        const x = (index % COLS) * 4 + 2;
        const y = (ROWS - 1 - Math.floor(index / COLS)) * 4 + 2;
        const offset = y * stride + x * 8;
        const empty = frame >= 40 && index < 257;
        const green = kind !== 'instances' && frame >= 20 && (index === 128 || index === 511);
        const expected = empty ? [0, 0, 0] : green ? [0, 1, 0] : [1, 0, 0];
        for (let channel = 0; channel < 3; channel++)
          expect(
            Math.abs(
              halfToFloat(view.getUint16(offset + channel * 2, true)) - (expected[channel] ?? 0),
            ),
            `${kind} frame ${frame} cell ${index} channel ${channel}`,
          ).toBeLessThan(0.05);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    off();
    lease.dispose();
  }
}
