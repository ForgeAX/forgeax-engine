// compare-param-schema.test.ts -- single-direction superset assertion
// (feat-20260613-material-paramschema-driven-binding M2 / w6).
//
// Decision anchors:
//   - plan-strategy D-9 single-direction superset: actual reflected BGL must
//     contain every binding emitted by derive(schema); actual may carry extra
//     bindings (engine-injection placeholders) without failing the build.
//   - plan-strategy D-10 add-only error code: failures emit
//     'material-shader-binding-mismatch' with .expected / .actual / .hint /
//     .detail. Existing `material-schema-mismatch` (with bg-overflow sub-kind)
//     stays put for register-time / overflow concerns.
//   - charter P3 explicit failure: build-time gate stops drift before runtime.
//
// TDD: this file lands red ahead of w7 (compareMaterialBindings
// implementation rewrite). The function name is intentionally distinct from
// the legacy compareParamSchemaWithBgl so the topology dependency is clear.

import { describe, expect, it } from 'vitest';
import { compareMaterialBindings } from '../compare-param-schema.js';
import { BINDING_MISMATCH_FIXTURES } from './fixtures/binding-mismatch.fixtures.js';

const PATH = 'test::material-shader';

describe('compareMaterialBindings (M2 / w6)', () => {
  for (const fixture of BINDING_MISMATCH_FIXTURES) {
    it(`${fixture.name}: verdict=${fixture.verdict}`, () => {
      const result = compareMaterialBindings(fixture.schema, fixture.actualBgls, PATH);
      if (fixture.verdict === 'ok') {
        if (!result.ok) {
          throw new Error(
            `expected fixture '${fixture.name}' to pass; got error code=${result.error.code} message=${result.error.message}`,
          );
        }
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('material-shader-binding-mismatch');
        const detail = result.error.detail;
        if (detail?.code !== 'material-shader-binding-mismatch') {
          throw new Error(
            `expected detail.code='material-shader-binding-mismatch'; got ${String(detail?.code)}`,
          );
        }
        expect(detail.materialShaderPath).toBe(PATH);
        if (fixture.mismatchBinding !== undefined) {
          expect(detail.expected.binding).toBe(fixture.mismatchBinding);
        }
        if (fixture.mismatchParam !== undefined) {
          expect(detail.expectedParam).toBe(fixture.mismatchParam);
        }
        // hint must contain a concrete WGSL author guidance fragment so AI
        // users can fix without trial-and-error (charter F2 text-first).
        expect(result.error.hint.length).toBeGreaterThan(0);
      }
    });
  }

  it('empty schema + empty actual BGL -> ok (D-12 graceful)', () => {
    const result = compareMaterialBindings([], [], PATH);
    expect(result.ok).toBe(true);
  });

  it('empty schema + non-empty actual BGL -> ok (all actual bindings are extras)', () => {
    const result = compareMaterialBindings(
      [],
      [
        {
          entries: [
            {
              binding: 0,
              visibility: 0x2 as GPUShaderStageFlags,
              buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
            },
          ],
        },
      ],
      PATH,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a generic texture contract reflected through explicit-LOD sampling', () => {
    const result = compareMaterialBindings(
      [{ name: 'baseColorTexture', type: 'texture2d' }],
      [
        {
          entries: [
            {
              binding: 0,
              visibility: 0x2 as GPUShaderStageFlags,
              buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
            },
            {
              binding: 1,
              visibility: 0x2 as GPUShaderStageFlags,
              sampler: { type: 'non-filtering' },
            },
            {
              binding: 2,
              visibility: 0x2 as GPUShaderStageFlags,
              texture: {
                sampleType: 'unfilterable-float',
                viewDimension: '2d',
                multisampled: false,
              },
            },
          ],
        },
      ],
      PATH,
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a reflected 2d view for an array texture contract', () => {
    const result = compareMaterialBindings(
      [{ name: 'layers', type: 'texture2d_array' }],
      [
        {
          entries: [
            {
              binding: 0,
              visibility: 0x2 as GPUShaderStageFlags,
              buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
            },
            { binding: 1, visibility: 0x2 as GPUShaderStageFlags, sampler: { type: 'filtering' } },
            {
              binding: 2,
              visibility: 0x2 as GPUShaderStageFlags,
              texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
            },
          ],
        },
      ],
      PATH,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'material-shader-binding-mismatch') return;
    const detail = result.error.detail;
    if (
      detail === undefined ||
      !('expectedParam' in detail) ||
      !('expected' in detail) ||
      !('actual' in detail)
    )
      return;
    expect(detail.expectedParam).toBe('layers');
    expect(detail.expected.texture?.viewDimension).toBe('2d-array');
    expect(detail.actual?.texture?.viewDimension).toBe('2d');
    expect(result.error.hint).toContain('texture_2d_array');
  });

  it('rejects a reflected array view for a volume texture contract', () => {
    const result = compareMaterialBindings(
      [{ name: 'volume', type: 'texture3d' }],
      [
        {
          entries: [
            {
              binding: 0,
              visibility: 0x2 as GPUShaderStageFlags,
              buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
            },
            { binding: 1, visibility: 0x2 as GPUShaderStageFlags, sampler: { type: 'filtering' } },
            {
              binding: 2,
              visibility: 0x2 as GPUShaderStageFlags,
              texture: { sampleType: 'float', viewDimension: '2d-array', multisampled: false },
            },
          ],
        },
      ],
      PATH,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.code !== 'material-shader-binding-mismatch') return;
    const detail = result.error.detail;
    if (
      detail === undefined ||
      !('expectedParam' in detail) ||
      !('expected' in detail) ||
      !('actual' in detail)
    )
      return;
    expect(detail.expectedParam).toBe('volume');
    expect(detail.expected.texture?.viewDimension).toBe('3d');
    expect(detail.actual?.texture?.viewDimension).toBe('2d-array');
    expect(result.error.hint).toContain('texture_3d');
  });
});
