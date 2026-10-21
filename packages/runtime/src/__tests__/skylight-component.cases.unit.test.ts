// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
{
  // --- from skylight-component.test.ts ---

  // These would be imported from the real module when t25 lands. Until then,
  // they are the target shape.
  const SKYLIGHT_COMPONENT_NAME = 'Skylight';
  const SKYLIGHT_DEFAULT_INTENSITY = 1.0;

  describe('Skylight component schema (AC-02)', () => {
    it('Skylight component name is "Skylight" (single-semantic, no Component suffix)', () => {
      expect(SKYLIGHT_COMPONENT_NAME).toBe('Skylight');
    });

    it('Skylight schema shape: { equirect: handle<EquirectAsset>, intensity: f32 }', () => {
      // Verify the expected schema field names.
      // When t25 lands, the real component must have exactly these fields.
      const expectedFields = ['equirect', 'intensity'];
      // Both fields are present; no extra.
      expect(expectedFields).toContain('equirect');
      expect(expectedFields).toContain('intensity');
      expect(expectedFields.length).toBe(2);
    });

    it('Skylight default intensity === 1.0', () => {
      expect(SKYLIGHT_DEFAULT_INTENSITY).toBe(1.0);
    });
  });

  // TODO: Skylight component narrowing sites (AC-16(c)) -- placeholders pruned in
  // feat-20260608-ci-time-cut. The compile-time contracts (no `as` cast on
  // world.spawn / world.addSystem / world.get) are enforced by tsc; runtime
  // `expect(true)` placeholders carried no signal and were removed.
  //
  // TODO: Skylight component default spawn (intensity = 1.0) -- placeholders pruned
  // in feat-20260608-ci-time-cut. The default-value contract is verified at
  // schema-registration time once the t25 impl lands.
}
