# RHI debug Viewer fixtures

The Viewer consumes one strict v7 .rhitape artifact. No second artifact or
committed binary is part of this directory.

Generate a temporary local fixture with:

    node apps/rhi-debug-viewer/fixtures/generate-fixture.mjs [outDir]

The Browser smoke scripts generate the same artifact in os.tmpdir() and upload
it through the single-file input. The v7 decoder, TapeIndex, and FrameModel
remain owned by @forgeax/engine-rhi-debug; fixture code only supplies test data.

Visual evidence targets are:

- viewer-single-tape-loaded
- viewer-real-texture-inspection
- viewer-shader-preview
- viewer-shader-error
- viewer-no-webgpu-degraded

Each Browser run can write structured evidence by setting
FORGEAX_VIEWER_EVIDENCE_PATH and screenshots by setting
FORGEAX_VIEWER_SCREENSHOT_DIR. Pixel availability is reported separately from
the structural Viewer verdict; no-WebGPU is a local recovery state.

Every evidence row keeps `artifactDigest`, `selectedWorkIndex`, `backend`,
`capability`, and `provenance` together. Shader rows are viewer-private and may
only report `preview` after a selected raster module validates and compiles.
Compute, incomplete, unsupported, and error paths report `preview-*` with no
success canvas. Fixture generation never writes a tape to the repository or
creates a second artifact identity.

Browser smoke output also contains a `coldStart` transcript. Each step has
explicit `input`, structured `output`, and the same `{ kind: 'rhi-tape', digest,
source, path }` ArtifactRef: capture, summary, inspect, readback, preview, shader-error,
and layout-recovery. `workIndex`, `eventIndex`, and `passIndex` are the stable
coordinates. Recovery rows preserve the error code and next action; a missing
WebGPU capability never becomes a success canvas or a second artifact.
