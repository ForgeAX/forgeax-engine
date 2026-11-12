import { describe, expect, it } from 'vitest';
import { composeShader } from '../index';

const ENTRY = `
#ifdef USE_COMMON
#import test::common::marker
#endif
@compute @workgroup_size(1) fn main() {
#ifdef USE_COMMON
  marker();
#endif
}`;
const UNKNOWN_AXIS = `
#define_import_path test::common
#if EXTENDED_LIGHTING_AVAILABLE == true
fn marker() {}
#else
fn marker() {}
#endif`;
const PADDING = `
#define_import_path test::common
struct Data { @size(32) value: f32 }
fn marker() {}`;
const TRANSITIVE_ENTRY = `
#import test::root::root_marker
@compute @workgroup_size(1) fn main() { root_marker(); }`;
const ROOT = `
#define_import_path test::root
#ifdef USE_COMMON
#import test::common::marker
#endif
fn root_marker() {
#ifdef USE_COMMON
  marker();
#endif
}`;

describe('raw composer imported layout preflight', () => {
  it.each([
    ['direct', ENTRY, { 'test::common': UNKNOWN_AXIS }],
    ['transitive', TRANSITIVE_ENTRY, { 'test::root': ROOT, 'test::common': UNKNOWN_AXIS }],
  ] as const)('does not preprocess unrelated %s modules without padding attributes', async (_name, entry, imports) => {
    await expect(composeShader(entry, imports, {})).resolves.toContain('fn main');
  });

  it.each([
    ['direct', ENTRY, { 'test::common': PADDING }],
    ['transitive', TRANSITIVE_ENTRY, { 'test::root': ROOT, 'test::common': PADDING }],
  ] as const)('retains conservative registered %s padding admission', async (_name, entry, imports) => {
    await expect(composeShader(entry, imports, {})).rejects.toThrow(
      /naga-oil-import-layout-admission.*@size/,
    );
  });

  it.each([
    ['size', false],
    ['align', false],
    ['size', true],
    ['align', true],
  ] as const)('rejects registered @%s materialized across directives (selected=%s)', async (attribute, selected) => {
    const common = `
#define_import_path test::common
struct Data { @
#ifdef USE_PADDING
${attribute}(32)
#endif
value: f32 }
fn marker() {}`;
    await expect(
      composeShader(
        ENTRY,
        { 'test::common': common },
        { USE_PADDING: true, ...(selected ? { USE_COMMON: true } : {}) },
      ),
    ).rejects.toThrow(new RegExp(`naga-oil-import-layout-admission.*@${attribute}`));
  });

  it.each(['size', 'align'] as const)('allows inactive registered @%s', async (attribute) => {
    const common = `
#define_import_path test::common
#if USE_PADDING == true
struct Data { @${attribute}(32) value: f32 }
#endif
fn marker() {}`;
    await expect(
      composeShader(ENTRY, { 'test::common': common }, { USE_PADDING: false }),
    ).resolves.toContain('fn main');
  });

  it('retains unknown-definition failures in a selected module', async () => {
    await expect(
      composeShader(ENTRY, { 'test::common': UNKNOWN_AXIS }, { USE_COMMON: true }),
    ).rejects.toThrow(
      /shader-compile-failed:.*(?:UnknownShaderDef|Unknown shader def).*EXTENDED_LIGHTING_AVAILABLE/,
    );
  });

  it.each([
    ['direct', ENTRY, { 'test::common': PADDING }],
    ['transitive', TRANSITIVE_ENTRY, { 'test::root': ROOT, 'test::common': PADDING }],
  ] as const)('retains the %s selected-module padding guard', async (_name, entry, imports) => {
    await expect(composeShader(entry, imports, { USE_COMMON: true })).rejects.toThrow(
      /naga-oil-import-layout-admission.*@size/,
    );
  });

  it('retains module/source definition conflicts', async () => {
    await expect(
      composeShader(
        `#define USE_COMMON\n${ENTRY}`,
        { 'test::common': PADDING },
        { USE_COMMON: false },
      ),
    ).rejects.toThrow(/inconsistent shader definition 'USE_COMMON'/);
  });

  it('ignores comment-only padding tokens before conditional preprocessing', async () => {
    const common = UNKNOWN_AXIS.replace('#if', '// @size(32)\n/* @align(32) */\n#if');
    await expect(composeShader(ENTRY, { 'test::common': common }, {})).resolves.toContain(
      'fn main',
    );
  });
});
