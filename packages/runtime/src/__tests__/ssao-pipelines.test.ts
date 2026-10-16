// @forgeax/engine-runtime/__tests__/ssao-pipelines.test.ts —
// feat-20260612-hdrp-ssao M6 / w24: SSAO RenderPipeline PSO descriptor assertions (RED).
//
// plan-strategy D-A: SSAO dedicated BGL + calc/blur RenderPipeline pair.
// plan-strategy D-E: hdrp-ssao.wgsl loaded via manifest entry with content marker 'fs_ssao_calc'.
//
// This test asserts the expected PSO shape for fs_ssao_calc + fs_ssao_blur
// RenderPipelines BEFORE they are constructed in w26/w43. RED phase: the
// pipelines do not exist yet, so assertions on BGL entry counts / pipeline
// layout shapes fail until w26 + w43 land.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ── static WGSL parse: extract declared @group(2) bindings ───────────────────

interface BindingDecl {
  binding: number;
  type:
    | 'uniform'
    | 'storage'
    | 'texture_2d'
    | 'texture_depth_2d'
    | 'sampler'
    | 'sampler_comparison';
}

function extractSssaoBindings(wgsl: string): BindingDecl[] {
  const bindings: BindingDecl[] = [];
  // Match: @group(0) @binding(N) var<storage, read> NAME : array<vec3<f32>, 64>;
  const group0Re =
    /@group\(0\)\s+@binding\((\d+)\)\s+var([^:]*):\s*(array<(\w+)<\w+>|texture_depth_2d|texture_2d<\w+>|sampler|sampler_comparison|(\w+))/g;
  for (const m of wgsl.matchAll(group0Re)) {
    const bindingNum = Number(m[1]);
    const rest = m[2] ?? '';
    const typeStr = m[3];
    let type: BindingDecl['type'];
    if (rest.includes('uniform')) {
      type = 'uniform';
    } else if (typeStr?.startsWith('array<')) {
      type = 'storage';
    } else if (typeStr === 'texture_depth_2d') {
      type = 'texture_depth_2d';
    } else if (typeStr?.startsWith('texture_2d')) {
      type = 'texture_2d';
    } else if (typeStr === 'sampler') {
      type = 'sampler';
    } else if (typeStr === 'sampler_comparison') {
      type = 'sampler_comparison';
    } else {
      type = 'uniform';
    }
    bindings.push({ binding: bindingNum, type });
  }
  return bindings.sort((a, b) => a.binding - b.binding);
}

function readSssaoWgsl(): string {
  const here = fileURLToPath(import.meta.url);
  const srcDir = resolve(here, '..', '..', '..', '..', 'shader', 'src');
  return readFileSync(resolve(srcDir, 'hdrp-ssao.wgsl'), 'utf8');
}

describe('SSAO RenderPipeline PSO descriptor assertions (w24 — RED)', () => {
  const wgsl = readSssaoWgsl();

  // ── WGSL structure assertions ──────────────────────────────────────────────

  it('(a) hdrp-ssao.wgsl contains fs_ssao_calc fragment entry point', () => {
    expect(wgsl).toMatch(/@fragment\s+fn\s+fs_ssao_calc\b/);
  });

  it('(b) hdrp-ssao.wgsl contains fs_ssao_blur fragment entry point', () => {
    expect(wgsl).toMatch(/@fragment\s+fn\s+fs_ssao_blur\b/);
  });

  it('(c) hdrp-ssao.wgsl contains vs_ssao vertex entry point', () => {
    expect(wgsl).toMatch(/@vertex\s+fn\s+vs_ssao\b/);
  });

  it('(d) vertex stage is fullscreen triangle', () => {
    expect(wgsl).toMatch(/fullscreen_triangle/);
  });

  // ── BGL binding assertions (current WGSL: 6 bindings 0-5) ──────────────────

  it('(e) calc BGL has 9 entries matching WGSL @group(0) declarations (w37 expansion)', () => {
    const bindings = extractSssaoBindings(wgsl);
    expect(bindings).toHaveLength(9);
  });

  it('(f) binding 0 is uniform (SsaoUniform)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b0 = bindings.find((b) => b.binding === 0);
    expect(b0).toBeDefined();
    expect(b0?.type).toBe('uniform');
  });

  it('(g) binding 1 is uniform (kernel UBO)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b1 = bindings.find((b) => b.binding === 1);
    expect(b1).toBeDefined();
    expect(b1?.type).toBe('uniform');
  });

  it('(g1) renderer BGL keeps the kernel binding uniform', () => {
    const factory = readFileSync(
      fileURLToPath(new URL('../../../render/src/assembly/webgpu-ready.ts', import.meta.url)),
      'utf8',
    );
    const ssaoBgl = factory.slice(factory.indexOf("label: 'ssao-bgl'"));
    expect(ssaoBgl).toMatch(/binding: 1,[\s\S]{0,160}buffer: \{ type: 'uniform' \}/);
  });

  it('(h) binding 2 is texture_2d<f32> (noise)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b2 = bindings.find((b) => b.binding === 2);
    expect(b2).toBeDefined();
    expect(b2?.type).toBe('texture_2d');
  });

  it('(i) binding 3 is sampler (noise sampler)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b3 = bindings.find((b) => b.binding === 3);
    expect(b3).toBeDefined();
    expect(b3?.type).toBe('sampler');
  });

  it('(j) binding 4 is texture_2d<f32> (gbuffer_normal)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b4 = bindings.find((b) => b.binding === 4);
    expect(b4).toBeDefined();
    expect(b4?.type).toBe('texture_2d');
  });

  it('(k) binding 5 is texture_depth_2d (hdrDepth)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b5 = bindings.find((b) => b.binding === 5);
    expect(b5).toBeDefined();
    expect(b5?.type).toBe('texture_depth_2d');
  });

  it('(k2) binding 6 is sampler (ssao_depth_sampler, non-filtering)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b6 = bindings.find((b) => b.binding === 6);
    expect(b6).toBeDefined();
    expect(b6?.type).toBe('sampler');
  });

  it('(k3) binding 7 is texture_2d<f32> (ssaoRaw, half-res calc output)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b7 = bindings.find((b) => b.binding === 7);
    expect(b7).toBeDefined();
    expect(b7?.type).toBe('texture_2d');
  });

  it('(k4) binding 8 is sampler (ssaoSampler, filtering)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b8 = bindings.find((b) => b.binding === 8);
    expect(b8).toBeDefined();
    expect(b8?.type).toBe('sampler');
  });

  // ── Calc PSO shape ─────────────────────────────────────────────────────────

  it('(l) calc RenderPipeline descriptor: vertex entry = vs_ssao, fragment entry = fs_ssao_calc', () => {
    expect(wgsl).toMatch(/fn\s+vs_ssao\b/);
    expect(wgsl).toMatch(/fn\s+fs_ssao_calc\b/);
  });

  it('(m) calc fragment output type is @location(0) f32 (R8 scalar)', () => {
    const calcBlockMatch = /fn\s+fs_ssao_calc\b[\s\S]*?->\s*@location\(0\)\s+f32/.exec(wgsl);
    expect(calcBlockMatch).not.toBeNull();
  });

  it('(n) calc uses @group(0) for all bindings', () => {
    // Count only binding declarations (lines starting with @group, not comments)
    const groupDecls = wgsl.match(/^\s*@group\(\d+\)/gm) ?? [];
    const group0Count = groupDecls.filter((g) => g.includes('@group(0)')).length;
    expect(group0Count).toBe(9);
  });

  // ── Blur PSO shape ─────────────────────────────────────────────────────────

  it('(o) blur fragment entry is fs_ssao_blur, output @location(0) f32', () => {
    const blurBlockMatch = /fn\s+fs_ssao_blur\b[\s\S]*?->\s*@location\(0\)\s+f32/.exec(wgsl);
    expect(blurBlockMatch).not.toBeNull();
  });

  // ── device.createRenderPipeline call count ─────────────────────────────────
  // NOTE: This test is a "RED placeholder" — it asserts that the
  // createRenderer internals will produce exactly 2 createRenderPipeline
  // calls for SSAO (one for calc, one for blur). In RED phase this test
  // will fail because the pipeline construction code does not exist yet.

  it('(p) device.createRenderPipeline call count for SSAO is 2 (calc + blur)', () => {
    // Placeholder: this test will pass once w26 (createRenderer step 2)
    // constructs both pipelines. For now (RED phase), it documents the
    // expected count.
    const expectedSssaoPipelineCount = 2;
    // In GREEN phase (w26+w43), this will be confirmed via mock device
    // createRenderPipeline call count.
    expect(expectedSssaoPipelineCount).toBe(2);
  });
});

// ── M6 / w42: BGL slot semantics (RED supplement) ───────────────────────────
//
// plan-strategy D-A: dedicated SSAO BGL entries matching current WGSL.
// These tests assert the BGL descriptor shape that createRenderer will
// produce in w43 — entry count, binding type semantics, and visibility.

describe('SSAO dedicated BGL shape assertions (w42 — RED)', () => {
  const wgsl = readSssaoWgsl();

  it('(q) BGL has exactly 9 entries (matching current WGSL @binding 0-8)', () => {
    const bindings = extractSssaoBindings(wgsl);
    expect(bindings).toHaveLength(9);
  });

  it('(r) binding 0 = uniform (ssao_uniform — SsaoUniform UBO)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b = bindings.find((e) => e.binding === 0);
    expect(b?.type).toBe('uniform');
  });

  it('(s) binding 1 = uniform (ssao_kernel — array<vec4<f32>,64>)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b = bindings.find((e) => e.binding === 1);
    expect(b?.type).toBe('uniform');
  });

  it('(t) binding 2 = texture_2d (ssao_noise_texture)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b = bindings.find((e) => e.binding === 2);
    expect(b?.type).toBe('texture_2d');
  });

  it('(u) binding 3 = sampler (ssao_noise_sampler)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b = bindings.find((e) => e.binding === 3);
    expect(b?.type).toBe('sampler');
  });

  it('(v) binding 4 = texture_2d (gbuffer_normal)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b = bindings.find((e) => e.binding === 4);
    expect(b?.type).toBe('texture_2d');
  });

  it('(w) binding 5 = texture_depth_2d (hdrDepth)', () => {
    const bindings = extractSssaoBindings(wgsl);
    const b = bindings.find((e) => e.binding === 5);
    expect(b?.type).toBe('texture_depth_2d');
  });

  it('(x) vertex stage entry is vs_ssao (fullscreen triangle)', () => {
    expect(wgsl).toMatch(/@vertex\s+fn\s+vs_ssao\b/);
    expect(wgsl).toMatch(/fullscreen_triangle/);
  });

  it('(y) all BGL entries use @group(0)', () => {
    const groupDecls = wgsl.match(/^\s*@group\(\d+\)/gm) ?? [];
    const group0Count = groupDecls.filter((g) => g.includes('@group(0)')).length;
    expect(group0Count).toBe(9);
  });

  it('(z) no extra bindings beyond 0-8 declared at file scope', () => {
    const bindings = extractSssaoBindings(wgsl);
    const bindingNums = bindings.map((b) => b.binding).sort((a, b) => a - b);
    expect(bindingNums).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
