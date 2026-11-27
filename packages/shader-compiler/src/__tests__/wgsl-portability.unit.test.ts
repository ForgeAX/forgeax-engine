import { composeShader } from '@forgeax/engine-naga';
import { fnv1aUtf16 } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { compileShader, createShaderProgramCompiler } from '../index.js';
import { canonicalizePortableWgsl } from '../wgsl-compat.js';
import { EXACT_F32_MAX, F32_BOUNDARY_SOURCE } from './wgsl-f32-boundary.fixture.js';

it('leaves long fractions and already scientific WGSL byte-identical', () => {
  const source =
    'let tiny = 0.00000000000000000001f; let maximum = 3.4028234663852885981170418348451692544e38f;';
  expect(canonicalizePortableWgsl(source)).toBe(source);
});

it('rewrites only whole decimal f32 tokens through the lexical boundary', () => {
  const source =
    '// 100000000000000000000f\nlet id_100000000000000000000f = -12345678901234567890f; let plain = 100000000000000000000f; let fraction = .12345678901234567890f;';
  expect(canonicalizePortableWgsl(source)).toBe(
    '// 100000000000000000000f\nlet id_100000000000000000000f = -1.234567890123456789e19f; let plain = 1e20f; let fraction = .12345678901234567890f;',
  );
});

it('rejects a rewrite candidate without quadratic scanning of a long digit run', () => {
  const source = `let value = ${'1'.repeat(256 * 1024)};`;
  expect(canonicalizePortableWgsl(source)).toBe(source);
});

it('retains the same IEEE maximum with a portable exact decimal, including unary signs', () => {
  const source = 'let a=3.4028235e38f;let b=-34.028235e37f;let c=+.34028235e39f;';
  const expected = `let a=${EXACT_F32_MAX};let b=-${EXACT_F32_MAX};let c=+${EXACT_F32_MAX};`;
  expect(canonicalizePortableWgsl(source)).toBe(expected);
  expect(canonicalizePortableWgsl(expected)).toBe(expected);
  const maximum = (1n << 128n) - (1n << 104n);
  const halfway = (1n << 128n) - (1n << 103n);
  const shortest = 34028235n * 10n ** 31n;
  expect(shortest > maximum && shortest < halfway).toBe(true);
  expect(maximum.toString()).toBe('340282346638528859811704183484516925440');
});

it('does not admit the overflow midpoint, alter non-f32 families, comments or identifiers', () => {
  const source = `let boundary=3.40282356779733661637539395458142568448e38f;
let above=3.4028236e38f;let lower=3.402823466e38f;let abstract=3.4028235e38;
let half=3.4028235e38h;let hex=0x1.fffffep127f;
// 3.4028235e38f
/* outer /* inner */ 3.4028235e38f */ let id_3_4028235e38f=1f;`;
  expect(canonicalizePortableWgsl(source)).toBe(source);
});

it('canonicalizes actual Naga output before direct and selected-entry publication', async () => {
  const raw = await composeShader(F32_BOUNDARY_SOURCE, {}, {});
  expect(raw).toContain('340282350000000000000000000000000000000f');
  for (const computeEntry of [undefined, 'positive', 'negative']) {
    const result = await compileShader(F32_BOUNDARY_SOURCE, {
      id: 'f32-boundary',
      ...(computeEntry === undefined ? {} : { computeEntry }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.wgsl).toContain(EXACT_F32_MAX);
    expect(result.value.wgsl).not.toContain('3.4028235e38f');
    expect(result.value.manifestEntry.wgsl).toBe(result.value.wgsl);
    expect(result.value.manifestEntry.hash).toBe(
      (fnv1aUtf16(result.value.wgsl) >>> 0).toString(16).padStart(8, '0'),
    );
    expect(canonicalizePortableWgsl(result.value.wgsl)).toBe(result.value.wgsl);
  }
});

it('keeps cached selected entries and publication identities tied to the actual canonical output', async () => {
  const cached = createShaderProgramCompiler();
  const positive = (await cached(F32_BOUNDARY_SOURCE, { computeEntry: 'positive' })).unwrap();
  const negative = (await cached(F32_BOUNDARY_SOURCE, { computeEntry: 'negative' })).unwrap();
  const again = (await cached(F32_BOUNDARY_SOURCE, { computeEntry: 'positive' })).unwrap();
  expect(positive.wgsl).toContain('fn positive(');
  expect(positive.wgsl).not.toContain('fn negative(');
  expect(negative.wgsl).toContain('fn negative(');
  expect(negative.wgsl).not.toContain('fn positive(');
  expect(positive.wgsl).toContain(EXACT_F32_MAX);
  expect(negative.wgsl).toContain(EXACT_F32_MAX);
  expect(negative.manifestEntry.hash).not.toBe(positive.manifestEntry.hash);
  expect(again).toEqual(positive);
});
