// feat-20260713-animation-state-machine-plugin M4 / w27 -- AnimationGraph
// serialize -> deserialize pack round-trip (AC-14 part a).
//
// AC-14 (part a) metric: construct a nested graph -> serialize to a pack payload
// -> deserialize (rebuild) and assert the graph topology (Clip/Blend/Add nodes +
// child references), every node's static weight, the root, and every clip
// reference are field-for-field equal to the original. Clip references round-trip
// through the existing `refs` GUID mechanism (plan D-4): serialize rewrites each
// clip leaf's `shared<AnimationClip>` handle to a GUID (indexed into `refs`), and
// the loader resolves each `refs` index back to its GUID string (the same "GUID
// verbatim at load, resolve to a handle at use time" contract materialLoader
// uses, asset-registry D-19).
//
// TDD red anchor: before w29 (serializeAnimationGraph) + w30 (animationGraphLoader)
// the two imports below do not resolve, so the file fails to compile. w29 lands
// serialize (payload + refs); w30 lands the loader; the round-trip goes green
// once both halves exist (a round-trip test spans both impl seams by nature).

import { defineAnimationGraph, serializeAnimationGraph } from '@forgeax/engine-animation';
import { AssetRegistry, animationGraphLoader } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AnimationClip, AnimationGraph, Handle, LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

// Register a clip payload under `guidStr` in BOTH the registry catalog (so
// `_guidForAsset` resolves payload -> GUID) and the world's shared-ref store (so
// `resolveAssetHandle` resolves handle -> payload). The SAME payload object is
// used for both so the identity-based `_guidForAsset` scan matches.
function registerClip(
  world: World,
  reg: AssetRegistry,
  guidStr: string,
  duration: number,
): { handle: Handle<'AnimationClip', 'shared'>; guid: string } {
  const parsed = AssetGuid.parse(guidStr);
  if (!parsed.ok) throw new Error(`bad test GUID ${guidStr}`);
  const clip: AnimationClip = { kind: 'animation-clip', duration, channels: [] };
  reg.catalog(parsed.value, clip);
  const handle = world.allocSharedRef('AnimationClip', clip) as Handle<'AnimationClip', 'shared'>;
  return { handle, guid: AssetGuid.format(parsed.value) };
}

// Resolver used by serialize: clip handle -> catalogued GUID string, via the two
// production seams (resolveAssetHandle on the world + _guidForAsset on the
// registry). Mirrors how a scene-serialize caller resolves an asset handle.
function makeClipGuidResolver() {
  return (clip: string): string | undefined => clip;
}

const G1 = 'a1000000-0000-4000-8000-000000000001';
const G2 = 'a1000000-0000-4000-8000-000000000002';
const G3 = 'a1000000-0000-4000-8000-000000000003';

// Minimal LoadContext stub -- the animation-graph loader is a pure payload/refs
// transform and reads nothing off the context (no fetch / device / shader).
const stubCtx = {} as LoadContext;

describe('AnimationGraph serialize -> deserialize round-trip (M4 / w27, AC-14 part a)', () => {
  it('serialize produces a pack payload with deduped refs of clip GUIDs', () => {
    const world = new World();
    const reg = makeRegistry();
    const walk = registerClip(world, reg, G1, 10);
    const run = registerClip(world, reg, G2, 20);

    // overlay reuses the walk clip handle -> serialize must dedupe it to a
    // single refs entry (mirrors material/scene refs dedup).
    const built = defineAnimationGraph((b) => {
      const w = b.clip(walk.guid);
      const r = b.clip(run.guid);
      const loco = b.blend([w, r]);
      const overlay = b.clip(walk.guid, 0.3);
      return b.add(loco, [overlay]);
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const out = serializeAnimationGraph(built.value, makeClipGuidResolver());
    expect(out).not.toBeUndefined();
    if (out === undefined) return;

    // Two unique clip GUIDs despite three clip nodes (walk referenced twice).
    expect([...out.refs].sort()).toEqual([walk.guid, run.guid].sort());
    const payloadNodes = (out.payload.nodes as Array<Record<string, unknown>>) ?? [];
    expect(payloadNodes).toHaveLength(5);
    // Every clip node's `clip` in the payload is a refs index, not a handle.
    for (const node of payloadNodes) {
      if (node.type === 'clip') {
        expect(typeof node.clip).toBe('number');
        expect(node.clip as number).toBeGreaterThanOrEqual(0);
        expect(node.clip as number).toBeLessThan(out.refs.length);
      }
    }
  });

  it('deserialize rebuilds the graph field-for-field equal to the original', () => {
    const world = new World();
    const reg = makeRegistry();
    const walk = registerClip(world, reg, G1, 10);
    const run = registerClip(world, reg, G2, 20);
    const survey = registerClip(world, reg, G3, 30);

    // Nested DAG: Add(base=Blend(survey@0.5, Blend(walk, run))@0.8, additive=[overlay@0.3]).
    const built = defineAnimationGraph((b) => {
      const w = b.clip(walk.guid);
      const r = b.clip(run.guid);
      const s = b.clip(survey.guid, 0.5);
      const loco = b.blend([w, r]);
      const base = b.blend([s, loco], 0.8);
      const overlay = b.clip(survey.guid, 0.3);
      return b.add(base, [overlay]);
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const original = built.value;

    const out = serializeAnimationGraph(original, makeClipGuidResolver());
    expect(out).not.toBeUndefined();
    if (out === undefined) return;

    const parsed = animationGraphLoader.load(out.payload, out.refs, stubCtx);
    expect(parsed).not.toBeUndefined();
    if (parsed === undefined || typeof parsed !== 'object' || 'ok' in parsed) {
      throw new Error('animationGraphLoader returned a non-asset result');
    }
    const rebuilt = parsed as AnimationGraph;

    // kind + root + node count are structurally identical.
    expect(rebuilt.kind).toBe('animation-graph');
    expect(rebuilt.root).toBe(original.root);
    expect(rebuilt.nodes).toHaveLength(original.nodes.length);

    // Field-for-field per node: type, static weight, child references identical;
    // clip references equal at the GUID level (the persistent form).
    for (let i = 0; i < original.nodes.length; i++) {
      const o = original.nodes[i];
      const d = rebuilt.nodes[i];
      if (o === undefined || d === undefined) throw new Error(`missing node ${i}`);
      expect(d.type).toBe(o.type);
      expect(d.weight).toBe(o.weight);
      if (o.type === 'clip' && d.type === 'clip') {
        expect(d.clip).toBe(o.clip);
      } else if (o.type === 'blend' && d.type === 'blend') {
        expect([...d.children]).toEqual([...o.children]);
      } else if (o.type === 'add' && d.type === 'add') {
        expect(d.base).toBe(o.base);
        expect([...d.additive]).toEqual([...o.additive]);
      }
    }
  });

  it('deserialize rejects a malformed payload with undefined (asset-parse-failed upstream)', () => {
    // clip node whose refs index is out of range -> loader returns undefined so
    // the load-by-guid path surfaces the existing `asset-parse-failed` code.
    const badPayload: Record<string, unknown> = {
      nodes: [{ type: 'clip', clip: 5, weight: 1 }],
      root: 0,
    };
    const parsed = animationGraphLoader.load(
      badPayload,
      ['a1000000-0000-4000-8000-000000000009'],
      stubCtx,
    );
    expect(parsed).toBeUndefined();
  });
});
