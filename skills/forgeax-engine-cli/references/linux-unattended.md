# Linux unattended game validation

Read `/etc/os-release`, `id -u`, `$DISPLAY` and the first failed command before
changing a test image. TencentOS is not Ubuntu: select the package manager from
the observed OS. A missing display, missing GPU, failed install and failed game
startup have different owners.

## Prepare writable command state

Run Chromium as an unprivileged user with usable user namespaces or a trusted
Chrome sandbox helper. Keep Chromium sandboxing enabled. Xvfb supplies a display;
it does not repair a root/sandbox conflict.

For a disposable batch job with read-only home or `/run/user/<uid>`, allocate
job-owned directories on a writable filesystem before SDK initialization:

```bash
export XDG_DATA_HOME="$PWD/.test-env/data"
export XDG_RUNTIME_DIR="$PWD/.test-env/runtime"
mkdir -p "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
```

`XDG_DATA_HOME/ForgeaX/operations` stores command receipts. `FORGEAX_HISTORY_DIR`
overrides that history root. `XDG_RUNTIME_DIR` also affects pnpm's operation locks;
changing only the pnpm store cannot repair a read-only runtime lock directory.
Keep job state outside shipped assets and SDK payloads. Preserve the pinned pnpm
version and frozen lockfile; never write a shim that reports a skipped install
as successful. Re-run the failed real command and retain its exit status.

A target directory may contain `@`, spaces or Unicode when `project new` receives
a legal explicit `--id`, for example `project new '../case@forgeax-run' --id case
--template game-3d`. Without `--id`, the basename must itself be a valid project ID.
Do not create elsewhere and rename an installed project to evade validation.

## Select the browser presentation

| Intent | Route | Linux display requirement |
|:--|:--|:--|
| Unattended software validation without X11 | `forgeax dev start --headless true --backend software --json` | None; explicit headless capture does not start Xvfb |
| Headed compositor capture without a monitor | `forgeax project capture --backend software --json` | CLI starts Xvfb when `DISPLAY` is absent; Xvfb must be installed |
| Hardware performance acceptance | Explicit `--backend hardware`, requested viewport/DPR and workload | Qualify the actual adapter/driver and completed-frame window |

For a one-shot unattended capture use `forgeax project capture --headless true
--backend software --require-ui --output artifacts/capture/game-ui.png --json`.
The persistent session API accepts the same `headless: true` option. A physical
monitor is not required. Absence of DISPLAY does not imply absence of a GPU:
on a GPU host, use `--headless true --backend hardware` and qualify the actual
adapter; never downgrade a hardware benchmark merely because X11 is absent. Software capture can verify startup, interactions and
pixels; it cannot qualify a physical-GPU FPS target.

Install Chrome/Playwright Chromium and its system libraries. For the default
virtual headed route also install Xvfb and the software Vulkan driver:

```bash
# Ubuntu/Debian image preparation
sudo apt-get update
sudo apt-get install -y xvfb xauth mesa-vulkan-drivers

# TencentOS 4 / compatible RPM image preparation
sudo dnf install -y xorg-x11-server-Xvfb xorg-x11-xauth mesa-vulkan-drivers
```

Use the pinned SDK Playwright version for browser provisioning. Playwright's
`install-deps` distro auto-detection is not a TencentOS support guarantee; use the
image's package manager for missing libraries. `--browser /absolute/path/to/chrome`
or `FORGEAX_BROWSER_EXECUTABLE` selects an existing browser. Inspect missing-library
and sandbox diagnostics before retrying. Do not disable sandboxing.

## Preserve the acceptance boundary

Source preparation can cook a cold shader/Pack closure before opening the browser.
Inspect `dev status` and `.forgeax/dev.log` to distinguish preparation from App
startup. `package.json#forgeax.startupTimeoutMs` configures both waits (`null`
disables deadlines); keep the underlying cause and verify a fresh ready session.
A visible fatal is failed startup even without a browser console exception.
For contributor Dawn tests on TencentOS, use the maintained `pnpm ci:graphics
setup` route: system Mesa alone may lack the required Vulkan capabilities. This
is separate from Chrome's SwiftShader capture lane. Run native acceptance through
`pnpm ci:graphics -- pnpm test:dawn`: the maintained suite prepares verified
shared shader inputs before individual tests and owns the native test heap
budget. Calling raw Vitest or the internal gate runner omits that preparation;
cold `forgeax:shader` work before an adapter or completed frame is startup work,
not GPU frame time. On constrained software-rendering hosts, keep one active
preview/test until measured CPU and resident memory justify concurrency, and
retire its live owner before starting the next workload.

After environment repair, run the same authored project and actual browser
interaction. Retain startup/App/browser/GPU errors, backend/adapter, viewport,
PNG and capture JSON. Build/unit success cannot replace a failed browser run.
Report “implementation built; runtime acceptance blocked” until that path passes.
An unsupported capability ends with the inspected entry points and unsupported
status; an unchanged template preview is not its demo.

For physics cases, test sustained platform standing/reversal/jump/removal,
first-person self-mesh visibility and real dynamic-body displacement. For camera
cases, exercise the requested drag or pointer-lock gesture inside the actual
embedding and check focus. For lighting/flicker, follow RHI Debug with a real
failing frame. For performance, preserve actor/contact accumulation and quality,
measure completed frames plus CPU/GPU owners, and report callback/Update counters
only as diagnostics. Never remove the requested load to claim the regression fixed.
