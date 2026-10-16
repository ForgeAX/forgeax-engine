import { describe, expect, it } from 'vitest';
import { createAnimationPayloadLookup } from '../animation-asset-lookup';

describe('createAnimationPayloadLookup', () => {
  it('projects the renderer catalogue lookup into the animation callback', () => {
    const clip = { kind: 'animation-clip' as const, duration: 2, channels: [] };
    const lookup = createAnimationPayloadLookup({
      lookup<T>(guid: string): T | undefined {
        return (guid === 'clip-guid' ? clip : undefined) as T | undefined;
      },
    });

    expect(lookup('clip-guid')).toBe(clip);
    expect(lookup('missing')).toBeUndefined();
  });

  it('fails closed before a renderer catalogue exists', () => {
    expect(createAnimationPayloadLookup(undefined)('clip-guid')).toBeUndefined();
  });
});
