# hello-text

> **World-space MSDF text oracle** — load one baked FontAsset, spawn four
> GlyphText entities, and let the shared layout system produce billboarded
> meshes through the normal render path.

## Run locally

~~~bash
pnpm --filter @forgeax/hello-text dev      # Vite dev server
pnpm --filter @forgeax/hello-text build    # production pack + shader build
pnpm --filter @forgeax/hello-text smoke    # Dawn 60-frame pixel/structure smoke
~~~

The browser page uses the same public createApp + Pack-v2 loading path as a
consumer project. The Dawn smoke registers the same baked payload inline because
headless Dawn has no Vite middleware.

## One-line text composition

~~~ts
import { Transform } from '@forgeax/engine-scene';
import { GlyphText } from '@forgeax/engine-render/authoring';

world.spawn(
  { component: Transform, data: { pos: [0, 2, 0], quat: [0, 0, 0, 1] } },
  {
    component: GlyphText,
    data: { fontHandle, text: 'PLAYER 1', fontSize: 0.025, color: [1, 1, 1, 1] },
  },
);
~~~

GlyphText is authoring data. The runtime glyphTextLayoutSystem bakes one mesh
per text entity and attaches MeshFilter plus MeshRenderer; consumers do not
create glyph geometry or a second text renderer. fontSize is in world units,
and a newline starts a new line.

## Scene matrix

| Scene | Text behavior | Why it matters |
|:--|:--|:--|
| PLAYER 1 | single-line label | name plates and damage-number style feedback |
| HP / MANA | multi-line layout | explicit newline and line advance |
| BLOOM | HDR tint (rgb > 1) | text participates in the camera bloom pass |
| HIDDEN | opaque cube in front | depth testing and world-space occlusion |

The font source is the license-safe baked DejaVu Sans Mono payload under
forgeax-engine-assets/dejavu-fonts/. Its atlas PNG and font pack are delivered
through the normal importer, GUID, catalog, and runtime loader chain.

## Evidence and falsifiers

- scripts/smoke-dawn.mjs requires 60 frames, four GlyphText entities with
  generated MeshFilter/MeshRenderer, zero app errors, and visible MSDF pixels.
- FALSIFY=atlas-empty pnpm --filter @forgeax/hello-text smoke must report
  FALSIFY atlas-empty PASS - 0 text meshes baked, proving the smoke is
  sensitive to the font path while keeping the falsifier itself green.
- Browser evidence should include a non-black canvas screenshot, zero page and
  console errors, and successful /pack-index.json plus font DDC requests.

The four-scene gallery is a focused renderer/asset oracle. templates/game-3d
uses the same public FontAsset/GlyphText contract only where text changes an
existing gameplay owner (for example, the pooled hit-score label); it does not
add a second static text scene.

## Source map

| Path | Purpose |
|:--|:--|
| src/main.ts | App bootstrap, FontAsset loading, camera, light, cube, and scene setup |
| src/text-scenes.ts | Shared scene data and public Transform + GlyphText spawn shape |
| scripts/smoke-dawn.mjs | Headless Dawn verification and falsifier |
| vite.config.ts | Shader manifest and DejaVu Pack-v2 asset roots |
