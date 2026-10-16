// resolve-texture-descriptor.unit.test.ts — SSOT "tape handle -> texture descriptor".
//
// resolveTextureDescriptor is the one resolver both the RT path (resolveAttachmentSize /
// readbackDrawRt) and the viewer's depth + bound-texture preview paths share. It walks
// createTextureView resultHandleId -> sourceHandleId -> createTexture, falling back to the
// id itself for direct texture handles, and reads size from the raw createTexture event
// (The raw event remains the authoritative source for texture dimensions.)

import { describe, expect, it } from 'vitest';
import { resolveAttachmentSize, resolveTextureDescriptor } from '../readback';
import type { RhiCallEvent } from '../types';

describe('resolveTextureDescriptor', () => {
  it('resolves a view handle through its source createTexture (size from event)', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'tex-src',
        desc: { size: [256, 128, 1], format: 'rgba8unorm', usage: 0x14 },
      } as RhiCallEvent,
      {
        kind: 'createTextureView',
        sourceHandleId: 'tex-src',
        resultHandleId: 'view-1',
        desc: { dimension: '2d' },
      } as RhiCallEvent,
    ];
    expect(resolveTextureDescriptor(events, 'view-1')).toEqual({
      handleId: 'tex-src',
      width: 256,
      height: 128,
      format: 'rgba8unorm',
      dimension: '2d',
      arrayLayers: 1,
    });
  });

  it('resolves a direct texture handle when no view event exists', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'tex-1',
        desc: { size: { width: 512, height: 512 }, format: 'bgra8unorm', usage: 0x14 },
      } as RhiCallEvent,
    ];
    expect(resolveTextureDescriptor(events, 'tex-1')).toEqual({
      handleId: 'tex-1',
      width: 512,
      height: 512,
      format: 'bgra8unorm',
      dimension: '2d',
      arrayLayers: 1,
    });
  });

  it('captures the view dimension (cube) over the texture dimension', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'cube-src',
        desc: { size: [64, 64, 6], format: 'rgba8unorm', dimension: '2d', usage: 0x14 },
      } as RhiCallEvent,
      {
        kind: 'createTextureView',
        sourceHandleId: 'cube-src',
        resultHandleId: 'cube-view',
        desc: { dimension: 'cube' },
      } as RhiCallEvent,
    ];
    expect(resolveTextureDescriptor(events, 'cube-view')?.dimension).toBe('cube');
  });

  it('defaults height to width for a square [w] size array', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'tex-sq',
        desc: { size: [320], format: 'rgba8unorm', usage: 0x14 },
      } as RhiCallEvent,
    ];
    const desc = resolveTextureDescriptor(events, 'tex-sq');
    expect(desc?.width).toBe(320);
    expect(desc?.height).toBe(320);
  });

  it('extracts arrayLayers (depthOrArrayLayers) from an array-size texture', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'atlas',
        // cube-array shadow atlas: 512x512, 6 faces x 4 layers = 24 array layers.
        desc: { size: [512, 512, 24], format: 'depth32float', dimension: '2d', usage: 0x14 },
      } as RhiCallEvent,
    ];
    expect(resolveTextureDescriptor(events, 'atlas')?.arrayLayers).toBe(24);
  });

  it('extracts arrayLayers from an object-size texture (depthOrArrayLayers)', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'arr',
        desc: {
          size: { width: 256, height: 256, depthOrArrayLayers: 4 },
          format: 'rgba8unorm',
          usage: 0x14,
        },
      } as RhiCallEvent,
    ];
    expect(resolveTextureDescriptor(events, 'arr')?.arrayLayers).toBe(4);
  });

  it('defaults arrayLayers to 1 for a plain 2D texture', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'plain',
        desc: { size: { width: 128, height: 128 }, format: 'rgba8unorm', usage: 0x14 },
      } as RhiCallEvent,
    ];
    expect(resolveTextureDescriptor(events, 'plain')?.arrayLayers).toBe(1);
  });

  it('returns null when no createTexture declares the resolved handle', () => {
    expect(resolveTextureDescriptor([], 'missing')).toBeNull();
  });
});

describe('resolveAttachmentSize (thin wrapper)', () => {
  it('returns the resolved dimensions', () => {
    const events: RhiCallEvent[] = [
      {
        kind: 'createTexture',
        handleId: 'rt',
        desc: { size: [800, 600, 1], format: 'rgba8unorm', usage: 0x14 },
      } as RhiCallEvent,
    ];
    expect(resolveAttachmentSize(events, 'rt')).toEqual({ width: 800, height: 600 });
  });

  it('falls back to 512x512 when unresolved', () => {
    expect(resolveAttachmentSize([], 'nope')).toEqual({ width: 512, height: 512 });
  });
});
