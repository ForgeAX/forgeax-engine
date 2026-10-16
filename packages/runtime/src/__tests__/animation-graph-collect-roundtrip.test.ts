// feat-20260713-animation-state-machine-plugin M4 / w28 -- graph-holding entity
// scene collect round-trip (AC-14 part b).
//
// AC-14 (part b) metric: an entity carrying a `shared<AnimationGraph>` handle is
// collected through scene collect; the graph handle resolves to a persistable
// GUID reference (schema-driven, plan D-4: `classifyFieldSchema` sees the
// `shared<AnimationGraph>` scalar and routes it through `_guidForAsset` with ZERO
// special-case in collect-scene-asset.ts, w31 verifies this); a `graph == 0`
// (no-graph) entity is skipped by the existing 0-sentinel path (lossless); and a
// graph reloaded from its serialized pack payload evaluates to the SAME derived
// N-slot weights as the original (round-trip lossless).
//
// TDD red anchor: serializeAnimationGraph (w29) + animationGraphLoader (w30) do
// not resolve until those tasks land; the eval-consistency case then goes green.
// The collect->GUID cases exercise the already-present schema-driven path (w31 is
// a verify-only landing that this test is the witness for).

import {
  AnimationPlayer,
  defineAnimationGraph,
  defineAnimationMask,
  deriveAnimationTargetId,
  evaluateAnimationGraph,
  serializeAnimationGraph,
} from '@forgeax/engine-animation';
import { AssetRegistry, animationGraphLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AnimationClip, AnimationGraph, Handle, LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { rootsToSceneAsset } from '../collect-scene-asset';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

function makeWorld(): World {
  const world = new World();
  world.components.register(AnimationPlayer).unwrap();
  return world;
}

const stubCtx = {} as LoadContext;

// Register a clip in the registry catalog + world shared-ref store under the same
// payload identity, returning both its handle and its GUID string.
function registerClip(
  world: World,
  reg: AssetRegistry,
  guidStr: string,
  duration: number,
): { handle: Handle<'AnimationClip', 'shared'>; guid: string; asset: AnimationClip } {
  const parsed = AssetGuid.parse(guidStr);
  if (!parsed.ok) throw new Error(`bad test GUID ${guidStr}`);
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  reg.catalog(parsed.value, clip);
  const handle = world.allocSharedRef('AnimationClip', clip) as Handle<'AnimationClip', 'shared'>;
  return { handle, guid: AssetGuid.format(parsed.value), asset: clip };
}

// Register a graph POD in both stores; returns its handle + GUID string.
function registerGraph(
  world: World,
  reg: AssetRegistry,
  guidStr: string,
  graph: AnimationGraph,
): { handle: Handle<'AnimationGraph', 'shared'>; guid: string } {
  const parsed = AssetGuid.parse(guidStr);
  if (!parsed.ok) throw new Error(`bad test GUID ${guidStr}`);
  reg.catalog(parsed.value, graph);
  const handle = world.allocSharedRef('AnimationGraph', graph) as Handle<
    'AnimationGraph',
    'shared'
  >;
  return { handle, guid: AssetGuid.format(parsed.value) };
}

function apOf(scene: {
  entities: Readonly<Record<string, unknown>>;
}): Record<string, unknown> | undefined {
  for (const e of Object.values(scene.entities)) {
    const comps = (e as { components: Record<string, Record<string, unknown>> }).components;
    if (comps.AnimationPlayer !== undefined) return comps.AnimationPlayer;
  }
  return undefined;
}

const G_WALK = 'b1000000-0000-4000-8000-000000000001';
const G_RUN = 'b1000000-0000-4000-8000-000000000002';
const G_SURVEY = 'b1000000-0000-4000-8000-000000000003';
const G_GRAPH = 'b1000000-0000-4000-8000-0000000000aa';
const G_GRAPH2 = 'b1000000-0000-4000-8000-0000000000bb';

// Build the standard test graph: Add(base=Blend(walk, run), additive=[survey@0.3]).
function buildStandardGraph(walk: string, run: string, survey: string): AnimationGraph {
  const built = defineAnimationGraph((b) => {
    const w = b.clip(walk);
    const r = b.clip(run);
    const loco = b.blend([w, r]);
    const overlay = b.clip(survey, 0.3);
    return b.add(loco, [overlay]);
  });
  if (!built.ok) throw new Error('graph build failed');
  return built.value;
}

describe('AnimationGraph collect round-trip (M4 / w28, AC-14 part b)', () => {
  it('collects a graph-holding entity with graph resolved to its GUID (schema-driven, zero special-case)', () => {
    const world = makeWorld();
    const reg = makeRegistry();
    const walk = registerClip(world, reg, G_WALK, 10);
    const run = registerClip(world, reg, G_RUN, 20);
    const survey = registerClip(world, reg, G_SURVEY, 30);
    const graph = buildStandardGraph(walk.guid, run.guid, survey.guid);
    const g = registerGraph(world, reg, G_GRAPH, graph);

    const e = world
      .spawn({
        component: AnimationPlayer,
        data: { graph: g.handle, nodeWeights: [1, 1, 1, 1, 1] },
      })
      .unwrap();

    const collected = rootsToSceneAsset(reg, world, [e]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const ap = apOf(collected.value);
    expect(ap).not.toBeUndefined();
    if (ap === undefined) return;
    // The graph scalar shared field resolves to the catalogued GUID string.
    expect(ap.graph).toBe(g.guid);
  });

  it('keeps World-local mask handles transient while collecting ordinary playback assets', () => {
    const world = makeWorld();
    const reg = makeRegistry();
    const clip = registerClip(world, reg, G_WALK, 10);
    const mask = world.allocSharedRef(
      'AnimationMask',
      defineAnimationMask([
        { targetId: deriveAnimationTargetId(['Rig', 'Upper']), weight: 1 },
      ]).unwrap(),
    );
    const player = world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [clip.handle],
          times: [0],
          weights: [1],
          speeds: [1],
          masks: [mask],
          nodeMasks: [mask],
        },
      })
      .unwrap();
    const collected = rootsToSceneAsset(reg, world, [player]).unwrap();
    const data = apOf(collected);
    expect(data?.clips).toEqual([clip.guid]);
    expect(data).not.toHaveProperty('masks');
    expect(data).not.toHaveProperty('nodeMasks');
  });

  it('skips a graph == 0 (no-graph) entity 0-sentinel: lossless, no graph key emitted', () => {
    const world = makeWorld();
    const reg = makeRegistry();

    const e = world
      .spawn({
        component: AnimationPlayer,
        data: { clips: [], times: [], weights: [], speeds: [] },
      })
      .unwrap();

    const collected = rootsToSceneAsset(reg, world, [e]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const ap = apOf(collected.value);
    expect(ap).not.toBeUndefined();
    if (ap === undefined) return;
    // graph == 0 (unset) is dropped by the shared-scalar 0-sentinel skip.
    expect('graph' in ap).toBe(false);
  });

  it('a graph reloaded from its serialized pack payload evaluates to identical weights', () => {
    const world = makeWorld();
    const reg = makeRegistry();
    const walk = registerClip(world, reg, G_WALK, 10);
    const run = registerClip(world, reg, G_RUN, 20);
    const survey = registerClip(world, reg, G_SURVEY, 30);
    const original = buildStandardGraph(walk.guid, run.guid, survey.guid);
    const lookup = (guid: string): AnimationClip | undefined =>
      new Map([
        [walk.guid, walk.asset],
        [run.guid, run.asset],
        [survey.guid, survey.asset],
      ]).get(guid);

    // Original graph -> register -> spawn -> eval one frame -> read weights.
    const g0 = registerGraph(world, reg, G_GRAPH, original);
    const e0 = world.spawn({ component: AnimationPlayer, data: { graph: g0.handle } }).unwrap();
    evaluateAnimationGraph(world, 1 / 60, lookup);
    const w0res = world.get(e0, AnimationPlayer);
    expect(w0res.ok).toBe(true);
    if (!w0res.ok) return;
    const weights0 = Array.from((w0res.value as unknown as { weights: Float32Array }).weights);

    // Serialize -> deserialize -> re-resolve clip GUIDs to their handles -> rebuild.
    const clipGuidResolver = (clip: string): string | undefined => clip;
    const out = serializeAnimationGraph(original, clipGuidResolver);
    expect(out).not.toBeUndefined();
    if (out === undefined) return;
    const parsed = animationGraphLoader.load(out.payload, out.refs, stubCtx);
    if (parsed === undefined || typeof parsed !== 'object' || 'ok' in parsed) {
      throw new Error('animationGraphLoader returned a non-asset result');
    }
    const reloaded = parsed as AnimationGraph;

    const rebuilt: AnimationGraph = reloaded;

    const g1 = registerGraph(world, reg, G_GRAPH2, rebuilt);
    const e1 = world.spawn({ component: AnimationPlayer, data: { graph: g1.handle } }).unwrap();
    evaluateAnimationGraph(world, 1 / 60, lookup);
    const w1res = world.get(e1, AnimationPlayer);
    expect(w1res.ok).toBe(true);
    if (!w1res.ok) return;
    const weights1 = Array.from((w1res.value as unknown as { weights: Float32Array }).weights);

    // Round-trip lossless: reloaded graph evaluates to the same derived weights.
    expect(weights1).toHaveLength(weights0.length);
    for (let i = 0; i < weights0.length; i++) {
      expect(weights1[i]).toBeCloseTo(weights0[i] as number, 6);
    }
    // Sanity: the standard graph yields Blend(walk,run)=[0.5,0.5] + Add survey@0.3.
    // weights[] is a Float32Array column, so 0.3 reads back as its f32 nearest
    // (0.30000001192...) -- compare per-slot with f32-scale tolerance, not
    // strict f64 equality.
    const expectedWeights0 = [0.5, 0.5, 0.3];
    expect(weights0).toHaveLength(expectedWeights0.length);
    for (let i = 0; i < expectedWeights0.length; i++) {
      expect(weights0[i]).toBeCloseTo(expectedWeights0[i] as number, 6);
    }
  });
});
