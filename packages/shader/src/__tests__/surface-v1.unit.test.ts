import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const surfaceSource = readFileSync(
  fileURLToPath(new URL('../surface_v1.wgsl', import.meta.url)),
  'utf8',
);
const defaultSource = readFileSync(
  fileURLToPath(new URL('../default_standard_surface.wgsl', import.meta.url)),
  'utf8',
);

const inputFields = [
  ['positionOS', 'vec3<f32>'],
  ['positionWS', 'vec3<f32>'],
  ['geometricNormalWS', 'vec3<f32>'],
  ['vertexNormalWS', 'vec3<f32>'],
  ['tangentWS', 'vec4<f32>'],
  ['viewDirectionWS', 'vec3<f32>'],
  ['uv0', 'vec2<f32>'],
  ['uv1', 'vec2<f32>'],
  ['uv2', 'vec2<f32>'],
  ['uv3', 'vec2<f32>'],
  ['uv4', 'vec2<f32>'],
  ['uv5', 'vec2<f32>'],
  ['uv6', 'vec2<f32>'],
  ['uv7', 'vec2<f32>'],
  ['vertexColor', 'vec4<f32>'],
  ['frontFacing', 'bool'],
  ['uvFootprint0', 'vec4<f32>'],
  ['uvFootprint1', 'vec4<f32>'],
  ['frameTime', 'f32'],
] as const;

const dataFields = [
  ['baseColor', 'vec3<f32>'],
  ['normalWS', 'vec3<f32>'],
  ['metallic', 'f32'],
  ['roughness', 'f32'],
  ['emissive', 'vec3<f32>'],
  ['occlusion', 'f32'],
  ['opacity', 'f32'],
  ['alphaClipThreshold', 'f32'],
] as const;

function assertOrderedFields(source: string, fields: readonly (readonly [string, string])[]) {
  let previous = -1;
  for (const [name, type] of fields) {
    const index = new RegExp(`${name}\\s*:\\s*${type.replace(/[<>]/g, '\\$&')}`).exec(
      source,
    )?.index;
    expect(index, `Surface ABI must contain ${name}: ${type}`).toBeGreaterThan(previous);
    previous = index ?? previous;
  }
}

describe('surface_v1 ABI', () => {
  it('publishes one versioned base-only ABI in stable field order', () => {
    expect(surfaceSource).toContain('#define_import_path forgeax_material::surface_v1');
    expect(surfaceSource).toContain('struct SurfaceInput');
    expect(surfaceSource).toContain('struct SurfaceData');
    assertOrderedFields(surfaceSource, inputFields);
    assertOrderedFields(surfaceSource, dataFields);
    expect(surfaceSource).not.toMatch(/clearcoat|anisotropy|sheen|iridescence|specular/);
  });

  it('keeps authored Surface entry points free of stage and resource ownership', () => {
    const authoredSource = `
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(1.0), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}
`;
    expect(authoredSource).toMatch(
      /fn\s+evaluate_surface\s*\(input\s*:\s*SurfaceInput\s*\)\s*->\s*SurfaceData/,
    );
    expect(authoredSource.match(/fn\s+evaluate_surface\s*\(/g)).toHaveLength(1);
    expect(authoredSource).not.toMatch(/@(fragment|vertex|compute)|@(group|binding)\s*\(/);
    expect(surfaceSource).not.toMatch(/@(fragment|vertex|compute)|@(group|binding)\s*\(/);
  });

  it('keeps the default evaluator in the same Surface ABI family', () => {
    expect(defaultSource).toContain(
      '#define_import_path forgeax_material::default_standard_surface',
    );
    expect(defaultSource).toMatch(
      /fn\s+evaluate_surface\s*\(input\s*:\s*SurfaceInput\s*\)\s*->\s*SurfaceData/,
    );
    expect(defaultSource).toContain('input.vertexNormalWS');
    expect(defaultSource).not.toMatch(/@(fragment|vertex|compute)|@(group|binding)\s*\(/);
  });
});
