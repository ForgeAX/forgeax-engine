# Actual WebGL shader sources

Use this collector after a real frame has an independently verified one-to-one
GL/RHI alignment. It reads the actual `getShaderSource` bodies from the running
context, and separately reads `WEBGL_debug_shaders.getTranslatedShaderSource` when
the driver exposes it. Translated output is not assumed to be GLSL.

The input is a prepared [draw omission](performance.md#causal-draw-omission-on-an-aligned-live-frame) plan for the confirmed
publication. Its source hashes are provenance, not a new tape decoder or proof that
two observations have identical pixels. Existing `FrameModel.workIndex` values
remain authoritative. Program ordinals are assigned by first aligned draw use.

Read [preparation](#prepare-the-verified-frame-plan),
[host collection](#collect-through-the-official-host-runner),
[bounded protocol](#bounded-game-realm-protocol),
[export and cleanup](#export-and-release), and [qualified scope](#qualified-scope)
as needed. Empty translated output remains missing driver-lowering evidence.

## Prepare the verified frame plan

Prepare on Linux, choosing all programs by default:

```sh
node skills/forgeax-engine-wechat/scripts/shader_sources.mjs \
  --plan VERIFIED_OMISSION_PLAN_JSON \
  --out NEW_PREPARED_DIRECTORY
```

Add `--programs 7,8,9,10,11` to collect only those programs. All frame operations and
program bindings are still checked. The output is `install.js` (a self-contained
function expression) and `plan.json`. It refuses to overwrite an existing directory.

## Collect through the official host runner

The reusable host runner uses the existing private `wechatide` config and official
evaluation transport. Point it at an already active project and an explicit unique
canvas selector:

```sh
python3 skills/forgeax-engine-wechat/scripts/collect_shader_sources.py \
  --config MACHINE_CONFIG_JSON \
  --project ABSOLUTE_ACTIVE_PROJECT_PATH \
  --prepared PREPARED_DIRECTORY \
  --canvas-selector CANVAS_SELECTOR \
  --out NEW_COLLECTION_DIRECTORY \
  --deadline 300
```

The selector is evaluated in `GameGlobal.document`; this mode reads the receipt from
`GameGlobal.__gameContextWindow.__forgeaxGameInspection.renderer()`. For another
binding, replace `--canvas-selector` with `--bindings FUNCTION_SOURCE_JS`: that file
must contain one JavaScript function expression returning `{canvas, readReceipt}`.
The runner does not open, import or close projects.

It installs once, polls the small summary, batches program metadata and draw rows,
and reads selected source bodies in pages of at most 4096 UTF-16 code units. Each
read may retry the exact request up to three attempts, with its original offset;
it never reinstalls after a lost response. It validates page identity, offsets and
complete body byte counts. Metadata for unselected programs is retained. The default
300-second overall deadline reserves up to 15 seconds for cleanup, and every path
after an installation attempt tries to release only this runner's probe instance.
A temporary owner marker on that instance protects another caller's existing probe.

Successful transfer **and** successful cleanup produce `assembled.json`. Failures
produce `assembled.partial.json`, including any unfinished source prefix, and never
publish the success filename. `result.json` reports the outcome; individual official
calls retain their own structured artifacts. A collector `partial` result preserves
available bodies and missing-source metadata but gives a nonzero runner exit. The
runner uses only the Python standard library plus the existing `wechatide.py` helper.

Pass `assembled.json` to the Node exporter shown below. The remaining API details
also support custom callers using the same bounded collector.

## Bounded game-realm protocol

Release any draw-omission probe first. Inject the installer through the existing
official evaluation transport with the actual canvas and renderer receipt reader:

```js
install({
  canvas,
  plan,
  readReceipt: () => inspection.renderer(),
});
```

`install` is the function expression from `install.js`; `plan` is the parsed JSON.
Do not assume a canvas selector, project path or AppID. This operation installs
`globalThis.__forgeaxShaderSourceProbe`; it does not open or close the project.

The collector first waits for the current fence. Additional fences before the next
`clear(256)` are counted as prefix fences: HAL submission and queue completion can
each create one without another frame starting. It then observes one natural frame
from `clear(256)` through its fence, forwarding every original call. During capture
it tracks only draw/clear arguments and `useProgram` handles: no GL getters or GPU
queries run. Every operation must match the verified plan, and every actual program
handle must map one-to-one to the aligned pipeline. At the fence it restores all
methods. A deferred task then reads shader attachments, stages, original sources
and optional translated sources, one program per task. It never compiles a shader.

Poll the small summary until `phase === "done"`:

```js
globalThis.__forgeaxShaderSourceProbe.report()
```

`complete` means all selected original sources were returned; optional translation
absence is reported separately. `partial` preserves explicit source unavailability.
Other terminal statuses preserve failure evidence and are not a successful capture.
The summary records frame/fence/restoration times, publication identities, generation
and device identity, and retained-handle count. Collection is bounded to 30 seconds,
32 programs, 2 MiB per source and 16 MiB total source text. JavaScript cannot preempt
a single synchronous driver getter; the deadline is checked between tasks and calls.

Read metadata and draw correspondence using separate small evaluations:

```js
probe.program(ordinal)          // 1 through report.expectedPrograms
probe.readDraws(offset, count)  // default count 16; follow nextOffset
```

For each selected program, each `vertex`/`fragment` shader and each source kind whose
metadata says `availability === "available"`, fetch its full body:

```js
probe.readSource(ordinal, stage, kind, offset, count)
// kind: "original" or "translated"; default count 2048, maximum 4096
```

Append `text` and use returned `nextOffset`; offsets and `totalChars` count UTF-16
code units, not host-language Unicode characters. Pages do not split surrogate
pairs. Retry `page-too-large` or `page-too-small` using `retryCount`. Validate page
identity, offsets, total length and final UTF-8 byte count; preserve official errors.
The page budget includes the observed official pretty JSON envelope, a JSON-escaped
transport layer and 4 KiB of headroom, totaling at most 32 KiB. Never request the
whole source collection in one evaluation.

## Export and release

Save a host-side JSON with this shape, assembling bodies only after page validation:

```js
{
  report,                         // final report()
  programs,                       // program(1) through program(expectedPrograms)
  draws,                          // every readDraws row
  sources: [{ ordinal, stage, kind, text }] // every available source, exactly once
}
```

Export on Linux:

```sh
node skills/forgeax-engine-wechat/scripts/shader_sources.mjs \
  --collected REASSEMBLED_JSON \
  --out NEW_SOURCE_DIRECTORY
```

The exporter verifies mapping and advertised body lengths before creating the output.
It writes original `.glsl` and separate `.translated.txt` bodies byte-for-byte, plus
`manifest.json` with per-file SHA-256 digests and the full collection metadata. No
source body is replaced by a length-only record. Existing output is never overwritten.

Always call `probe.release()` in the host runner's cleanup. It restores any remaining
owned wrappers and removes retained text and handles. A later wrapper owner is never
overwritten; a restoration conflict is an explicit failure.

## Qualified scope

This collector has offline tests, including the actual 88-operation/14-program plan,
getter ordering, full Unicode bodies through the official envelope, missing driver
translation, generation changes and restoration failures.
The host runner also has offline tests for lost replies, same-offset retries,
Unicode transfer through the actual Node exporter, partial evidence, instance
ownership and deadline cleanup.

The collector and host runner were qualified on the real WeChat simulator on
2026-10-11 with program 10 selected from the full 14-program alignment. Evidence is
under `artifacts/cross-platform-host-ui/design-resumed/simulator-shader-sources/ground-live-fixed/`:
`collection/result.json` records `success: true`, `released: true`, 35 official calls
and 40.012 seconds. The captured frame matched all 88 operations and 81 draws;
one extra completion fence and one presentation blit were correctly treated as
prefix. All methods were restored at the captured fence, before source reads, and
no program handles remained afterward.

`sources/manifest.json` records the full original vertex source (11,726 bytes) and
fragment source (85,326 bytes), totaling 97,052 bytes. Their SHA-256 digests are
`c21338f38276c3fcc22726d8f13a676b63862be014b9431c096fe440e727f8c8` and
`d6a87adc4a2d117a0b15e9363239e97a0edf39c9199f99766e309c8876fef9dc`.
`WEBGL_debug_shaders` was exposed, but both translated-source getters returned empty
strings; the two zero-byte translated files preserve that result. Extension
availability or a successful getter alone does not supply ANGLE/Metal lowering
evidence. Require a nonempty translated body before drawing such conclusions.
