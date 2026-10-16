// feat-20260713-animation-state-machine-plugin M2 / w9 — legal graph build +
// shared handle multi-entity rc (AC-02).
//
// AC-02: a legal Clip/Blend/Add/nested graph constructs without error via
// defineAnimationGraph; the resulting POD is minted into a GUID-addressable
// shared<AnimationGraph> handle; two entities share the SAME handle and the
// SharedRefStore refcount retains/releases correctly as entities spawn/despawn
// (multi-entity sharing). The evaluation system is NOT landed in M2 — this test
// only exercises the data model + carrier (plan-strategy §7 M2 boundary).
//
// TDD red anchor: before w13 (types POD) + w14 (builder), the imports below do
// not resolve and defineAnimationGraph does not exist — the file fails to
// compile. After w13/w14 the legal graph constructs and the rc assertions pass.

import { defineAnimationGraph } from '@forgeax/engine-animation';
import { defineComponent, World } from '@forgeax/engine-ecs';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

// A test-only component carrying a single shared<AnimationGraph> handle. M2 does
// NOT extend AnimationPlayer with a graph field (that is M3 / w24), so this
// minimal holder is the authentic ECS path for exercising the write-barrier
// retain/release across multiple entities without touching the M2-frozen
// AnimationPlayer schema.
const GraphHolder = defineComponent('AnimationGraphHolderW9', {
  graph: 'shared<AnimationGraph>',
});

function clipGuid(id: number) {
  return `test/animation-clip-${id}`;
}

describe('AnimationGraph — legal build + multi-entity rc (M2 / w9)', () => {
  it('constructs a nested Clip/Blend/Add graph without error', () => {
    const walk = clipGuid(1);
    const run = clipGuid(2);
    const survey = clipGuid(3);
    const overlay = clipGuid(4);

    const result = defineAnimationGraph((b) => {
      const walkNode = b.clip(walk);
      const runNode = b.clip(run);
      const surveyNode = b.clip(survey);
      const loco = b.blend([walkNode, runNode]);
      const base = b.blend([surveyNode, loco]);
      const overlayNode = b.clip(overlay, 0.3);
      return b.add(base, [overlayNode]);
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const graph = result.value;
    expect(graph.kind).toBe('animation-graph');
    // 4 clip nodes + 2 blend nodes + 1 add node = 7 nodes; root is the add.
    expect(graph.nodes.length).toBe(7);
    expect(graph.nodes[graph.root]?.type).toBe('add');
  });

  it('mints a GUID-addressable shared handle with rc=1 (alloc grant)', () => {
    const world = new World();
    const result = defineAnimationGraph((b) => b.clip(clipGuid(1)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const handle = world.allocSharedRef('AnimationGraph', result.value);
    expect(handle).toBeGreaterThan(0);
    expect(world.sharedRefs.refcount(handle)).toBe(1);
  });

  it('shares one handle across two entities; rc tracks retain/release', () => {
    const world = new World();
    const clipMap = new Map<number, AnimationClip>();
    clipMap.set(1, { kind: 'animation-clip', duration: 10, channels: [] });

    const result = defineAnimationGraph((b) => {
      const a = b.clip(clipGuid(1));
      const c = b.clip(clipGuid(1));
      return b.blend([a, c]);
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const handle = world.allocSharedRef('AnimationGraph', result.value);
    // alloc grant = 1.
    expect(world.sharedRefs.refcount(handle)).toBe(1);

    // Two entities hold the SAME handle — each spawn retains via the write
    // barrier, so rc climbs to 3 (1 grant + 2 holders).
    const e0 = world.spawn({ component: GraphHolder, data: { graph: handle } }).unwrap();
    const e1 = world.spawn({ component: GraphHolder, data: { graph: handle } }).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(3);

    // Despawning one holder releases exactly one ref (independent per entity).
    world.despawn(e0).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(2);

    world.despawn(e1).unwrap();
    expect(world.sharedRefs.refcount(handle)).toBe(1);
  });
});
