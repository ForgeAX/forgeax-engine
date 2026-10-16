# Export a simulator RHI capture

Use the ordinary recorder-enabled game and the existing
[RHI Debug workflow](../../forgeax-engine-rhi-debug/SKILL.md). This helper exports
one `captureFrame()` artifact; it neither replays it nor creates another capture
after a transport failure. Keep the publication identity and original failing
scene with the resulting tape.

Use [window transfer](#native-window-transfer) for transport,
[failure and cleanup](#failure-and-cleanup) for partial evidence, and
[seed inspection](#inspect-seed-data-and-ordinary-ui-work) for replay differences.
Keep the [qualified scope](#verification-scope) separate from live rendering.

## Native window transfer

For a simulator tape that is available through the DevTools host filesystem:

```sh
python3 skills/forgeax-engine-wechat/scripts/capture_rhi.py \
  --config /private/machine.json --project /absolute/devtools/game \
  --native-file --native-root /explicit/devtools/sandbox-subtree \
  --out /new/local/capture-directory --timeout 600
forgeax rhi summary \
  --artifact /new/local/capture-directory/frame.rhitape --json
```

`--native-file` and `--native-root` are required together. Discover the current
simulator sandbox on the DevTools machine; `wx.env.USER_DATA_PATH` can be
`http://usr`, which is not a host path. The observed Mac mapping is beneath
DevTools Application Support, under
`WeappSimulator/WeappFileSystem/<account>/<appid>/usr/`. Supply an explicit
subtree, never `/`; keep account-specific paths in private evidence.
The helper finds the random capture filename exactly once within that subtree,
then reuses the confirmed path for subsequent windows. The configured host needs
Python 3; it is invoked through the existing `wechatide.py` local/SSH transport.

One game-realm export state retains the original artifact and its iterator:

1. Native `writeFile` / `appendFile` writes at most **1 MiB** to the task file,
   in buffers of at most 256 KiB. Status returns only offset, length, generation,
   total artifact size, canonical digest and the task path. No binary bytes
   travel through the official JSON tool channel.
2. The host opens the exact regular file without following its final symlink,
   verifies size and file identity before and after reading, and streams that
   window with a SHA-256 receipt. The local helper independently checks length
   and SHA, appends to `frame.rhitape.partial`, and flushes it to disk.
3. Only then does it ACK that offset and length. The game state unlinks its exact
   task file before writing the next window. An unacknowledged window stays
   unchanged; retrying the last ACK never deletes or skips the next window.
4. After the final ACK and confirmed completion, the helper checks the whole
   tape against the original `artifact.digest`, then exclusively publishes
   `frame.rhitape`. `summary.json` contains its path, size, digest, generation,
   window count, `copiedAndVerified: true` and release outcome.

The native file holds only the current window. Do not open it as a complete tape
or close the project during transfer. No separate copy/delete command is needed.
The one-window bound concerns temporary native **file bytes**, not artifact
memory, snapshot readback, the sandbox's existing contents or available quota.
A sandbox with less than one window of free space can still return a structured
write error; the helper does not clear unrelated caches or switch to a slow
large JSON transfer.

## Failure and cleanup

The total `--timeout` includes capture, native reads, local hashing, ACKs and
final digest validation. The App snapshot has its separate original 120-second
bound (`min(120000, timeout * 1000)`); extra transfer time does not extend that
snapshot. Inspect structured progress on snapshot failure: `resource-hash`
reports seeding/hash work, not proof of a GPU wait. A completed buffer mapping
alone does not establish that its hash or the complete snapshot finished. A host read is limited to the remaining deadline or
60 seconds, whichever is shorter. Status, a stable window read and the last ACK
can retry up to three times; **start is attempted once**. These retries transfer
the same artifact, not another frame. Cleanup has a separate bounded 30-second
allowance so an expired export can still release its resources.

Failure retains private official-call evidence, host receipts and any partial
local bytes. `frame.rhitape` is not published on copy or digest failure. The
`finally` release aborts capture, waits for outstanding native write/unlink work
and removes only its task file. A failed unlink retains its game-realm owner so
another release retries cleanup; missing state must not hide a known failed
deletion. Keep `releaseError` and the exact task path if cleanup still fails.
Do not mistake `copiedAndVerified: true` for overall success when
`released: false` remains.

For small captures without a host filesystem route, omit both native flags.
The existing 16 KiB base64 path remains bounded beneath the observed official
stdout truncation limit. It is an explicitly selected small-transfer mode,
not an automatic fallback for native failures.

`--max-bytes` bounds accepted tape size. `--seed-max-resource-bytes` limits each
historical resource seed independently; it is not a total capture bound.
Zero produces structural evidence. Inspect `unseededResources` and prove
initialization before recorded reads before using replay pixels, especially
when a cached UI frame contains only `screen-ui-composite` and retains its
previous `ui-target` texture.

## Verification scope

The offline regressions execute the actual export JS and host reader. They
cover a multi-window artifact under a 1 MiB filesystem quota, withheld and
repeated ACKs, a short final window, replacement generations, release during
write/unlink, cleanup failure retention, real local subprocess transfer,
damaged bytes, changed files, total deadlines and exclusive publication:

```sh
node --test skills/forgeax-engine-wechat/scripts/test_rhi_capture.mjs
python3 -m unittest discover -s skills/forgeax-engine-wechat/scripts \
  -p test_capture_rhi.py -v
```

These establish transport and lifecycle behavior. Actual simulator acceptance
still requires one successful native transfer with matching whole-tape SHA,
confirmed release and useful RHI Debug inspection; replay or image equivalence
requires its own resource coverage and backend evidence.

The first real windowed simulator transfer on 2026-10-11 passed with a
23,779,374-byte tape, 23 windows, matching whole-file SHA-256 and confirmed
release. The same capture retained its UI texture and 14 shader sources; the
formal CLI agreed on 538 commands / nine passes / 81 works / 186 resources.
This qualifies transport. Subsequent replay exposed a sky/environment-lighting
difference, demonstrating why a verified file and an empty transport error list
must remain separate from visible replay acceptance.

## Inspect seed data and ordinary UI work

After transport succeeds, use `decodeTape` / `buildFrameModel` and compare the
result with the formal `forgeax rhi summary`. Derive resource identities,
view ranges and work indices from this capture; handles from an earlier tape
are not stable. Keep these checks distinct:

- **Seed bytes:** resolve `bootstrap.initialData` against decoded blobs and use
  RHI Debug's canonical `computeTextureLayout` for every array layer and mip.
  Check complete byte coverage, then record each slice's digest and nonzero
  count. A seed entry can exist while every cubemap face contains zero bytes.
  Nonzero data detects that failure; it does not prove the intended colors.
  Inspect suspicious fallback textures separately, including their actual
  descriptors and bound consumers. An unused zero texture cannot explain a
  draw that never binds it.
- **Unseeded reads:** prove an earlier explicit clear or complete write for the
  selected mip/layer/aspect or buffer range. A depth clear does not initialize
  stencil; `storeOp: discard` invalidates the stored contents. Account for
  dynamic buffer offsets and submission order. A draw or storage write is not
  proof of full coverage. Unsupported operations/ranges remain unknown, never
  an automatic pass.
- **UI work:** changed content exposes ordinary `ui-raster-*` pipelines before
  `screen-ui-composite`; a cached frame can correctly contain only the latter.
  Inspect their WGSL, bindings, targets and draw counts, then batch-read the
  composite's UI input and `color0` output. Compare the resulting images with
  the simulator screenshot. A structural capture cannot qualify retained
  texture pixels, and a replay's timing does not measure simulator performance.

For a replay mismatch, separate **snapshot readback** from **replay upload**.
The 2026-10-11 investigation found both: GLES cube readback left zero staging
bytes, and mapped WRITE buffers lost the JavaScript mapped view's changes on
unmap. The shared wgpu source is selected by
[`packages/wgpu-wasm/Cargo.toml`](../../../packages/wgpu-wasm/Cargo.toml), currently
`third_party/wgpu` (wgpu 30), shared with the native host. Older captures may refer
to the former separate `third_party/wgpu-webgl` pin; preserve their recorded identity.
Confirm this dependency chain and the loaded WASM digest before changing a
similarly named Rust source tree.

The formal CLI returns PNGs, image statistics and raw-byte digests. When a
backend comparison needs the original HDR values, preserve `ReplaySession`
`readAtWorks()` results before image conversion, using the same exported
`createCliRhiDebugOperationContext()` backend factory, `openReplay`, and
FrameModel-derived `workOutputs` / `bindingReadRequest`. Record each raw file's
format, dimensions, selected work, resource, provenance and SHA-256. Never use
a PNG conversion as a substitute for a raw `rgba16float` comparison.

The repaired simulator tape on 2026-10-12 contained 553 commands, 11 passes,
82 works and 209 resources, including UI raster and composite work. All 42
face/mip slices of its three bound environment cubes had complete nonzero
seeds; 130 conservative reads of five unseeded textures had prior explicit
initialization. A formal Dawn batch read recovered the sky, IBL and UI images.
Two unused 1×1 fallback textures still had zero seeds; their intended values
were not qualified by that result. This is resource and replay evidence,
not a simulator frame-rate result or a claim of universal seed correctness.
