# Hello Topology

This app is the Geometry factory dogfood surface. It consumes the public
`@forgeax/engine-geometry` barrel and renders two results from one indexed box
source:

The same page also carries the first-class public Points/Lines route used by
the renderer contract. The focused URLs are:

- `http://127.0.0.1:5173/?evidenceLane=webgpu`
- `http://127.0.0.1:5173/?evidenceLane=wgpu-webgl2`

Those routes author `Materials.unlit`, `Points`, and `Lines` through public
barrels and expose typed `renderer.inspect().renderScene.pointsLines` evidence.
The query-free URL remains the Geometry factory visual oracle below. `RhiNull`
is structural-only; it is not a pixel verdict.

| Display | Factory | Edge rule | Expected carrier |
|:--|:--|:--|:--|
| Wireframe | `createWireframeGeometry(source)` | Every unique triangle edge, including coplanar diagonals | 18 edges, one non-indexed `line-list` submesh |
| Surface edges | `createEdgesGeometry(source, 1)` | Boundary and sharp edges; coplanar edges filtered at 1 degree | 12 edges, one non-indexed `line-list` submesh |

The runtime HUD is the first machine-readable inspection surface. It reports:

- `factory`: the two public factory names;
- `edgeCount`: emitted endpoint pairs (`vertexCount / 2`);
- `topology=line-list` and `indexed=false` for both outputs;
- `backend`: `renderer.inspect().capabilities.backendKind`, with provenance;
- `failure recovery`: structured `AssetError.code/detail` handling and a
  retry action directed back to the Geometry owner;
- `visual record`: the Browser executor fills `{observed, verdict, confidence}`
  after directly reading the PNG.

## Focused public authoring

```ts
import { Lines, Materials, MeshFilter, MeshRenderer, Points } from '@forgeax/engine-render';

const material = Materials.unlit([0.1, 0.9, 1, 1]);
world.spawn(
  { component: MeshFilter, data: { assetHandle: pointMeshHandle } },
  { component: MeshRenderer, data: { materials: [materialHandle] } },
  { component: Points, data: { sizePx: 16, shape: 'circle' } },
);
world.spawn(
  { component: MeshFilter, data: { assetHandle: lineMeshHandle } },
  { component: MeshRenderer, data: { materials: [materialHandle] } },
  { component: Lines, data: { width: 4 } },
);
```

`scripts/public-consumer.mjs` is the public-import contract. It checks both
evidence lanes and rejects private renderer helpers, encoders, graph keys, and
backend-specific authoring branches.

> [!IMPORTANT]
> A live page, a non-black canvas, or a successful Dawn/RhiNull structural
> check is not a visual PASS. Browser evidence requires a readable PNG,
> pixel-region observations for both displays, zero unexpected console errors,
> and an explicit `verdict` plus `confidence`.

## Run

```sh
pnpm --filter @forgeax/hello-topology typecheck
pnpm --filter @forgeax/hello-topology build
SMOKE_MIN_FRAMES=60 SMOKE_DURATION_MS=5000 pnpm --filter @forgeax/hello-topology smoke
```

The Dawn smoke prints backend provenance, both factory edge counts, the
line-list/index state, sparse foreground readback, and the 60-frame criterion.
Its falsifiers are deliberately expected to exit red:

```sh
FALSIFY=topology-triangle-list pnpm --filter @forgeax/hello-topology smoke
FALSIFY=degenerate pnpm --filter @forgeax/hello-topology smoke
FALSIFY=threshold pnpm --filter @forgeax/hello-topology smoke
```

`FALSIFY` is diagnostic evidence and is not a positive CI gate. It never
creates a fallback mesh, a private Geometry import, or a Browser query
artifact. Browser visual evidence remains separate from Dawn and RhiNull
structural evidence.

## Failure recovery

Factory failures are returned as `Result.err(AssetError)` and are displayed by
`code`, `detail.field`, `detail.value`, and `detail.reason` when available.
The recovery action is to correct the source or threshold at the Geometry
factory boundary and retry. The app does not hide the failure with a stand-in
mesh or a hand-written edge/packer implementation.
