import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  addStandardDeferredLighting,
  DEFERRED_LIGHTING_PARAMS_BYTES,
} from '../pipeline/standard-deferred-lighting';

type Pass = { encode: (context: never) => void };

function fixture(screenAo: boolean, strength: number | undefined) {
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
      installedPipelineConfig: { ssao: { intensity: 1.4, directLightingStrength: strength } },
    },
    camera: {},
    runtime: { device: { queue: { writeBuffer } } },
  };
  const resources = { buffer: (ref: unknown) => ok(ref) };
  copy.encode({ frame, resources, encoder: { clearBuffer: vi.fn() } } as never);
  return { graph, writeBuffer, raster };
}

describe('actual deferred direct AO uniform owners', () => {
  it.each([
    undefined,
    0,
    0.5,
    1,
  ])('uploads two complete lanes and the authored strength (%s)', (strength) => {
    const f = fixture(true, strength);
    expect(DEFERRED_LIGHTING_PARAMS_BYTES).toBe(32);
    expect(f.graph.createBuffer).toHaveBeenCalledWith('deferred-lighting-params', { size: 32 });
    const payload = f.writeBuffer.mock.calls[0]?.[2] as unknown as Float32Array;
    expect(payload.byteLength).toBe(32);
    expect(payload[0]).toBeCloseTo(1.4);
    expect(payload[4]).toBe(strength ?? 0);
    expect([...payload.slice(5)]).toEqual([0, 0, 0]);
  });
  it('uploads neutral direct AO when no screen occlusion target is admitted', () => {
    const f = fixture(false, 1);
    const payload = f.writeBuffer.mock.calls[0]?.[2] as unknown as Float32Array;
    expect(payload[0]).toBe(0);
    expect(payload[4]).toBe(0);
  });
  it('gives the actual uniform binding the same minimum byte size as its allocation', () => {
    const f = fixture(true, 0.5);
    const stop = new Error('binding layout observed');
    const createBindGroupLayout = vi.fn((_descriptor: unknown) => {
      throw stop;
    });
    expect(() =>
      f.raster.encode({
        frame: {
          runtime: {
            device: { createBindGroupLayout },
            standardDeferredShaders: { unclustered: 'fixture' },
            shaderModuleFactory: { createShaderModule: () => ok({}) },
          },
        },
      } as never),
    ).toThrow(stop);
    expect(createBindGroupLayout.mock.calls[0]?.[0]).toMatchObject({
      entries: expect.arrayContaining([
        { binding: 7, visibility: 2, buffer: { type: 'uniform', minBindingSize: 32 } },
      ]),
    });
  });
});
