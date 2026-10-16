import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
} from '../../raytracing/card-lookup';
import {
  buildRayReferenceScene,
  type ReferenceRay,
  traceReferenceRay,
} from '../../raytracing/scene';
import { createSdfQuery, type SdfMeshInstance, SdfQueryStatus } from '../../raytracing/sdf-query';
import { createSurfaceCapture, type SurfaceCardSource } from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeInstance } from './sdf-cards.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

export async function verifySdfCases(fixture: SdfCardsFixture) {
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(device),
    errors: string[] = [];
  raw?.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const field = {
    ...fixture.field,
    bricks: Uint32Array.from(fixture.field.bricks),
    values: Float32Array.from(fixture.field.values),
  };
  const source: SurfaceCardSource = {
    instance: sdfCubeInstance,
    layout: fixture.layout,
    sections: [
      {
        indexOffset: 0,
        indexCount: sdfCubeInstance.indices.length,
        material: { id: 0, ...fixture.card },
      },
    ],
  };
  const ray = (
    origin: ReferenceRay['origin'],
    direction: ReferenceRay['direction'],
    mask = 255,
  ): ReferenceRay => ({ origin, direction, tMin: 0, tMax: 20, mask });
  async function trace(
    sources: readonly SdfMeshInstance[],
    rays: readonly ReferenceRay[],
    steps = 128,
  ) {
    const q = (
      await createSdfQuery(device, webgpu.createShaderModule, sources, rays, { maxSteps: steps })
    ).unwrap();
    try {
      const e = device.createCommandEncoder({}).unwrap();
      q.record(e).unwrap();
      device.queue.submit([e.finish().unwrap()]).unwrap();
      const b = await readBuffer(device, q.buffers.hits, rays.length * 64);
      return { u: new Uint32Array(b.buffer), f: new Float32Array(b.buffer) };
    } finally {
      q.dispose();
    }
  }
  async function mapped(
    capture: SurfaceCardSource,
    current: SurfaceCardSource,
    r: ReferenceRay,
    expected = current,
  ) {
    const cards = (
      await createSurfaceCapture(device, webgpu.createShaderModule, [capture])
    ).unwrap();
    const q = (
      await createSdfQuery(
        device,
        webgpu.createShaderModule,
        [
          {
            ...current.instance,
            field:
              current.layout.meshDigest === fixture.hollowLayout.meshDigest
                ? {
                    ...fixture.hollow,
                    bricks: Uint32Array.from(fixture.hollow.bricks),
                    values: Float32Array.from(fixture.hollow.values),
                  }
                : field,
          },
        ],
        [r],
      )
    ).unwrap();
    const lookup = (
      await createSdfCardLookup(device, webgpu.createShaderModule, q, cards, [expected])
    ).unwrap();
    try {
      const e = device.createCommandEncoder({}).unwrap();
      cards.record(e).unwrap();
      q.record(e).unwrap();
      lookup.record(e).unwrap();
      device.queue.submit([e.finish().unwrap()]).unwrap();
      const b = await readBuffer(device, lookup.buffer, CARD_LOOKUP_STRIDE);
      return new Uint32Array(b.buffer)[0];
    } finally {
      lookup.dispose();
      q.dispose();
      cards.dispose();
    }
  }
  try {
    const hitRay = ray([0, 0, 3], [0, 0, -1]);
    expect((await trace([], [hitRay])).u[0]).toBe(SdfQueryStatus.miss);
    expect(
      (await trace([{ ...sdfCubeInstance, field }], [ray([0, 0, 3], [0, 0, -1], 0)])).u[0],
    ).toBe(SdfQueryStatus.miss);
    expect((await trace([{ ...sdfCubeInstance, field }], [hitRay], 1)).u[0]).toBe(
      SdfQueryStatus.stepBudget,
    );
    const absent = { ...sdfCubeInstance, field: { missing: true as const, bounds: field.bounds } };
    expect((await trace([absent], [hitRay])).u[0]).toBe(SdfQueryStatus.missingField);
    // Local samples are reused by rigid, nonuniform and mirrored transforms, with non-unit rays.
    for (const scale of [
      [2, 0.5, 1.5],
      [-2, 0.5, 1.5],
    ]) {
      const instance = {
        ...sdfCubeInstance,
        transform: [
          scale[0] ?? 1,
          0,
          0,
          0,
          0,
          scale[1] ?? 1,
          0,
          0,
          0,
          0,
          scale[2] ?? 1,
          0,
          100,
          0,
          0,
          1,
        ],
      };
      const r = ray([100, 0, 5], [0, 0, -2]);
      const oracle = traceReferenceRay(buildRayReferenceScene([instance]).unwrap(), r);
      expect(oracle).not.toBeNull();
      const result = await trace([{ ...instance, field }], [r]);
      expect(result.u[0]).toBe(SdfQueryStatus.surfaceBand);
      expect(Math.abs((result.f[4] ?? 0) - (oracle?.t ?? 0)) * 2).toBeLessThan(result.f[5] ?? 0);
      expect(result.f[14]).toBeCloseTo(1, 3);
      expect(await mapped({ ...source, instance }, { ...source, instance }, r)).toBe(
        CardLookupStatus.mapped,
      );
    }
    const moved = {
      ...sdfCubeInstance,
      instanceId: 8,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1],
    };
    const r = ray([0, 0, 8], [0, 0, -1]);
    const both = [
      { ...sdfCubeInstance, field },
      { ...moved, field },
    ];
    expect((await trace(both, [r])).u[1]).toBe(8);
    expect((await trace([...both].reverse(), [r])).u[1]).toBe(8);
    expect((await trace([{ ...sdfCubeInstance, field }], [r])).u[1]).toBe(7);
    expect(await mapped(source, { ...source, instance: { ...moved, instanceId: 7 } }, r)).toBe(
      CardLookupStatus.stale,
    );
    const changed = {
      ...source,
      sections: source.sections.map((section) => ({
        ...section,
        material: {
          ...section.material,
          asset: {
            ...section.material.asset,
            values: { ...section.material.asset.values, roughness: 0.3 },
          },
        },
      })),
    };
    expect(await mapped(source, source, hitRay, changed)).toBe(CardLookupStatus.stale);
    expect(
      await mapped(source, source, hitRay, {
        ...source,
        instance: {
          ...source.instance,
          uvSets: (source.instance.uvSets ?? []).map((v) => Array.from(v, (x) => x + 0.1)),
        },
      }),
    ).toBe(CardLookupStatus.stale);
    // Multi-depth cards represent the closed shell cavity, independently of its SDF.
    const hollow = {
      ...fixture.hollow,
      bricks: Uint32Array.from(fixture.hollow.bricks),
      values: Float32Array.from(fixture.hollow.values),
    };
    const hollowInstance = {
      ...sdfCubeInstance,
      uvSets: [],
      positions: [...sdfCubePositions, ...sdfCubePositions.map((v) => v * 0.55)],
      indices: [...sdfCubeIndices, ...sdfCubeIndices.map((v) => v + 8).reverse()],
    };
    const cavity = ray([0, 0, 0], [0, 0, 1]);
    expect((await trace([{ ...hollowInstance, field: hollow }], [cavity])).u[0]).toBe(
      SdfQueryStatus.surfaceBand,
    );
    expect(
      await mapped(
        {
          ...source,
          instance: hollowInstance,
          sections: source.sections.map((s) => ({
            ...s,
            indexCount: hollowInstance.indices.length,
          })),
          layout: fixture.hollowLayout,
        },
        {
          ...source,
          instance: hollowInstance,
          sections: source.sections.map((s) => ({
            ...s,
            indexCount: hollowInstance.indices.length,
          })),
          layout: fixture.hollowLayout,
        },
        cavity,
      ),
    ).toBe(CardLookupStatus.mapped);
    expect(errors).toEqual([]);
  } finally {
    raw?.destroy();
  }
}
