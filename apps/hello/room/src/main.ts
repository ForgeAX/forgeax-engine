// apps/hello/room - thin shim retained for backward referrers
// (feat-20260531-hoist-onerror-gate-to-apps-shared-and-fix-hello-room M3 /
// w6). The demo entry + scene recipe + renderer.onError wiring now live in
// `index.ts` (the importable SUT entry consumed by the onerror-gate browser
// test). index.html loads `/src/index.ts` directly; this shim re-exports the
// same bootstrap so any historical `/src/main.ts` referrer still works.
export { bootstrap } from './index.ts';
