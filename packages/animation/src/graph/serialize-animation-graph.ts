// @forgeax/engine-animation -- AnimationGraph POD -> pack payload serialization.
//
// feat-20260713-animation-state-machine-plugin M4 / w29 (plan D-4 landing (2),
// §6.3 serialize seam):
//
//   const out = serializeAnimationGraph(graph, (clipGuid) => clipGuid);
//   if (out === undefined) return; // a durable clip GUID was unavailable
//   // out.payload -> the pack `payload` object; out.refs -> the pack `refs[]`.
//
// The inverse of `animationGraphLoader` (w30, in @forgeax/engine-assets-runtime):
// serialize rewrites each Clip leaf's durable GUID into a deduped `refs[]`
// array (the payload stores the refs INDEX, not a runtime handle) -- the exact
// "GUID in refs, index in payload" contract
// the scene/material serialize paths use (plan D-4, asset-registry D-19). Blend
// and Add nodes carry only intra-graph node indices, which are position-stable
// under round-trip, so they pass through unchanged. `root` is a node index and
// passes through too.
//
// OOS-7: this serializes only the topology of an engine-authored
// `defineAnimationGraph` graph (nodes / static weights / clip refs); there is no
// DCC-import metadata surface.

import type { AnimationGraph } from '@forgeax/engine-types';

/**
 * Resolves a Clip leaf's durable GUID string to the form stored in Pack
 * `refs[]`. Returns `undefined` when the GUID is unavailable, which aborts
 * serialization.
 * The caller supplies this so serialize stays free of AssetRegistry / World
 * coupling; the graph already carries durable GUID strings at this boundary.
 */
export type ClipGuidResolver = (clip: string) => string | undefined;

/**
 * Output of {@link serializeAnimationGraph}: the pack `payload` object (a flat
 * `{ nodes, root }` shape where Clip leaves reference `refs[]` by index) plus the
 * deduped `refs[]` array of clip GUID strings.
 */
export interface SerializedAnimationGraph {
  readonly payload: Record<string, unknown>;
  readonly refs: readonly string[];
}

/**
 * Serialize an {@link AnimationGraph} POD into a pack payload + refs pair. Clip
 * leaves are rewritten from durable GUIDs to deduped `refs[]` GUID indices via
 * `resolveClipGuid`; Blend/Add node references and `root` (all intra-graph node
 * indices) pass through. Returns `undefined` if any durable clip GUID cannot be
 * resolved -- an unresolvable clip means the graph cannot be persisted losslessly.
 */
export function serializeAnimationGraph(
  graph: AnimationGraph,
  resolveClipGuid: ClipGuidResolver = (clip) => clip,
): SerializedAnimationGraph | undefined {
  const refs: string[] = [];
  const guidToIndex = new Map<string, number>();
  const internRef = (guid: string): number => {
    const existing = guidToIndex.get(guid);
    if (existing !== undefined) return existing;
    const index = refs.length;
    refs.push(guid);
    guidToIndex.set(guid, index);
    return index;
  };

  const nodes: Array<Record<string, unknown>> = [];
  for (const node of graph.nodes) {
    switch (node.type) {
      case 'clip': {
        const guid = resolveClipGuid(node.clip);
        if (guid === undefined || guid.length === 0) return undefined;
        nodes.push({ type: 'clip', clip: internRef(guid), weight: node.weight });
        break;
      }
      case 'blend':
        nodes.push({ type: 'blend', children: [...node.children], weight: node.weight });
        break;
      case 'add':
        nodes.push({
          type: 'add',
          base: node.base,
          additive: [...node.additive],
          weight: node.weight,
        });
        break;
    }
  }

  return { payload: { nodes, root: graph.root }, refs };
}
