import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  STANDARD_OBJECT_SPACE_NORMAL_BIT,
  STANDARD_ORM_REUSE_BIT,
  STANDARD_PARALLAX_DISPLACEMENT_BIT,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  STANDARD_SAMPLE_REUSE,
  STANDARD_TRIPLANAR_PROJECTION_BIT,
  standardCoverageTextureMask,
  standardSampleReuseMask,
  standardTextureMask,
} from '../index';
import { standardSurfaceResourceDefines } from '../material-schemas';

const textureBits = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(
  (entry) => entry.type === 'texture2d',
).length;

const log2 = (bit: number) => Math.log2(bit);

describe('Standard override mask layout', () => {
  it('lays out presence, reuse selectors and projection bits contiguously without overlap', () => {
    let cursor = textureBits;
    for (const entry of STANDARD_SAMPLE_REUSE.filter(
      (entry) => entry.target !== 'occlusionTexture',
    )) {
      const width = Math.ceil(Math.log2(entry.sources.length + 1));
      expect(entry.shift, entry.target).toBe(cursor);
      cursor += width;
    }
    expect(log2(STANDARD_TRIPLANAR_PROJECTION_BIT)).toBe(cursor);
    expect(log2(STANDARD_OBJECT_SPACE_NORMAL_BIT)).toBe(cursor + 1);
    expect(log2(STANDARD_PARALLAX_DISPLACEMENT_BIT)).toBe(cursor + 2);
    expect(cursor + 3).toBeLessThanOrEqual(32);
    const orm = STANDARD_SAMPLE_REUSE.find((entry) => entry.target === 'occlusionTexture');
    expect(orm).toMatchObject({ shift: log2(STANDARD_ORM_REUSE_BIT), width: 1 });
  });

  it('only enables authored texture bits declared by the selected program schema', () => {
    const selected = new Set(['baseColorTexture', 'specularColorTexture']);
    const authored = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(({ name }) => selected.has(name));
    const mask = standardTextureMask(authored);
    expect(standardSurfaceResourceDefines(mask, STANDARD_PIPELINE_PARAM_SCHEMA)).toMatchObject({
      BASE_COLOR_TEXTURE_AVAILABLE: true,
      SPECULAR_COLOR_TEXTURE_AVAILABLE: false,
    });
    expect(standardSurfaceResourceDefines(mask, authored)).toMatchObject({
      BASE_COLOR_TEXTURE_AVAILABLE: true,
      SPECULAR_COLOR_TEXTURE_AVAILABLE: true,
    });
  });

  it('projects coverage and displacement without retaining lighting texture selectors', () => {
    const used = new Set(['baseColorTexture', 'alphaTexture', 'displacementTexture']);
    const coverage = standardTextureMask(
      DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter(({ name }) => used.has(name)),
    );
    const all = standardTextureMask(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const reuseBase = standardSampleReuseMask(
      all,
      (source, target) => target === 'alphaTexture' && source === 'baseColorTexture',
    );
    const reuseLighting = standardSampleReuseMask(
      all,
      (source, target) => target === 'alphaTexture' && source === 'metallicRoughnessTexture',
    );
    expect(standardCoverageTextureMask(all + reuseBase + STANDARD_ORM_REUSE_BIT)).toBe(
      coverage + reuseBase,
    );
    expect(
      standardCoverageTextureMask(all + reuseLighting + STANDARD_PARALLAX_DISPLACEMENT_BIT),
    ).toBe(coverage + STANDARD_PARALLAX_DISPLACEMENT_BIT);
    const projected = all + reuseBase + STANDARD_TRIPLANAR_PROJECTION_BIT;
    expect(standardCoverageTextureMask(projected)).toBe(coverage + reuseBase);
    expect(standardCoverageTextureMask(projected, true)).toBe(
      coverage + reuseBase + STANDARD_TRIPLANAR_PROJECTION_BIT,
    );
  });

  it('keeps the alpha selector clear of the projection bits at its largest value', () => {
    const alpha = STANDARD_SAMPLE_REUSE.find((entry) => entry.target === 'alphaTexture');
    if (alpha === undefined) throw new Error('missing alpha reuse entry');
    const selector = (alpha.sources.length * 2 ** alpha.shift) % 2 ** 32;
    for (const bit of [
      STANDARD_TRIPLANAR_PROJECTION_BIT,
      STANDARD_OBJECT_SPACE_NORMAL_BIT,
      STANDARD_ORM_REUSE_BIT,
      STANDARD_PARALLAX_DISPLACEMENT_BIT,
    ]) {
      expect(Math.floor(selector / bit) % 2).toBe(0);
    }
  });
});
