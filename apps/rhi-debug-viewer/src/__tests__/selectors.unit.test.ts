// selectors.unit.test.ts — data-forgeax-* anchor contract tests.
//
// Each anchor helper returns the attribute NAME only (not key="value" full string).
// Components supply the value in the spread: { [drawAnchor()]: String(idx) }.
// This key/value separation is required for React to render data-* DOM attributes
// (React rejects '=' and '"' in attribute names).
//
// Related: plan-strategy D-5 (selectors SSOT); AC-13 (grep data-forgeax-* only in selectors.ts + this file);
// R2-NEW fix (anchor spread idiom rendering bug).

import { describe, expect, it } from 'vitest';
import {
  capabilityAnchor,
  drawAnchor,
  LOAD_STATUS,
  loadStatus,
  loadStatusAnchor,
  passAnchor,
  RT_STATUS,
  rtCanvasAnchor,
  rtStatus,
  rtStatusAnchor,
  selectedAnchor,
} from '../selectors';

describe('data-forgeax-* naming convention', () => {
  it('all anchor names are lowercase hyphenated data-forgeax-<noun>', () => {
    const anchorPattern = /^data-forgeax-[a-z][a-z-]*$/;

    expect(drawAnchor()).toMatch(anchorPattern);
    expect(passAnchor()).toMatch(anchorPattern);
    expect(selectedAnchor()).toMatch(anchorPattern);
    expect(loadStatusAnchor()).toMatch(anchorPattern);
    expect(rtStatusAnchor()).toMatch(anchorPattern);
    expect(rtCanvasAnchor()).toMatch(anchorPattern);
    expect(capabilityAnchor()).toMatch(anchorPattern);
  });

  it('no CamelCase in anchor names', () => {
    const camelCheck = /[A-Z]/;
    expect(camelCheck.test(drawAnchor())).toBe(false);
    expect(camelCheck.test(passAnchor())).toBe(false);
    expect(camelCheck.test(selectedAnchor())).toBe(false);
    expect(camelCheck.test(loadStatusAnchor())).toBe(false);
    expect(camelCheck.test(rtStatusAnchor())).toBe(false);
    expect(camelCheck.test(rtCanvasAnchor())).toBe(false);
  });
});

describe('LOAD_STATUS', () => {
  it('contains exactly parse-error / loaded / empty', () => {
    const expected = ['parse-error', 'loaded', 'empty'];
    expect(LOAD_STATUS).toEqual(expected);
  });

  it('loadStatus returns only LOAD_STATUS values', () => {
    for (const val of LOAD_STATUS) {
      expect(loadStatus(val)).toBe(val);
      expect(LOAD_STATUS).toContain(loadStatus(val));
    }
  });

  it('is readonly and ordered stable', () => {
    expect(LOAD_STATUS[0]).toBe('parse-error');
    expect(LOAD_STATUS[1]).toBe('loaded');
    expect(LOAD_STATUS[2]).toBe('empty');
    expect(Object.isFrozen(LOAD_STATUS)).toBe(true);
  });
});

describe('RT_STATUS', () => {
  it('contains exactly ok / no-rt / no-webgpu / error', () => {
    const expected = ['ok', 'no-rt', 'no-webgpu', 'error'];
    expect(RT_STATUS).toEqual(expected);
  });

  it('rtStatus returns only RT_STATUS values', () => {
    for (const val of RT_STATUS) {
      expect(rtStatus(val)).toBe(val);
      expect(RT_STATUS).toContain(rtStatus(val));
    }
  });

  it('is readonly and ordered stable', () => {
    expect(RT_STATUS[0]).toBe('ok');
    expect(RT_STATUS[1]).toBe('no-rt');
    expect(RT_STATUS[2]).toBe('no-webgpu');
    expect(RT_STATUS[3]).toBe('error');
    expect(Object.isFrozen(RT_STATUS)).toBe(true);
  });
});

describe('drawAnchor', () => {
  it('returns attribute name data-forgeax-draw', () => {
    expect(drawAnchor()).toBe('data-forgeax-draw');
  });

  it('is a pure constant, no arguments', () => {
    expect(drawAnchor()).toBe(drawAnchor());
  });
});

describe('passAnchor', () => {
  it('returns attribute name data-forgeax-pass', () => {
    expect(passAnchor()).toBe('data-forgeax-pass');
  });
});

describe('selectedAnchor', () => {
  it('returns attribute name data-forgeax-selected', () => {
    expect(selectedAnchor()).toBe('data-forgeax-selected');
  });
});

describe('loadStatusAnchor', () => {
  it('returns attribute name data-forgeax-load-status', () => {
    expect(loadStatusAnchor()).toBe('data-forgeax-load-status');
  });
});

describe('rtStatusAnchor', () => {
  it('returns attribute name data-forgeax-rt-status', () => {
    expect(rtStatusAnchor()).toBe('data-forgeax-rt-status');
  });
});

describe('rtCanvasAnchor', () => {
  it('returns attribute name data-forgeax-rt-canvas', () => {
    expect(rtCanvasAnchor()).toBe('data-forgeax-rt-canvas');
  });
});

describe('uniqueness — no collisions across anchors', () => {
  it('all six anchor names are distinct', () => {
    const names = new Set([
      drawAnchor(),
      passAnchor(),
      selectedAnchor(),
      loadStatusAnchor(),
      rtStatusAnchor(),
      rtCanvasAnchor(),
    ]);
    expect(names.size).toBe(6);
  });

  it('no anchor name collides with any other', () => {
    expect(drawAnchor()).not.toBe(passAnchor());
    expect(drawAnchor()).not.toBe(selectedAnchor());
    expect(drawAnchor()).not.toBe(loadStatusAnchor());
    expect(drawAnchor()).not.toBe(rtStatusAnchor());
    expect(drawAnchor()).not.toBe(rtCanvasAnchor());
  });
});
