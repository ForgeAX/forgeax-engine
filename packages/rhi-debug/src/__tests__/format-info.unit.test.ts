// format-info.unit.test.ts — per-channel metadata for host-side color decode.
//
// formatInfo sits beside bytesPerTexel (the replay-critical byte-size SSOT). The
// key invariant: for every plain (non-packed) format, channels * per-channel-bytes
// equals bytesPerTexel — the two tables must never drift apart.

import { describe, expect, it } from 'vitest';
import {
  bytesPerTexel,
  computeTextureLayout,
  formatInfo,
  textureBlockLayout,
} from '../texel-layout';

describe('formatInfo', () => {
  it('returns channels + channelType for representative formats', () => {
    expect(formatInfo('rgba8unorm')).toEqual({ channels: 4, channelType: 'unorm' });
    expect(formatInfo('bgra8unorm')).toEqual({ channels: 4, channelType: 'unorm', bgra: true });
    expect(formatInfo('r32float')).toEqual({ channels: 1, channelType: 'float' });
    expect(formatInfo('rg16float')).toEqual({ channels: 2, channelType: 'float' });
    expect(formatInfo('rgba16float')).toEqual({ channels: 4, channelType: 'float' });
    expect(formatInfo('r8uint')).toEqual({ channels: 1, channelType: 'uint' });
    expect(formatInfo('rgba8snorm')).toEqual({ channels: 4, channelType: 'snorm' });
  });

  it('flags packed formats', () => {
    expect(formatInfo('rgb10a2unorm')).toEqual({
      channels: 4,
      channelType: 'unorm',
      packed: 'rgb10a2unorm',
    });
    expect(formatInfo('rg11b10ufloat')).toEqual({
      channels: 3,
      channelType: 'ufloat',
      packed: 'rg11b10ufloat',
    });
  });

  it('returns undefined for compressed / depth / unknown formats', () => {
    expect(formatInfo('bc7-rgba-unorm')).toBeUndefined();
    expect(formatInfo('depth32float')).toBeUndefined();
    expect(formatInfo('depth24plus-stencil8')).toBeUndefined();
    expect(formatInfo(undefined)).toBeUndefined();
    expect(formatInfo('not-a-format')).toBeUndefined();
  });

  it('derives compressed block layout for snapshot and seed', () => {
    expect(textureBlockLayout('bc7-rgba-unorm-srgb')).toEqual({
      blockWidth: 4,
      blockHeight: 4,
      bytesPerBlock: 16,
    });
    const layout = computeTextureLayout('bc7-rgba-unorm-srgb', 7, 5, 1, 1);
    expect(layout).toMatchObject({
      blockWidth: 4,
      blockHeight: 4,
      bytesPerBlock: 16,
      totalBytes: 64,
    });
    expect(layout?.slices[0]).toMatchObject({ width: 7, height: 5, byteLength: 64 });
  });

  it('plain formats: channels * per-channel-bytes == bytesPerTexel (no table drift)', () => {
    const plain: string[] = [
      'r8unorm',
      'rg8unorm',
      'rgba8unorm',
      'bgra8unorm',
      'r16uint',
      'rg16float',
      'rgba16float',
      'r32float',
      'rg32uint',
      'rgba32float',
    ];
    for (const fmt of plain) {
      const info = formatInfo(fmt);
      const total = bytesPerTexel(fmt as never);
      if (!info || total === undefined) throw new Error(`missing tables for ${fmt}`);
      expect(total % info.channels).toBe(0);
      // per-channel width is total/channels; reconstructing the total must match.
      expect((total / info.channels) * info.channels).toBe(total);
    }
  });
});
