# Engine Dawn Node carrier

Node consumers import `@forgeax/engine-dawn-node` directly. This physical package retains the official
`webgpu@0.4.0` `create`, `globals`, and `isMac` exports. Browser WebGPU remains owned
by the browser and does not use this Node carrier.

| Host | Provider | Native preparation |
| --- | --- | --- |
| macOS arm64 | Pinned Dawn with the Metal empty-compute timestamp patch | Host arm64 source build |
| macOS x64 | Same pinned source and patch | Host x86_64 source build; validation pending |
| Linux | Exact upstream `webgpu@0.4.0`, an optional peer named `upstream-webgpu` | Consumers opt in with `upstream-webgpu@npm:webgpu@0.4.0`; the workspace installs it as a development dependency |
| Windows x64 | Pinned Dawn with built DXC; GPU qualification pending | Host x64 source build |

## Build and installation

The public JavaScript and declaration exports point to checked-in `src` files, so
`--ignore-scripts` installations can resolve the carrier before a package build.
Installation has no native-build lifecycle hook. Ordinary `pnpm build` only
copies JavaScript and declarations into `dist`; `bun fx setup`, SDK initialization
and `pnpm build:engine` do not compile Dawn. Upstream dependency installation uses
its packaged prebuilt libraries, not a source compiler.

Dawn GPU tests and Node replay are explicit local opt-ins. On macOS or Windows,
prepare the native carrier before running them:

```sh
pnpm --filter @forgeax/engine-dawn-node build:native
pnpm test:dawn
```

Basic `pnpm test` / `pnpm test:unit` do not load this carrier. `pnpm test:all`
explicitly selects the complete CPU, Browser and Dawn acceptance surface.
Maintainer/CI GPU gates retain their full roster, completed-frame counts and
pixel oracles; nightly prepares this carrier in a separate explicit step.
Missing native output fails an opted-in GPU run rather than skipping the gate or
silently downloading source and compiling it.

macOS and Windows import their prepared host native library from
`dist/native/<platform>-<architecture>/dawn.node`; Linux uses the exact upstream
provider. An absent native output fails import rather than selecting another compiler.
It uses official node-webgpu commit `2f5fb632d9d9db9bcb3705bd868de69a6a2ae4e2`
and Dawn commit `c5d549e250b9225744929ae860b369cb4304a767`, verifies the checked-in
patch and all three changed source files, and builds the current host architecture.
Native binaries and build caches are generated and must not be committed.
The package's unit project excludes its generated `dist/` and root
`.native-build/` cache. Vendored WebGPU CTS specifications use their upstream
runner; they are not Engine unit suites. Ordinary package tests remain discoverable,
including tests under a nested directory with the same cache name.
The actual discovery regression belongs to this package's unit project; an empty
package population remains a failure in the maintained API runner. Native graphics
acceptance still belongs to the complete Dawn and 60-frame Smoke gates.

The Windows RTX 4080 / D3D12 qualification on 2026-10-09 reproduced FXC
`E_FAIL` while creating the Standard PBR deferred pipeline, both in hello-gi
and the ordinary visible-surface replay test. This installed upstream provider
forces a requested `use_dxc` toggle off: adding a portable DXC DLL does not
enable its compiled-out DXC route. A Windows source producer must build the
pinned Dawn with
[`DAWN_USE_BUILT_DXC=ON`](https://github.com/google/dawn/blob/c5d549e250b9225744929ae860b369cb4304a767/CMakeLists.txt),
retain its native DLL closure and provenance, and pass those same pipelines and
the original complete gates.
The Windows producer asks CMake to select the newest installed Visual Studio
C++ generator, targets x64, and enables built DXC. MSVC `/MP` compiles up to
four source files concurrently inside a project; MSBuild schedules one project
at a time so aggregate compiler concurrency stays capped by host parallelism.
It builds the official `dawn_node` target and copies
`dawn.node`, `dxcompiler.dll`, `dxil.dll`, and `d3dcompiler_47.dll` from the same
Release output, checks every PE machine type, and records every file digest.
Missing or altered DLLs invalidate the native cache. Source preparation checks
the same pinned revisions and patched source bytes as macOS.

Windows preparation requires Git, Python 3 (`python`), CMake 3.24 or newer that
supports the installed Visual Studio generation, Go, Visual Studio C++ Build
Tools and Windows SDK, plus network access for the pinned official
dependencies. The producer checks CMake, Go and Python before fetching source;
the CMake generator discovers installed MSVC and the selected SDK version. The
producer checks both registry views against actual D3D12/DXGI headers and passes
that admitted SDK root to Dawn and built DXC, so stale registry paths cannot
silently select another SDK. Windows producer caches
use `%SystemDrive%/tmp/forgeax-dawn-native/<input-key>` so MSBuild's generated
tracking paths fit its 260-character limit even in a deep project checkout.
Source integrity reads and patch application use the same local Git long-path
and LF policy as dependency preparation; global Git configuration is unchanged.
The earlier missing-toolchain and long-path failures remain retained. Current
MSVC/SDK admission and the pinned source build passed; GPU qualification remains
a separate gate.

Windows preparation keeps Git's long-path and LF checkout policy local to the
producer and its gclient children. It invokes the official gclient batch/vpython
entry without depot_tools self-update, preserving that tool's dependency spec.
It generates the official depot_tools `git.bat` template against installed Git;
gclient's Windows Git cache and direct executable parser both use that entry.
When reusing source with `FORGEAX_DAWN_NATIVE_SOURCE_DIR`, keep the source and
its Git metadata on a short path too; an alias does not shorten an existing
submodule's absolute Git metadata paths. Incomplete dependency checkouts are
not accepted as successful preparation.
The default vpython environment cache uses `C:/tmp/forgeax-dawn-vpython` (the
actual system drive replaces `C:`), avoiding MSIX AppData redirection and long
wheel paths; an existing `VPYTHON_VIRTUALENV_ROOT` is respected. Windows CMake
preparation fetches dependencies with `--nohooks`, using the installed MSVC/SDK
rather than Chromium's GN toolchain bootstrap.

macOS preparation requires Git, Python 3, CMake, Go, Xcode's compiler and SDK, and
network access for official pinned dependencies. Official depot_tools supplies Ninja.
The SDK comes from `xcrun --sdk macosx --show-sdk-path`, so the selected Command Line
Tools SDK and full Xcode installations use the same producer. An unavailable SDK fails
before source download; the native provenance records the selected SDK path.
SwiftShader is excluded from the macOS source preparation through official gclient
`custom_deps`; the Metal implementation and original test budgets are unchanged.

`FORGEAX_DAWN_NATIVE_SOURCE_DIR` selects an existing official source checkout for
local preparation; both pinned Git revisions and every patched source byte are
validated. `FORGEAX_DAWN_NATIVE_BUILD_DIR` selects its own CMake output directory.
`CMAKE_BUILD_PARALLEL_LEVEL` can cap native compilation below the platform default; use `1` for serial preparation on a shared host. Invalid or non-positive limits fail before compilation.
Neither option substitutes another native library. The producer records a derived
input key and binary digest beside the host native output for cache admission.

## Verification boundary

- [ ] Ordinary canonical provider import bound to this package's native library.
- [ ] Original timestamp regressions and relevant completed 60-frame smoke.
- [ ] Complete Engine hello/learn-render, browser, and Dawn gates.
- [ ] Supported-platform release and SDK consumer closure.

The earlier patched 0.6.2 diagnostic passed four timestamp cases. It does not
establish acceptance of this default 0.4 carrier, image quality, or frame rate.
