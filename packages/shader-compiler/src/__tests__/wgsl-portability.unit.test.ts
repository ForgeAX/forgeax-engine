import { expect, it } from 'vitest';
import { canonicalizePortableWgsl } from '../wgsl-compat.js';

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
