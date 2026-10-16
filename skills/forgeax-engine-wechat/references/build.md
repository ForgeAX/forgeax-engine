# Ordinary project builds

Use the same project and PluginAsset roots as browser development. The DevKit
producer owns target bootstrap, native WASM/glue, static Pack programs, fonts,
shaders and the complete artifact inventory. Do not reconstruct these files from
separate successful probes.

```sh
forgeax project build --target wechat --appid wx0000000000000000
```

Run from the project or use the CLI's existing project-root option. Supply the
user's AppID only in local build parameters. `forgeax project build` tool discovery
exposes the same `target` and `appid` fields for structured tool calls. Read the
[DevKit contract](../../../packages/devkit/README.md) for build options.

| Output | Ownership |
|:--|:--|
| Root `game.js` | Starts the declared native subpackage load; native load executes its entry |
| `game.json`, `project.config.json` | Mini Game target, orientation, subpackage root and local AppID |
| `payload/game.js` and relative JS chunks | Complete native CJS module closure; no cross-subpackage `require` |
| `payload/**/*.br` | Actual Brotli transport files for WASM and non-JS resources |
| `forgeax-dist.json` | Exact file identities, `target: "wechat"`, and physical Pack/shader artifact URLs |

The Host reads logical Pack URLs through a package fetcher with `root: "payload"`
and `encoding: "br"`. Resource owners verify decompressed identities; WASM owners
retain their complete initialization protocols. Main-package code must not call
`require('./payload/game.js')` after loading: DevTools already executes that entry.

The producer checks actual on-disk main and total bytes against 4 MiB / 20 MiB.
On 2026-10-11 official `auto_preview` rejected a 22,101 KB source package with
`source size 22101KB exceed max limit 20MB` (code 10), despite the general
code-package documentation's 30 M total. Use the preview-admitted budget for
deliverable builds. The ordinary `verifyDist` path checks the native entry,
configuration, physical artifact hashes and absence of undeclared files. These
are build checks; official compilation and actual game execution remain separate.
Recheck the [current official limits](sources.md) before changing the budget policy.

Vite owns the bundle's syntax lowering and minification. The common project
config keeps `setting.es6`, `setting.enhance` and `setting.minified` false;
`es6` and `enhance` remain paired as required by the installed project-config
skill. DevTools 2.02.2610092 rejected optional chains and logical assignment in
an `esnext` bundle; enabling its second compiler did not admit those constructs.
The WeChat bundle uses Vite's `chrome70` syntax capabilities to lower optional
chains, nullish coalescing, logical assignment and class fields while preserving
native BigInt. This is a syntax selection, not a claim about the phone's browser
version. Keep the browser target independent. DevTools 2.02.2610092's bundled
Babel 7.24.6, using its official `chrome53` / `ios8` preset targets, reproduced a
native initialization failure on the emitted bundle: it hoisted a loop-local
context variable into the async callback and shadowed the captured Host parameter
before any GPU frame. Disabling this second pass let the simulator initialize
wgpu. Verify both official compilation and real native startup after producer
changes; a syntax test or successful preview upload alone is not a pass.

Vite also selects each native payload owner through the same resolution as its
JavaScript. A `project engine use-local` consumer may retain an older installed SDK;
its WASM and provenance must still come from the selected local source. Compare the
emitted decompressed bytes to the bundled native factory's identity before transfer.

The published `wgpu.provenance.json` describes the generated native binding
(`wgpu-native-binding/1`); its `canonical` field is the original
`wgpu-wasm-provenance/1` package receipt. Compare decompressed WASM bytes directly
with the selected package, then verify the canonical receipt and generated native
binding receipt through `packages/wgpu-wasm/scripts/native-build.mjs`. Comparing
the entire native receipt directly with `pkg/provenance.json` incorrectly reports
a mismatch. Retain the native generator/initializer/glue hashes as well as the
canonical source key. Native and WASM/WebGL builds share `third_party/wgpu`;
there is no separate WebGL source checkout.

When changing a maintained native fork, a published WASM archive and pushed
feature branch do not establish gitlink admission. The contributor gate
`python3 scripts/forgeax/check_submodule_pins.py --repo .` checks reachability from
the maintenance branch declared in `.gitmodules`. Integrate verified source into
that branch while preserving the pinned commits; do not change the declaration
to a temporary feature branch. A merge whose complete tree equals the already
tested source preserves its native artifact identity and needs no new WASM build.
See [source admission](../../../scripts/ci/README.md#cross-platform-host-build-inputs).

Copy the exact verified output to a dedicated project directory on the DevTools
machine, then follow [Simulator](simulator.md). Incremental transfer is sufficient
when source artifacts are unchanged. A removed or renamed published file must also
disappear remotely so old JS chunks cannot influence compilation. Restrict mirroring
to the task's generated project directory; preserve credentials and unrelated games.
Keep the original ZIP and manifest authoritative after import: DevTools can add
project metadata and default configuration fields. Preserve and verify these
[IDE changes separately](verification.md#account-for-devtools-project-metadata).

Keep the build manifest with screenshots, native errors and completion receipts.
`[forgeax.wechat.completed]` is emitted by the ordinary Host after 60 ready Renderer
completions with the game activated. Confirm the main-screen pixels and actual
input consequences as well; a successful build or subpackage callback is insufficient.

## Recover at the owning boundary

| Failure | Recovery |
|:--|:--|
| Node built-ins or browser WASM enter native JS | Fix the dependency owner's conditional entry or generated factory; rebuild normally |
| Obsolete compact shader publication | Re-prepare through the matching shader producer; never omit variants to suppress reader errors |
| Generated WASM differs from its provenance | Rebuild/fetch the exact owner bundle; never copy one binary into unrelated glue |
| A new SDK project's tests report `No test suite found` for installed skill scripts and their Agent aliases | Use the DevKit test-discovery fix: `project test` reads the skill installation manifest and excludes its actual source directories and matching links. Preserve the tool tests, adjacent game tests and the project's own Vitest exclusions. |
| SDK Source Preview stays queued while its parent holds the same GPU lock | Follow the [SDK consumer entry](../../../scripts/ci/README.md#sdk-consumers): the normal verifier admits individual GPU owners, while Source Preview retains its internal template leases. Do not add a whole-consumer GPU lock. Retain the process/lock evidence and use the owning process's cleanup; a completed source build does not prove template rendering. |
| Missing subpackage root despite files being present | Verify the remote directory, then follow the documented project-window file-tree recovery |
| Surface size exceeds requested device limits | Inspect adapter and device limits at RHI initialization; retain the actual viewport/DPR while identifying the owner |
| Main or total package exceeds budget | Inspect the artifact inventory, reachable modules and duplicate payloads; measure actual compressed output |

The current package build does not establish phone, Worker-realm or Tauri support.
Keep each platform and execution-mode result explicit in the verification record.
