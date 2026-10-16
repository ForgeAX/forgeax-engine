// Negative fixture (w7 case d): a file literally named `image-decoders.d.ts`
// regrows under `packages/runtime/`. The Path (a) gate must FAIL on the
// legacy-filename clause; the file content can be anything (including
// empty) -- the rejection is by name alone. Placed under `src/` rather
// than `dist/` so the fixture is committable (root .gitignore excludes
// `dist/`).
export {};
