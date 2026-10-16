// fullscreen-post-depth-params-arity.test.ts —
// feat-20260702-postprocess-camera-depth-read verify round-1 hotfix (F-1).
//
// Regression for the depth-read-without-params silent-no-render defect: the
// 'fullscreen-post-with-scene-depth' BGL always declares params@2, so a depth
// pass MUST bind a UBO at binding 2 or the bindgroup arity ([0,1,3,4]) mismatches
// the BGL ([0,1,2,3,4]) and dawn silently rejects createBindGroup (no draw, no
// error). register() auto-allocates a minimal 16B UBO for a param-less depth
// entry (plan D-3); this test pins the bindgroup emits all five bindings when
// that UBO + depth views are supplied.

import type { BindGroup, BindGroupLayout, Buffer, Sampler, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  createFullscreenBindGroup,
  DEPTH_MIN_PARAMS_BYTE_SIZE,
  entryHasDepthRead,
} from '../../../render/src/fullscreen-post-process-pass';

interface RecordedEntry {
  binding: number;
  resource: { kind: string; value: unknown };
}

/** Minimal fake device that records the createBindGroup entries. */
function makeRecordingDevice(): {
  device: Parameters<typeof createFullscreenBindGroup>[0];
  lastEntries: () => RecordedEntry[];
} {
  let captured: RecordedEntry[] = [];
  const device = {
    createBindGroup(desc: { entries: RecordedEntry[] }) {
      captured = desc.entries;
      return { ok: true as const, value: {} as BindGroup };
    },
  } as unknown as Parameters<typeof createFullscreenBindGroup>[0];
  return { device, lastEntries: () => captured };
}

const fakeView = {} as TextureView;
const fakeSampler = {} as Sampler;
const fakeBuffer = {} as Buffer;
const fakeBgl = {} as BindGroupLayout;

describe('depth pass params arity (F-1 regression)', () => {
  it('DEPTH_MIN_PARAMS_BYTE_SIZE is 16 (WebGPU min uniform binding)', () => {
    expect(DEPTH_MIN_PARAMS_BYTE_SIZE).toBe(16);
  });

  it('entryHasDepthRead detects a param-less depth read', () => {
    expect(entryHasDepthRead({ source: '', reads: [{ key: 'depth', sampleType: 'depth' }] })).toBe(
      true,
    );
    expect(entryHasDepthRead({ source: '', reads: ['sceneColor'] })).toBe(false);
    expect(entryHasDepthRead({ source: '' })).toBe(false);
  });

  it('binds all five entries [0,1,2,3,4] when params UBO + depth views supplied', () => {
    const { device, lastEntries } = makeRecordingDevice();
    createFullscreenBindGroup(
      device,
      fakeBgl,
      fakeView,
      fakeSampler,
      fakeBuffer,
      fakeView,
      fakeSampler,
    );
    const bindings = lastEntries().map((e) => e.binding);
    expect(bindings).toEqual([0, 1, 2, 3, 4]);
    // binding 2 must be the params buffer (the slot the depth BGL always declares)
    const b2 = lastEntries().find((e) => e.binding === 2);
    expect(b2?.resource.kind).toBe('buffer');
  });

  it('drops binding 2 when params UBO is null -- the arity bug the hotfix prevents', () => {
    // This documents the failing shape: without the auto-allocated UBO the depth
    // pass would emit [0,1,3,4], mismatching the 5-entry depth BGL. register()
    // must therefore always provide a UBO for a depth entry.
    const { device, lastEntries } = makeRecordingDevice();
    createFullscreenBindGroup(device, fakeBgl, fakeView, fakeSampler, null, fakeView, fakeSampler);
    expect(lastEntries().map((e) => e.binding)).toEqual([0, 1, 3, 4]);
  });
});
