// 5 built-in shader register-time e2e (feat-20260613-material-paramschema-
// driven-binding M4 / w25).
//
// Walks the post-w18/w19/w20 sidecar paramSchemas through derive() and
// asserts that the BGL shape lines up with plan-strategy §3.4 + the
// orchestrator Q3 reading (3-texture user region; engine injections appended
// via appendInjection).
//
// Coverage matrix:
//   - default-standard-pbr     : userRegionBindingEnd === 7
//   - default-standard-pbr-skin: userRegionBindingEnd === 7
//   - default-unlit            : userRegionBindingEnd === 3
//   - sprite                   : userRegionBindingEnd === 3
//   - shadow-caster (empty)    : userRegionBindingEnd === 0
//
// The fixtures mirror the engine sidecar files exactly — any drift between
// this test and packages/shader/src/*.material.json surfaces immediately
// (charter F2: structural, falsifiable).

import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { appendInjection } from '../../../render/src/pbr-pipeline';

// ─── post-w18 default-standard-pbr sidecar ──────────────────────────────────
const STANDARD_PBR_SIDECAR: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
  { name: 'metallic', type: 'f32', default: 0.0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2.0 },
  { name: 'roughnessChannel', type: 'f32', default: 1.0 },
  { name: 'aoChannel', type: 'f32', default: 0.0 },
  { name: 'extraChannel', type: 'f32', default: 0.0 },
  { name: 'emissive', type: 'vec3', default: [0.0, 0.0, 0.0] },
  { name: 'emissiveIntensity', type: 'f32', default: 0.0 },
  { name: 'occlusionStrength', type: 'f32', default: 1.0 },
  { name: 'alphaCutoff', type: 'f32', default: 0.0 },
  { name: 'clearcoat', type: 'f32', default: 0.0 },
  { name: 'clearcoatRoughness', type: 'f32', default: 1 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

// ─── post-w19 default-standard-pbr-skin sidecar ────────────────────────────
const PBR_SKIN_SIDECAR: readonly ParamSchemaEntry[] = STANDARD_PBR_SIDECAR;

// ─── post-w20 default-unlit sidecar ──────────────────────────────────────────
const UNLIT_SIDECAR: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color' },
  { name: 'baseColorTexture', type: 'texture2d' },
];

// ─── post-w20 sprite sidecar ─────────────────────────────────────────────────
const SPRITE_SIDECAR: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
  { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
  { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
  { name: 'flipX', type: 'f32', default: 0.0 },
  { name: 'flipY', type: 'f32', default: 0.0 },
  { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
  { name: 'sliceMode', type: 'f32', default: 0.0 },
  { name: 'texture', type: 'texture2d' },
];

// ─── shadow-caster (vertex-only depth pass; no per-material params) ──────────
const SHADOW_CASTER_SIDECAR: readonly ParamSchemaEntry[] = [];

describe('5 built-in shader register-time e2e (M4 / w25)', () => {
  it('default-standard-pbr derives 1 UBO + 3 sampler/texture pairs', () => {
    const out = derive(STANDARD_PBR_SIDECAR);
    expect(out.userRegionBindingEnd).toBe(7);
    expect(out.bglEntries.length).toBe(7);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    // Sampler-first (§D-4): odd bindings are samplers, even bindings
    // (after the UBO) are textures.
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.texture?.viewDimension).toBe('2d');
    expect(out.bglEntries[3]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[4]?.texture?.viewDimension).toBe('2d');
    expect(out.bglEntries[5]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[6]?.texture?.viewDimension).toBe('2d');
    // Texture field names exposed for the loader's missing-handle gate.
    expect([...out.textureFieldNames].sort()).toEqual(
      ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture'].sort(),
    );
  });

  it('default-standard-pbr-skin matches the standard-pbr layout (skinned vertex stream lives elsewhere)', () => {
    const out = derive(PBR_SKIN_SIDECAR);
    expect(out.userRegionBindingEnd).toBe(7);
    expect(out.bglEntries.length).toBe(7);
  });

  it('default-unlit derives 1 UBO + 1 sampler/texture pair (userRegionBindingEnd=3)', () => {
    const out = derive(UNLIT_SIDECAR);
    expect(out.userRegionBindingEnd).toBe(3);
    expect(out.bglEntries.map((e) => e.binding)).toEqual([0, 1, 2]);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.texture?.sampleType).toBe('float');
  });

  it('sprite derives one merged UBO (numerics packed std140) + 1 sampler/texture pair', () => {
    const out = derive(SPRITE_SIDECAR);
    // Numerics: baseColor(16) + region(16) + pivot(8 align 8) + flipX(4)
    //         + flipY(4) + slices(16) + sliceMode(4) collapse onto one UBO
    // entry; texture+sampler pair follow.
    expect(out.userRegionBindingEnd).toBe(3);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.texture?.viewDimension).toBe('2d');
    expect(out.uboLayout.entries.find((e) => e.name === 'baseColor')?.offset).toBe(0);
    expect(out.uboLayout.entries.find((e) => e.name === 'region')?.offset).toBe(16);
  });

  it('shadow-caster empty schema derives empty BGL (graceful per D-12)', () => {
    const out = derive(SHADOW_CASTER_SIDECAR);
    expect(out.userRegionBindingEnd).toBe(0);
    expect(out.bglEntries.length).toBe(0);
    expect(out.uboLayout.totalBytes).toBe(0);
  });

  it('appendInjection threads userRegionBindingEnd for each shader', () => {
    // appendInjection consumes the WebGPU-native GPUBindGroupLayoutEntry
    // shape; derive returns the structurally compatible engine-types
    // BindGroupLayoutEntry. The cast is structural — both share the same
    // four resource-layout members (buffer / sampler / texture / storage
    // texture) and the only nominal divergence is exactOptionalPropertyTypes
    // narrowing on the @webgpu/types side.
    type LayoutEntry = readonly GPUBindGroupLayoutEntry[];

    // standard-pbr: 7 + ibl(6) -> bindings 7..12; +transmission(2) -> 13..14
    const pbrOut = derive(STANDARD_PBR_SIDECAR);
    const ibl = appendInjection(pbrOut.bglEntries as unknown as LayoutEntry, 'ibl');
    expect(ibl.map((e) => e.binding)).toEqual([7, 8, 9, 10, 11, 12]);
    const merged = [...(pbrOut.bglEntries as unknown as LayoutEntry), ...ibl];
    const transmission = appendInjection(merged, 'transmission');
    expect(transmission.map((e) => e.binding)).toEqual([13, 14]);

    // unlit: 3 + shadow(2) -> bindings 3..4
    const unlitOut = derive(UNLIT_SIDECAR);
    const unlitShadow = appendInjection(unlitOut.bglEntries as unknown as LayoutEntry, 'shadow');
    expect(unlitShadow.map((e) => e.binding)).toEqual([3, 4]);

    // shadow-caster: 0 + shadow(2) -> bindings 0..1
    const scOut = derive(SHADOW_CASTER_SIDECAR);
    const scShadow = appendInjection(scOut.bglEntries as unknown as LayoutEntry, 'shadow');
    expect(scShadow.map((e) => e.binding)).toEqual([0, 1]);
  });
});
