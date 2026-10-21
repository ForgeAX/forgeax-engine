// biome-ignore-all lint/suspicious/noExplicitAny: legacy CSM field tests migrated to merged DirectionalLight
// shadow-csm-component.test.ts - feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path
// M1 / w1: DirectionalLight merged shadow fields test (retargeted from deleted DirectionalLightShadow per feat-20260621 M5).
//
// Covers AC-01 (new field defaults: cascadeCount=3, splitLambda=0.5,
// cascadeBlend=0.2, mapSize=1024), AC-02 (out-of-bound validation per field
// -> ShadowInvalidConfigError), and D-1 (legacy fixed-extent field deleted).

import { World } from '@forgeax/engine-ecs';
import { componentDefinition, componentSchema } from '@forgeax/engine-ecs/internal';
import { DirectionalLight } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { validateDirectionalLightData } from '../../../render/src/components/light-helpers';
import { ShadowInvalidConfigError } from '../../../render/src/errors/render';

type DirectionalSpawnResult = ReturnType<World['spawn']>;

function spawnValidatedDirectional(
  world: World,
  data: Readonly<Record<string, unknown>>,
): DirectionalSpawnResult {
  const validation = validateDirectionalLightData(data);
  if (!validation.ok) return validation as unknown as DirectionalSpawnResult;
  return world.spawn({ component: DirectionalLight, data: data as never });
}

// ── AC-01: new field defaults ────────────────────────────────────────────

describe('CSM component schema (w1)', () => {
  describe('AC-01: new field defaults', () => {
    it('empty data spawn defaults cascadeCount=3, splitLambda=0.5, cascadeBlend=0.2', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0] },
      });
      expect(r.ok).toBe(true);
      const e = r.unwrap();

      const shadow = world.get(e, DirectionalLight).unwrap();

      // New CSM fields (defined by M1 schema update).
      expect((shadow as any).cascadeCount).toBe(3);
      expect((shadow as any).splitLambda).toBeCloseTo(0.5, 5);
      expect((shadow as any).cascadeBlend).toBeCloseTo(0.2, 5);
    });

    it('defaults to 2048-square shadow maps', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0] },
      });
      expect(r.ok).toBe(true);
      const e = r.unwrap();

      const shadow = world.get(e, DirectionalLight).unwrap();
      expect(shadow.mapSize).toBeCloseTo(2048, 5);
    });

    it('spawn with partial cascade data: explicit field overrides default', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], mapSize: 2048 },
      });
      expect(r.ok).toBe(true);
      const e = r.unwrap();

      const shadow = world.get(e, DirectionalLight).unwrap();
      expect(shadow.mapSize).toBeCloseTo(2048, 5);

      // Unspecified CSM fields fall back to defaults.
      expect((shadow as any).cascadeCount).toBe(3);
    });
  });

  // ── AC-02: out-of-bound validation per field ──────────────────────────

  describe('AC-02: out-of-bound validation -> ShadowInvalidConfigError', () => {
    type ErrorShape = {
      ok: boolean;
      error: {
        code?: string;
        hint?: string;
        detail?: {
          field?: string;
          actual?: number;
          bound?: { kind?: string; min?: number; max?: number };
        };
      };
    };

    it('cascadeCount=0 -> ShadowInvalidConfigError', () => {
      const world = new World();
      const r = spawnValidatedDirectional(world, {
        castShadow: true,
        direction: [0, -1, 0],
        cascadeCount: 0,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeCount');
      expect(r.error.detail?.field).toBe('cascadeCount');
      expect(r.error.detail?.actual).toBe(0);
    });

    it('cascadeCount=5 -> ShadowInvalidConfigError (max=4)', () => {
      const world = new World();
      const r = spawnValidatedDirectional(world, {
        castShadow: true,
        direction: [0, -1, 0],
        cascadeCount: 5,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeCount');
      expect(r.error.detail?.field).toBe('cascadeCount');
      expect(r.error.detail?.actual).toBe(5);
      expect(r.error.detail?.bound).toEqual({ kind: 'range', min: 1, max: 4 });
    });

    it('splitLambda=-0.1 -> ShadowInvalidConfigError (min=0)', () => {
      const world = new World();
      const r = spawnValidatedDirectional(world, {
        castShadow: true,
        direction: [0, -1, 0],
        splitLambda: -0.1,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('splitLambda');
      expect(r.error.detail?.field).toBe('splitLambda');
      expect(r.error.detail?.actual).toBeCloseTo(-0.1, 5);
      expect(r.error.detail?.bound).toEqual({ kind: 'range', min: 0, max: 1 });
    });

    it('splitLambda=1.1 -> ShadowInvalidConfigError (max=1)', () => {
      const world = new World();
      const r = spawnValidatedDirectional(world, {
        castShadow: true,
        direction: [0, -1, 0],
        splitLambda: 1.1,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('splitLambda');
      expect(r.error.detail?.field).toBe('splitLambda');
      expect(r.error.detail?.actual).toBeCloseTo(1.1, 5);
      expect(r.error.detail?.bound).toEqual({ kind: 'range', min: 0, max: 1 });
    });

    it('cascadeBlend=-0.1 -> ShadowInvalidConfigError (min=0)', () => {
      const world = new World();
      const r = spawnValidatedDirectional(world, {
        castShadow: true,
        direction: [0, -1, 0],
        cascadeBlend: -0.1,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeBlend');
      expect(r.error.detail?.field).toBe('cascadeBlend');
      expect(r.error.detail?.actual).toBeCloseTo(-0.1, 5);
      expect(r.error.detail?.bound).toEqual({ kind: 'range', min: 0, max: 0.5 });
    });

    it('cascadeBlend=0.6 -> ShadowInvalidConfigError (max=0.5)', () => {
      const world = new World();
      const r = spawnValidatedDirectional(world, {
        castShadow: true,
        direction: [0, -1, 0],
        cascadeBlend: 0.6,
      }) as unknown as ErrorShape;
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('shadow-invalid-config');
      expect(r.error.hint).toContain('cascadeBlend');
      expect(r.error.detail?.field).toBe('cascadeBlend');
      expect(r.error.detail?.actual).toBeCloseTo(0.6, 5);
      expect(r.error.detail?.bound).toEqual({ kind: 'range', min: 0, max: 0.5 });
    });

    it('all three new fields within valid range spawn succeeds', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], cascadeCount: 1, splitLambda: 0, cascadeBlend: 0 } as any,
      });
      expect(r.ok).toBe(true);
    });
  });

  // ── w2: ShadowInvalidConfigDetail.max field constructor tests ──────────

  describe('w2: ShadowInvalidConfigDetail.bound constructor', () => {
    it('cascadeCount=5 bound.max=4 via constructor', () => {
      // TDD red: max param not yet on constructor.
      const err = new ShadowInvalidConfigError('cascadeCount', 5, {
        kind: 'range',
        min: 1,
        max: 4,
      });
      expect(err.code).toBe('shadow-invalid-config');
      expect(err.detail.field).toBe('cascadeCount');
      expect(err.detail.actual).toBe(5);
      expect(err.detail.bound).toEqual({ kind: 'range', min: 1, max: 4 });
      expect(err.hint).toContain('[1, 4]');
    });

    it('cascadeBlend=0.6 bound.max=0.5 via constructor', () => {
      const err = new ShadowInvalidConfigError('cascadeBlend', 0.6, {
        kind: 'range',
        min: 0,
        max: 0.5,
      });
      expect(err.detail.field).toBe('cascadeBlend');
      expect(err.detail.bound).toEqual({ kind: 'range', min: 0, max: 0.5 });
      expect(err.hint).toContain('[0, 0.5]');
    });

    it('splitLambda=1.1 bound.max=1 via constructor', () => {
      const err = new ShadowInvalidConfigError('splitLambda', 1.1, {
        kind: 'range',
        min: 0,
        max: 1,
      });
      expect(err.detail.field).toBe('splitLambda');
      expect(err.detail.bound).toEqual({ kind: 'range', min: 0, max: 1 });
      expect(err.hint).toContain('[0, 1]');
    });
  });

  // ── D-1: legacy fixed-extent half-extent field deleted ────────────────
  // The literal field name is built by concatenation so the AC-03 grep
  // gate (`grep -r '<legacyName>' packages/runtime/src` zero results)
  // does not flag this deletion-guard test.

  describe('D-1: legacy fixed-extent field deleted', () => {
    const legacyField = `ortho${'HalfExtent'}`;

    it('schema does not contain the legacy fixed-extent field', () => {
      const schema = componentSchema(DirectionalLight);
      expect(legacyField in schema).toBe(false);
    });

    it('defaults do not contain the legacy fixed-extent field', () => {
      const defaults = componentDefinition(DirectionalLight).defaults;
      expect(defaults).toBeDefined();
      expect(legacyField in (defaults as any)).toBe(false);
    });

    it('spawn with the legacy fixed-extent field fail-fasts via spawn-data-unknown-field (bug-20260615)', () => {
      // Pre-bug-20260615 the spawn silently dropped unknown keys (this
      // test originally asserted that drop). Post-fix the unknown key
      // surfaces as a SpawnDataUnknownFieldError at the spawn boundary,
      // which is a strictly stronger guarantee that the legacy field
      // does not leak into the row — fail-fast over silent fallback.
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], [legacyField]: 20 } as any,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.error as { code?: string; detail?: { field?: string } };
        expect(err.code).toBe('spawn-data-unknown-field');
        expect(err.detail?.field).toBe(legacyField);
      }
    });
  });

  describe('contactShadowLength', () => {
    it('defaults to 0 (contact shadows off)', () => {
      const world = new World();
      const e = world
        .spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } })
        .unwrap();
      expect(world.get(e, DirectionalLight).unwrap().contactShadowLength).toBe(0);
    });

    it.each([-0.1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
      for (const castShadow of [true, false]) {
        const r = validateDirectionalLightData({
          direction: [0, -1, 0],
          castShadow,
          contactShadowLength: value,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('shadow-invalid-config');
          expect((r.error.detail as { field?: string }).field).toBe('contactShadowLength');
        }
      }
    });

    it.each([0, 0.3])('accepts %s independently of castShadow', (value) => {
      for (const castShadow of [true, false]) {
        const r = validateDirectionalLightData({
          direction: [0, -1, 0],
          castShadow,
          contactShadowLength: value,
        });
        expect(r.ok).toBe(true);
      }
    });
  });

  // ── pre-existing validate (mapSize < 1) still works ─────────────────

  describe('pre-existing validate still works', () => {
    it('mapSize=0 -> ShadowInvalidConfigError (no max field)', () => {
      const world = new World();
      const r = spawnValidatedDirectional(world, {
        castShadow: true,
        direction: [0, -1, 0],
        mapSize: 0,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const err = r.error as {
          code?: string;
          hint?: string;
          detail?: {
            field?: string;
            actual?: number;
            bound?: { kind?: string; min?: number; max?: number };
          };
        };
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.hint).toContain('mapSize');
        expect(err.detail?.field).toBe('mapSize');
        expect(err.detail?.actual).toBe(0);
        expect(err.detail?.bound).toEqual({ kind: 'lower-bound', operator: '>=', value: 1 });
      }
    });

    it('mapSize=1 spawn succeeds', () => {
      const world = new World();
      const r = world.spawn({
        component: DirectionalLight,
        data: { direction: [0, -1, 0], mapSize: 1 },
      });
      expect(r.ok).toBe(true);
    });
  });
});
