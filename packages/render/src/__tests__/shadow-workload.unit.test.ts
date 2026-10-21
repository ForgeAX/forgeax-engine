import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import type { LodObservationCapture } from '../assembly/lod-observation';
import { captureShadowWorkload } from '../assembly/shadow-workload';
import {
  capturesShadowBundleWorkload,
  recordShadowBundleWorkload,
  ShadowRasterLedger,
} from '../record/shadow-raster-ledger';

function pass() {
  return {
    draw: vi.fn(),
    drawIndexed: vi.fn(),
    drawIndirect: vi.fn(),
    drawIndexedIndirect: vi.fn(),
    executeBundles: vi.fn(() => ({ ok: true, value: undefined })),
  } as unknown as RhiRenderPassEncoder;
}
const identity = { kind: 'directional', index: 1, layer: 'static' } as const;
function record(ledger: ShadowRasterLedger, frameId: number, enabled = true) {
  ledger.begin(enabled, frameId);
  const slot = ledger.evaluate(identity, 'content-changed');
  ledger.encode(slot, pass(), (p) => p.drawIndexed(6, 3), 'shadowCascade1.static');
  ledger.commit();
}
function roster(ledger: ShadowRasterLedger, frameId = 7): LodObservationCapture {
  return {
    frameId,
    deviceGeneration: 2,
    leases: [],
    views: [
      {
        viewKey: 'main',
        entityKey: 40,
        attachmentId: 'world-a',
        viewGeneration: 3,
        eye: undefined,
        graphGeneration: 4,
        state: 'rendered',
        system: { captureShadowWorkload: (id: number) => ledger.captureWorkload(id) },
      } as unknown as LodObservationCapture['views'][number],
    ],
  };
}
const receipt = { frameId: 7, deviceGeneration: 2, graphGeneration: 9 };

describe('receipt-owned shadow workload', () => {
  it('is absent when disabled and rejects stale frame identities', () => {
    const ledger = new ShadowRasterLedger();
    record(ledger, 7, false);
    expect(ledger.captureWorkload(7)).toBeUndefined();
    record(ledger, 8);
    expect(ledger.captureWorkload(7)).toBeUndefined();
  });
  it('counts successful direct/indirect encoder calls without traversing opaque bundles', () => {
    const ledger = new ShadowRasterLedger();
    const target = pass();
    const buffer = {} as Parameters<RhiRenderPassEncoder['drawIndirect']>[0];
    const bundles = {
      [Symbol.iterator]() {
        throw new Error('must only be consumed by backend');
      },
    };
    ledger.begin(true, 7);
    const slot = ledger.evaluate(identity, 'content-changed');
    ledger.encode(
      slot,
      target,
      (p) => {
        p.draw(3);
        p.drawIndexed(6, 2);
        p.drawIndirect(buffer, 16);
        p.drawIndexedIndirect(buffer, 32);
        expect(capturesShadowBundleWorkload(p)).toBe(true);
        p.executeBundles(bundles);
        recordShadowBundleWorkload(p, { indirect: 2, indexedIndirect: 4 });
      },
      'shadowCascade1.static-partial',
    );
    ledger.commit();
    expect(target.drawIndirect).toHaveBeenCalledWith(buffer, 16);
    expect(vi.mocked(target.executeBundles).mock.calls[0]?.[0]).toBe(bundles);
    expect(ledger.captureWorkload(7)?.[0]).toMatchObject({
      passName: 'shadowCascade1.static-partial',
      cache: 'miss',
      indirectActual: 'unobserved',
      bundleContents: 'unobserved',
      commands: {
        directDraws: 1,
        directIndexedDraws: 1,
        indirectDraws: 1,
        indexedIndirectDraws: 1,
        bundleCalls: 1,
        knownBundleIndirectDraws: 2,
        knownBundleIndexedIndirectDraws: 4,
        directVertexInstances: 3,
        directIndexInstances: 12,
      },
    });
  });
  it('does not publish failed encodes or staged later frames and detaches held receipts', () => {
    const ledger = new ShadowRasterLedger();
    record(ledger, 7);
    const old = ledger.captureWorkload(7);
    ledger.begin(true, 8);
    const slot = ledger.evaluate(identity, 'view-changed');
    const target = pass();
    target.draw = () => {
      throw new Error('encode failed');
    };
    expect(() => ledger.encode(slot, target, (p) => p.draw(20), 'failed')).toThrow('encode failed');
    expect(ledger.captureWorkload(8)).toBeUndefined();
    expect(ledger.captureWorkload(7)).toEqual(old);
    record(ledger, 9);
    record(ledger, 10);
    expect(old?.[0]?.commands.directIndexInstances).toBe(18);
    expect(Object.isFrozen(old?.[0]?.identity)).toBe(true);
    expect(Object.isFrozen(old?.[0]?.commands)).toBe(true);
  });
  it('represents cache hits without a physical pass and unsafe direct products as unknown', () => {
    const ledger = new ShadowRasterLedger();
    ledger.begin(true, 7);
    ledger.evaluate(identity, undefined);
    const slot = ledger.evaluate({ kind: 'spot', index: 2 }, 'uncached');
    ledger.encode(slot, pass(), (p) => p.drawIndexed(Number.MAX_SAFE_INTEGER, 2), 'shadowSpot2');
    ledger.commit();
    expect(ledger.captureWorkload(7)?.[0]).toMatchObject({
      cache: 'hit',
      passName: null,
      commands: { directDraws: 0, directIndexedDraws: 0 },
    });
    expect(ledger.captureWorkload(7)?.[1]?.commands.directIndexInstances).toBeNull();
  });
  it('binds camera and graph roster to the same successful Renderer receipt', () => {
    const ledger = new ShadowRasterLedger();
    record(ledger, 7);
    const value = captureShadowWorkload(receipt, roster(ledger));
    expect(value).toMatchObject({
      ...receipt,
      status: 'complete',
      scope: 'display-views',
      views: [{ viewKey: 'main', viewId: 40, graphGeneration: 4, state: 'rendered' }],
    });
    expect(structuredClone(value)).toEqual(value);
    expect(Object.isFrozen(value.views)).toBe(true);
    expect(captureShadowWorkload(receipt, roster(ledger, 6))).toMatchObject({
      status: 'unavailable',
      reason: 'view-not-captured',
    });
    expect(captureShadowWorkload(receipt, roster(ledger), true)).toMatchObject({
      ...receipt,
      status: 'unavailable',
      reason: 'ui-only',
    });
  });
  it('keeps held camera views and oversized observation trees explicitly unavailable', () => {
    const ledger = new ShadowRasterLedger();
    record(ledger, 7);
    const capture = roster(ledger);
    const held = {
      ...capture,
      views: capture.views.map((v) => ({ ...v, state: 'held' as const })),
    };
    expect(captureShadowWorkload(receipt, held)).toMatchObject({
      status: 'unavailable',
      reason: 'held-view',
      views: [{ passes: [] }],
    });
    const large = {
      ...capture,
      views: capture.views.map((v) => ({ ...v, viewKey: 'x'.repeat(20000) })),
    };
    expect(captureShadowWorkload(receipt, large)).toMatchObject({
      ...receipt,
      status: 'unavailable',
      reason: 'observation-budget',
      views: [],
    });
  });
});

it('keeps historical GPU readback producer separate from the current CPU pass', () => {
  const ledger = new ShadowRasterLedger();
  record(ledger, 7);
  const observed = {
    producer: {
      frameId: 4,
      deviceGeneration: 1,
      graphGeneration: 2,
      viewKey: 'directional:1:static',
      viewGeneration: 5,
      sourceRevision: 9,
    },
    resourceGeneration: 3,
    indirectBufferIdentity: 6,
    planRevision: 8,
    candidateCount: 30,
    batchCount: 2,
    visible: 18,
    overflow: false,
    texelCulled: 10,
    cameraCulled: 2,
  };
  const copied = ledger.captureWorkload(7, [{ identity, lastCullingObservation: observed }]);
  expect(copied?.[0]?.lastCullingObservation).toEqual(observed);
  expect(copied?.[0]?.lastCullingObservation?.producer.frameId).toBe(4);
  expect(Object.isFrozen(copied?.[0]?.lastCullingObservation?.producer)).toBe(true);
  observed.producer.frameId = 99;
  observed.visible = 99;
  expect(copied?.[0]?.lastCullingObservation?.producer.frameId).toBe(4);
  expect(copied?.[0]?.lastCullingObservation?.visible).toBe(18);
  expect(
    ledger.captureWorkload(7, [
      { identity: { kind: 'spot', index: 1 }, lastCullingObservation: observed },
    ])?.[0],
  ).not.toHaveProperty('lastCullingObservation');
});
