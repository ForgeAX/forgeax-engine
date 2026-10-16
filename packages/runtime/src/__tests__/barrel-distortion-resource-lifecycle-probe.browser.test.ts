import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import {
  ANTIALIAS_NONE,
  BarrelDistortion,
  Camera,
  Materials,
  MeshFilter,
  MeshRenderer,
  TONEMAP_NONE,
} from '@forgeax/engine-render';
import { ok, type RhiDevice } from '@forgeax/engine-rhi';
import { rhi as webgpuRhi } from '@forgeax/engine-rhi-webgpu';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const PHYSICAL = { width: 128, height: 96 } as const;
const CYCLES = 3;
const POST_SHUTDOWN_WAIT_MS = 500;

interface ResourceRecord {
  readonly kind: 'buffer' | 'texture' | 'query-set';
  readonly bytes: number;
  readonly label: string | undefined;
  destroyed: boolean;
}

interface ResourceCounter {
  creates: number;
  destroys: number;
  createdBytes: number;
  destroyedBytes: number;
  readonly live: Map<object, ResourceRecord>;
}

interface ResourceSnapshot {
  readonly creates: number;
  readonly destroys: number;
  readonly createdBytes: number;
  readonly destroyedBytes: number;
  readonly outstandingCount: number;
  readonly outstandingBytes: number;
  readonly outstanding: readonly {
    readonly kind: ResourceRecord['kind'];
    readonly bytes: number;
    readonly label: string | undefined;
  }[];
}

function counter(): ResourceCounter {
  return { creates: 0, destroys: 0, createdBytes: 0, destroyedBytes: 0, live: new Map() };
}

function snapshot(state: ResourceCounter): ResourceSnapshot {
  let outstandingBytes = 0;
  for (const resource of state.live.values())
    if (!resource.destroyed) outstandingBytes += resource.bytes;
  return {
    creates: state.creates,
    destroys: state.destroys,
    createdBytes: state.createdBytes,
    destroyedBytes: state.destroyedBytes,
    outstandingCount: [...state.live.values()].filter((resource) => !resource.destroyed).length,
    outstandingBytes,
    outstanding: [...state.live.values()]
      .filter((resource) => !resource.destroyed)
      .map((resource) => ({ kind: resource.kind, bytes: resource.bytes, label: resource.label })),
  };
}

function extentBytes(desc: {
  readonly size?: unknown;
  readonly format?: unknown;
  readonly mipLevelCount?: unknown;
  readonly sampleCount?: unknown;
}): number {
  const size = desc.size;
  const width =
    typeof size === 'number'
      ? size
      : Array.isArray(size)
        ? Number(size[0] ?? 1)
        : Number((size as { width?: unknown } | undefined)?.width ?? 1);
  const height =
    typeof size === 'object' && size !== null && !Array.isArray(size)
      ? Number((size as { height?: unknown }).height ?? 1)
      : Array.isArray(size)
        ? Number(size[1] ?? 1)
        : 1;
  const depth =
    typeof size === 'object' && size !== null && !Array.isArray(size)
      ? Number((size as { depthOrArrayLayers?: unknown }).depthOrArrayLayers ?? 1)
      : Array.isArray(size)
        ? Number(size[2] ?? 1)
        : 1;
  const format = String(desc.format ?? 'rgba8unorm');
  const bytesPerTexel = format.includes('rgba16')
    ? 8
    : format.includes('rgba32')
      ? 16
      : format.includes('rg16')
        ? 4
        : format.includes('rg32')
          ? 8
          : format.includes('r32')
            ? 4
            : format.includes('depth32')
              ? 4
              : format.includes('depth24plus-stencil8')
                ? 4
                : format.includes('depth24plus')
                  ? 4
                  : 4;
  const mipLevels = Math.max(1, Number(desc.mipLevelCount ?? 1));
  const samples = Math.max(1, Number(desc.sampleCount ?? 1));
  let mipBytes = 0;
  for (let level = 0; level < mipLevels; level += 1)
    mipBytes +=
      Math.max(1, Math.ceil(width / 2 ** level)) *
      Math.max(1, Math.ceil(height / 2 ** level)) *
      depth *
      bytesPerTexel;
  return Math.max(0, Math.ceil(mipBytes * samples));
}

function installResourceInstrumentation(counters: ResourceCounter[]): {
  readonly resolveSurfaceDevice: (device: RhiDevice) => {
    readonly ok: true;
    readonly value: RhiDevice;
  };
} {
  return {
    resolveSurfaceDevice(device) {
      const state = counter();
      counters.push(state);
      const createBuffer = device.createBuffer.bind(device);
      device.createBuffer = (desc) => {
        const result = createBuffer(desc);
        if (result.ok) {
          const resource = {
            kind: 'buffer' as const,
            bytes: Math.max(0, Number(desc.size ?? 0)),
            label: desc.label,
            destroyed: false,
          };
          state.creates += 1;
          state.createdBytes += resource.bytes;
          state.live.set(result.value as object, resource);
        }
        return result;
      };
      const createTexture = device.createTexture.bind(device);
      device.createTexture = (desc) => {
        const result = createTexture(desc);
        if (result.ok) {
          const resource = {
            kind: 'texture' as const,
            bytes: extentBytes(desc),
            label: desc.label,
            destroyed: false,
          };
          state.creates += 1;
          state.createdBytes += resource.bytes;
          state.live.set(result.value as object, resource);
        }
        return result;
      };
      const createQuerySet = device.createQuerySet.bind(device);
      device.createQuerySet = (desc) => {
        const result = createQuerySet(desc);
        if (result.ok) {
          const resource = {
            kind: 'query-set' as const,
            bytes: Math.max(0, Number(desc.count ?? 0)) * 8,
            label: desc.label,
            destroyed: false,
          };
          state.creates += 1;
          state.createdBytes += resource.bytes;
          state.live.set(result.value as object, resource);
        }
        return result;
      };
      const destroyBuffer = device.destroyBuffer.bind(device);
      device.destroyBuffer = (value) => {
        const result = destroyBuffer(value);
        if (result.ok) {
          const resource = state.live.get(value as object);
          if (resource !== undefined && !resource.destroyed) {
            resource.destroyed = true;
            state.destroys += 1;
            state.destroyedBytes += resource.bytes;
          }
        }
        return result;
      };
      const destroyTexture = device.destroyTexture.bind(device);
      device.destroyTexture = (value) => {
        const result = destroyTexture(value);
        if (result.ok) {
          const resource = state.live.get(value as object);
          if (resource !== undefined && !resource.destroyed) {
            resource.destroyed = true;
            state.destroys += 1;
            state.destroyedBytes += resource.bytes;
          }
        }
        return result;
      };
      const destroyQuerySet = device.destroyQuerySet.bind(device);
      device.destroyQuerySet = (value) => {
        const result = destroyQuerySet(value);
        if (result.ok) {
          const resource = state.live.get(value as object);
          if (resource !== undefined && !resource.destroyed) {
            resource.destroyed = true;
            state.destroys += 1;
            state.destroyedBytes += resource.bytes;
          }
        }
        return result;
      };
      return { ok: true as const, value: device };
    },
  };
}

function createInstrumentedRhi(
  counters: ResourceCounter[],
  beforeBuffer?: (descriptor: Parameters<RhiDevice['createBuffer']>[0]) => void,
): typeof webgpuRhi {
  const instrumentation = installResourceInstrumentation(counters);
  return {
    ...webgpuRhi,
    async requestAdapter(options) {
      const adapter = await webgpuRhi.requestAdapter(options);
      if (!adapter.ok) return adapter;
      return ok({
        ...adapter.value,
        async requestDevice(options) {
          const result = await adapter.value.requestDevice(options);
          if (result.ok) {
            instrumentation.resolveSurfaceDevice(result.value);
            const createBuffer = result.value.createBuffer.bind(result.value);
            result.value.createBuffer = (descriptor) => {
              beforeBuffer?.(descriptor);
              return createBuffer(descriptor);
            };
          }
          return result;
        },
      });
    },
  };
}

function createScene(): { readonly world: World; readonly release: () => void } {
  const world = new World();
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.95, 0.05, 0.05, 1]));
  world
    .spawn(
      { component: Transform, data: { pos: [0.72, 0.28, 0], scale: [0.9, 0.9, 0.9] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: PHYSICAL.width / PHYSICAL.height,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          tonemap: TONEMAP_NONE,
          clearColor: [0.02, 0.02, 0.02, 1],
        },
      },
      { component: BarrelDistortion, data: { strength: 0.2, centerX: 0.5, centerY: 0.5 } },
    )
    .unwrap();
  const releaseTransforms = registerPropagateTransforms(world);
  return {
    world,
    release: () => {
      releaseTransforms();
      world.sharedRefs.release(material).unwrap();
    },
  };
}

describe('barrel distortion resource lifecycle probe', () => {
  afterEach(() => {
    document.querySelectorAll('canvas[data-barrel-resource-probe]').forEach((node) => {
      node.remove();
    });
  });

  it('releases real allocations when renderer initialization fails partway through', {
    timeout: 120_000,
  }, async () => {
    const counters: ResourceCounter[] = [];
    const canvas = document.createElement('canvas');
    canvas.dataset.barrelResourceProbe = 'true';
    canvas.width = PHYSICAL.width;
    canvas.height = PHYSICAL.height;
    document.body.append(canvas);
    let injected = false;
    const host = await constructRuntimeRendererHost(
      canvas,
      {
        rhi: createInstrumentedRhi(counters, (descriptor) => {
          if (descriptor.label === 'pbr-view-ubo') {
            injected = true;
            throw new Error('injected failure after builtin mesh allocations');
          }
        }),
      },
      { shaderManifestUrl: '/shaders/manifest.json' },
    );
    expect(
      injected,
      JSON.stringify({
        initialization: host.ok ? 'ready' : host.error,
        allocations: counters.map(snapshot),
      }),
    ).toBe(true);
    expect(host.ok).toBe(false);
    const allocations = counters.at(-1);
    if (allocations === undefined) throw new Error('initialization probe did not reach the device');
    const remaining = snapshot(allocations);
    expect(remaining.creates).toBeGreaterThan(0);
    expect(remaining.outstandingCount).toBe(0);
    expect(remaining.outstandingBytes).toBe(0);
  });

  it('returns instrumented backing resources to a stable baseline after repeated shutdown', {
    timeout: 120_000,
  }, async () => {
    const counters: ResourceCounter[] = [];
    const cycles: Array<Record<string, unknown>> = [];
    for (let index = 0; index < CYCLES; index += 1) {
      const canvas = document.createElement('canvas');
      canvas.dataset.barrelResourceProbe = 'true';
      canvas.width = PHYSICAL.width;
      canvas.height = PHYSICAL.height;
      document.body.append(canvas);
      const host = await constructRuntimeRendererHost(
        canvas,
        { rhi: createInstrumentedRhi(counters) },
        { shaderManifestUrl: '/shaders/manifest.json' },
      );
      expect(host.ok).toBe(true);
      if (!host.ok) throw host.error;
      const renderer: Renderer = host.value.renderer;
      const { world, release } = createScene();
      try {
        const attached = renderer.attach(world);
        expect(attached.ok).toBe(true);
        if (!attached.ok) throw attached.error;
        const lease = attached.value;
        expect(world.update(1 / 60).ok).toBe(true);
        const first = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
        expect(first.ok).toBe(true);
        if (!first.ok || first.value === undefined)
          throw new Error('resource probe did not receive first receipt');
        expect((await first.value.completed).ok).toBe(true);
        const beforeCounter = counters.at(-1);
        if (beforeCounter === undefined)
          throw new Error('resource probe did not install instrumentation');
        const beforeShutdown = snapshot(beforeCounter);
        expect(
          beforeShutdown.outstanding.some((resource) => resource.label === 'pbr-view-ubo'),
        ).toBe(true);
        const postShutdownEvents: string[] = [];
        let shutdownComplete = false;
        const unsubscribe = renderer.subscribe((event) => {
          if (shutdownComplete) postShutdownEvents.push(event.kind);
        });
        const second = renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
        });
        expect(second.ok).toBe(true);
        if (!second.ok || second.value === undefined)
          throw new Error('resource probe did not receive late receipt');
        lease.dispose();
        const shutdown = await renderer.dispose();
        shutdownComplete = true;
        const lateCompletion = await second.value.completed;
        await new Promise<void>((resolve) => setTimeout(resolve, POST_SHUTDOWN_WAIT_MS));
        const afterCounter = counters.at(-1);
        if (afterCounter === undefined) throw new Error('resource probe lost instrumentation');
        const afterShutdown = snapshot(afterCounter);
        unsubscribe();
        cycles.push({
          cycle: index + 1,
          beforeShutdown,
          afterShutdown,
          shutdown: shutdown.ok,
          lateCompletion: lateCompletion.ok,
          postShutdownEvents,
        });
        // biome-ignore lint/suspicious/noConsole: diagnostics for the temporary lifecycle probe.
        console.info(
          '[barrel-resource-lifecycle-cycle]',
          JSON.stringify({ cycle: index + 1, beforeShutdown, afterShutdown }),
        );
        expect(shutdown.ok).toBe(true);
        expect(lateCompletion.ok).toBe(false);
        expect(afterShutdown.outstandingCount).toBe(0);
        expect(afterShutdown.outstandingBytes).toBe(0);
        expect(afterShutdown.creates).toBe(afterShutdown.destroys);
        expect(afterShutdown.createdBytes).toBe(afterShutdown.destroyedBytes);
        expect(postShutdownEvents).toEqual([]);
      } finally {
        release();
      }
    }
    // biome-ignore lint/suspicious/noConsole: raw acceptance packet for the temporary probe.
    console.info(
      '[barrel-resource-lifecycle-probe]',
      JSON.stringify({ cycles, counterCount: counters.length }),
    );
    expect(cycles).toHaveLength(CYCLES);
  });
});
