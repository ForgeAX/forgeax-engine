# Native Ray Query triangle Tauri spike

This app is the thin desktop consumer of `packages/rhi-wgpu-native`. It creates a WebView control
window and a separate native viewport window. The viewport is rendered by a Rust-owned wgpu device
using Metal on macOS, DX12 on Windows or Vulkan on Linux; it never uses `navigator.gpu`, an HTML canvas, or
`wgpu-wasm`.

## Commands

```sh
pnpm --filter @forgeax/native-ray-query-triangle-tauri verify:native-owner
pnpm --filter @forgeax/native-ray-query-triangle-tauri test:native
pnpm --filter @forgeax/native-ray-query-triangle-tauri test:conformance-report
pnpm --filter @forgeax/native-ray-query-triangle-tauri build:desktop
pnpm --filter @forgeax/native-ray-query-triangle-tauri smoke:desktop
pnpm --filter @forgeax/native-ray-query-triangle-tauri verify:report
```

`smoke:desktop` is strict: it requires the platform-native adapter exposing
`EXPERIMENTAL_RAY_QUERY`. `smoke:desktop:unsupported` exists only to verify the structured unsupported
path on a machine without that capability; it is not hardware acceptance.

On Windows, run `smoke:desktop` from the logged-in user's interactive desktop.
A Session 0 service runner has no usable presentation context and may fail at
initial `Surface::configure`; use the native owner's offscreen conformance there.
This desktop requirement does not add Graphics Tools or Dawn to source setup.

The strict smoke launches the artifact produced by Tauri, verifies the barycentric triangle, runs
100 offscreen resizes, minimizes and restores the native window, then rebuilds the same TLAS with no
instances and proves that the triangle disappears. It writes schema-validated lifecycle facts plus
`frame.png`, `frame-resized.png`, and `frame-restored.png` for the conformance runner to import.
