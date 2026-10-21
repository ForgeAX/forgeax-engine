# Game3D Sun parameter recovery

Captured on 2026-10-20 in sandboxed Chrome on Linux with the SwiftShader WebGPU
backend, at 1680 × 1100. These are actual View screenshots, not mockups.

The project began with the existing Game3D `assets/scene.pack.ts`: no parameter
array and an imported package ID. With its Scene and Parameters panel already
open, the source was replaced with literal `sunColor` and `sunIntensity`
descriptors. The file kept the same package UUID and output GUID.

- `parameters-added.png`: fields appeared automatically in 115 ms in this sample.
  The page document and Scene target were retained; no refresh or Generate was used.
- `live-sun.png`: RGB `[0.1, 0.35, 1]` and intensity `6` immediately changed the
  existing Sun and rendered lighting. The source still contained the saved defaults.
- `saved-sun.png`: Save wrote only parameter defaults to the TS source. Closing
  and reopening the draft restored those values. No uncaught page errors occurred.

The timing is one file-write-to-visible-control observation on a shared host,
not a latency guarantee. The template retains its original warm sunlight defaults.
The generation badge describes the draft's generation state; runtime fields do
not require Generate.

The Engine's maintained `verify-pack-authoring.mjs` journey covers failed legacy
opens followed by external source repair, immediate edits, Generate, Save/reopen,
JSON, external additions, conflicts and preview retirement. The focused DevKit
regression rejects generator execution and Catalog enumeration during recovery.
