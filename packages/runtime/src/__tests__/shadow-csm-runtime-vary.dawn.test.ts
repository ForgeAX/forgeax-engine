import { shaderManifestUrl } from './shader-manifest-url.fixture';
// shadow-csm-runtime-vary.dawn.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M5 / w26: dynamic cascadeCount + mapSize via world.set dawn-node test.
//
// Covers AC-07 (runtime-mutable cascade fields take effect on the next
// frame; shadow atlas RT rebuilds on mapSize change without device error)
// + AC-10 (cascadeCount=1 degeneracy renders cleanly through the same
// pathway).
//
// Strategy: spin up a renderer with a minimal directional-light + shadow
// scene, draw N frames at cascadeCount=4, mutate to cascadeCount=2 via
// world.set and draw, mutate to cascadeCount=4 again, then walk
// mapSize from the shared test size to half and back. Asserts every draw returns
// `ok: true` and no device-lost / structured RhiError fires.
//
// This is a structural GPU behavior gate: the unified Standard shadow graph
// must rebuild its atlas and continue drawing without device errors.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it, onTestFinished } from 'vitest';
import testQuality from '../../../../scripts/test/render-quality.json' with { type: 'json' };
import { projectDirectionalShadowInspection } from '../../../render/src/assembly/directional-shadow-inspection';
import { resolveDirectionalShadowBackendAdmission } from '../../../render/src/render-pipeline';
import { constructRuntimeRendererHost } from '../renderer-host';
import { drawPublished } from './draw-published';

const ENGINE_MANIFEST = await (async () => {
  const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
  return buildEngineShaderManifest();
})();
const ENGINE_MANIFEST_URL = shaderManifestUrl(ENGINE_MANIFEST);

// biome-ignore lint/suspicious/noExplicitAny: dawn-node detection guard
const dawnReady = typeof navigator !== 'undefined' && (navigator as any).gpu !== undefined;

describe('M3 RhiNull structural admission', () => {
  it('requires the structural-only RhiNull projection and explicit no-pixel claim', async () => {
    const module = (await import('../../../render/src/render-pipeline')) as Record<string, unknown>;
    const resolver = module.resolveDirectionalShadowBackendAdmission;
    expect(typeof resolver).toBe('function');
    const result = (
      resolver as (input: {
        backendKind: 'null';
        requested: 'pcssMedium' | 'pcssHigh';
        candidate: 'accepted' | 'failed';
      }) => { effective: string; fallbackReason?: string; pixelEvidence: string }
    )({ backendKind: 'null', requested: 'pcssMedium', candidate: 'accepted' });
    expect(result).toMatchObject({
      effective: 'rhi-null-structural',
      fallbackReason: 'rhi-null-structural',
      pixelEvidence: 'not-available',
    });
  });

  it('keeps RhiNull recovery structural and generation-scoped', () => {
    const inspection = projectDirectionalShadowInspection({
      admission: resolveDirectionalShadowBackendAdmission({
        backendKind: 'null',
        requested: 'pcssMedium',
        candidate: 'accepted',
      }),
      cascadeCount: 4,
      mapSize: 1024,
      shadowMapBytes: 16_777_216,
      writerPasses: 4,
      blockerTaps: 0,
      filterTapUpperBound: 0,
      seamTapUpperBound: 0,
      deviceGeneration: 4,
      graphGeneration: 9,
    });
    expect(inspection).toMatchObject({
      effective: 'rhi-null-structural',
      pixelEvidence: 'not-available',
      deviceGeneration: 4,
      graphGeneration: 9,
    });
  });
});

const WIDTH = testQuality.viewport.width;
const HEIGHT = testQuality.viewport.height;
const MAP_SIZE = testQuality.shadowMapSize;

interface MockCanvas {
  width: number;
  height: number;
  getContext(kind: string): unknown;
}

function createMockCanvas(): MockCanvas {
  let renderTarget: GPUTexture | undefined;
  let sharedDevice: GPUDevice | undefined;
  return {
    width: WIDTH,
    height: HEIGHT,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format: GPUTextureFormat }): void {
          sharedDevice = desc.device;
          if (renderTarget === undefined) {
            renderTarget = desc.device.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format: desc.format,
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
          }
        },
        unconfigure(): void {
          renderTarget?.destroy();
          renderTarget = undefined;
          sharedDevice = undefined;
        },
        getCurrentTexture(): GPUTexture {
          if (renderTarget === undefined && sharedDevice !== undefined) {
            renderTarget = sharedDevice.createTexture({
              size: { width: WIDTH, height: HEIGHT, depthOrArrayLayers: 1 },
              format: 'rgba8unorm',
              usage: 0x10 | 0x01,
              viewFormats: ['rgba8unorm-srgb'],
            });
          }
          if (renderTarget === undefined) throw new Error('no render target');
          return renderTarget;
        },
      };
    },
  };
}

interface SceneEntities {
  world: World;
  shadowEntity: EntityHandle;
}

function buildScene(initialCascadeCount: number, initialMapSize: number): SceneEntities {
  const world = new World();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { component: Camera, data: { fov: 1.0472, near: 0.1, far: 60 } },
    )
    .unwrap();
  const shadowEntity = world
    .spawn({
      component: DirectionalLight,
      data: {
        castShadow: true,
        direction: [0, -1, 0],
        color: [1, 1, 1],
        intensity: 1,
        mapSize: initialMapSize,
        shadowDistance: 50,
        cascadeCount: initialCascadeCount,
      },
    })
    .unwrap();
  return { world, shadowEntity };
}

async function createRenderer() {
  const host = await constructRuntimeRendererHost(
    createMockCanvas() as unknown as HTMLCanvasElement,
    {},
    { shaderManifestUrl: ENGINE_MANIFEST_URL },
  );
  if (!host.ok) throw host.error;
  const { renderer } = host.value;
  onTestFinished(async () => {
    const disposed = await renderer.dispose();
    if (!disposed.ok) throw disposed.error;
  });
  expect(renderer.inspect().state).toBe('alive');
  return renderer;
}

describe('CSM runtime cascade + mapSize variation (M5/w26)', () => {
  it.skipIf(!dawnReady)("'dawn-binding-missing' -- dawn.node binding injection failed", () => {
    expect(dawnReady).toBe(true);
  });

  it('cascadeCount 4 -> 2 -> 4 round-trip without device error', async () => {
    if (!dawnReady) return;
    const renderer = await createRenderer();
    const { world, shadowEntity } = buildScene(4, MAP_SIZE);

    expect((await drawPublished(renderer, world)).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: MAP_SIZE,
      shadowDistance: 50,
      cascadeCount: 2,
    });
    expect((await drawPublished(renderer, world)).ok).toBe(true);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: MAP_SIZE,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect((await drawPublished(renderer, world)).ok).toBe(true);
  });

  it('rebuilds a smaller shadow atlas and restores its dimensions and allocation', async () => {
    if (!dawnReady) return;
    const renderer = await createRenderer();
    const { world, shadowEntity } = buildScene(4, MAP_SIZE);

    expect((await drawPublished(renderer, world)).ok).toBe(true);
    const initial = renderer.inspect().directionalShadow;
    expect(initial?.shadowMapBytes).toBeGreaterThan(0);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: MAP_SIZE / 2,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect((await drawPublished(renderer, world)).ok).toBe(true);
    const reduced = renderer.inspect().directionalShadow;
    expect(reduced?.mapSize).toBeLessThan(initial?.mapSize ?? 0);
    expect(reduced?.shadowMapBytes).toBeLessThan(initial?.shadowMapBytes ?? 0);

    world.set(shadowEntity, DirectionalLight, {
      mapSize: MAP_SIZE,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect((await drawPublished(renderer, world)).ok).toBe(true);
    expect(renderer.inspect().directionalShadow?.mapSize).toBe(initial?.mapSize);
    expect(renderer.inspect().directionalShadow?.shadowMapBytes).toBe(initial?.shadowMapBytes);
  });

  it('cascadeCount=1 renders through the unified pathway (AC-10)', async () => {
    if (!dawnReady) return;
    const renderer = await createRenderer();
    const { world } = buildScene(1, MAP_SIZE);
    expect((await drawPublished(renderer, world)).ok).toBe(true);
  });

  it('castShadow true -> false -> true toggles the directional graph without device error', async () => {
    if (!dawnReady) return;
    const renderer = await createRenderer();
    const { world, shadowEntity } = buildScene(4, MAP_SIZE);

    expect((await drawPublished(renderer, world)).ok).toBe(true);
    world.set(shadowEntity, DirectionalLight, { castShadow: false });
    expect((await drawPublished(renderer, world)).ok).toBe(true);
    world.set(shadowEntity, DirectionalLight, {
      castShadow: true,
      mapSize: MAP_SIZE,
      shadowDistance: 50,
      cascadeCount: 4,
    });
    expect((await drawPublished(renderer, world)).ok).toBe(true);
  });
});
