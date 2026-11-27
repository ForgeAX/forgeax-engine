import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { deriveFieldReceivers } from '../../raytracing/field-receiver';
import { FIELD_RECEIVER_GPU } from '../../raytracing/field-receiver-texture';
import { createScreenProbeExtent } from '../../raytracing/screen-probe-extent';
import {
  planScreenProbeLayout,
  SCREEN_PROBE_DEFAULTS,
  SCREEN_PROBE_HISTORY_BYTES,
  SCREEN_PROBE_RADIANCE_BYTES,
  SCREEN_PROBE_RECORD_BYTES,
  SCREEN_PROBE_ROOT_REQUEST_BYTES,
  SCREEN_PROBE_TEXELS,
  screenProbeAllocationSizes,
} from '../../raytracing/screen-probe-plan';
import { receiverMetadataFixture } from './field-receiver.fixture';

it('publishes GPU receiver words from the same admitted frame instead of depth or a second roster', async () => {
  const f = await receiverMetadataFixture();
  try {
    const frame = deriveFieldReceivers(f.input).unwrap();
    expect(frame.state).toBe('ready');
    if (frame.state !== 'ready') throw Error('Actual ready receiver source required');
    // A metadata-only identity cannot yet be consumed by the actual GPU probe.
    expect('gpuSource' in frame).toBe(true);
    const limits = { maxTextureDimension2D: 8192, maxBytes: 1024 * 1024 };
    const projected = frame
      .gpuSource(f.input.acceptedSource, frame.frameOwner, 31, limits)
      .unwrap();
    expect(projected.state).toBe('ready');
    if (projected.state !== 'ready') throw Error('Expected qualified GPU projection');
    expect([...projected.words.subarray(0, 4)]).toEqual([
      FIELD_RECEIVER_GPU.magic,
      2,
      f.input.raster.records.length / 16,
      31,
    ]);
    expect([...projected.words.subarray(4, 8)]).toEqual(f.input.acceptedSource);
    expect(projected.words[16]).toBe(1); // canonical row zero is not missing.
    expect(projected.words[17]).toBe(0);
    const indices = f.source.mesh.indices;
    if (indices === undefined) throw Error('Actual indexed receiver geometry required');
    expect(projected.words[18]).toBe(indices.length / 3);
    expect([...new Float32Array(projected.words.buffer, 80, 16)]).toEqual([...f.pose]);
    expect(frame.gpuSource(f.input.acceptedSource, frame.frameOwner, 31, limits).unwrap()).toBe(
      projected,
    );
    const next = frame.gpuSource(f.input.acceptedSource, frame.frameOwner, 32, limits).unwrap();
    expect(next).not.toBe(projected);
    expect(projected.words[3]).toBe(31);
  } finally {
    f.dispose();
  }
});

it('accounts for the canonical origin enclosure and source proof in probes and history', () => {
  expect(SCREEN_PROBE_RECORD_BYTES).toBe(96);
  expect(SCREEN_PROBE_HISTORY_BYTES).toBe(96 + SCREEN_PROBE_TEXELS * SCREEN_PROBE_RADIANCE_BYTES);
  const layout = planScreenProbeLayout(SCREEN_PROBE_DEFAULTS, 64, 64);
  const sizes = screenProbeAllocationSizes(layout, 128 * 1024 * 1024, true, 256);
  expect(SCREEN_PROBE_ROOT_REQUEST_BYTES).toBe(128);
  expect(sizes.probes).toBe(layout.probeCount * 96);
  expect(sizes.rootRequests).toBe(layout.probeCount * 64 * 128);
  expect(sizes.receiverSource).toBe(256);
  expect(() => screenProbeAllocationSizes(layout, 1024, true, 256)).toThrow('exceeds');
});

it('rejects foreign/stale frame and epoch before reusing a projected image', async () => {
  const f = await receiverMetadataFixture();
  let current = true;
  try {
    const frame = deriveFieldReceivers({
      ...f.input,
      owner: { identity: f.input.owner.identity, current: () => current },
    }).unwrap();
    if (frame.state !== 'ready') throw Error('Expected accepted receiver frame');
    const limits = { maxTextureDimension2D: 8192, maxBytes: 1024 * 1024 };
    frame.gpuSource(f.input.acceptedSource, frame.frameOwner, 0, limits).unwrap();
    expect(frame.gpuSource(f.input.acceptedSource, {}, 0, limits).unwrap()).toEqual({
      state: 'unavailable',
      reason: 'stale-owner',
    });
    const wrong = [...f.input.acceptedSource] as [number, number, number, number];
    wrong[3]++;
    expect(frame.gpuSource(wrong, frame.frameOwner, 0, limits).unwrap()).toEqual({
      state: 'unavailable',
      reason: 'stale-source',
    });
    current = false;
    expect(frame.gpuSource(f.input.acceptedSource, frame.frameOwner, 0, limits).unwrap()).toEqual({
      state: 'unavailable',
      reason: 'stale-owner',
    });
  } finally {
    f.dispose();
  }
});

it('retains uncovered holes and fails a full-image budget instead of truncating rows', async () => {
  const f = await receiverMetadataFixture();
  try {
    f.input.raster.records[10] = 0;
    const frame = deriveFieldReceivers(f.input).unwrap();
    if (frame.state !== 'ready') throw Error('Expected same accepted source');
    const projected = frame
      .gpuSource(f.input.acceptedSource, frame.frameOwner, 0, {
        maxTextureDimension2D: 8192,
        maxBytes: 1024 * 1024,
      })
      .unwrap();
    if (projected.state !== 'ready') throw Error('Expected complete projection with uncovered row');
    expect([...projected.words.subarray(16, 36)]).toEqual(Array(20).fill(0));
    expect(
      frame.gpuSource(f.input.acceptedSource, frame.frameOwner, 0, {
        maxTextureDimension2D: 8192,
        maxBytes: 64,
      }).ok,
    ).toBe(false);
  } finally {
    f.dispose();
  }
});

it('releases all successful extent buffers and its texture when receiver view creation fails', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const destroyBuffer = vi.spyOn(device, 'destroyBuffer'),
    destroyTexture = vi.spyOn(device, 'destroyTexture');
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'injected view allocation failure',
    hint: 'test-only failure',
  });
  vi.spyOn(device, 'createTextureView').mockReturnValueOnce(err(failure));
  try {
    expect(() =>
      createScreenProbeExtent(device, planScreenProbeLayout(SCREEN_PROBE_DEFAULTS, 16, 16), false, {
        state: 'ready',
        width: 4,
        height: 1,
        bytes: 64,
        words: new Uint32Array(16),
      }),
    ).toThrow(failure);
    expect(destroyBuffer).toHaveBeenCalledTimes(14);
    expect(destroyTexture).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
  }
});
