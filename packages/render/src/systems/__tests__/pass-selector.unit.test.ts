import type { PassSelector } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  COLOR_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  FORWARD_PASS_SELECTOR,
  matchPass,
  SHADOW_CASTER_PASS_SELECTOR,
} from '../pass-selector';

const stock = [
  FORWARD_PASS_SELECTOR,
  DEFERRED_PASS_SELECTOR,
  COLOR_PASS_SELECTOR,
  SHADOW_CASTER_PASS_SELECTOR,
];

describe('stock pass selectors', () => {
  it('owns deeply frozen requests with no mutable value-array aliases', () => {
    for (const selector of stock) {
      expect(Object.isFrozen(selector)).toBe(true);
      expect(Object.isFrozen(selector.LightMode)).toBe(true);
      expect(Reflect.set(selector, 'LightMode', ['Other'])).toBe(false);
      expect(Reflect.set(selector.LightMode, '0', 'Other')).toBe(false);
    }
  });

  it('matches all stock lanes without enumerating selectors and reads each tag once', () => {
    let entryCalls = 0;
    const original = Object.entries;
    const spy = vi.spyOn(Object, 'entries').mockImplementation((value) => {
      entryCalls++;
      return original(value);
    });
    try {
      for (const selector of stock) {
        for (const value of ['Forward', 'Deferred', 'ShadowCaster', 'Other', undefined]) {
          let reads = 0;
          const tags = {
            get LightMode() {
              reads++;
              return value;
            },
          } as Record<string, string>;
          expect(matchPass(tags, selector)).toBe(
            value !== undefined && (selector.LightMode as readonly string[]).includes(value),
          );
          expect(reads).toBe(1);
        }
      }
      expect(entryCalls).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not reread a changing tag for the second allowed color lane', () => {
    for (const selector of [COLOR_PASS_SELECTOR, { LightMode: ['Deferred', 'Forward'] }]) {
      let reads = 0;
      const tags = {
        get LightMode() {
          return ++reads === 1 ? 'Other' : 'Forward';
        },
      };
      expect(matchPass(tags, selector)).toBe(false);
      expect(reads).toBe(1);
    }
  });
});

describe('raw pass selector observation', () => {
  it('eagerly observes a later throwing getter even when the first tag cannot match', () => {
    const reads: string[] = [];
    const marker = {};
    const selector = Object.freeze({
      get LightMode() {
        reads.push('LightMode');
        return ['Forward'];
      },
      get RenderType(): readonly string[] {
        reads.push('RenderType');
        throw marker;
      },
    });
    const tags = {
      get LightMode() {
        reads.push('tag');
        return 'Deferred';
      },
    };
    let caught: unknown;
    try {
      matchPass(tags, selector);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(marker);
    expect(reads).toEqual(['LightMode', 'RenderType']);
  });

  it('keeps own enumerable ordering, prototype tag reads and repeated accessor observations', () => {
    const reads: string[] = [];
    const selector = Object.create({
      get Inherited() {
        throw new Error('inherited selector must not be read');
      },
    }) as PassSelector;
    Object.defineProperties(selector, {
      LightMode: {
        enumerable: true,
        get: () => {
          reads.push('LightMode');
          return ['Forward'];
        },
      },
      2: {
        enumerable: true,
        get: () => {
          reads.push('2');
          return ['yes'];
        },
      },
      hidden: {
        get: () => {
          throw new Error('non-enumerable selector must not be read');
        },
      },
    });
    const tags = Object.create({
      get 2() {
        reads.push('tag.2');
        return 'yes';
      },
      get LightMode() {
        reads.push('tag.LightMode');
        return 'Forward';
      },
    }) as Record<string, string>;
    expect(matchPass(tags, selector)).toBe(true);
    expect(matchPass(tags, selector)).toBe(true);
    expect(reads).toEqual([
      '2',
      'LightMode',
      'tag.2',
      'tag.LightMode',
      '2',
      'LightMode',
      'tag.2',
      'tag.LightMode',
    ]);
  });

  it('does not recognize raw copies or proxies as owned selectors', () => {
    let calls = 0;
    const original = Object.entries;
    const spy = vi.spyOn(Object, 'entries').mockImplementation((value) => {
      calls++;
      return original(value);
    });
    try {
      for (const selector of [{ ...FORWARD_PASS_SELECTOR }, new Proxy(FORWARD_PASS_SELECTOR, {})]) {
        expect(matchPass({ LightMode: 'Forward' }, selector)).toBe(true);
      }
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
