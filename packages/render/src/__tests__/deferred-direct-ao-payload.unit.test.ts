import { ok, ShaderSource } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import {
  addStandardDeferredLighting,
  DEFERRED_LIGHTING_PARAMS_BYTES,
} from '../pipeline/standard-deferred-lighting';

type Pass = { encodeDirect: (encoder: never, frame: never, resources: never) => void };

function fixture(screenAo: boolean) {
  let copy!: Pass;
  let raster!: Pass;
  const graph = {
    createBuffer: vi.fn((label: string, descriptor: { size: number }) => ok({ label, descriptor })),
    importBuffer: vi.fn(() => ok({ label: 'probe' })),
    addCopyPass: vi.fn((_label: string, spec: Pass) => {
      copy = spec;
      return ok({});
    }),
    addRasterPass: vi.fn((_label: string, spec: Pass) => {
      raster = spec;
      return ok({});
    }),
  };
  const target = { view: {} };
  const result = addStandardDeferredLighting(
    graph as unknown as Parameters<typeof addStandardDeferredLighting>[0],
    {
      color: target,
      localProbes: true,
      gbuffer: [],
      receiverGeometry: target,
      depth: {},
      spotShadow: target,
      ...(screenAo ? { ssao: target } : {}),
      cluster: null,
      extraAccesses: [],
      size: { width: 64, height: 64 },
    } as unknown as Parameters<typeof addStandardDeferredLighting>[1],
  );
  expect(result.ok).toBe(true);
  const writeBuffer = vi.fn((_buffer: unknown, _offset: number, _data: Float32Array) =>
    ok(undefined),
  );
  const frame = {
    frameState: {
      installedPipelineConfig: {
        ambientOcclusion: { enabled: true, intensity: 1.4 },
      },
    },
    camera: {},
    runtime: { device: { queue: { writeBuffer } } },
  };
  const resources = { buffer: (ref: unknown) => ok(ref) };
  const encodeCopy = () =>
    copy.encodeDirect({ clearBuffer: vi.fn() } as never, frame as never, resources as never);
  encodeCopy();
  return { graph, writeBuffer, raster, frame, encodeCopy };
}

describe('deferred lighting AO uniform owner', () => {
  it('binds the resolved indirect AO weight without applying AO intensity again', () => {
    const f = fixture(true);
    expect(DEFERRED_LIGHTING_PARAMS_BYTES).toBe(32);
    expect(f.graph.createBuffer).toHaveBeenCalledWith('deferred-lighting-params', { size: 32 });
    const weights: number[] = [];
    for (const intensity of [0, 0.5, 1.4]) {
      f.frame.frameState.installedPipelineConfig.ambientOcclusion.intensity = intensity;
      f.encodeCopy();
      const payload = f.writeBuffer.mock.calls.at(-1)?.[2];
      if (payload === undefined) throw new Error('Deferred lighting parameter upload is missing');
      expect(payload.byteLength).toBe(32);
      weights.push(payload[0] ?? Number.NaN);
      expect([...payload.slice(4)]).toEqual([0, 0, 0, 0]);
    }
    expect(weights).toEqual([1, 1, 1]);
  });

  it('uploads neutral AO when no screen occlusion target is admitted', () => {
    const f = fixture(false);
    const payload = f.writeBuffer.mock.calls[0]?.[2] as unknown as Float32Array;
    expect(payload[0]).toBe(0);
    expect([...payload.slice(4)]).toEqual([0, 0, 0, 0]);
  });

  it('gives the actual uniform binding the same minimum byte size as its allocation', () => {
    const f = fixture(true);
    const scope = DeviceScope.create(1, 'deferred-direct-ao-payload');
    const stop = new Error('binding layout observed');
    const createBindGroupLayout = vi.fn((_descriptor: unknown) => {
      throw stop;
    });
    try {
      expect(() =>
        f.raster.encodeDirect(
          undefined as never,
          {
            runtime: {
              device: { createBindGroupLayout },
              deviceScope: scope,
              standardSceneShaders: {
                gbuffer: 'standard-gbuffer/2',
                deferred: { unclustered: 'fixture' },
                specializedDeferredLighting: () => new ShaderSource(['fixture']),
              },
              shaderModuleFactory: { createShaderModule: () => ok({}) },
            },
            pipelineState: { viewBindGroupLayout: {} },
          } as never,
          undefined as never,
        ),
      ).toThrow(stop);
      expect(createBindGroupLayout.mock.calls[0]?.[0]).toMatchObject({
        entries: expect.arrayContaining([
          { binding: 7, visibility: 2, buffer: { type: 'uniform', minBindingSize: 32 } },
        ]),
      });
    } finally {
      scope.dispose();
    }
  });
});
