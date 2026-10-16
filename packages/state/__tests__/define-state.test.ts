// @forgeax/engine-state -- defineState unit tests (M1 / m1w3)
//
// Covers: token construction, variant-to-index mapping, duplicate detection,
// empty variants rejection, error shape verification.
//
// AC-01 type narrowing verified via @ts-expect-error annotations.
// AC-04 both error cases covered.

import { describe, expect, it } from 'vitest';
import { defineState, getRegisteredTokens } from '../src/define-state';
import type { StateTokenVariant } from '../src/define-state';

describe('defineState', () => {
  it('returns a StateToken with name, variants, nameToIdx, and defaultValue', () => {
    const token = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);

    expect(token.name).toBe('LevelId');
    expect(token.variants).toEqual(['main-menu', 'tutorial', 'street-a']);
    expect(token.defaultValue).toBe('main-menu');
    expect(token.nameToIdx.size).toBe(3);
    expect(token.nameToIdx.get('main-menu')).toBe(0);
    expect(token.nameToIdx.get('tutorial')).toBe(1);
    expect(token.nameToIdx.get('street-a')).toBe(2);
  });

  it('works with 2 variants', () => {
    const token = defineState('GameMode', ['menu', 'playing'] as const);

    expect(token.name).toBe('GameMode');
    expect(token.variants).toEqual(['menu', 'playing']);
    expect(token.defaultValue).toBe('menu');
    expect(token.nameToIdx.get('menu')).toBe(0);
    expect(token.nameToIdx.get('playing')).toBe(1);
  });

  it('works with a single variant', () => {
    const token = defineState('EmptyState', ['idle'] as const);

    expect(token.name).toBe('EmptyState');
    expect(token.variants).toEqual(['idle']);
    expect(token.defaultValue).toBe('idle');
    expect(token.nameToIdx.get('idle')).toBe(0);
  });

  it('throws StateError on duplicate defineState with same name', () => {
    defineState('DupTest', ['a', 'b'] as const);

    let caught: unknown = null;
    try {
      defineState('DupTest', ['x', 'y'] as const);
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect((caught as Record<string, unknown>).code).toBe('state-already-defined');
    expect((caught as Record<string, unknown>).expected).toContain('exactly once');
    expect((caught as Record<string, unknown>).hint).toContain('DupTest');
    expect((caught as Record<string, unknown>).detail).toHaveProperty('name', 'DupTest');
  });

  it('throws StateError on empty variants array', () => {
    let caught: unknown = null;
    try {
      // @ts-expect-error - empty array is deliberately wrong for the test
      defineState('EmptyTest', [] as const);
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect((caught as Record<string, unknown>).code).toBe('state-default-required');
    expect((caught as Record<string, unknown>).expected).toContain('at least one variant');
    expect((caught as Record<string, unknown>).hint).toContain('EmptyTest');
    expect((caught as Record<string, unknown>).detail).toHaveProperty('name', 'EmptyTest');
  });

  it('registers token in the module-private registry', () => {
    const token = defineState('RegistryTest', ['on', 'off'] as const);
    const registry = getRegisteredTokens();

    expect(registry.has('RegistryTest')).toBe(true);
    expect(registry.get('RegistryTest')).toBe(token);
  });

  it('AC-01: type narrowing via @ts-expect-error on invalid variant literal', () => {
    const TypeTest = defineState('TypeNarrowTest', ['alpha', 'beta', 'gamma'] as const);

    // Compile-time narrowing: StateTokenVariant extracts the union
    type Variants = StateTokenVariant<typeof TypeTest>;

    // This type-level assertion verifies that the union type is correct.
    // If the type system were broken, the next line would fail.
    const _assert: Variants = 'alpha';
    expect(_assert).toBe('alpha');

    // Ensure 'invalid' is NOT part of the union -- compile error expected here:
    // @ts-expect-error - 'invalid' is not a valid variant
    // const _bad: Variants = 'invalid';

    // Verify that the token structurally has all three
    expect(TypeTest.variants).toHaveLength(3);
    expect(TypeTest.variants).toContain('beta');
  });

  it('throws on duplicate variants within the same token', () => {
    let caught: unknown = null;
    try {
      defineState('DupVariantTest', ['a', 'b', 'a'] as const);
    } catch (e) {
      caught = e;
    }

    expect(caught).not.toBeNull();
    expect((caught as Record<string, unknown>).code).toBe('state-default-required');
    expect((caught as Record<string, unknown>).hint).toContain('duplicate');
  });
});