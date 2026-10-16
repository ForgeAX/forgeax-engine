import { describe, expect, it } from 'vitest';
import { deriveAnimationTargetId, isAnimationTargetId } from '../target-id';

const VECTORS = [
  [['Root', 'Hip'], 'a95da0ec669189f98273e8f86d8ad9f2'],
  [['ab'], 'f9435481ae45880387567b7a1b26b41c'],
  [['a', 'b'], '2a4725924b1c84a5adf2f7933aa10c63'],
  [['Root', 'A/B'], '72262f23f7148acaaf24c50e22924ca7'],
  [['\u6839', '\u9aa8'], '06749e3fb5a88f3a8945fb13c1d7a6b1'],
] as const;

describe('animation target id', () => {
  it.each(VECTORS)('derives %j', (path, expected) => {
    const actual = deriveAnimationTargetId(path);
    expect(actual).toBe(expected);
    expect(actual[12]).toBe('8');
    expect(Number.parseInt(actual[16] ?? '', 16) & 0xc).toBe(0x8);
  });

  it('preserves segment, slash, and UTF-8 boundaries', () => {
    expect(deriveAnimationTargetId(['ab'])).not.toBe(deriveAnimationTargetId(['a', 'b']));
    expect(deriveAnimationTargetId(['Root', 'A/B'])).not.toBe(
      deriveAnimationTargetId(['Root', 'A', 'B']),
    );
    expect(deriveAnimationTargetId(['\u6839', '\u9aa8'])).toBe(VECTORS[4][1]);
  });

  it.each([
    '',
    'a'.repeat(31),
    'a'.repeat(33),
    'A95da0ec669159f98273e8f86d8ad9f',
    'g95da0ec669159f98273e8f86d8ad9f',
  ])('rejects invalid wire %j', (wire) => {
    expect(isAnimationTargetId(wire)).toBe(false);
  });

  it('accepts a 32-character lowercase hexadecimal wire', () => {
    expect(isAnimationTargetId(VECTORS[0][1])).toBe(true);
  });
});
