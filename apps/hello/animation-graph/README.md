# hello-animation-graph

A runnable **AnimationGraph DAG** demo: Fox.glb driven by a nested directed
acyclic graph of animation nodes, evaluated declaratively into a variable-length
N-slot blend every frame. You adjust only per-node runtime weights from the
keyboard — the final `weights[]` is computed for you, never written by hand.

```bash
pnpm --filter @forgeax/hello-animation-graph dev     # browser demo
pnpm --filter @forgeax/hello-animation-graph smoke    # headless numerical checks
```

## 1. The proposition

An `AnimationGraph` is a serializable, GUID-addressable asset describing HOW a
set of animation clips combine — the same way Bevy's animation graph does. You
build it once with `defineAnimationGraph`, attach it to an `AnimationPlayer`, and
the default `animationPlugin` runs `evaluateAnimationGraph` each frame to derive
the per-clip `weights[]` (a variable-length N-slot array, no fixed cap).

```ts
const graph = defineAnimationGraph((b) => {
  const survey = b.clip(surveyHandle);
  const walk = b.clip(walkHandle);
  const run = b.clip(runHandle);
  const locomotion = b.blend([walk, run]);           // normalizing
  const base = b.blend([survey, locomotion]);         // normalizing
  const overlay = b.clip(surveyHandle, 0.3);          // static weight 0.3
  return b.add(base, [overlay]);                       // non-normalizing root
});
// graph.ok === true; graph.value is a validated AnimationGraph POD.
```

## 2. Node semantics & the effective-weight formula

Three node kinds:

| Node | Combination | Normalizes? |
|:--|:--|:--|
| `clip(handle, w?)` | samples one `AnimationClip`; leaf of the graph | — |
| `blend([...children], w?)` | weighted **lerp** of children | yes (weights renormalized to sum 1) |
| `add(base, [...additive], w?)` | `base` plus each additive layer **stacked** | **no** (total may exceed 1) |

Each node carries a **static weight** (declared at build time) and a **runtime
weight** (`AnimationPlayer.nodeWeights[i]`, tweaked per frame). The effective
contribution of a node is:

```
effectiveWeight(i) = nodeWeights[i] * staticWeight(i)   (nodeWeights[i] defaults to 1)
```

`evaluateAnimationGraph` walks the graph in **construction order** (post-order:
a node is computed after every node it references) and folds these into the flat
`weights[]` that the clip sampler consumes. Because `add` does not renormalize,
turning the overlay on pushes the total above 1 — this is intentional (an
additive layer stacks on top of the base pose).

### Introspection

`describeAnimationGraph(graph)` returns a machine-readable description
(`nodes[]` / `root` / `staticWeights[]`) **without reading source**, mirroring
the `getRegisteredComponents` reflection idiom. `desc.nodes[i].index === i` is
the **same index** as `nodeWeights[i]` / `nodeTimes[i]` / `nodeSpeeds[i]`, so you
can introspect a shared or deserialized graph and drive the right node directly.

## 3. Errors & boundaries

`defineAnimationGraph` validates topology at **construction time** and returns a
`Result`; each illegal shape carries a structured `.code` / `.hint` / `.detail`
(exhaustively switchable on `AnimationGraphErrorCode`, all re-exported from
`@forgeax/engine-runtime`):

| `.code` | Cause |
|:--|:--|
| `animation-graph-empty` | zero nodes |
| `animation-graph-node-out-of-range` | a ref points outside `[0, nodeCount)` |
| `animation-graph-node-weight-invalid` | a static weight is negative / non-finite |
| `animation-graph-cycle` | the graph is not acyclic |

At **evaluation time**, an unresolved clip handle raises
`AnimationGraphClipMissingError` (`animation-graph-clip-missing`) before any slot
is written, so a dangling clip never leaves a dirty pose.

Out of scope for this feature (deferred): finite-state machines, per-bone masks,
crossfade/transition primitives, and DCC-imported graphs — the graph is built in
engine via `defineAnimationGraph`.

## Keyboard (browser demo)

| Key | Effect |
|:--|:--|
| `A` / `D` | Survey ↔ Walk/Run locomotion ratio |
| `W` / `S` | Walk ↔ Run ratio (inner blend) |
| `O` | toggle additive overlay (watch the HUD total cross 1) |
| `Space` | pause |
