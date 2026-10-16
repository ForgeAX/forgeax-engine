import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const viewUboSrc = readFileSync(fileURLToPath(new URL('../view-ubo.ts', import.meta.url)), 'utf8');
const commonWgslSrc = readFileSync(
  fileURLToPath(new URL('../../../..//shader/src/common.wgsl', import.meta.url)),
  'utf8',
);

describe('View UBO directional shadow ABI', () => {
  it('keeps the 1280 B payload inside the aligned View slot', () => {
    expect(viewUboSrc).toMatch(/VIEW_UNIFORM_BYTES\s*=\s*1280/);
    expect(viewUboSrc).toMatch(/VIEW_UNIFORM_SLOT_STRIDE\s*=\s*1280/);
    expect(viewUboSrc).toMatch(/VIEW_PAYLOAD_FLOATS\s*=\s*VIEW_UNIFORM_BYTES \/ 4/);
  });

  it('packs all four cascade metrics into the existing vec4 lanes', () => {
    expect(viewUboSrc).toMatch(/viewPayload\[108 \+ s \* 4 \+ lane\]/);
    expect(viewUboSrc).not.toMatch(/viewPayload\[108 \+ s \* 4\]\s*=\s*lights\.splitPlanes/);
  });

  it('keeps bias at [126]/[127], directional filter at [128..131], and Spot at 132', () => {
    expect(viewUboSrc).toMatch(/viewPayload\[126\]\s*=\s*lights\.depthBias/);
    expect(viewUboSrc).toMatch(/viewPayload\[127\]\s*=\s*lights\.normalBias/);
    expect(viewUboSrc).toMatch(/viewPayload\[128\]/);
    expect(viewUboSrc).toMatch(/viewPayload\[129\]/);
    expect(viewUboSrc).toMatch(/viewPayload\[130\]/);
    expect(viewUboSrc).toMatch(/viewPayload\[131\]/);
    expect(viewUboSrc).toMatch(/SPOT_LVP_BASE_FLOAT\s*=\s*132/);
    expect(viewUboSrc).not.toMatch(/lights\.pcfKernelSize/);
  });

  it('declares one shared View binding with a vec4 directional filter carrier', () => {
    const viewStruct = commonWgslSrc.match(/struct View \{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(viewStruct).toMatch(/directionalShadowFilter\s*:\s*vec4<f32>/);
    expect(viewStruct).toMatch(/ssrParams\s*:\s*vec4<f32>/);
    expect(viewStruct).toMatch(/cloudShadowProjection\s*:\s*vec4<f32>/);
    expect(viewUboSrc).toMatch(/viewPayload\[236\]\s*=\s*ssr\.maxDistance/);
    expect(viewUboSrc).toMatch(/viewPayload\[237\]\s*=\s*ssr\.thickness/);
    expect(viewUboSrc).toMatch(/viewPayload\[238\]\s*=\s*ssr\.maxRoughness/);
    expect(viewUboSrc).toMatch(/viewPayload\[239\]\s*=\s*1/);
    expect(viewStruct).not.toMatch(/pcfKernelSize/);
    expect(commonWgslSrc.match(/@group\(0\) @binding\(0\) var<uniform> view/g)).toHaveLength(1);
  });
});
