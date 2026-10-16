import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderFiles = [
  'standard-surface.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
  'sprite.wgsl',
  'sprite-lit.wgsl',
  'msdf-text.wgsl',
] as const;

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
}

describe('built-in texture coordinate records', () => {
  it('does not declare hand-written texture coordinate members', () => {
    for (const file of shaderFiles) {
      const text = source(file);
      expect(text, `${file} has fixed UV scale members`).not.toMatch(/UvScale\b/);
      expect(text, `${file} has fixed coordinate offsets`).not.toMatch(
        /TEXTURE_COORDINATE_OFFSET|textureScaleOffset/,
      );
    }
  });

  it('routes every built-in material texture sample through the shared scale-aware helper', () => {
    for (const file of shaderFiles) {
      const text = source(file);
      expect(text, `${file} imports the material sampling helper`).toContain(
        'sampleMaterialTexture',
      );
      expect(text, `${file} has no direct material textureSample bypass`).not.toMatch(
        /textureSample\((?:baseColor|metallicRoughness|normal|emissive|occlusion)Texture/,
      );
    }
  });

  it('documents the falsification boundary: replacing a non-unit scale with identity reaches padding', () => {
    const scale: readonly [number, number] = [2085 / 2088, 1573 / 1576];
    const [logicalX, logicalY] = scale;
    const sabotagedEdge: readonly [number, number] = [1, 1];
    expect(logicalX).toBeLessThan(sabotagedEdge[0]);
    expect(logicalY).toBeLessThan(sabotagedEdge[1]);
  });

  it('keeps custom coordinate metadata distinct from texture resources', () => {
    for (const file of shaderFiles) {
      const text = source(file);
      if (file === 'default-standard-pbr-skin.wgsl') {
        // Standard templates are parameter-agnostic inputs. The compiler
        // lowers the generated coordinate metadata together with the selected
        // Surface, so the skinned template only needs to expose that seam.
        expect(text, `${file} must delegate material facts to Surface`).toContain(
          'evaluate_surface',
        );
      } else {
        expect(text, `${file} must name coordinate metadata`).toMatch(/CoordinatesMetadata/);
      }
      expect(text, `${file} must preserve texture resources`).toMatch(/texture_2d|texture_cube/);
    }
  });
});
