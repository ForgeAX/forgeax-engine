// fullscreen-post-process-pass.unit.test.ts -- M3-T3-TEST.
//
// Two surfaces under test:
// 1. Byte-equiv: buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' })
//    deep-equals the historical FULLSCREEN_BGL_DESCRIPTOR for color-input specs
//    (sampleType='float', sampler='filtering').
// 2. R3 historical bug fix: sampleType derives from spec.attachments.
//    'depth32float' (or other depth formats) -> sampleType='depth' + sampler='comparison';
//    'r32float' -> sampleType='unfilterable-float';
//    everything else -> sampleType='float'.

import { describe, expect, it } from 'vitest';
import {
  buildBindGroupLayoutDescriptor,
  type PipelineSpec,
} from '../../../render/src/pipeline-spec';

function makeSpec(attachments: Partial<PipelineSpec['attachments']>): PipelineSpec {
  return {
    shader: {
      id: 'forgeax::tonemap',
      passKind: 'forward',
      variantSet: undefined,
    },
    attachments: {
      colorFormats: ['rgba16float'],
      depthFormat: undefined,
      sampleCount: 1,
      ...attachments,
    },
    geometry: {
      topology: 'triangle-list',
      vertexLayout: {},
    },
    renderState: undefined,
  };
}

describe('buildBindGroupLayoutDescriptor — fullscreen-post', () => {
  describe('byte-equiv vs historical FULLSCREEN_BGL_DESCRIPTOR', () => {
    it('color-input (rgba16float): 2 entries, sampleType=float, sampler=filtering', () => {
      const spec = makeSpec({ colorFormats: ['rgba16float'], depthFormat: undefined });
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries).toEqual([
        {
          binding: 0,
          visibility: 0x2,
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: 0x2,
          sampler: { type: 'filtering' },
        },
      ]);
    });

    it('color-input (rgba8unorm-srgb): float sampleType', () => {
      const spec = makeSpec({ colorFormats: ['rgba8unorm-srgb'], depthFormat: undefined });
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries[0]?.texture?.sampleType).toBe('float');
      expect(out.entries[1]?.sampler?.type).toBe('filtering');
    });

    it('color-input (bgra8unorm): float sampleType', () => {
      const spec = makeSpec({ colorFormats: ['bgra8unorm'], depthFormat: undefined });
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries[0]?.texture?.sampleType).toBe('float');
    });
  });

  describe('R3 sampleType derivation table', () => {
    it("depth32float -> sampleType='depth' + sampler='comparison'", () => {
      const spec = makeSpec({ depthFormat: 'depth32float', colorFormats: [] });
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries[0]?.texture?.sampleType).toBe('depth');
      expect(out.entries[1]?.sampler?.type).toBe('comparison');
    });

    it('r32float -> sampleType=unfilterable-float', () => {
      const spec = makeSpec({ colorFormats: ['r32float'], depthFormat: undefined });
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries[0]?.texture?.sampleType).toBe('unfilterable-float');
      expect(out.entries[1]?.sampler?.type).toBe('filtering');
    });

    it('rgba16float -> float (default branch)', () => {
      const spec = makeSpec({ colorFormats: ['rgba16float'], depthFormat: undefined });
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries[0]?.texture?.sampleType).toBe('float');
    });
  });

  describe('R3 regression case (depth32float view bug)', () => {
    it('depth32float input does not collapse to filterable float (R3 historical bug)', () => {
      // Pre-R3 fix: buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' })
      // emitted sampleType='float' for any input, including depth32float views,
      // which trips wgpu validation: a 'depth' texture cannot be sampled by
      // a 'filtering' sampler. This test pins the post-fix behaviour.
      const spec = makeSpec({
        colorFormats: [],
        depthFormat: 'depth32float',
      });
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries[0]?.texture?.sampleType).not.toBe('float');
      expect(out.entries[0]?.texture?.sampleType).toBe('depth');
    });
  });
});
