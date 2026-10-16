# Release note: draw-source seam + camera-owner / resource-owner split

> feat-20260709-editor-world-partition-editorworld-super-composite (2026-07-09)
> Anchors: requirements AC-08 · plan-strategy §2 D-3 · research F1/F2

Two changes ship together in this feature. The draw contract is intentionally
breaking: all callers provide both owner indices explicitly.

1. **`draw(worlds, options)` owner split** — the single `owner` index splits into
   two independent indices, `cameraOwner` and `resourceOwner` (delivered M1).
2. **`drawSource` frame-loop seam** — `createApp` gains an optional per-frame
   pull callback that lets a host (e.g. the editor) choose which worlds to render
   and which owner indices to use, each frame, without the engine knowing
   anything about how the host partitions its worlds (delivered M2).

---

## 1. Single-world users

If you call `createApp(canvas)` or `createApp({ renderer, world })` and never
touch `drawSource`, the engine renders your one world exactly as before. The
frame-loop still issues the identity call:

```ts
renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
```

`cameraOwner === resourceOwner === 0` is the single-world identity path.

A host that does not inject a `drawSource` frame uses this primary-world path.

---

## 2. Owner semantics: camera-owner + resource-owner

`renderer.draw(worlds, options)` accepts exactly one `DrawOwnerOptions` shape:
`{ cameraOwner, resourceOwner }`. Both indices are required.

The two owners name **which world contributes what** to the composited frame:

- **camera-owner** (`cameraOwner`) — the world whose `Camera` entities drive the
  frame. View + projection matrices are surfaced from `worlds[cameraOwner]`.
- **resource-owner** (`resourceOwner`) — the world whose **singleton render
  resources** drive the frame: `Skylight`, skybox, and post-process params are
  surfaced from `worlds[resourceOwner]`.

Every world in `worlds` still contributes its renderable geometry
(`MeshFilter` + `MeshRenderer`, etc.). The split only governs the two *singleton*
categories (camera, environment/post) that must resolve from exactly one world.

Example — render a scene world's geometry through an editor world's camera while
sourcing lighting/skybox from the scene world:

```ts
renderer.draw([sceneWorld, editorWorld], { cameraOwner: 1, resourceOwner: 0 });
```

### The `drawSource` seam (createApp)

`drawSource` is an optional per-frame pull on both `createApp` forms:

```ts
type DrawSource = () =>
  | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
  | undefined;

const app = await createApp({ renderer, world, drawSource });
```

Contract (plan-strategy D-3):

- Returns `undefined` → single-world path (see §1).
- Returns a result → the frame-loop runs `world.update()` on **every** returned
  world before drawing, then `renderer.draw(worlds, { cameraOwner, resourceOwner })`.

> [!IMPORTANT]
> The frame-loop **updates the injected worlds every frame** — it is not
> draw-only. This is load-bearing, not an optimization. The renderer's extract
> stage reads the *derived* `GlobalTransform.world` mat4, whose sole writer is the
> `propagateTransforms` system, which only runs inside `world.update()`. If an
> injected world were fed to `draw` without first being updated, the renderer
> would read a **stale** world matrix (or the identity default on the first
> frame) — the injected world would render one frame behind, or at the origin.
> The own `App.world` is updated once (never double-updated even if a drawSource
> degenerately lists it).

---

## 3. Error codes

No new error codes. The two existing multi-world draw-entry codes gain a
discriminating `.detail` field for the split; AI users branch on `.code` then
read `.detail` by property access (never by parsing the message string).

| `.code` | When | `.detail` |
|:--|:--|:--|
| `render-system-empty-worlds` | `draw(worlds, ...)` received an empty `worlds` array. The frame is skipped before any extract runs — no per-world side effects fire. A supplied World without a `Camera` is valid; an empty `worlds` array still has no source owner. | `undefined` — the failure is fully described by `.code`. |
| `render-system-owner-out-of-range` | An owner index is not a valid index into `worlds` (`< 0` or `>= worlds.length`). Checked at the draw entry, after the empty-worlds short-circuit. | `{ role, owner, worldCount }` |

`render-system-owner-out-of-range` detail fields:

- **`role`** ∈ `{ 'camera', 'resource' }` — which of the two split indices was out
  of range. `cameraOwner` is validated before `resourceOwner`, so when **both**
  indices offend, `role === 'camera'` (the first offender wins). This is the sole
  reason no new code was needed: the discriminator lives in `.detail`, keeping
  net-new codes at 0 (D-3).
- **`owner`** — the offending index the caller passed (the `role` index's value).
- **`worldCount`** — `worlds.length` at call time; the valid range is
  `0 .. worldCount - 1`.

```ts
const r = renderer.draw(worlds, { cameraOwner, resourceOwner });
if (!r.ok && r.error.code === 'render-system-owner-out-of-range') {
  const { role, owner, worldCount } = r.error.detail;
  // e.g. role='resource', owner=2, worldCount=2 -> resourceOwner must be 0..1
}
```

---

## 4. v1 boundaries

The split defines *which world* supplies cameras vs environment/post; it does not
add new rendering capability. Two boundaries carry over unchanged, restated here
in camera-owner / resource-owner terms:

- **Video-texture provider miss.** A material sampling a video texture resolves
  its provider from the drawn worlds' resources as before. The owner split does
  not add a cross-world video-texture provider lookup: a video provider that
  lives in a world other than the one carrying the material is still a miss.
  Practically, keep a video-textured material and its provider in the same world
  (typically the resource-owner world, alongside the other singleton resources).
- **No CPU frustum culling across the split.** Culling behaviour is per the
  existing render path; the feature adds no CPU-side frustum cull keyed on the
  camera-owner's frustum across the other (geometry-contributing) worlds. Every
  drawn world's renderables are extracted as before, regardless of which world
  owns the camera.
