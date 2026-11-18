import { describe, expect, it } from 'vitest';
import { ownConfigurationData } from '../configuration-data';

describe('configuration data ownership', () => {
  it('rejects sparse arrays without silently compacting device declarations', () => {
    const profiles = new Array(2);
    profiles[1] = { id: 'phone' };
    expect(() => ownConfigurationData({ deviceProfiles: profiles })).toThrow();
  });

  it('rejects extra array properties rather than converting them to entries', () => {
    const stages = Object.assign(['first'], { extra: 'second' });
    expect(() => ownConfigurationData(stages)).toThrow();
  });

  it('does not invoke getters while admitting data', () => {
    let reads = 0;
    const value = Object.defineProperty({}, 'settings', {
      enumerable: true,
      get() {
        reads++;
        return {};
      },
    });
    expect(() => ownConfigurationData(value)).toThrow();
    expect(reads).toBe(0);
  });
});
