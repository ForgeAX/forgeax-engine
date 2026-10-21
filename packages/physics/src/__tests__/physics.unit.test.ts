// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=2):
//   - packages/physics/__tests__/component-schema.test.ts
//   - packages/physics/__tests__/enum-helpers.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from __tests__/ into src/__tests__/; import paths adjusted (../src/index → ../index).

import { World } from '@forgeax/engine-ecs';
import { componentDefinition, componentSchema } from '@forgeax/engine-ecs/internal';
import { describe, expect, it } from 'vitest';
import type { PhysicsErrorCode } from '../index';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  CollisionEvent,
  colliderShapeFromF32,
  PHYSICS_ERROR_HINTS,
  PhysicsError,
  RigidBody,
  RigidBodyTypeValue,
  rigidBodyTypeFromF32,
} from '../index';

{
  // ─── from component-schema.test.ts ───

  describe('component-schema.test.ts', () => {
    describe('feat-20260528 M1 t7 physics component schema definitions', () => {
      it('RigidBody is a valid Component token with expected fields', () => {
        expect(RigidBody).toBeDefined();
        expect(RigidBody.name).toBe('RigidBody');
        const schema = componentSchema(RigidBody);
        expect(schema).toHaveProperty('type');
        expect(schema).toHaveProperty('mass');
        expect(schema).toHaveProperty('linearDamping');
        expect(schema).toHaveProperty('angularDamping');
        expect(schema).toHaveProperty('gravityScale');
        expect(schema).toHaveProperty('ccdEnabled');
      });

      it('Collider is a valid Component token with expected fields', () => {
        expect(Collider).toBeDefined();
        expect(Collider.name).toBe('Collider');
        const schema = componentSchema(Collider);
        expect(schema).toHaveProperty('shape');
        // feat-20260709 M4: cuboid half-extents collapsed from 3 per-axis
        // scalar columns into one inline array<f32,3> column (halfExtents).
        // radius / halfHeight stay scalar (OOS-1: independent sphere/capsule
        // params, not part of the cuboid vec).
        expect(schema).toHaveProperty('halfExtents');
        expect(schema.halfExtents).toBe('array<f32, 3>');
        expect('halfExtentsX' in schema).toBe(false);
        expect('halfExtentsY' in schema).toBe(false);
        expect('halfExtentsZ' in schema).toBe(false);
        expect(schema).toHaveProperty('radius');
        expect(schema).toHaveProperty('halfHeight');
        expect(schema).toHaveProperty('friction');
        expect(schema).toHaveProperty('restitution');
        expect(schema).toHaveProperty('density');
        expect(schema).toHaveProperty('isSensor');
        expect(schema).toHaveProperty('collisionGroups');
        expect(schema).toHaveProperty('solverGroups');
      });

      it('CollidingEntities is a valid Component token with entities field', () => {
        expect(CollidingEntities).toBeDefined();
        expect(CollidingEntities.name).toBe('CollidingEntities');
        const schema = componentSchema(CollidingEntities);
        expect(schema).toHaveProperty('entities');
      });

      it('CollisionEvent is the expected constant value', () => {
        expect(CollisionEvent).toBe('__CollisionEvent__');
      });

      it('PhysicsError is importable and constructable', () => {
        const err = new PhysicsError({
          code: 'backend-not-registered',
          expected: 'PhysicsWorld resource to be registered',
          hint: 'use createApp(canvas, { plugins: [physicsPlugin(...)] })',
          detail: {
            code: 'backend-not-registered',
            attemptedBackend: 'rapier-3d',
          },
        });
        expect(err.code).toBe('backend-not-registered');
        expect(err.name).toBe('PhysicsError');
        expect(err.hint).toContain('createApp');
      });

      it('PhysicsErrorCode literal union has all 8 members', () => {
        const codes: Set<string> = new Set();
        const all: PhysicsErrorCode[] = [
          'wasm-load-failed',
          'wasm-simd-unsupported',
          'step-failed',
          'invalid-body-config',
          'body-not-found',
          'collider-not-found',
          'backend-not-registered',
          'controller-requires-kinematic',
        ];
        for (const c of all) {
          codes.add(c);
        }
        expect(codes.size).toBe(8);
      });

      it('PHYSICS_ERROR_HINTS has all 8 code entries', () => {
        const allCodes: PhysicsErrorCode[] = [
          'wasm-load-failed',
          'wasm-simd-unsupported',
          'step-failed',
          'invalid-body-config',
          'body-not-found',
          'collider-not-found',
          'backend-not-registered',
          'controller-requires-kinematic',
        ];
        for (const code of allCodes) {
          expect(PHYSICS_ERROR_HINTS[code]).toBeDefined();
          expect(PHYSICS_ERROR_HINTS[code].length).toBeGreaterThan(0);
        }
      });

      it('RigidBodyType literal union has 3 discriminants', () => {
        const types = ['static', 'dynamic', 'kinematic'] as const;
        expect(new Set(types).size).toBe(3);
      });

      it('ColliderShape reflected values have unique discriminants', () => {
        const shapes = Object.values(ColliderShapeValue);
        expect(new Set(shapes).size).toBe(shapes.length);
      });

      // solo round-24 (P7 residue): the enum fields project their label→value
      // map through FieldReflection, sourced from the SAME `*Value` const map
      // (Derive, don't Duplicate). This is what the editor's describeComponent
      // surfaces so a docs-only AI learns static=0/dynamic=1/kinematic=2 without
      // reading engine source. Revert-to-red: drop `labels:` from the descriptor.
      it('RigidBody.type reflects labels === RigidBodyTypeValue', () => {
        const reflection = RigidBody.fields.type as { readonly labels?: Record<string, number> };
        expect(reflection.labels).toEqual({ ...RigidBodyTypeValue });
        expect(reflection.labels).toEqual({ static: 0, dynamic: 1, kinematic: 2 });
      });

      it('Collider.shape reflects labels === ColliderShapeValue', () => {
        const reflection = Collider.fields.shape as { readonly labels?: Record<string, number> };
        expect(reflection.labels).toEqual({ ...ColliderShapeValue });
        expect(reflection.labels).toEqual({
          cuboid: 0,
          sphere: 1,
          capsule: 2,
          cylinder: 3,
          cone: 4,
          convexHull: 5,
          trimesh: 6,
        });
      });

      it('a non-enum field (RigidBody.mass) reflects no labels (control)', () => {
        const reflection = RigidBody.fields.mass as { readonly labels?: Record<string, number> };
        expect(reflection.labels).toBeUndefined();
      });
    });
  });
}

{
  // ─── from enum-helpers.test.ts ───

  describe('enum-helpers.test.ts', () => {
    describe('rigidBodyTypeFromF32', () => {
      it('0 maps to static', () => {
        expect(rigidBodyTypeFromF32(0)).toBe('static');
      });

      it('1 maps to dynamic', () => {
        expect(rigidBodyTypeFromF32(1)).toBe('dynamic');
      });

      it('2 maps to kinematic', () => {
        expect(rigidBodyTypeFromF32(2)).toBe('kinematic');
      });

      it('out-of-range values fall back to static', () => {
        expect(rigidBodyTypeFromF32(-1)).toBe('static');
        expect(rigidBodyTypeFromF32(3)).toBe('static');
        expect(rigidBodyTypeFromF32(99)).toBe('static');
      });

      it('fractional values fall back to static', () => {
        expect(rigidBodyTypeFromF32(0.5)).toBe('static');
        expect(rigidBodyTypeFromF32(1.5)).toBe('static');
        expect(rigidBodyTypeFromF32(2.9)).toBe('static');
      });
    });

    describe('colliderShapeFromF32', () => {
      it('0 maps to cuboid', () => {
        expect(colliderShapeFromF32(0)).toBe('cuboid');
      });

      it('1 maps to sphere', () => {
        expect(colliderShapeFromF32(1)).toBe('sphere');
      });

      it('2 maps to capsule', () => {
        expect(colliderShapeFromF32(2)).toBe('capsule');
      });

      it('out-of-range values fall back to cuboid', () => {
        expect(colliderShapeFromF32(-1)).toBe('cuboid');
        expect(colliderShapeFromF32(7)).toBe('cuboid');
        expect(colliderShapeFromF32(99)).toBe('cuboid');
      });

      it('fractional values fall back to cuboid', () => {
        expect(colliderShapeFromF32(0.5)).toBe('cuboid');
        expect(colliderShapeFromF32(1.5)).toBe('cuboid');
        expect(colliderShapeFromF32(2.9)).toBe('cuboid');
      });
    });

    describe('numeric enum constants', () => {
      it('RigidBodyTypeValue has expected numeric values', () => {
        expect(RigidBodyTypeValue.static).toBe(0);
        expect(RigidBodyTypeValue.dynamic).toBe(1);
        expect(RigidBodyTypeValue.kinematic).toBe(2);
      });

      it('ColliderShapeValue has expected numeric values', () => {
        expect(ColliderShapeValue.cuboid).toBe(0);
        expect(ColliderShapeValue.sphere).toBe(1);
        expect(ColliderShapeValue.capsule).toBe(2);
      });
    });

    describe('layer-2 defaults (m3-1e regression)', () => {
      it('RigidBody defaults include gravityScale=1', () => {
        expect(componentSchema(RigidBody)).toHaveProperty('gravityScale');
        const defaults = componentDefinition(RigidBody).defaults;
        expect(defaults).toBeDefined();
        if (defaults) {
          expect(defaults.gravityScale).toBe(1);
        }
      });

      it('RigidBody defaults include mass=1', () => {
        const defaults = componentDefinition(RigidBody).defaults;
        expect(defaults).toBeDefined();
        if (defaults) {
          expect(defaults.mass).toBe(1);
        }
      });

      it('RigidBody defaults include type=dynamic (1)', () => {
        const defaults = componentDefinition(RigidBody).defaults;
        expect(defaults).toBeDefined();
        if (defaults) {
          expect(defaults.type).toBe(1);
        }
      });

      it('Collider defaults include density=1', () => {
        expect(componentSchema(Collider)).toHaveProperty('density');
        const defaults = componentDefinition(Collider).defaults;
        expect(defaults).toBeDefined();
        if (defaults) {
          expect(defaults.density).toBe(1);
        }
      });

      it('Collider defaults include friction=0.5', () => {
        const defaults = componentDefinition(Collider).defaults;
        expect(defaults).toBeDefined();
        if (defaults) {
          expect(defaults.friction).toBe(0.5);
        }
      });

      it('Collider defaults include restitution=0', () => {
        const defaults = componentDefinition(Collider).defaults;
        expect(defaults).toBeDefined();
        if (defaults) {
          expect(defaults.restitution).toBe(0);
        }
      });
    });
  });
}

{
  // ─── feat-20260709 M4 / w17: Collider halfExtents vec-collapse ───
  //
  // AC-01 / E1 / AC-04: halfExtents is array<f32,3> with explicit layer-2
  // default [0.5,0.5,0.5] (the array layer-3 fallback is all-zero, so the
  // non-zero default MUST be declared explicitly). Spawn-omit resolves to the
  // same value the old per-axis scalar defaults produced. radius/halfHeight
  // stay scalar (OOS-1). TDD red until w19 lands the schema collapse.

  describe('collider-halfextents-vec.test.ts', () => {
    it('Collider.halfExtents is array<f32,3> with explicit layer-2 default [0.5,0.5,0.5]', () => {
      expect(componentSchema(Collider).halfExtents).toBe('array<f32, 3>');
      expect(Array.from(Collider.fields.halfExtents.default as Float32Array)).toEqual([
        0.5, 0.5, 0.5,
      ]);
    });

    it('Collider per-axis scalar keys are gone; radius/halfHeight stay scalar (OOS-1)', () => {
      expect('halfExtentsX' in componentSchema(Collider)).toBe(false);
      expect('halfExtentsY' in componentSchema(Collider)).toBe(false);
      expect('halfExtentsZ' in componentSchema(Collider)).toBe(false);
      expect(componentSchema(Collider).radius).toBe('f32');
      expect(componentSchema(Collider).halfHeight).toBe('f32');
    });

    it('E1: Collider spawned with halfExtents omitted resolves to [0.5,0.5,0.5]', () => {
      const world = new World();
      const e = world
        .spawn({ component: Collider, data: { shape: ColliderShapeValue.cuboid } })
        .unwrap();
      const row = world.get(e, Collider).unwrap();
      expect(Array.from(row.halfExtents)).toEqual([0.5, 0.5, 0.5]);
    });

    it('E1: Collider spawned with explicit halfExtents carries the array through', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Collider,
          data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 2, 3] },
        })
        .unwrap();
      const row = world.get(e, Collider).unwrap();
      expect(Array.from(row.halfExtents)).toEqual([1, 2, 3]);
    });

    it('AC-04: residual halfExtentsX at a spawn call-site is a compile error', () => {
      const world = new World();
      world.spawn({
        component: Collider,
        // @ts-expect-error halfExtentsX/Y/Z were collapsed into the halfExtents array.
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [1, 1, 1], halfExtentsX: 1 },
      });
    });
  });
}
