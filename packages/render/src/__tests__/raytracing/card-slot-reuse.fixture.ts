import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect, vi } from 'vitest';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
} from '../../raytracing/card-lookup';
import { referenceSurfaceMaterialSnapshot } from '../../raytracing/material-bindings';
import { createSdfQuery, SdfQueryStatus } from '../../raytracing/sdf-query';
import {
  prepareSurfaceCapture,
  type SurfaceCaptureSource,
  type SurfaceCardSource,
  surfaceCardKey,
} from '../../raytracing/surface-cards';
import { retiredDenseCardProjections } from './card-slot-reuse-control.fixture';
import { readBuffer } from './path-tracer.fixture';
import type { prepareSdfCardsBaseFixture } from './sdf-cards.commands';
import { readCardPlanes, sdfCubeInstance } from './sdf-cards.fixture';

type Base = Awaited<ReturnType<typeof prepareSdfCardsBaseFixture>>;
type Compile = Parameters<typeof prepareSurfaceCapture>[1];
const color = (bytes: Uint8Array, id: number) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [0, 1, 2].map((axis) => view.getFloat32(id * CARD_LOOKUP_STRIDE + 16 + axis * 4, true));
};
const state = (bytes: Uint8Array, id: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    id * CARD_LOOKUP_STRIDE,
    true,
  );

function expectCurrent(bytes: Uint8Array, stage: string, m: number, width: number) {
  expect(state(bytes, 1)).toBe(CardLookupStatus.mapped);
  expect(color(bytes, 1)).toEqual([0, 1, 0]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tile = view.getUint32(CARD_LOOKUP_STRIDE + 8, true);
  expect(tile).toBeGreaterThanOrEqual(m);
  expect(tile).toBeLessThan(2 * m);
  expect(view.getUint32(CARD_LOOKUP_STRIDE + 12, true)).toBe(1);
  for (let tap = 0; tap < 4; tap++) {
    if (view.getFloat32(CARD_LOOKUP_STRIDE + 96 + 4 * tap, true) === 0) continue;
    const texel = view.getUint32(CARD_LOOKUP_STRIDE + 80 + 4 * tap, true);
    const physical =
      Math.floor((texel % width) / 16) + Math.floor(Math.floor(texel / width) / 16) * (width / 16);
    expect(physical).toBe(tile);
  }
  expect(state(bytes, 0)).toBe(
    stage === 'initial' ? CardLookupStatus.mapped : CardLookupStatus.unmapped,
  );
  expect(state(bytes, 2)).toBe(
    stage === 'reuse' ? CardLookupStatus.mapped : CardLookupStatus.unmapped,
  );
  if (stage === 'reuse') expect(color(bytes, 2)).toEqual([1, 0, 0]);
}

function expectRetired(bytes: Uint8Array, current: Uint8Array, stage: string) {
  if (stage === 'initial') expect(bytes).toEqual(current);
  else
    expect(state(bytes, 1) === CardLookupStatus.mapped && color(bytes, 1).join() === '0,1,0').toBe(
      false,
    );
  if (stage === 'reuse') {
    expect(state(bytes, 1)).toBe(CardLookupStatus.mapped);
    expect(color(bytes, 1)).toEqual([1, 0, 0]);
    expect(color(bytes, 2)).toEqual([0, 1, 0]);
  }
}

/** Actual factory graph; the query's authored hit buffer isolates Card sampling. */
export async function prepareCardSlotCapture(device: RhiDevice, compile: Compile, base: Base) {
  const expected: SurfaceCardSource[] = [
    [0, 0, 1, 1],
    [0, 1, 0, 1],
    [1, 0, 0, 1],
  ].map((color, instanceId) => ({
    instance: { ...sdfCubeInstance, instanceId },
    layout: base.layout,
    sections: [
      {
        indexOffset: 0,
        indexCount: sdfCubeInstance.indices.length,
        material: {
          id: instanceId,
          ...base.card,
          asset: { ...base.card.asset, values: { ...base.card.asset.values, baseColor: color } },
        },
      },
    ],
  }));
  // Same reference snapshot/key authorities as createSurfaceCapture; reserve is
  // needed here to exercise real add/remove without replacing the atlas.
  const lowered: SurfaceCaptureSource[] = expected.map((source) => ({
    instance: source.instance,
    layout: source.layout,
    captureKey: surfaceCardKey(source),
    sections: source.sections.map((section) => ({
      ...section,
      material: {
        id: section.material.id,
        program: {
          source: section.material.program.wgsl,
          paramSchema: section.material.program.paramSchema,
        },
        snapshot: referenceSurfaceMaterialSnapshot(section.material),
      },
    })),
  }));
  const a = lowered[0],
    b = lowered[1],
    c = lowered[2];
  assert(a && b && c);
  const capture = (
    await prepareSurfaceCapture(
      device,
      compile,
      [a],
      { kind: 'cards', resolution: 16 },
      256 * 1024 * 1024,
      base.layout.cards.length,
    )
  ).unwrap();
  try {
    (await capture.admit(b)).unwrap();
    (await capture.admit(c)).unwrap();
    const query = (
      await createSdfQuery(
        device,
        compile,
        expected.map((source) => ({ ...source.instance, field: base.field })),
        expected.map(() => ({
          origin: [0, 0, 3],
          direction: [0, 0, -1],
          tMin: 0,
          tMax: 4,
          mask: 255,
        })),
      )
    ).unwrap();
    const bytes = new Uint8Array(expected.length * 64),
      view = new DataView(bytes.buffer);
    for (const source of expected) {
      const offset = source.instance.instanceId * 64;
      view.setUint32(offset, SdfQueryStatus.visibilityHit, true);
      view.setUint32(offset + 4, source.instance.instanceId, true);
      view.setUint32(offset + 8, source.instance.geometryId, true);
      view.setUint32(offset + 12, 0xffffffff, true);
      view.setFloat32(offset + 40, 1, true);
      view.setFloat32(offset + 56, 1, true);
    }
    device.queue.writeBuffer(query.buffers.hits, 0, bytes).unwrap();
    return { capture, query, expected, b, c };
  } catch (error) {
    capture.dispose();
    throw error;
  }
}

export async function verifyCardSlotReuse(
  base: Base,
  onRead?: (name: string, bytes: Uint8Array) => Promise<void>,
) {
  const device = (
    await (
      await webgpu.rhi.requestAdapter({ powerPreference: 'high-performance' })
    )
      .unwrap()
      .requestDevice()
  ).unwrap();
  const raw = device.nativeDevice().unwrap();
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let graph: Awaited<ReturnType<typeof prepareCardSlotCapture>>;
  try {
    graph = await prepareCardSlotCapture(device, webgpu.createShaderModule, base);
  } catch (error) {
    raw.destroy();
    throw error;
  }
  const { capture, query, expected, b, c } = graph;
  const m = base.layout.cards.length;
  const evidence: {
    stage: string;
    current: Uint8Array;
    retired: Uint8Array;
    planes: Uint8Array[];
  }[] = [];
  try {
    expect(capture.add(b).unwrap()).toEqual({ first: m, count: m });
    for (const stage of ['initial', 'remove-only', 'reuse'] as const) {
      if (stage === 'remove-only') capture.remove(0).unwrap();
      if (stage === 'reuse') expect(capture.add(c).unwrap()).toEqual({ first: 0, count: m });
      const observed = vi.spyOn(device, 'createBuffer');
      let lookup: Awaited<ReturnType<typeof createSdfCardLookup>>;
      let projections: Buffer | undefined, settings: Buffer | undefined;
      try {
        lookup = await createSdfCardLookup(
          device,
          webgpu.createShaderModule,
          query,
          capture,
          expected,
        );
        for (const [i, [descriptor]] of observed.mock.calls.entries()) {
          const result = observed.mock.results[i];
          if (result?.type !== 'return' || !result.value.ok) continue;
          if (descriptor.label === 'cards.lookup-projections') projections = result.value.value;
          if (descriptor.label === 'cards.lookup-settings') settings = result.value.value;
        }
      } finally {
        observed.mockRestore();
      }
      assert(lookup.ok && projections && settings);
      const sampled = lookup.value;
      try {
        const encoder = device.createCommandEncoder({}).unwrap();
        capture.record(encoder).unwrap();
        sampled.record(encoder).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const current = await readBuffer(device, sampled.buffer, 3 * CARD_LOOKUP_STRIDE);
        await onRead?.(`${stage}-current`, current);
        // Same live textures, same PSO and hits. Only restore the retired dense
        // projection upload and its logical count, not a fabricated atlas.
        const old = retiredDenseCardProjections(capture, query.sources, expected);
        const upload = new Uint8Array(capture.allocatedTiles * 80);
        upload.set(old.bytes);
        device.queue.writeBuffer(projections, 0, upload).unwrap();
        device.queue
          .writeBuffer(settings, 0, new Uint8Array(Uint32Array.of(old.count, 16, 0, 0).buffer))
          .unwrap();
        const control = device.createCommandEncoder({}).unwrap();
        sampled.record(control).unwrap();
        device.queue.submit([control.finish().unwrap()]).unwrap();
        const retired = await readBuffer(device, sampled.buffer, 3 * CARD_LOOKUP_STRIDE);
        await onRead?.(`${stage}-retired`, retired);
        const planes = await readCardPlanes(device, capture);
        for (const [index, plane] of planes.entries())
          await onRead?.(`${stage}-plane-${index}`, plane);
        expectCurrent(current, stage, m, capture.width);
        expectRetired(retired, current, stage);
        evidence.push({ stage, current, retired, planes });
      } finally {
        sampled.dispose();
      }
    }
    expect(errors).toEqual([]);
    return { width: capture.width, height: capture.height, resolution: 16, cards: m, evidence };
  } finally {
    capture.dispose();
    query.dispose();
    raw.destroy();
  }
}
