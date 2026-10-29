# Pack authoring browser evidence

Captured from the real View and Engine by
`tools/view/scripts/verify-pack-authoring-integration.mjs` in paired Engine CI
checkout, using sandboxed Chromium and software WebGPU. These are UI captures,
not mockups. The probe also reads submitted frame pixels and actual World fields.

- `parameters-ui.png`: separate generation and runtime groups.
- `live-ui.png`: material edit previews before Save; source bytes are unchanged.
- `inspector-ui.png`: the light color edits the same Engine draft.
- `new-parameter-ui.png`: an external TS edit adds a new exposed field.

The full journey also verifies explicit generation, save/reopen, direct JSON,
conflict rejection, and draft retention after preview retirement. One local run
completed 100 sequential live edits in 751 ms (median 2.60 ms, P95 6.60 ms).
These are transport round-trip timings on a shared Linux host, not GPU frame
times or a performance guarantee. Dedicated tests reject workspace/Catalog scans
and complete workspace publications on the live path.
