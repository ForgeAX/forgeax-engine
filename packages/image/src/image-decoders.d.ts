// Ambient module declarations for the upng-js (PNG decoder) + jpeg-js (JPEG
// decoder) dependencies. Both packages ship without shipped .d.ts files
// (upng-js has no @types; jpeg-js has @types/jpeg-js but we cast through
// local interfaces to match the subset the Node path uses).
//
// The import sites live in src/image-decoder-node.ts (T-M2-05) and are
// lazy dynamic imports (`await import('upng-js')`) so browser bundles
// tree-shake them out; tsc needs the module name to resolve nonetheless.
//
// For each module we declare only the surface consumed by the Node decoder;
// widening is handled in consumer site via explicit interface casts.
//
// Anchors:
//   - Open Q-3 option a (plan-strategy section 2.4): runtime decoupled from
//     decode APIs; the d.ts + lazy decoder code + upng / jpeg deps were
//     migrated from packages/runtime/src/ to packages/image/src/ in
//     feat-20260515-learn-render-getting-started M2 T-M2-02.
//   - AC-15 grep gate: packages/runtime/src/ contains zero hits of
//     `image-decode` / `decodeImage` after this migration; CI fail-fast
//     enforces the disk-to-memory pipeline isolation (charter P5).

declare module 'upng-js';
declare module 'jpeg-js';
