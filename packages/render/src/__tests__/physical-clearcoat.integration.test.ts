import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage.js';
import { Materials } from '../materials.js';
import {
  buildBindGroupLayoutDescriptor,
  materialBindGroupLayoutIdentity,
} from '../pbr-pipeline.js';

describe('Standard clearcoat root contract', () => {
  it('keeps a declared factor-zero clearcoat physical and forward-only', () => {
    const material = Materials.standard({
      staticSwitches: { clearcoat: true },
      baseColor: [1, 1, 1, 1],
      clearcoat: 0,
    });
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
    expect(material.parameters?.map((parameter) => parameter.name)).toContain('clearcoat');
    expect(material.values).toMatchObject({ clearcoat: 0 });
  });

  it('retains a single root identity when coat maps are present', () => {
    const options = {
      baseColor: [1, 1, 1, 1] as const,
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      clearcoatTexture: 11,
      clearcoatRoughnessTexture: 12,
      clearcoatNormalTexture: 13,
      clearcoatNormalScale: 0.5,
    } as Parameters<typeof Materials.standard>[0] & Record<string, unknown>;
    const material = Materials.standard(options);
    expect(material.values).toMatchObject({
      clearcoat: 0.8,
      clearcoatRoughness: 0.2,
      clearcoatTexture: 11,
      clearcoatRoughnessTexture: 12,
      clearcoatNormalTexture: 13,
      clearcoatNormalScale: 0.5,
    });
  });

  it('keys equivalent schema instances by the same merged layout identity', () => {
    const withTexture = (name: string) => [
      ...STANDARD_PIPELINE_PARAM_SCHEMA,
      { name, type: 'texture2d' as const },
    ];
    const rigidR = withTexture('clearcoatTexture');
    const rigidRClone = [...rigidR];
    const rigidG = withTexture('clearcoatRoughnessTexture');
    const rigidRg = [...rigidR, { name: 'clearcoatNormalTexture', type: 'texture2d' as const }];

    expect(materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidR)).toBe(
      materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidRClone),
    );
    expect(materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidR)).not.toBe(
      materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidG),
    );
    expect(materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidR)).not.toBe(
      materialBindGroupLayoutIdentity('forgeax::default-standard-pbr', rigidRg),
    );
  });

  it('keeps the built-in Standard IBL ABI stable when physical maps are appended', () => {
    const schema = [
      ...STANDARD_PIPELINE_PARAM_SCHEMA,
      { name: 'clearcoatTexture', type: 'texture2d' as const },
      { name: 'clearcoatNormalTexture', type: 'texture2d' as const },
    ];
    const descriptor = buildBindGroupLayoutDescriptor(
      {
        shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      },
      { kind: 'pbr-material-merged', materialParamSchema: schema },
    );

    // IBL follows the schema-derived user region; scene and physical bindings
    // retain their reserved identities. The bump pair aliases the normal pair.
    const userEnd = derive(STANDARD_PIPELINE_PARAM_SCHEMA).userRegionBindingEnd;
    const userEntries = userEnd - 2;
    expect(descriptor.entries).toHaveLength(userEntries + 13);
    expect(descriptor.entries.slice(0, userEntries).map((entry) => entry.binding)).toEqual(
      Array.from({ length: userEnd }, (_, binding) => binding).filter(
        (binding) => ![15, 16].includes(binding),
      ),
    );
    expect(descriptor.entries[userEntries]?.texture).toMatchObject({ viewDimension: 'cube' });
    expect(descriptor.entries[userEntries + 2]?.texture).toMatchObject({ viewDimension: '2d' });
    expect(descriptor.entries[userEntries + 6]?.texture).toMatchObject({ viewDimension: '2d' });
    expect(
      descriptor.entries.slice(userEntries + 7, userEntries + 11).map((entry) => entry.binding),
    ).toEqual([48, 49, 52, 53]);
    expect(descriptor.entries.find((entry) => entry.binding === 47)).toMatchObject({
      binding: 47,
      texture: { sampleType: 'float', viewDimension: '2d' },
    });
    expect(descriptor.entries.find((entry) => entry.binding === 46)).toMatchObject({
      binding: 46,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'read-only-storage', hasDynamicOffset: false },
    });
    expect(new Set(descriptor.entries.map((entry) => entry.binding)).size).toBe(
      descriptor.entries.length,
    );
  });

  it('reserves the dynamic material UBO for an empty authored schema', () => {
    const descriptor = buildBindGroupLayoutDescriptor(
      {
        shader: { id: 'game::custom', passKind: 'forward', variantSet: undefined },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      },
      { kind: 'pbr-material-merged', materialParamSchema: [] },
    );

    expect(descriptor.entries[0]).toMatchObject({
      binding: 0,
      visibility: 3,
      buffer: { type: 'uniform', hasDynamicOffset: true },
    });
    expect(descriptor.entries[1]?.texture).toMatchObject({ viewDimension: 'cube' });
    // PBR layouts keep the producer-owned scene-material row at binding 46,
    // even when an authored schema has no numeric parameters.
    expect(descriptor.entries.map((entry) => entry.binding)).toEqual([
      ...Array.from({ length: 9 }, (_, binding) => binding),
      46,
      47,
    ]);
  });

  it('derives the single-layer medium depth and nearest inputs at the shader bindings', () => {
    const descriptor = buildBindGroupLayoutDescriptor(
      {
        shader: {
          id: 'forgeax::single-layer-medium',
          passKind: 'forward',
          variantSet: undefined,
        },
        attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
        geometry: { topology: 'triangle-list', vertexLayout: {} },
        renderState: undefined,
      },
      { kind: 'pbr-material-merged', materialParamSchema: [] },
    );

    expect(descriptor.entries.map((entry) => entry.binding)).toEqual([
      ...Array.from({ length: 17 }, (_, binding) => binding),
      46,
    ]);
    expect(descriptor.entries[9]).toMatchObject({
      sampler: { type: 'non-filtering' },
    });
    expect(descriptor.entries[10]).toMatchObject({
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    });
    expect(descriptor.entries[11]).toMatchObject({
      sampler: { type: 'filtering' },
    });
    expect(descriptor.entries[12]).toMatchObject({
      texture: { sampleType: 'float', viewDimension: '2d' },
    });
    expect(descriptor.entries[13]).toMatchObject({
      sampler: { type: 'non-filtering' },
    });
    expect(descriptor.entries[14]).toMatchObject({
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    });

    // The medium is a project material artifact with an explicit empty
    // paramSchema. Its per-shader user region is therefore the reserved UBO
    // at binding 0, followed by IBL 1..6, transmission 7..8, and Surface
    // resources 9..14. Keep this source assertion next to the descriptor
    // assertion so a future injection-order change cannot leave a compiled
    // WGSL binding map out of sync with the runtime BGL.
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../shader/src/single-layer-medium.wgsl'),
      'utf8',
    );
    expect(source).toContain('@group(1) @binding(9) var surfaceRawDepthSampler');
    expect(source).toContain('@group(1) @binding(10) var surfaceRawDepthTexture');
    expect(source).toContain('@group(1) @binding(11) var surfaceNearestLayerSampler');
    expect(source).toContain('@group(1) @binding(12) var surfaceNearestLayerTexture');
    expect(source).toContain('@group(1) @binding(13) var surfaceNearestDepthSampler');
    expect(source).toContain('@group(1) @binding(14) var surfaceNearestDepthTexture');
  });
});
