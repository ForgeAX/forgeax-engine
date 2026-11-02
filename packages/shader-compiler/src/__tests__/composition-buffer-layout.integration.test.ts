import {
  composeShader,
  emit_reflection,
  parse,
  parseReflectionWire,
  specializeComputeEntries,
  validate,
} from '@forgeax/engine-naga';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../compile.js';

const ALIGNED_BUFFER = `\
struct Data {
  prefix: f32,
  @align(32) aligned: f32,
  tail: f32,
}
@group(0) @binding(0) var<storage, read> data: Data;
@compute @workgroup_size(1) fn main() {
  let keep = data.prefix + data.aligned + data.tail;
}`;

const SIZED_BUFFER = `\
struct Data {
  @size(32) padded: f32,
  tail: f32,
}
@group(0) @binding(0) var<storage, read> data: Data;
@compute @workgroup_size(1) fn main() {
  let keep = data.padded + data.tail;
}`;

async function directReflection(source: string) {
  const parsed = await parse(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const checked = await validate(parsed.value);
  if (!checked.ok) throw new Error(checked.error.message);
  try {
    const emitted = await emit_reflection(checked.value, '{}');
    if (!emitted.ok) throw new Error(emitted.error.message);
    return parseReflectionWire(emitted.value);
  } finally {
    checked.value.free();
  }
}

function expectCompileFailure(
  result: Awaited<ReturnType<typeof compileShader>>,
  resource: string,
): void {
  expect(result).toMatchObject({ ok: false, error: { code: 'shader-compile-failed' } });
  if (!result.ok) {
    expect(result.error.message).toContain('buffer ABI');
    expect(result.error.message).toContain(resource);
    expect(result.error.message).toContain('before=');
    expect(result.error.message).toContain('after=');
  }
}

function expectImportedPaddingFailure(
  result: Awaited<ReturnType<typeof compileShader>>,
  moduleId: string,
  attribute: '@align' | '@size',
): void {
  expect(result).toMatchObject({ ok: false, error: { code: 'shader-compile-failed' } });
  if (!result.ok) {
    expect(result.error.message).toContain('naga-oil-import-layout-admission');
    expect(result.error.message).toContain(moduleId);
    expect(result.error.message).toContain(attribute);
    expect(result.error.message).toContain('writer');
  }
}

describe('WGSL writer buffer-layout admission', () => {
  it('preserves explicit align and size facts in direct Naga reflection', async () => {
    const aligned = await directReflection(ALIGNED_BUFFER);
    expect(aligned.boundGlobals[0]).toMatchObject({
      span: 64,
      members: [
        { name: 'prefix', offset: 0, size: 4, alignment: 4 },
        { name: 'aligned', offset: 32, size: 4, alignment: 4 },
        { name: 'tail', offset: 36, size: 4, alignment: 4 },
      ],
    });

    const sized = await directReflection(SIZED_BUFFER);
    expect(sized.boundGlobals[0]).toMatchObject({
      span: 36,
      members: [
        { name: 'padded', offset: 0, size: 4, alignment: 4 },
        { name: 'tail', offset: 32, size: 4, alignment: 4 },
      ],
    });
  });

  it('rejects lossy direct composition and compute-entry projection with structured errors', async () => {
    await expect(composeShader(ALIGNED_BUFFER, {}, {})).rejects.toThrow(
      /shader-compile-failed:.*buffer ABI.*group=0.*binding=0/s,
    );
    await expect(composeShader(SIZED_BUFFER, {}, {})).rejects.toThrow(
      /shader-compile-failed:.*buffer ABI.*group=0.*binding=0/s,
    );

    expectCompileFailure(
      await compileShader(ALIGNED_BUFFER, { id: 'test::aligned', computeEntry: 'main' }),
      'group=0 binding=0',
    );
    expectCompileFailure(
      await compileShader(SIZED_BUFFER, { id: 'test::sized', computeEntry: 'main' }),
      'group=0 binding=0',
    );

    const projected = await specializeComputeEntries(ALIGNED_BUFFER, ['main']);
    expect(projected).toMatchObject({
      ok: false,
      error: { code: 'shader-compile-failed' },
    });
    if (!projected.ok) {
      expect(projected.error.message).toContain('buffer ABI');
      expect(projected.error.message).toContain('group=0 binding=0');
    }
  });

  it('accepts natural matrix and fixed-array padding', async () => {
    const source = `\
struct Data {
  matrix: mat3x3<f32>,
  values: array<vec4<f32>, 2>,
  tail: vec4<f32>,
}
@group(0) @binding(0) var<storage, read> data: Data;
@compute @workgroup_size(1) fn main() {
  let keep = data.matrix[0][0] + data.values[0].x + data.tail.x;
}`;
    const composed = await composeShader(source, {}, {});
    expect(composed).toContain('mat3x3<f32>');
    const compiled = await compileShader(source, {
      id: 'test::natural-padding',
      computeEntry: 'main',
    });
    expect(compiled).toMatchObject({ ok: true });
  });

  it('rejects active imported padding through transitive module closure', async () => {
    const importedSource = `\
#import test::outer::{ Outer }
@group(2) @binding(4) var<storage, read> data: Outer;
@compute @workgroup_size(1) fn main() {
  let keep = data.inner.basis[0][0] + data.tail;
}`;
    const inner = `\
#define_import_path test::inner
struct Inner {
  prefix: f32,
  @align(32) aligned: f32,
  basis: mat3x3<f32>,
}`;
    const outer = `\
#define_import_path test::outer
#import test::inner::{ Inner }
struct Outer {
  inner: Inner,
  tail: f32,
}`;
    const importedResult = await compileShader(importedSource, {
      id: 'test::imported-buffer',
      imports: { 'test::outer': outer, 'test::inner': inner },
      computeEntry: 'main',
    });
    expectImportedPaddingFailure(importedResult, 'test::inner', '@align');
  });

  it('admits natural nested matrix and fixed-array layout from imported modules', async () => {
    const source = `\
#import test::outer::{ Outer }
@group(2) @binding(4) var<storage, read> data: Outer;
@compute @workgroup_size(1) fn main() {
  let keep = data.inner.basis[0][0] + data.inner.values[1].x + data.tail.x;
}`;
    const imports = {
      'test::outer': `\
#define_import_path test::outer
#import test::inner::{ Inner }
struct Outer { inner: Inner, tail: vec4<f32> }`,
      'test::inner': `\
#define_import_path test::inner
struct Inner { basis: mat3x3<f32>, values: array<vec4<f32>, 2> }`,
    };
    const compiled = await compileShader(source, {
      id: 'test::natural-import-padding',
      imports,
      computeEntry: 'main',
    });
    expect(compiled).toMatchObject({ ok: true });
    if (compiled.ok) {
      const global = compiled.value.reflection.boundGlobals.find(
        ({ group, binding }) => group === 2 && binding === 4,
      );
      expect(global?.typeDescriptor).toMatchObject({
        kind: 'struct',
        members: [
          {
            name: 'inner',
            offset: 0,
            typeDescriptor: {
              kind: 'struct',
              members: [
                { name: 'basis', offset: 0, typeDescriptor: { kind: 'matrix', columnStride: 16 } },
                { name: 'values', offset: 48, typeDescriptor: { kind: 'array', stride: 16 } },
              ],
            },
          },
          { name: 'tail', offset: 80 },
        ],
      });
    }
  });

  it('matches the selected option and entry-source define branches for imported padding', async () => {
    const importedSource = `\
#import test::conditional::{ Data }
@group(0) @binding(0) var<storage, read> data: Data;
@compute @workgroup_size(1) fn main() {
  let keep = data.prefix + data.aligned + data.tail;
}`;
    const conditional = `\
#define_import_path test::conditional
#ifdef PADDED_LAYOUT
struct Data {
  prefix: f32,
  @align(32) aligned: f32,
  tail: f32,
}
#else
struct Data { prefix: f32, aligned: f32, tail: f32 }
#endif`;
    const imports = { 'test::conditional': conditional };

    expectImportedPaddingFailure(
      await compileShader(importedSource, {
        id: 'test::active-import-padding-option',
        imports,
        defines: { PADDED_LAYOUT: true },
        computeEntry: 'main',
      }),
      'test::conditional',
      '@align',
    );
    expect(
      await compileShader(importedSource, {
        id: 'test::inactive-import-padding-option',
        imports,
        defines: { PADDED_LAYOUT: false },
        computeEntry: 'main',
      }),
    ).toMatchObject({ ok: true });

    const conditionalImport = `\
#define PADDED_LAYOUT
#ifdef PADDED_LAYOUT
#import test::padded::marker
#else
#import test::plain::marker
#endif
@compute @workgroup_size(1) fn main() { let keep = marker(); }`;
    const selectedImports = {
      'test::padded': `\
#define_import_path test::padded
struct Data { prefix: f32, @size(32) padded: f32 }
fn marker() -> f32 { return 1.0; }`,
      'test::plain': `\
#define_import_path test::plain
fn marker() -> f32 { return 1.0; }`,
    };
    expectImportedPaddingFailure(
      await compileShader(conditionalImport, {
        id: 'test::entry-source-define-padding',
        imports: selectedImports,
        defines: { OTHER_AXIS: true },
        computeEntry: 'main',
      }),
      'test::padded',
      '@size',
    );

    const conflictingSourceDefine = await compileShader(conditionalImport, {
      id: 'test::entry-option-source-define-conflict',
      imports: selectedImports,
      defines: { PADDED_LAYOUT: false },
      computeEntry: 'main',
    });
    expect(conflictingSourceDefine).toMatchObject({
      ok: false,
      error: { code: 'shader-compile-failed' },
    });
    if (!conflictingSourceDefine.ok) {
      expect(conflictingSourceDefine.error.message).toContain('inconsistent shader definition');
      expect(conflictingSourceDefine.error.message).toContain('PADDED_LAYOUT');
    }

    const inactiveEntryDefine = conditionalImport.replace('#define PADDED_LAYOUT', '');
    const inactive = await compileShader(inactiveEntryDefine, {
      id: 'test::entry-source-define-inactive-import',
      imports: selectedImports,
      defines: { PADDED_LAYOUT: false },
      computeEntry: 'main',
    });
    expect(inactive).toMatchObject({ ok: true });
    if (inactive.ok) expect(inactive.value.deps).toEqual(['test::padded', 'test::plain']);

    const nestedImports = {
      'test::root': `\
#define_import_path test::root
#ifdef PADDED_LAYOUT
#import test::padded
#else
#import test::plain
#endif
fn root_marker() -> f32 { return 1.0; }`,
      'test::padded': selectedImports['test::padded'],
      'test::plain': selectedImports['test::plain'],
    };
    const nestedImportEntry = `\
#import test::root::root_marker
@compute @workgroup_size(1) fn main() { let keep = root_marker(); }`;
    expectImportedPaddingFailure(
      await compileShader(nestedImportEntry, {
        id: 'test::transitive-active-padding-branch',
        imports: nestedImports,
        defines: { PADDED_LAYOUT: true },
        computeEntry: 'main',
      }),
      'test::padded',
      '@size',
    );
    const nestedInactive = await compileShader(nestedImportEntry, {
      id: 'test::transitive-inactive-padding-branch',
      imports: nestedImports,
      defines: { PADDED_LAYOUT: false },
      computeEntry: 'main',
    });
    expect(nestedInactive).toMatchObject({ ok: true });
    if (nestedInactive.ok) {
      expect(nestedInactive.value.deps).toEqual(['test::root', 'test::padded', 'test::plain']);
    }

    const conditionalSourceDefine = conditionalImport.replace(
      '#define PADDED_LAYOUT',
      '#ifdef OUTER_AXIS\n#define PADDED_LAYOUT\n#endif',
    );
    expectImportedPaddingFailure(
      await compileShader(conditionalSourceDefine, {
        id: 'test::conditional-entry-source-define',
        imports: selectedImports,
        computeEntry: 'main',
      }),
      'test::padded',
      '@size',
    );
  });

  it('ignores padding-like comments and ordinary identifiers and keeps module defines unsupported', async () => {
    const source = `\
#import test::plain::{ Data }
@group(0) @binding(0) var<storage, read> data: Data;
@compute @workgroup_size(1) fn main() { let keep = data.alignedSize; }`;
    const plain = `\
#define_import_path test::plain
// @align(32) and #import test::padding
/* @size(64) */
struct Data { alignedSize: f32 }`;
    expect(
      await compileShader(source, {
        id: 'test::commented-import-padding',
        imports: { 'test::plain': plain },
        computeEntry: 'main',
      }),
    ).toMatchObject({ ok: true });

    await expect(
      composeShader(
        '@compute @workgroup_size(1) fn main() {}',
        {
          'test::unused-padding': `\
#define_import_path test::unused-padding
struct Data { prefix: f32, @align(32) value: f32 }`,
        },
        {},
      ),
    ).rejects.toThrow(
      /shader-compile-failed: naga-oil-import-layout-admission rejected active @align in imported module 'test::unused-padding'/,
    );

    const moduleDefine = `\
#define_import_path test::defines
#define PADDED_LAYOUT
fn marker() -> f32 { return 1.0; }`;
    const moduleDefineEntry =
      '#import test::defines::marker\n@compute @workgroup_size(1) fn main() { let keep = marker(); }';
    const moduleDefineResult = await compileShader(moduleDefineEntry, {
      id: 'test::module-define-unsupported',
      imports: { 'test::defines': moduleDefine },
      computeEntry: 'main',
    });
    expect(moduleDefineResult).toMatchObject({
      ok: false,
      error: { code: 'shader-compile-failed' },
    });
    await expect(
      composeShader(moduleDefineEntry, { 'test::defines': moduleDefine }, {}),
    ).rejects.toThrow(/shader-compile-failed/);
  });
});
