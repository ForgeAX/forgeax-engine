import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectShaderConditionals } from '../conditionals';

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../../shader/src/${file}`, import.meta.url)), 'utf8');

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, `${name} is declared`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\nfn ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

// Alpha test is a compile-time variant: on Apple TBDR any reachable discard
// disables hidden-surface removal for the whole pipeline, so the opaque
// projection must contain no discard at all (not merely a runtime branch).
const ALPHA_TEST_FUNCTIONS = [
  ['default-standard-pbr.wgsl', 'alphaTestSurface'],
  ['default-standard-pbr-skin.wgsl', 'alphaTestSurface'],
  ['shadow_caster.wgsl', 'alphaTestShadowSurface'],
] as const;

describe('ALPHA_MASK compile-time variant', () => {
  it.each(ALPHA_TEST_FUNCTIONS)('%s %s has no discard in the opaque variant', (file, name) => {
    const source = read(file);
    const opaque = projectShaderConditionals(source, { ALPHA_MASK: false }, 'all');
    expect(functionBody(opaque, name)).not.toMatch(/\bdiscard\b/);
  });

  it.each(
    ALPHA_TEST_FUNCTIONS,
  )('%s %s keeps its discard in the alpha-mask variant', (file, name) => {
    const source = read(file);
    const masked = projectShaderConditionals(source, { ALPHA_MASK: true }, 'all');
    expect(functionBody(masked, name)).toMatch(/\bdiscard\b/);
  });

  it.each(
    ALPHA_TEST_FUNCTIONS,
  )('%s %s carries the cutoff discard only for a stock Surface that declares alphaCutoff', (file, name) => {
    const source = read(file);
    const body = (defines: Record<string, boolean>) =>
      functionBody(
        projectShaderConditionals(source, { ALPHA_MASK: true, ...defines }, 'all'),
        name,
      );
    // Hash-only or coverage-only stock materials: no cutoff discard in the source.
    expect(
      body({ STANDARD_STOCK_SURFACE_AVAILABLE: true, ALPHA_CLIPPING_AVAILABLE: false }),
    ).not.toMatch(/\bdiscard\b/);
    expect(
      body({ STANDARD_STOCK_SURFACE_AVAILABLE: true, ALPHA_CLIPPING_AVAILABLE: true }),
    ).toMatch(/\bdiscard\b/);
    // A custom Surface sets its own threshold and keeps the generic gate.
    expect(
      body({ STANDARD_STOCK_SURFACE_AVAILABLE: false, ALPHA_CLIPPING_AVAILABLE: false }),
    ).toMatch(/\bdiscard\b/);
  });

  it('calls the alpha-hash discard only from the alpha-mask variant', () => {
    const source = read('default_standard_surface.wgsl');
    const defines = { ALPHA_HASH_AVAILABLE: true };
    expect(projectShaderConditionals(source, { ...defines, ALPHA_MASK: false }, 'all')).not.toMatch(
      /applyAlphaHash\(coverage/,
    );
    expect(projectShaderConditionals(source, { ...defines, ALPHA_MASK: true }, 'all')).toMatch(
      /applyAlphaHash\(coverage/,
    );
  });

  it('declares the axis on every Standard root that alpha-tests', () => {
    for (const file of [
      'default-standard-pbr.wgsl',
      'default-standard-pbr-skin.wgsl',
      'shadow_caster.wgsl',
    ]) {
      expect(read(file), file).toMatch(/^#pragma variant_axis ALPHA_MASK$/m);
    }
  });
});
