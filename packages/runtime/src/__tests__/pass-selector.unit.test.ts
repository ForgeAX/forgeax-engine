import type { MaterialPass, PassSelector } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { matchPass, selectPasses } from '../../../render/src/systems/pass-selector';

/*
 * feat-20260609 M1 / T-003: typed scene/shadow selector required.
 *
 * These tests verify the PassSelector matching semantics:
 *   - selector: {} matches every pass (AC-02)
 *   - selector with a key filters passes that have that tag key + value in the
 *     allowed list
 *   - selector with multiple keys requires all keys to match (AND logic)
 */

function makePass(name: string, tags?: Record<string, string>): MaterialPass {
  if (tags !== undefined) {
    return { name, program: { module: 'forgeax_material::unlit' }, renderState: { tags } };
  }
  return { name, program: { module: 'forgeax_material::unlit' } };
}

describe('pass-selector semantics', () => {
  describe('selector: {} = match all', () => {
    it('returns the input array reference (no filtering) for empty selector', () => {
      const passes = [
        makePass('Forward', { LightMode: 'Forward' }),
        makePass('ShadowCaster', { LightMode: 'ShadowCaster' }),
        makePass('Untagged'),
      ];
      const result = selectPasses(passes, {});
      // AC-02: empty selector returns the input reference unchanged (no array copy)
      expect(result).toBe(passes);
      expect(result.length).toBe(3);
    });

    it('returns empty array reference when input is empty and selector is empty', () => {
      const passes: MaterialPass[] = [];
      const result = selectPasses(passes, {});
      expect(result).toBe(passes);
      expect(result.length).toBe(0);
    });
  });

  describe('selector filtering', () => {
    it('filters passes by single tag key', () => {
      const passes = [
        makePass('Forward', { LightMode: 'Forward' }),
        makePass('ShadowCaster', { LightMode: 'ShadowCaster' }),
        makePass('Untagged'),
      ];
      const selector: PassSelector = { LightMode: ['Forward'] };
      const result = selectPasses(passes, selector);
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('Forward');
    });

    it('filters passes by multiple allowed values for one key', () => {
      const passes = [
        makePass('Forward', { LightMode: 'Forward' }),
        makePass('ShadowCaster', { LightMode: 'ShadowCaster' }),
        makePass('Untagged'),
      ];
      const selector: PassSelector = { LightMode: ['Forward', 'ShadowCaster'] };
      const result = selectPasses(passes, selector);
      expect(result.length).toBe(2);
      expect(result.map((p) => p.name).sort()).toEqual(['Forward', 'ShadowCaster']);
    });

    it('returns empty array when no pass matches', () => {
      const passes = [makePass('Forward', { LightMode: 'Forward' })];
      const selector: PassSelector = { LightMode: ['ShadowCaster'] };
      const result = selectPasses(passes, selector);
      expect(result.length).toBe(0);
    });

    it('requires all selector keys to match (AND logic)', () => {
      const passes = [
        makePass('A', { Kind: 'Opaque', RenderType: 'Main' }),
        makePass('B', { Kind: 'Transparent', RenderType: 'Main' }),
        makePass('C', { Kind: 'Opaque', RenderType: 'Shadow' }),
      ];
      const selector: PassSelector = { Kind: ['Opaque'], RenderType: ['Main'] };
      const result = selectPasses(passes, selector);
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe('A');
    });
  });

  describe('matchPass edge cases', () => {
    it('tags with no matching key -> false', () => {
      expect(matchPass({ LightMode: 'Forward' }, { LightMode: ['ShadowCaster'] })).toBe(false);
    });

    it('missing key in tags -> false', () => {
      expect(matchPass({}, { LightMode: ['Forward'] })).toBe(false);
    });

    it('empty allowed values array -> false', () => {
      expect(matchPass({ LightMode: 'Forward' }, { LightMode: [] })).toBe(false);
    });
  });
});
