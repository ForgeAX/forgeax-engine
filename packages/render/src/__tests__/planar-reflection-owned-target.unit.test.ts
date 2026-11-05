import { World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type PlanarTargetHost,
  PlanarTargetLease,
  planarReflectionLevels,
  planarReflectionTargetDescriptor,
} from '../capture/planar-target';
import { encodePlanarReflectionUniform } from '../capture/planar-uniform';
import { Camera } from '../components/camera';
import { PlanarReflection } from '../components/planar-reflection';
import type { CameraSnapshot } from '../render-contract';
import { projectAuxiliaryCamerasForView, selectCameraRoles } from '../render-system-extract';
import type { RenderTarget, RenderTargetDescriptor } from '../targets/contracts';

const mipmapPipelines = vi.hoisted(() => ({ size: 0 }));
vi.mock('@forgeax/engine-assets-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@forgeax/engine-assets-runtime')>()),
  mipmapCacheSize: () => mipmapPipelines.size,
}));

function ownedPlanarWorld(data: { resolutionScale?: number; generateMipmaps?: boolean } = {}) {
  const world = new World();
  const display = world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0, 3, 5],
          quat: quat.fromLookAt(quat.create(), [0, 3, 5], [0, 0, 0], [0, 1, 0]),
        },
      },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 2, near: 0.1, far: 100 } },
    )
    .unwrap();
  world.addComponent(display, { component: PlanarReflection, data }).unwrap();
  propagateTransforms(world).unwrap();
  return world;
}

function roles(world: World) {
  const raw = selectCameraRoles(world);
  return {
    display: raw.display[0],
    auxiliary: projectAuxiliaryCamerasForView(raw.display[0], raw.auxiliary),
  };
}

function fakeHost() {
  const calls: string[] = [];
  let next = 0;
  const host = {
    createRenderTarget: (descriptor: RenderTargetDescriptor) => {
      calls.push(`create ${descriptor.width}x${descriptor.height}`);
      return { ok: true, value: { id: ++next } as unknown as RenderTarget };
    },
    resizeRenderTarget: (_target: RenderTarget, descriptor: RenderTargetDescriptor) => {
      calls.push(`resize ${descriptor.width}x${descriptor.height} mips=${descriptor.mipLevels}`);
      return { ok: true, value: undefined };
    },
    destroyRenderTarget: () => {
      calls.push('destroy');
      return { ok: true, value: undefined };
    },
  } as unknown as PlanarTargetHost;
  return { host, calls };
}

afterEach(() => {
  mipmapPipelines.size = 0;
  vi.restoreAllMocks();
});

describe('PlanarReflection renderer-owned target', () => {
  it('extracts a targetless mirror with default scale and no mips', () => {
    const { auxiliary } = roles(ownedPlanarWorld());
    expect(auxiliary[0]?.target).toBeUndefined();
    expect(auxiliary[0]?.planarReflection).toMatchObject({
      resolutionScale: 1,
      generateMipmaps: false,
    });
  });

  // NaN never reaches extraction: the ECS write rejects it.
  it.each([0, -0.5, Number.POSITIVE_INFINITY])('rejects resolutionScale %s', (bad) => {
    const world = ownedPlanarWorld({ resolutionScale: bad });
    expect(() => selectCameraRoles(world)).toThrow(
      expect.objectContaining({
        code: 'planar-reflection-invalid',
        detail: { field: 'resolutionScale' },
      }),
    );
  });

  it('sizes round(display extent x scale), at least 1x1, rgba16float', () => {
    expect(
      planarReflectionTargetDescriptor(
        { width: 1280, height: 721 },
        { resolutionScale: 0.5, generateMipmaps: false },
      ),
    ).toEqual({
      shape: '2d',
      width: 640,
      height: 361,
      format: 'rgba16float',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    const tiny = planarReflectionTargetDescriptor(
      { width: 3, height: 1 },
      { resolutionScale: 0.1, generateMipmaps: true },
    );
    expect([tiny.width, tiny.height, tiny.mipLevels]).toEqual([1, 1, 'full']);
  });

  it('creates once, resizes on extent or scale change, and releases', () => {
    const { host, calls } = fakeHost();
    const lease = new PlanarTargetLease();
    const half = roles(ownedPlanarWorld({ resolutionScale: 0.5 }));
    const first = lease.resolve(host, half.display, half.auxiliary, { width: 800, height: 600 });
    expect(first[0]?.target).toBeDefined();
    const again = lease.resolve(host, half.display, half.auxiliary, { width: 800, height: 600 });
    expect(again[0]?.target).toBe(first[0]?.target);
    lease.resolve(host, half.display, half.auxiliary, { width: 1000, height: 600 });
    const quarter = roles(ownedPlanarWorld({ resolutionScale: 0.25 }));
    lease.resolve(host, quarter.display, quarter.auxiliary, { width: 1000, height: 600 });
    lease.release();
    lease.release();
    expect(calls).toEqual([
      'create 400x300',
      'resize 400x300 mips=1',
      'resize 500x300 mips=1',
      'resize 250x150 mips=1',
      'destroy',
    ]);
  });

  it('releases when the mirror goes away and leaves game targets untouched', () => {
    const { host, calls } = fakeHost();
    const lease = new PlanarTargetLease();
    const owned = roles(ownedPlanarWorld());
    lease.resolve(host, owned.display, owned.auxiliary, { width: 64, height: 64 });
    const gameTarget = { id: 99 } as unknown as RenderTarget;
    const withGameTarget = owned.auxiliary.map(
      (camera): CameraSnapshot => ({ ...camera, target: gameTarget }),
    );
    expect(lease.resolve(host, owned.display, withGameTarget, { width: 64, height: 64 })).toBe(
      withGameTarget,
    );
    expect(calls).toEqual(['create 64x64', 'resize 64x64 mips=1', 'destroy']);
  });

  it('refuses a targetless mirror when no renderer owns targets', () => {
    const owned = roles(ownedPlanarWorld());
    expect(() =>
      new PlanarTargetLease().resolve(undefined, owned.display, owned.auxiliary, {
        width: 8,
        height: 8,
      }),
    ).toThrow(expect.objectContaining({ detail: { field: 'target' } }));
  });

  it('counts the full chain when mipmaps are generated, else one level', () => {
    const device = {} as RhiDevice;
    mipmapPipelines.size = 1;
    const full = planarReflectionTargetDescriptor(
      { width: 1024, height: 300 },
      { resolutionScale: 1, generateMipmaps: true },
    );
    expect(planarReflectionLevels(device, { generateMipmaps: true }, full)).toBe(11);
    expect(planarReflectionLevels(device, { generateMipmaps: false }, full)).toBe(1);
    // A game target keeps its own chain: 'full' mips, or a single level that skips generation.
    const game = { ...full, width: 512, height: 512 } as const;
    expect(planarReflectionLevels(device, { generateMipmaps: true }, game)).toBe(10);
    expect(
      planarReflectionLevels(device, { generateMipmaps: true }, { ...game, mipLevels: 1 }),
    ).toBe(1);
  });

  it('falls back to mip 0 with one warning when the mipmap pipeline is not prewarmed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const device = {} as RhiDevice;
    const full = planarReflectionTargetDescriptor(
      { width: 256, height: 256 },
      { resolutionScale: 1, generateMipmaps: true },
    );
    expect(planarReflectionLevels(device, { generateMipmaps: true }, full)).toBe(1);
    expect(planarReflectionLevels(device, { generateMipmaps: true }, full)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('encodes the sampled level count in the spare lane', () => {
    const { auxiliary } = roles(ownedPlanarWorld({ generateMipmaps: true }));
    expect(encodePlanarReflectionUniform(auxiliary[0])[22]).toBe(1);
    expect(encodePlanarReflectionUniform(auxiliary[0], 9)[22]).toBe(9);
    expect(encodePlanarReflectionUniform(undefined, 9)[22]).toBe(0);
  });
});
