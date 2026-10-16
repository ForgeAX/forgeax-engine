// apps/learn-render/5.advanced-lighting/3.3.csm/src/__tests__/keyswitch.test.ts
//
// Unit tests for csmOverlayModeForKey — a pure string→CsmOverlayMode|null
// mapping with no GPU/ECS dependency. W15 RED per TDD: the keyswitch path
// survives the w17 refactor from regex-swap to uniform params.
//
// The WGSL import in cascade-overlay.ts is mocked so vitest (which has no
// forgeaxShader plugin in unit mode) can load the module.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../cascade-overlay.wgsl', () => ({ default: { wgsl: '' } }));

import { csmOverlayModeForKey } from '../cascade-overlay';

describe('csmOverlayModeForKey', () => {
  it('maps key 0 to off', () => {
    expect(csmOverlayModeForKey('0')).toBe('off');
  });

  it('maps key 1 to c1', () => {
    expect(csmOverlayModeForKey('1')).toBe('c1');
  });

  it('maps key 2 to c2', () => {
    expect(csmOverlayModeForKey('2')).toBe('c2');
  });

  it('maps key 3 to c3', () => {
    expect(csmOverlayModeForKey('3')).toBe('c3');
  });

  it('maps key 4 to c4', () => {
    expect(csmOverlayModeForKey('4')).toBe('c4');
  });

  it('returns null for non-numeric key', () => {
    expect(csmOverlayModeForKey('a')).toBeNull();
  });

  it('returns null for key 5', () => {
    expect(csmOverlayModeForKey('5')).toBeNull();
  });

  it('returns null for the keyword "all"', () => {
    expect(csmOverlayModeForKey('all')).toBeNull();
  });
});
