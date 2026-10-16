// pbr-pipeline.unit.test.ts -- M3-T1-TEST: byte-equiv guard for D-13 dispatcher.
//
// For each of the 6 createBindGroupLayout sites in pbr-pipeline.ts
// (view / material-merged / mesh-array / instances / skin-mesh-array /
// unlit-material), assert that the descriptor passed to
// device.createBindGroupLayout(...) deep-equals
// buildBindGroupLayoutDescriptor(spec, { kind, caps }).
//
// This pins M3-T1's byte-equiv refactor: the 6 hand-written entries[] arrays
// must be replaced by buildBindGroupLayoutDescriptor calls without changing
// what the device sees.

import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  appendInjection,
  buildPbrMaterialUserRegionEntries,
  buildPbrViewBglEntries,
  materialBindGroupLayoutIdentity,
} from '../../../render/src/pbr-pipeline';
import type { PipelineSpec } from '../../../render/src/pipeline-spec';
import { buildBindGroupLayoutDescriptor } from '../../../render/src/pipeline-spec';

// Standard identity selects its shared backdrop sampler policy.
function makeSpec(): PipelineSpec {
  return {
    shader: {
      id: 'forgeax::default-standard-pbr',
      passKind: 'forward',
      variantSet: undefined,
    },
    attachments: {
      colorFormats: ['rgba8unorm-srgb'],
      depthFormat: 'depth24plus-stencil8',
      sampleCount: 1,
    },
    geometry: {
      topology: 'triangle-list',
      vertexLayout: {},
    },
    renderState: undefined,
  };
}

describe('buildBindGroupLayoutDescriptor — pbr-pipeline 6 sites byte-equiv', () => {
  describe('pbr-view', () => {
    it('storageBuffer=true: 12 entries with projector and cloud bindings', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-view',
        caps: { storageBuffer: true, extendedLighting: false },
      });
      const expected = {
        label: 'pbr-view-bgl',
        entries: buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false }),
      };
      expect(out).toEqual(expected);
      // Binding 8 is the always-on spot shadow atlas, binding 10 is the
      // Points/Lines viewport UBO, bindings 11/12 are the optional projector
      // resources, and bindings 16/17 carry the renderer-owned cloud shadow
      // map. Local lights are exclusively carried by the Standard Cluster
      // group(2), so the view group has no point/spot slots.
      expect(out.entries.length).toBe(12);
      expect(out.entries.find((entry) => entry.binding === 9)).toBeUndefined();
      expect(out.entries.find((entry) => entry.binding === 10)?.buffer?.type).toBe('uniform');
      expect(out.entries.find((entry) => entry.binding === 11)?.texture?.viewDimension).toBe('2d');
      expect(out.entries.find((entry) => entry.binding === 12)?.sampler?.type).toBe('filtering');
      expect(out.entries.find((entry) => entry.binding === 16)?.texture?.viewDimension).toBe('2d');
      expect(out.entries.find((entry) => entry.binding === 17)?.sampler?.type).toBe('filtering');
    });

    it('storageBuffer=false: view group still has no local-light bindings', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-view',
        caps: { storageBuffer: false },
      });
      const expected = {
        label: 'pbr-view-bgl',
        entries: buildPbrViewBglEntries({ storageBuffer: false }),
      };
      expect(out).toEqual(expected);
      expect(out.entries.some((entry) => entry.binding === 1 || entry.binding === 2)).toBe(false);
    });

    it('projectorAvailable=false: omits optional projector bindings for the 16-texture limit', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-view',
        caps: { storageBuffer: true, projectorAvailable: false, extendedLighting: false },
      });
      expect(out).toEqual({
        label: 'pbr-view-bgl',
        entries: buildPbrViewBglEntries({
          storageBuffer: true,
          projectorAvailable: false,
          extendedLighting: false,
        }),
      });
      expect(out.entries.find((entry) => entry.binding === 11)).toBeUndefined();
      expect(out.entries.find((entry) => entry.binding === 12)).toBeUndefined();
      expect(out.entries.find((entry) => entry.binding === 10)?.buffer?.type).toBe('uniform');
    });
  });

  describe('pbr-material-merged', () => {
    it('preserves authored float-data texture types in canonical and physical slots', () => {
      const schema = [
        {
          name: 'baseColorTexture',
          type: 'texture2d' as const,
          sampleType: 'unfilterable-float' as const,
        },
        {
          name: 'clearcoatTexture',
          type: 'texture2d' as const,
          sampleType: 'unfilterable-float' as const,
        },
      ];
      const out = buildBindGroupLayoutDescriptor(makeSpec(), {
        kind: 'pbr-material-merged',
        materialParamSchema: schema,
      });
      expect(out.entries.find((entry) => entry.binding === 2)?.texture?.sampleType).toBe(
        'unfilterable-float',
      );
      expect(out.entries.find((entry) => entry.binding === 49)?.texture?.sampleType).toBe(
        'unfilterable-float',
      );
      expect(out.entries.find((entry) => entry.binding === 4)?.texture?.sampleType).toBe('float');
      expect(materialBindGroupLayoutIdentity(makeSpec().shader.id, schema)).not.toBe(
        materialBindGroupLayoutIdentity(
          makeSpec().shader.id,
          schema.map(({ sampleType, ...entry }) => entry),
        ),
      );
    });
    it('32 entries: user-region 25 - shared pairs 2 + IBL 6 + backdrop 1 + scene material 1 + global specular 1', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-material-merged',
      });
      // Twelve map pairs follow the UBO; displacement is visible only to the vertex stage.
      const userRegion = buildPbrMaterialUserRegionEntries(
        STANDARD_PIPELINE_PARAM_SCHEMA,
        [],
        ['displacementTexture'],
      );
      const afterIbl = [...userRegion, ...appendInjection(userRegion, 'ibl')];
      const expected = {
        label: 'pbr-material-skylight-bgl',
        entries: [
          ...afterIbl.filter((entry) => ![15, 16].includes(entry.binding)),
          ...appendInjection(afterIbl, 'transmission').filter(
            (entry) => ![15, 16, 31].includes(entry.binding),
          ),
          {
            binding: 46,
            visibility: 0x1 | 0x2,
            buffer: { type: 'read-only-storage', hasDynamicOffset: false },
          },
          {
            binding: 47,
            visibility: 0x2,
            texture: { sampleType: 'float', viewDimension: 'cube' },
          },
        ],
      };
      expect(out).toEqual(expected);
      expect(out.entries.length).toBe(32);
    });

    it('adds only authored physical map pairs after the canonical injection chain', () => {
      const schema = [
        ...STANDARD_PIPELINE_PARAM_SCHEMA,
        { name: 'clearcoat', type: 'f32' as const },
        { name: 'clearcoatTexture', type: 'texture2d' as const },
        { name: 'clearcoatNormalTexture', type: 'texture2d' as const },
      ];
      const out = buildBindGroupLayoutDescriptor(makeSpec(), {
        kind: 'pbr-material-merged',
        materialParamSchema: schema,
      });
      expect(out.entries.slice(30).map((entry) => entry.binding)).toEqual([48, 49, 52, 53, 46, 47]);
    });
  });

  describe('pbr-mesh-array', () => {
    it('storageBuffer=true: 1 entry with read-only-storage + dynamic offset + VERTEX|FRAGMENT visibility', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-mesh-array',
        caps: { storageBuffer: true },
      });
      expect(out).toEqual({
        label: 'pbr-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x1 | 0x2,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
        ],
      });
    });

    it('storageBuffer=false: falls back to uniform', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-mesh-array',
        caps: { storageBuffer: false },
      });
      expect(out.entries[0]?.buffer?.type).toBe('uniform');
    });
  });

  describe('pbr-instances', () => {
    it('storageBuffer=true: one vertex-visible read-only-storage entry', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-instances',
        caps: { storageBuffer: true },
      });
      expect(out).toEqual({
        label: 'pbr-instances-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x3,
            buffer: { type: 'read-only-storage', hasDynamicOffset: false },
          },
        ],
      });
    });

    it('storageBuffer=false: one entry falls back to uniform', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-instances',
        caps: { storageBuffer: false },
      });
      expect(out).toEqual({
        label: 'pbr-instances-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x3,
            buffer: { type: 'uniform', hasDynamicOffset: false },
          },
        ],
      });
    });
  });

  describe('pbr-skin-mesh-array', () => {
    it('storageBuffer=true: 3 entries, all dynamic offset', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-skin-mesh-array',
        caps: { storageBuffer: true },
      });
      expect(out).toEqual({
        label: 'pbr-skin-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x3,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
          {
            binding: 1,
            visibility: 0x1,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
          {
            binding: 2,
            visibility: 0x1,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
        ],
      });
    });
  });

  describe('unlit-material', () => {
    it('25 entries: base PBR material only (no skylight injection)', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'unlit-material',
      });
      expect(out).toEqual({
        label: 'unlit-material-bgl',
        entries: buildPbrMaterialUserRegionEntries(),
      });
      expect(out.entries.length).toBe(25);
    });
  });
});
