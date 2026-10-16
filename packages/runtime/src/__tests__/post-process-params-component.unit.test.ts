// post-process-params-component.unit.test.ts — red-phase unit test for the
// upcoming PostProcessParams component (M-A1 / w1).
//
// AC-A4 three-consumer point 1: the component's `data` field type is
// `AllowSharedBufferSource` (via the ECS 'buffer' vocab keyword, whose
// FieldValueType is Uint8Array — a member of AllowSharedBufferSource).
// AC-A2: no imperative renderer.setParams mutator — this test only checks
// component field shape and type assignability.

import { World } from '@forgeax/engine-ecs';
import { componentId, componentSchema } from '@forgeax/engine-ecs/internal';
import { PostProcessParams } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

describe('PostProcessParams component definition', () => {
  it('should be registered as a named component', () => {
    expect(PostProcessParams).toBeDefined();
    expect(PostProcessParams.name).toBe('PostProcessParams');
    expect(typeof componentId(PostProcessParams)).toBe('number');
  });

  it('should have shader field of type string', () => {
    expect(componentSchema(PostProcessParams).shader).toBe('string');
  });

  it('should have data field of type buffer (variable-byte ECS managed slot)', () => {
    expect(componentSchema(PostProcessParams).data).toBe('buffer');
  });

  it('should accept Uint8Array for the data field (FieldInputType match)', () => {
    const world = new World();
    const bytes = new Uint8Array(16);
    const entity = world.spawn({
      component: PostProcessParams,
      data: {
        shader: 'mypkg::test',
        data: bytes,
      },
    });
    expect(entity.ok).toBe(true);
    if (entity.ok) {
      const read = world.get(entity.value, PostProcessParams);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.value.shader).toBe('mypkg::test');
        expect(read.value.data).toBeInstanceOf(Uint8Array);
        expect(read.value.data.length).toBe(16);
      }
    }
  });

  it('should enforce shader as string (compile-time guard)', () => {
    expect(componentSchema(PostProcessParams).shader).toBe('string');
    expect(componentSchema(PostProcessParams).data).toBe('buffer');
  });

  it('should be spawnable with an empty buffer', () => {
    const world = new World();
    const bytes = new Uint8Array(0);
    const entity = world.spawn({
      component: PostProcessParams,
      data: {
        shader: 'empty',
        data: bytes,
      },
    });
    expect(entity.ok).toBe(true);
    if (entity.ok) {
      const read = world.get(entity.value, PostProcessParams);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.value.data.length).toBe(0);
      }
    }
  });
});

describe('PostProcessParams multi-entity parallelism', () => {
  it('should allow multiple entities with different shader ids', () => {
    const world = new World();
    const e1 = world.spawn({
      component: PostProcessParams,
      data: {
        shader: 'forgeax::tonemap',
        data: new Uint8Array(16),
      },
    });
    const e2 = world.spawn({
      component: PostProcessParams,
      data: {
        shader: 'mypkg::vignette',
        data: new Uint8Array(8),
      },
    });
    expect(e1.ok).toBe(true);
    expect(e2.ok).toBe(true);
    if (e1.ok && e2.ok) {
      const r1 = world.get(e1.value, PostProcessParams);
      const r2 = world.get(e2.value, PostProcessParams);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.shader).toBe('forgeax::tonemap');
        expect(r2.value.shader).toBe('mypkg::vignette');
        expect(r1.value.data.length).toBe(16);
        expect(r2.value.data.length).toBe(8);
      }
    }
  });

  it('should allow same shader id on multiple entities (last-one-wins extract semantics)', () => {
    const world = new World();
    world.spawn({
      component: PostProcessParams,
      data: {
        shader: 'forgeax::tonemap',
        data: new Uint8Array(16),
      },
    });
    world.spawn({
      component: PostProcessParams,
      data: {
        shader: 'forgeax::tonemap',
        data: new Uint8Array(32),
      },
    });
    let count = 0;
    const query = world.query({ with: [PostProcessParams] }).unwrap();
    for (const _row of query) count += 1;
    expect(count).toBe(2);
  });
});

describe('PostProcessParams type-level AllowSharedBufferSource compatibility', () => {
  it('should have data typed as Uint8Array which satisfies AllowSharedBufferSource', () => {
    // AC-A4 three-consumer point 1: the component field type is an
    // AllowSharedBufferSource subtype. FieldValueType<'buffer'> === Uint8Array.
    const world = new World();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const spawned = world.spawn({
      component: PostProcessParams,
      data: { shader: 'x', data: bytes },
    });
    expect(spawned.ok).toBe(true);
    if (spawned.ok) {
      const read = world.get(spawned.value, PostProcessParams);
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect([...read.value.data]).toEqual([1, 2, 3, 4]);
      }
    }
  });
});
