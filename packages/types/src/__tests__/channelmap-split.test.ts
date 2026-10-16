// channelMap -> 4 f32 split fixture test
// feat-20260613-material-paramschema-driven-binding M1 / w4
//
// Decision anchors (plan-strategy §2):
//   - D-3  numeric-run merging: 4 contiguous f32 entries pack into one UBO
//          entry at one binding slot, with offsets at 4-byte intervals.
//   - D-8  the old `channelMap: vec4` field is split into 4 independent
//          f32 schema entries — `metallicChannel` / `roughnessChannel` /
//          `aoChannel` / `extraChannel` — for default-standard-pbr and
//          default-standard-pbr-skin sidecars (only these 2 shaders carry
//          channelMap; unlit / sprite / shadow-caster do not).
//
// This test is fixture-driven: it reconstructs the v2 sidecar paramSchema
// shapes for the two affected shaders and asserts that derive() emits
// 4 contiguous f32 fields packed across 16 bytes inside the merged UBO,
// with the textures + sampler trailing immediately after the UBO binding.

import { describe, expect, it } from 'vitest';
import { derive } from '../derive-paramschema';
import type { ParamSchemaEntry } from '../index';

// Fixture: post-D-8 standard-pbr paramSchema. Per orchestrator Q3 the user
// region carries 3 textures (baseColor / metallicRoughness / normal); emissive
// + occlusion are engine-owned Standard textures and so do NOT appear in the user-region paramSchema. mrAOMap consolidates the
// metallic-roughness-AO channels (selected per-fragment via the 4 channel
// f32 fields below).
const STANDARD_PBR_SIDECAR: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'extraChannel', type: 'f32', default: 0 },
  { name: 'baseColorMap', type: 'texture2d' },
  { name: 'mrAOMap', type: 'texture2d' },
  { name: 'normalMap', type: 'texture2d' },
];

// Fixture: post-D-8 standard-pbr-skin paramSchema (matches §3.4 row 2:
// merged-UBO + 3 texture+sampler pairs; skinned vertex stream is on a
// different bind group and does not appear in the material schema).
const STANDARD_PBR_SKIN_SIDECAR: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'extraChannel', type: 'f32', default: 0 },
  { name: 'baseColorMap', type: 'texture2d' },
  { name: 'mrAOMap', type: 'texture2d' },
  { name: 'normalMap', type: 'texture2d' },
];

function findUboField(out: ReturnType<typeof derive>, name: string) {
  const f = out.uboLayout.entries.find((e) => e.name === name);
  if (f === undefined) throw new Error(`uboLayout missing field '${name}'`);
  return f;
}

describe('channelMap -> 4 f32 split (D-8) — standard-pbr sidecar', () => {
  const out = derive(STANDARD_PBR_SIDECAR);

  it('emits the 4 channel fields as f32 in the merged UBO', () => {
    for (const name of ['metallicChannel', 'roughnessChannel', 'aoChannel', 'extraChannel']) {
      const f = findUboField(out, name);
      expect(f.type).toBe('f32');
      expect(f.size).toBe(4);
    }
  });

  it('packs the 4 channel f32 contiguously (4-byte stride, 16B span)', () => {
    const m = findUboField(out, 'metallicChannel');
    const r = findUboField(out, 'roughnessChannel');
    const a = findUboField(out, 'aoChannel');
    const x = findUboField(out, 'extraChannel');
    expect(r.offset - m.offset).toBe(4);
    expect(a.offset - r.offset).toBe(4);
    expect(x.offset - a.offset).toBe(4);
    expect(x.offset + x.size - m.offset).toBe(16);
  });

  it('places the channel run after baseColor (vec4) + metallic + roughness', () => {
    // baseColor occupies offset 0..16; metallic@16; roughness@20;
    // metallicChannel@24; roughnessChannel@28; aoChannel@32; extraChannel@36
    expect(findUboField(out, 'baseColor').offset).toBe(0);
    expect(findUboField(out, 'metallic').offset).toBe(16);
    expect(findUboField(out, 'roughness').offset).toBe(20);
    expect(findUboField(out, 'metallicChannel').offset).toBe(24);
    expect(findUboField(out, 'extraChannel').offset).toBe(36);
  });

  it('produces a single binding(0) UBO entry followed by sampler+texture pairs', () => {
    expect(out.bglEntries[0]?.binding).toBe(0);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    // 3 texture + 3 auto-paired filtering sampler = 6 trailing entries.
    expect(out.bglEntries.length).toBe(1 + 3 * 2);
    // userRegionBindingEnd == 7 (1 UBO + 6 sampler/tex); emissive + occlusion
    // are engine-owned and live outside this region.
    expect(out.userRegionBindingEnd).toBe(7);
  });

  it('texture entries are at the expected binding numbers (sampler-first §D-4)', () => {
    // 0=UBO, 1=baseColorSampler, 2=baseColorTex, 3=mrSampler, 4=mrTex,
    // 5=normalSampler, 6=normalTex. Sampler-first: samplers on odd
    // bindings, textures on even bindings.
    const tex = out.bglEntries.filter((e) => e.texture !== undefined);
    expect(tex.map((e) => e.binding)).toEqual([2, 4, 6]);
    const samplers = out.bglEntries.filter((e) => e.sampler !== undefined);
    expect(samplers.map((e) => e.binding)).toEqual([1, 3, 5]);
  });
});

describe('channelMap -> 4 f32 split (D-8) — standard-pbr-skin sidecar', () => {
  const out = derive(STANDARD_PBR_SKIN_SIDECAR);

  it('emits the 4 channel fields as f32 in the merged UBO', () => {
    for (const name of ['metallicChannel', 'roughnessChannel', 'aoChannel', 'extraChannel']) {
      const f = findUboField(out, name);
      expect(f.type).toBe('f32');
      expect(f.size).toBe(4);
    }
  });

  it('packs the 4 channel f32 contiguously (16B span)', () => {
    const m = findUboField(out, 'metallicChannel');
    const x = findUboField(out, 'extraChannel');
    expect(x.offset + x.size - m.offset).toBe(16);
  });

  it('userRegionBindingEnd == 7 for skin (1 UBO + 3 texture+sampler pairs)', () => {
    // §3.4 row 2: 0=UBO, 1/2=baseColor, 3/4=mrAO, 5/6=normal
    expect(out.userRegionBindingEnd).toBe(7);
  });
});
