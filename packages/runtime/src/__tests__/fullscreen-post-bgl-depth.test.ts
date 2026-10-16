// fullscreen-post-bgl-depth.test.ts —
// feat-20260702-postprocess-camera-depth-read M2 / w4.
//
// Structural assertions for the 'fullscreen-post-with-scene-depth' BGL kind:
// (a) 5-entry layout (color@0 + sampler@1 + params@2 + depthTex@3 + depthSampler@4).
// (b) depthTex@3 uses sampleType:'depth', viewDimension:'2d'.
// (c) depthSampler@4 uses type:'non-filtering' (plan-strategy D-2).
// (d) Existing 'fullscreen-post' and 'fullscreen-post-with-params' BGL shapes
//     are unchanged (AC-03 regression gate — pin the entry counts so a future
//     change to those kinds breaks this test).

import { describe, expect, it } from 'vitest';
import {
  buildBindGroupLayoutDescriptor,
  type PipelineSpec,
} from '../../../render/src/pipeline-spec';

function makeSpec(colorFormats: GPUTextureFormat[] = ['rgba16float']): PipelineSpec {
  return {
    shader: { id: '', passKind: 'forward', variantSet: undefined },
    attachments: { colorFormats, depthFormat: undefined, sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout: {} },
    renderState: undefined,
  };
}

describe('buildBindGroupLayoutDescriptor — fullscreen-post-with-scene-depth', () => {
  it('returns label fullscreen-post-with-scene-depth-bgl', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'fullscreen-post-with-scene-depth',
    });
    expect(out.label).toBe('fullscreen-post-with-scene-depth-bgl');
  });

  it('has exactly 5 entries', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'fullscreen-post-with-scene-depth',
    });
    expect(out.entries).toHaveLength(5);
  });

  it('binding 0 = texture(float, 2d)', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'fullscreen-post-with-scene-depth',
    });
    const e = out.entries[0];
    expect(e?.binding).toBe(0);
    expect(e?.visibility).toBe(0x2); // FRAGMENT
    expect(e?.texture?.sampleType).toBe('float');
    expect(e?.texture?.viewDimension).toBe('2d');
  });

  it('binding 1 = sampler(filtering)', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'fullscreen-post-with-scene-depth',
    });
    const e = out.entries[1];
    expect(e?.binding).toBe(1);
    expect(e?.visibility).toBe(0x2);
    expect(e?.sampler?.type).toBe('filtering');
  });

  it('binding 2 = buffer(uniform) — params always present (D-3)', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'fullscreen-post-with-scene-depth',
    });
    const e = out.entries[2];
    expect(e?.binding).toBe(2);
    expect(e?.visibility).toBe(0x2);
    expect(e?.buffer?.type).toBe('uniform');
  });

  it('binding 3 = texture(depth, 2d)', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'fullscreen-post-with-scene-depth',
    });
    const e = out.entries[3];
    expect(e?.binding).toBe(3);
    expect(e?.visibility).toBe(0x2);
    expect(e?.texture?.sampleType).toBe('depth');
    expect(e?.texture?.viewDimension).toBe('2d');
  });

  it('binding 4 = sampler(non-filtering) — D-2 nearest+clamp, NOT comparison', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'fullscreen-post-with-scene-depth',
    });
    const e = out.entries[4];
    expect(e?.binding).toBe(4);
    expect(e?.visibility).toBe(0x2);
    expect(e?.sampler?.type).toBe('non-filtering');
  });

  describe('AC-03 regression: existing kinds unchanged', () => {
    it("'fullscreen-post' still 2 entries", () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, { kind: 'fullscreen-post' });
      expect(out.entries).toHaveLength(2);
    });

    it("'fullscreen-post-with-params' still 3 entries", () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'fullscreen-post-with-params',
      });
      expect(out.entries).toHaveLength(3);
    });
  });
});

describe('buildBindGroupLayoutDescriptor — fullscreen-post-with-scene-depth-msaa', () => {
  it('declares a multisampled depth texture with the same five-slot ABI', () => {
    const out = buildBindGroupLayoutDescriptor(makeSpec(), {
      kind: 'fullscreen-post-with-scene-depth-msaa',
    });
    expect(out.label).toBe('fullscreen-post-with-scene-depth-msaa-bgl');
    expect(out.entries).toHaveLength(5);
    expect(out.entries[2]?.buffer?.type).toBe('uniform');
    expect(out.entries[3]?.texture).toMatchObject({
      sampleType: 'depth',
      viewDimension: '2d',
      multisampled: true,
    });
    expect(out.entries[4]?.sampler?.type).toBe('non-filtering');
  });

  it('keeps multisampled color and depth in one five-slot paired ABI', () => {
    const out = buildBindGroupLayoutDescriptor(makeSpec(), {
      kind: 'fullscreen-post-with-paired-msaa',
    });
    expect(out.label).toBe('fullscreen-post-with-paired-msaa-bgl');
    expect(out.entries).toHaveLength(5);
    expect(out.entries[0]?.texture).toMatchObject({
      sampleType: 'unfilterable-float',
      viewDimension: '2d',
      multisampled: true,
    });
    expect(out.entries[3]?.texture).toMatchObject({
      sampleType: 'depth',
      viewDimension: '2d',
      multisampled: true,
    });
  });
});
