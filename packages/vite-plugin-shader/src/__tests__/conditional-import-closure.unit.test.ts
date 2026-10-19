import { describe, expect, it } from 'vitest';
import { filterImportsByDefines } from '../engine-inputs/prepare-engine-shader-source';

const imports = Object.fromEntries(
  ['first', 'second', 'third', 'live'].map((id) => [id, `#define_import_path ${id}`]),
);

describe('conditional import closure', () => {
  it('does not let an opaque numeric conditional reopen a disabled parent', () => {
    const source = `#ifdef OUTER
#if COUNT > 2
#import first
#else
#import second
#endif
#import third
#endif
#import live`;
    expect(
      Object.keys(filterImportsByDefines(imports, source, { OUTER: false }, ['OUTER'])),
    ).toEqual(['live']);
  });

  it('preserves both opaque branches and follows the active transitive closure', () => {
    const source = '#import live';
    const modules = {
      ...imports,
      live: `#define_import_path live
#if COUNT > 2
#import first
#else
#import second
#endif
#if !OUTER
#import third
#endif`,
    };
    expect(
      Object.keys(filterImportsByDefines(modules, source, { OUTER: true }, ['OUTER'])).sort(),
    ).toEqual(['first', 'live', 'second']);
  });
});
