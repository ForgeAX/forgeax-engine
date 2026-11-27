import { expect, it } from 'vitest';
import { validateSurfaceDependency, validateSurfaceSource } from '../surface-contract.js';

const request = (extra: string) => ({
  material: 'attributes',
  pass: 'card-capture',
  sourcePath: 'surface.wgsl',
  source: `#define_import_path game::attributes
${extra}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData { return SurfaceData(); }
`,
});

it.each([
  ['@ group(3) @ binding(0) var<uniform> eye: vec4f;', 'resource-binding'],
  [
    '@ /* outer /* nested */ end */ group(3) @ /* gap */ binding(0) var<uniform> eye: vec4f;',
    'resource-binding',
  ],
  ['@\n group(3) @\n binding(0) var<uniform> eye: vec4f;', 'resource-binding'],
  ['@ /* gap */ fragment fn hidden() {}', 'fragment-entry'],
  ['@ vertex fn hidden() {}', 'vertex-entry'],
  ['@ /* gap */ compute @workgroup_size(1) fn hidden() {}', 'compute-entry'],
])('rejects forbidden attributes independently of legal token separators: %s', (extra, name) => {
  for (const validate of [validateSurfaceSource, validateSurfaceDependency]) {
    expect(validate(request(extra))).toMatchObject({
      ok: false,
      error: {
        code: 'material-surface-forbidden-interface',
        detail: { interface: name, action: 'remove-forbidden-interface' },
      },
    });
  }
});

it('keeps legal data attributes and nested-comment pseudo attributes outside the forbidden set', () => {
  const source = request(`
/* @ group(3) /* @ vertex */ @ binding(0) */
// @ fragment fn hidden() {}
struct Data { @align(16) @size(16) color: vec3f, }
`);
  expect(validateSurfaceSource(source).ok).toBe(true);
  expect(validateSurfaceDependency(source).ok).toBe(true);
});
