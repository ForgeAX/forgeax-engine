import { Skin } from '@forgeax/engine-skinning';
import { describe, expect, it } from 'vitest';

describe('static rig asset consumer', () => {
  it('does not require animation to describe Skin', () => {
    expect(Skin.name).toBe('Skin');
  });
});
