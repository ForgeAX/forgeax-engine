import { describe, expect, it } from 'vitest';
import { deriveAnimationTargetId, isAnimationTargetId } from '../target-id';

const VECTORS = [
  [['Root', 'Hip'], 'a95da0ec669189f98273e8f86d8ad9f2'],
  [['ab'], 'f9435481ae45880387567b7a1b26b41c'],
  [['a', 'b'], '2a4725924b1c84a5adf2f7933aa10c63'],
  [['Root', 'A/B'], '72262f23f7148acaaf24c50e22924ca7'],
  [['\u6839', '\u9aa8'], '06749e3fb5a88f3a8945fb13c1d7a6b1'],
] as const;

describe('animation target id browser vectors', () => {
  it.each(VECTORS)('derives %j', (path, expected) => {
    const actual = deriveAnimationTargetId(path);
    expect(actual).toBe(expected);
    expect(isAnimationTargetId(actual)).toBe(true);
  });

  it('preserves segment boundaries in the browser', () => {
    expect(deriveAnimationTargetId(['ab'])).not.toBe(deriveAnimationTargetId(['a', 'b']));
  });
});
