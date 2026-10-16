import { describe, expect, it } from 'vitest';
import { resolveIntegratedVolumeConsumer } from '../volume/capability';

describe('volumetric fog shared consumer contract', () => {
  it('provides one integrated volume to opaque and transparent consumers', () => {
    const resource = {
      identity: 'volume-integrated',
      format: 'rgba16float',
      stage: 'resolved' as const,
    } as const;
    for (const consumer of ['opaque', 'transparent', 'sprite', 'vfx'] as const) {
      expect(resolveIntegratedVolumeConsumer(resource, consumer)).toEqual({
        consumer,
        resource,
      });
    }
  });

  it('does not let a custom consumer own volume device or history', () => {
    const result = resolveIntegratedVolumeConsumer(
      { identity: 'volume-integrated', format: 'rgba16float', stage: 'resolved' } as const,
      'custom',
    );
    expect(result).not.toHaveProperty('device');
    expect(result).not.toHaveProperty('history');
  });
});
