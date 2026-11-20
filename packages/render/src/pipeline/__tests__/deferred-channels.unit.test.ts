import { expect, it } from 'vitest';
import { LIGHTING_CHANNELS_DEFAULT } from '../../components/lighting-channels';
import {
  prepareDeferredLightingChannels,
  projectDeferredLightingMask,
} from '../standard-lighting/deferred-channels';

const ALL = LIGHTING_CHANNELS_DEFAULT;
const HIGH = 0x80000000;

it('preserves the intersection for all receivers and lights in each admitted view', () => {
  let seed = 0x7adc142b;
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed >>> 16;
  };
  let mismatches = 0;
  for (let run = 0; run < 20000; run += 1) {
    const bits = [
      (1 << (random() & 31)) >>> 0,
      (1 << (random() & 31)) >>> 0,
      (1 << (random() & 31)) >>> 0,
    ];
    const masks = [0, ALL];
    for (let i = 1; i <= 6; i += 1) {
      const choice = random() & 7;
      masks.push(bits.reduce((mask, bit, j) => (choice & (1 << j) ? mask | bit : mask), 0) >>> 0);
    }
    const receivers = masks.map((lightingChannels) => ({ lightingChannels }));
    const local = masks.map((lightingChannels) => ({ source: { lightingChannels } }));
    const sun = { lightingChannels: masks[run % masks.length] as number };
    const projection = prepareDeferredLightingChannels(receivers, local, sun);
    if (projection === 0) throw new Error('A three-bit view could not be projected');
    if (projection !== prepareDeferredLightingChannels(receivers.slice().reverse(), local, sun))
      throw new Error('View projection depends on receiver order');
    if (((projection >>> 17) & 7) !== projectDeferredLightingMask(sun.lightingChannels, projection))
      throw new Error('The sun and local slots use different maps');
    const mapped = masks.map((mask) => projectDeferredLightingMask(mask, projection));
    for (const [a, left] of masks.entries())
      for (const [b, right] of masks.entries())
        if (((left & right) !== 0) !== (((mapped[a] ?? 0) & (mapped[b] ?? 0)) !== 0))
          mismatches += 1;
  }
  expect(mismatches).toBe(0);
});

it('uses a common bit for only all/default or zero, and withholds an incomplete proof', () => {
  const view = prepareDeferredLightingChannels([{ lightingChannels: 0 }, {}], [], undefined);
  expect(projectDeferredLightingMask(ALL, view)).toBe(1);
  expect(projectDeferredLightingMask(0, view)).toBe(0);
  const receivers = [{ lightingChannels: HIGH }, { lightingChannels: 1 << 12 }];
  const local = [{ source: { lightingChannels: 4 } }];
  const sun = { lightingChannels: 8 };
  expect(prepareDeferredLightingChannels(receivers, local, sun)).toBe(0);
  expect(prepareDeferredLightingChannels(receivers, [{}], undefined)).toBe(0);
  // A retained but hidden object does not constrain this frame's raster domain.
  const projected = prepareDeferredLightingChannels(
    [{ lightingChannels: HIGH }, { lightingChannels: 1 << 12, authorVisible: false }],
    local,
    sun,
  );
  expect(projectDeferredLightingMask(HIGH, projected)).toBe(4);
  expect((projected >>> 17) & 7).toBe(2);
});
