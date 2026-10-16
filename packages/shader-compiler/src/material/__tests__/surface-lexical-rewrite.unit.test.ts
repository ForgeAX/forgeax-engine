import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { composeSurfaceSource, hoistWgslEnables } from '../compose.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const surfaceAbi = readFileSync(
  new URL('../../../../shader/src/surface_v1.wgsl', import.meta.url),
  'utf8',
);

function compose(aliased: boolean) {
  const name = aliased ? 'surfaceAlias' : 'evaluate_surface';
  const template = `#define_import_path forgeax_material::standard
#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface${aliased ? ' as surfaceAlias' : ''}}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn sample(input: SurfaceInput) -> SurfaceData { return ${name}(input); }`;
  const surface = `#define_import_path game::lexical_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import game::lexical_helper::{shade as helperShade}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  // helperShade remains in this comment.
  let value = helperShade(input.frameTime);
  return SurfaceData(vec3<f32>(value), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`;
  const helper = `#define_import_path game::lexical_helper
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
struct Payload { shade: f32, }
fn passthrough(shade: f32) -> f32 { return shade; }
fn shade(value: f32) -> f32 {
  let payload = Payload(value);
  var total = passthrough(payload.shade);
  for (var shade = 0u; shade < 2u; shade += 1u) { total += f32(shade); }
  return total;
}`;
  const sources = buildMaterialSourceCatalog({
    engine: [
      { path: 'template.wgsl', source: template },
      { path: 'surface_v1.wgsl', source: surfaceAbi },
    ],
    project: [
      { path: 'surface.wgsl', source: surface },
      { path: 'helper.wgsl', source: helper },
    ],
  }).unwrap();
  return composeSurfaceSource({
    material: 'lexical-surface',
    pass: 'Forward',
    templateModule: 'forgeax_material::standard',
    surfaceModule: 'game::lexical_surface',
    sources,
  }).unwrap();
}

describe('Surface identifier rewrite ownership', () => {
  it('keeps canonical imports and aliased imports byte-equivalent after lowering', () => {
    const canonical = compose(false);
    const aliased = compose(true);
    expect(aliased.source).toBe(canonical.source);
    expect(aliased.source).toContain('return evaluate_surface(input);');
    expect(aliased.sourceClosure).toEqual(canonical.sourceClosure);
    // Closure identity still includes the differently authored template bytes.
    expect(aliased.sourceClosureDigest).not.toBe(canonical.sourceClosureDigest);
  });

  it('renames bound helpers without changing fields, parameters, loop locals or comments', () => {
    const { source } = compose(true);
    const helperName = /fn ([A-Za-z_][A-Za-z0-9_]*shade)\(value: f32\)/.exec(source)?.[1];
    expect(helperName).toBeDefined();
    expect(helperName).not.toBe('shade');
    expect(source).toContain(`let value = ${helperName}(input.frameTime);`);
    expect(source).toContain('shade: f32,');
    expect(source).toMatch(/fn \w+passthrough\(shade: f32\) -> f32 \{ return shade; \}/);
    expect(source).toContain('payload.shade');
    expect(source).toContain('for (var shade = 0u; shade < 2u; shade += 1u)');
    expect(source).toContain('total += f32(shade);');
    expect(source).toContain('// helperShade remains in this comment.');
  });

  it('preserves a source with no enable directive and identifiers containing its spelling', () => {
    for (const source of [
      'fn sample() -> f32 { return 1.0; }',
      'const enabled = true;\nfn sample() -> bool { return enabled; }',
    ]) {
      expect(hoistWgslEnables(source)).toBe(source);
    }
  });
});
