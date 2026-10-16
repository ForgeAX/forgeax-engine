# Tauri native host qualification

Contributor-only Linux X11 fixture: one Node process runs the ordinary TypeScript
World/Renderer and a real Tauri `App::run_iteration`. Tauri owns one top-level
window. Two native GTK children keep the GPU drawable and bounded HTML/CSS panel
independent, so WebKit's paint cannot overwrite the native Surface. Wry owns the
panel; a real mouse click sends ordered POD to Node, moves the World entity and
returns state to the DOM.

The addon links `rhi-wgpu-native/node` as an `rlib`. `TauriWindow.takeNativeWindow()`
lends its drawable once to the existing opaque N-API `NativeWindow`, which
`bindNativeWindow()` adapts to the ordinary canvas/RHI shape. Surface, device,
queue, texture expiration and receipt completion remain in that existing RHI
implementation. There is no second RHI, Rust World, per-draw IPC, transferred
pointer or readback presentation. RHI retains the GTK widget and its parent until
Surface retirement; dropping the UI controller cannot invalidate that borrow.
Native close requests are prevented until the caller retires the Renderer and
closes the Surface. Explicit fixture shutdown checks that all windows are closed.

This is an executable integration fixture, outside the published SDK and default
build. The generated `forgeax project build --target tauri` still uses the browser
distribution. This fixture does not qualify installation, libnode embedding,
Wayland, macOS, Windows, interactive resize/DPR transitions, input/audio assembly
or unrestricted WebView content. WebKit's default GC signal overrides Node's
SIGUSR1 handler here; inspector-on-signal behavior remains unqualified. The local
test page has a narrow controlled action stream; it is not a public IPC service.

Requirements: Node 24, Rust, GTK 3/WebKitGTK 4.1 development libraries, X11 and a
working Vulkan driver. The locked Tauri/Wry versions are part of this fixture.
Use the calling/main thread, and yield to libuv between event iterations. Tauri
owns the GUI loop; its bounded GTK drain also services the embedded Wry child's
layout and frame clock before each Surface frame.

From the checkout root:

The build launcher generates the required 32 × 32 RGBA Tauri icon from source,
using the checkout's `pngjs` development dependency. The icon is disposable and
is not tracked or fetched from an asset repository.

```sh
pnpm --filter @forgeax/engine-rhi-wgpu-native build
node packages/devkit/scripts/fixtures/tauri-native-host/build.mjs
# Reuse apps/hello/triangle/dist/shaders/manifest.json; build hello-triangle only if missing.
GDK_BACKEND=x11 node packages/devkit/scripts/fixtures/tauri-native-host/smoke.mjs
```

Click **Move native triangle** when the panel appears. The fixture completes 64
Renderer receipts, checks the 60-frame path, unrelated submission, stale surface
texture/view rejection, resize, device recovery, close and recreation. It also
checks that the drawable cannot be borrowed twice and a closed WebView rejects
evaluation. `node --expose-gc packages/devkit/scripts/fixtures/tauri-native-host/lifetime.mjs`
checks that UI-controller GC preserves the borrowed drawable, unclaimed UI GC
closes its window, and native-owner GC releases the Surface before the window.
Run it with the same X11/Vulkan environment. `NATIVE_WINDOW_EVIDENCE` chooses a fresh report directory;
`NATIVE_TAURI_ADDON` overrides the built fixture addon. The build uses its own Cargo
target directory: sharing one directory with the standalone RHI addon can collide
with that crate's different root/dependency N-API build artifacts. A dedicated
`CARGO_TARGET_DIR` may be supplied.

For an automated real mouse and screen check, install Python Pillow, Xvfb and
xdotool, select the desired Vulkan driver in the environment, then run:

```sh
GDK_BACKEND=x11 NATIVE_WINDOW_EVIDENCE=artifacts/tauri-native-host \
  dbus-run-session -- xvfb-run -a -s '-screen 0 1024x768x24' \
  python3 packages/devkit/scripts/fixtures/tauri-native-host/verify.py
```

`verify.py` expects the fresh Xvfb desktop without a window manager. It captures
real X11 pixels, checks the green CSS button and native triangle together at all
five checkpoints, verifies triangle movement and the two sibling drawables under
the same top-level, and saves the two interaction anchors. It inspects later
checkpoints without duplicate screenshots and retains the first failed image. `report.json` records Renderer/lifecycle evidence and `run.json`
records native window trees and `visibleAcceptance`; both must pass. Screen
capture is observation only and is never an input to presentation.
