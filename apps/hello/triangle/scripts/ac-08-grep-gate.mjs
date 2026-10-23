#!/usr/bin/env node
// ac-08-grep-gate.mjs - AC-08 stance gates + roster-owned smoke SSOT
// diff (feat-20260508-verify-gpu-smoke-gate w18 + feat-20260508-rhi-surface-completion w11)
//
// Exit codes:
//   0 = all gates PASS
//   1 = any gate FAIL
//
// Gate list:
//   (a) plan-strategy.md grep STANCE_NO_MANUAL_OVERRIDE >= 1
//       (K-10 verbatim stance phrase, see constant below)
//   (b) plan-strategy.md grep -E ARCH_PRINCIPLE_5_FAIL_FAST >= 1
//       (K-10 / K-11 anchor, see constant below)
//   (c) plan-strategy.md grep CHARTER_PROPOSITION_4 >= 1
//       (charter anchor, see constant below)
//   (d) .github/workflows/*.yml non-comment lines grep -E 'continue-on-error|
//       skip-smoke|ALLOW_SMOKE_FAIL' = 0 (K-10 grep gate; comments allowed
//       because they can explain policy). Only declared optional artifact
//       transport may tolerate its own Action initialization/transfer failure.
// Smoke ownership is checked by scripts/ci/__tests__/dawn-smoke-roster*.test.mjs.
//
// Gates (g)-(j) added by feat-20260508-rhi-surface-completion w11
// (AC-RSC-05 / AC-RSC-06 / D-S1 single-point exemption):
//
//   (g) word-boundary `\bgetRawDevice\b` hits across packages/ + apps/ source
//       (.ts/.mjs/.js, excluding dist/) = 0. After D-S1 the function is
//       renamed to `_internal_getRawDevice`; the bare identifier must not
//       reappear. Whitelist exists for legacy compatibility but is currently
//       empty (rename moved every call site to the prefixed form).
//   (h) `_internal_getRawDevice(` call sites are limited to the exact
//       ALLOWED_CALL_SITES paths below, with each owner or test boundary
//       explained there. Every other call site violates D-S1.
//   (i) packages/runtime/src/internal/webgpu-backend.ts must not contain raw
//       WebGPU device-recording entry-point calls. Banned tokens (bare
//       identifiers, only counted on non-comment lines):
//          rawDevice.queue / rawDevice.createCommandEncoder /
//          rawDevice.createBuffer / rawDevice.createTexture /
//          RAW_DEVICE_MAP / `\bgetRawDevice\b`
//       Word-boundary `\bgetRawDevice\b` is used so `_internal_getRawDevice`
//       (which contains `getRawDevice` as a substring but with a leading
//       word character `_`) does NOT match. After w9 the file uses no raw
//       device entry; this gate freezes that property.
//   (j) Forbidden cast patterns across packages/runtime/src/ +
//       apps/hello/triangle/src/ (.ts files, non-comment lines):
//          `as Rhi[A-Z]` / `as Command[A-Z]` / `as GPU[A-Z]`
//       Such casts would leak shim implementation details past the RHI
//       surface (charter proposition 5 consistent abstraction red line).
//       Note: assertions like `as unknown as GPUTexture` are still allowed
//       because the gate matches the bare `as Rhi/Command/GPU` form, and
//       legitimate `as unknown as ...` two-step assertions are explicit
//       opt-ins to a known-unsafe cast (different signal from the implicit
//       single-step cast pattern this gate forbids).
//
// Gate (l) added by feat-20260510-ci-metrics-coverage-drift M3 / w14
// (plan-strategy K-6 dual-layer SSOT lint):
//
//   (l) workflow SSOT lint via spawnSync on scripts/check-workflow-ssot.mjs.
//       Asserts install-playwright-chrome-beta composite action is reused in
//       >= 2 yml files and no yml installs chrome-beta inline (todo-059
//       split A). Independent root script lets AI users invoke locally;
//       gate (l) provides CI-side fail-fast hookup so ac-08 stays the
//       single grep-gate aggregator (architecture principle #5 Fail Fast).
//
// Three-way literal sameness = a 1-character edit at any site fails three
// places (charter proposition 5 consistent abstraction SSOT red line).
//
// Usage:
//   node apps/hello/triangle/scripts/ac-08-grep-gate.mjs
//   pnpm --filter @forgeax/hello-triangle exec node scripts/ac-08-grep-gate.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── locate the repo root (this script lives under apps/hello/triangle/scripts/)
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

const FEATURE_ID = 'feat-20260508-verify-gpu-smoke-gate';
const PLAN_STRATEGY = join(
  REPO_ROOT,
  'artifacts/engineering-gates',
  FEATURE_ID,
  'plan-strategy.md',
);
const CI_YML = join(REPO_ROOT, '.github/workflows/ci.yml');
const NIGHTLY_YML = join(REPO_ROOT, '.github/workflows/nightly.yml');

// ─── verbatim stance phrases (CJK) used as grep targets ──────────────────
//
// These phrases must match plan-strategy.md byte-for-byte. The source file
// itself stays English-only (per the forgeax-english check) by encoding the
// CJK with `\uXXXX` escapes; the runtime string is identical to the literal
// Chinese phrase recorded in plan-strategy.md.
//
// STANCE_NO_MANUAL_OVERRIDE (gate a): plan-strategy.md K-10 verbatim phrase
//   meaning "do not retain manual override" — the "no escape hatch in CI"
//   stance.
//
// ARCH_PRINCIPLE_5_FAIL_FAST (gate b): rules/architecture-principles.md
//   "principle #5 Fail Fast" — referenced from K-10 / K-11.
//
// CHARTER_PROPOSITION_4 (gate c): charter "proposition 4" — explicit
//   failure stance.
// Phrase decodes to: U+4E0D U+4FDD U+7559 + " manual override" (K-10 stance).
const STANCE_NO_MANUAL_OVERRIDE = '\u4E0D\u4FDD\u7559 manual override';
// Phrase decodes to: U+67B6 U+6784 U+539F U+5219 + " #5 Fail Fast" (K-10 / K-11 anchor).
const ARCH_PRINCIPLE_5_FAIL_FAST = '\u67B6\u6784\u539F\u5219 #5 Fail Fast';
// Phrase decodes to: U+547D U+9898 + " 4" (charter anchor).
const CHARTER_PROPOSITION_4 = '\u547D\u9898 4';

// gate-result accumulator (each entry: { name, status: 'PASS'|'FAIL', detail })
const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
}

function readSafely(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

// ─── (a) plan-strategy.md '\u4E0D\u4FDD\u7559 manual override' (literal stance phrase) ─
{
  const text = readSafely(PLAN_STRATEGY);
  if (text == null) {
    // A historical local process artifact may be absent from the working
    // tree. Trivially held — same stance as gates (k)/(f)/(i)/(13).
    record('a', 'PASS', `plan-strategy.md absent (local process artifact not present); stance gate trivially held`);
  } else {
    const hits = text.split('\n').filter((l) => l.includes('\u4E0D\u4FDD\u7559 manual override'));
    if (hits.length >= 1) {
      record('a', 'PASS', `plan-strategy.md matches '\u4E0D\u4FDD\u7559 manual override' × ${hits.length}`);
    } else {
      record(
        'a',
        'FAIL',
        "plan-strategy.md does not match '\u4E0D\u4FDD\u7559 manual override' (K-10 verbatim stance phrase)",
      );
    }
  }
}

// ─── (b) plan-strategy.md '\u67B6\u6784\u539F\u5219 #5 Fail Fast' anchor ──────────────────
{
  const text = readSafely(PLAN_STRATEGY);
  if (text == null) {
    record('b', 'PASS', 'plan-strategy.md absent (local process artifact not present); stance gate trivially held');
  } else {
    const hits = text.split('\n').filter((l) => /\u67B6\u6784\u539F\u5219 #5 Fail Fast/.test(l));
    if (hits.length >= 1) {
      record('b', 'PASS', `plan-strategy.md matches '\u67B6\u6784\u539F\u5219 #5 Fail Fast' × ${hits.length}`);
    } else {
      record(
        'b',
        'FAIL',
        "plan-strategy.md does not match '\u67B6\u6784\u539F\u5219 #5 Fail Fast' (K-10 / K-11 reference)",
      );
    }
  }
}

// ─── (c) plan-strategy.md '\u547D\u9898 4' anchor ─────────────────────────────────
{
  const text = readSafely(PLAN_STRATEGY);
  if (text == null) {
    record('c', 'PASS', 'plan-strategy.md absent (local process artifact not present); stance gate trivially held');
  } else {
    const hits = text.split('\n').filter((l) => l.includes('\u547D\u9898 4'));
    if (hits.length >= 1) {
      record('c', 'PASS', `plan-strategy.md matches '\u547D\u9898 4' × ${hits.length}`);
    } else {
      record('c', 'FAIL', "plan-strategy.md does not match '\u547D\u9898 4' (charter anchor)");
    }
  }
}

// ─── (d) .github/workflows/*.yml non-comment manual-override grep = 0 ────
{
  const workflowDirIndex = process.argv.indexOf('--workflow-dir');
  const dir = workflowDirIndex < 0
    ? join(REPO_ROOT, '.github/workflows')
    : resolve(process.argv[workflowDirIndex + 1]);
  const yamlFiles = readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => join(dir, f));
  const offending = [];
  for (const fp of yamlFiles) {
    const text = readSafely(fp);
    if (text == null) continue;
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      // Only optional artifact transport and bounded cache I/O may tolerate failure. Keep
      // this narrow to the repository's explicit step layout; unfamiliar YAML
      // shapes fail closed instead of creating a job or test escape hatch.
      if (/^ {8}continue-on-error: true\s*(?:#.*)?$/.test(line)) {
        let start = idx;
        while (start > 0 && !/^ {6}- /.test(lines[start])) start--;
        let end = start + 1;
        while (end < lines.length && (
          lines[end].trim() === '' || lines[end].trimStart().startsWith('#') ||
          /^ {7}/.test(lines[end])
        )) end++;
        const step = lines.slice(start, end).map((entry) => entry.replace(/#.*$/, '').trimEnd());
        const optionalTransport = step.some((entry) => entry.trim() === 'uses: ./.github/actions/upload-optional-artifact') || (
          step.some((entry) => /^ {8}uses: actions\/cache\/(restore|save)@v5$/.test(entry)) &&
          step.some((entry) => entry.trim() === 'timeout-minutes: 1')
        );
        if (
          idx < end && /^ {6}- /.test(lines[start]) &&
          optionalTransport &&
          step.filter((entry) => /^(?: {6}- | {8})uses:/.test(entry)).length === 1 &&
          !step.some((entry) => /^(?: {6}- | {8})run:/.test(entry))
        ) return;
      }
      // Strip comments (`#` at line start or after leading whitespace) —
      // comments may explain "why we do NOT use X" stance and are not gated.
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#')) return;
      // Strip trailing inline comments.
      const codePart = line.replace(/#.*$/, '');
      if (/continue-on-error|skip-smoke|ALLOW_SMOKE_FAIL/.test(codePart)) {
        offending.push(`${fp}:${idx + 1}: ${line}`);
      }
    });
  }
  if (offending.length === 0) {
    record(
      'd',
      'PASS',
      `no test/job overrides; only optional artifact transport and bounded cache I/O tolerate failure (${yamlFiles.length} files scanned)`,
    );
  } else {
    record('d', 'FAIL', `manual-override hits:\n${offending.join('\n')}`);
  }
}

// ─── helpers shared by gates (g)–(j) ─────────────────────────────────────
//
// walkSourceFiles(rootDir, exts): yield every absolute file path under rootDir
// whose extension is in `exts`, skipping `dist/` and `node_modules/` subtrees.
// We avoid pulling in a glob library so the gate stays dependency-free
// (matching the rest of this script's stdlib-only style).

// Self-exclude the gate script so it does not trip on the regex source
// strings it carries inside (`getRawDevice` / `_internal_getRawDevice(` etc).
// Identify by absolute path so a future move under a different parent does
// not silently let it slip back into the scan.
const GATE_SCRIPT_PATH = fileURLToPath(import.meta.url);

function* walkSourceFiles(rootDir, exts) {
  if (!existsSync(rootDir)) return;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'dist' || name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        // skip the gate script itself
        if (full === GATE_SCRIPT_PATH) continue;
        for (const ext of exts) {
          if (full.endsWith(ext)) {
            yield full;
            break;
          }
        }
      }
    }
  }
}

// stripLineComment(line): remove `//` line comments and `/* ... */`
// single-line block comments, preserving string literals approximately.
// We intentionally keep the heuristic simple - the gate flags only obvious
// non-comment violations; multi-line `/* ... */` blocks are not handled
// (acceptable: source code in this repo predominantly uses `//` for
// inline comments and JSDoc `/** */` blocks at top of declarations).
function stripLineComment(line) {
  // Walk the line tracking string literal state to avoid stripping `//` that
  // sits inside a template / single / double quoted string.
  let inStr = null; // null | '"' | "'" | '`'
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inStr !== null) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch;
      continue;
    }
    // outside string: detect comment starts
    if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
    if (ch === '/' && line[i + 1] === '*') {
      // strip from `/*` to next `*/` on the same line; if the block extends
      // past end-of-line we treat the rest as comment.
      const close = line.indexOf('*/', i + 2);
      if (close === -1) return line.slice(0, i);
      // continue past the block close
      line = line.slice(0, i) + line.slice(close + 2);
      i--; // re-scan at this index
    }
  }
  return line;
}

// ─── (g) word-boundary getRawDevice = 0 across source tree ──────────────────
//
// Whitelist: empty by default (after w10 rename, every call site moved to
// `_internal_getRawDevice` so the bare identifier should not appear). The
// whitelist exists as a future safety valve; entries are `path:line` pairs.
const G_GET_RAW_DEVICE_WHITELIST = new Set([
  // Currently empty - if a future migration needs to re-introduce a bare
  // `getRawDevice` somewhere, append `'apps/hello/triangle/src/main.ts:96'`
  // (or the new path:line) here. Entries must be reviewed at gate update.
]);

{
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const offending = [];
  for (const sub of ['packages', 'apps']) {
    const root = join(REPO_ROOT, sub);
    for (const fp of walkSourceFiles(root, exts)) {
      let text;
      try {
        text = readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      const rel = fp.slice(REPO_ROOT.length + 1);
      const lines = text.split('\n');
      for (let idx = 0; idx < lines.length; idx++) {
        const codePart = stripLineComment(lines[idx]);
        // Word-boundary getRawDevice: leading char is start-of-string or
        // non-word; trailing char is end-of-string or non-word. Underscore
        // counts as a word char so `_internal_getRawDevice` is NOT matched.
        if (/(?:^|\W)getRawDevice(?=\W|$)/.test(codePart)) {
          const key = `${rel}:${idx + 1}`;
          if (!G_GET_RAW_DEVICE_WHITELIST.has(key)) {
            offending.push(`${key}: ${lines[idx]}`);
          }
        }
      }
    }
  }
  if (offending.length === 0) {
    record(
      'g',
      'PASS',
      `bare getRawDevice (word-boundary) hits across packages/ + apps/ = 0 (whitelist size = ${G_GET_RAW_DEVICE_WHITELIST.size}; D-S1 single-point exemption uses _internal_getRawDevice)`,
    );
  } else {
    record(
      'g',
      'FAIL',
      `bare getRawDevice hits (D-S1 violation; rename to _internal_getRawDevice or whitelist):\n${offending.join('\n')}`,
    );
  }
}

// ─── (h) _internal_getRawDevice( call sites limited to D-S1 allow-list ─────
{
  const ALLOWED_CALL_SITES = new Set([
    'packages/rhi-webgpu/src/device.ts', // function definition
    'packages/rhi-webgpu/src/index.ts', // in-package use (createShaderModule)
    // feat-20260510-rhi-resource-creation M6 (w45) closure gate:
    // `apps/hello/triangle/scripts/m6-resource-creation-grep-gate.mjs`
    // contains the literal symbol inside the gate's regex / error
    // messages (same intent as the gate file itself appearing in this
    // allow-list - the gate IS the truth check for the symbol; without
    // this entry the M6 gate file cannot reference the symbol it polices).
    'apps/hello/triangle/scripts/m6-resource-creation-grep-gate.mjs',
    // feat-20260511-rhi-spec-realign-aggressive D-VD2 (Round 2 wire-up):
    // engine forwards the raw GPUDevice from rhi-webgpu via the D-S1
    // single-point escape hatch to register the spec
    // `onuncapturederror` listener that translates
    // GPUUncapturedErrorEvent → 3 new RhiErrorCode members
    // (`device-lost` / `oom` / `internal-error`, breaking point #4) and
    // fan-outs through `Renderer.onError`. The pack-level field shape
    // `pack._internal_getRawDevice(device)` matches `/_internal_getRawDevice\s*\(/`
    // so each renderer assembly owner that registers this spec listener must
    // be in the allow-list; renamed-imports are not applicable here because
    // the call goes through a `RhiBackendPack` record property.
    'packages/render/src/assembly/webgpu-renderer.ts',
    // The recovery fan-out now owns that listener registration after the
    // renderer assembly extraction; it remains the same D-S1 owner.
    'packages/render/src/assembly/recovery/device-loss-fanout.ts',
    // feat-20260511-asset-system-v1 verify F-1 fix-up (w17): dual-impl
    // texture upload spike invokes `_internal_getRawDevice(device)` to drop
    // to the raw GPUDevice for readback (copyTextureToBuffer destination
    // unwrap not yet in the rhi shim; tracked under
    // `feat-future-rhi-copy-texture-to-buffer-unwrap`). The upload path
    // itself stays on `queue.writeTexture` through the rhi surface; this
    // call site is a passive readback verification, D-S1-correct.
    'apps/dual-impl-spike/scripts/texture-4x4.mjs',
    // feat-20260615-debug-draw-immediate-mode-rhi-convenience-layer:
    // debug-draw demo and its dawn-node smoke harness use
    // `_internal_getRawDevice` to build GPU debug-draw buffer
    // primitives (lines, shapes) via the raw device — same D-S1
    // single-point exemption pattern as the dual-impl spike
    // texture upload readback verification.
    'apps/hello/debug-draw/src/main.ts',
    'apps/hello/debug-draw/scripts/smoke-dawn.mjs',
    // IBL Dawn evidence reads the native texture for a producer-owned
    // readback assertion; this remains a test-only D-S1 boundary.
    'packages/runtime/src/__tests__/dawn/ibl-precompute-readback.dawn.test.ts',
    // GPU-driven lifecycle Dawn/browser evidence uses a validation scope to
    // prove retired buffers are not submitted while a previous graph is
    // still in flight. This is a test-only D-S1 boundary, not a runtime
    // recording path.
    'packages/render/src/__tests__/gpu-driven-view-gpu-evidence.ts',
    // First-instance Dawn evidence checks the actually enabled native feature
    // and validation scopes; GPU work and readback remain on RHI.
    'packages/render/src/__tests__/gpu-driven-first-instance.dawn.test.ts',
    // Texture/sampler residency fixtures observe native validation and destroy
    // test-owned devices. Upload, Graph work, readback and replay stay on RHI.
    'packages/render/src/__tests__/graph-texture-residency.gpu-fixture.ts',
    'packages/render/src/__tests__/white-balance.gpu-fixture.ts',
    'packages/render/src/__tests__/sampler-residency.gpu-fixture.ts',
    'packages/render/src/__tests__/texture-generations.gpu-fixture.ts',
    // Managed asset admission, version, layout, range and mip fixtures use the
    // native device only for validation, completion waits and test-device cleanup.
    // Uploads, GPU work and readback remain on RHI.
    'packages/runtime/src/__tests__/asset-registry-mesh-pack-payload.dawn.test.ts',
    'packages/runtime/src/__tests__/dawn/mesh-update.dawn.test.ts',
    'packages/runtime/src/__tests__/dawn/upload-texture.dawn.test.ts',
    'packages/render/src/__tests__/managed-basis-versions.dawn.test.ts',
    'packages/render/src/__tests__/managed-material-layout.dawn.test.ts',
    'packages/render/src/__tests__/managed-material-versions.browser.test.ts',
    // Canvas-retention evidence observes a native validation scope only;
    // scene recording, pipeline preparation and submission stay on RHI.
    'packages/render/src/__tests__/pending-surface.browser.test.ts',
    'packages/render/src/__tests__/managed-material-versions.dawn.test.ts',
    'packages/render/src/__tests__/managed-mesh-range.gpu-fixture.ts',
    'packages/render/src/__tests__/managed-mesh-structure.gpu-fixture.ts',
    'packages/render/src/__tests__/managed-texture-range.gpu-fixture.ts',
    'packages/render/src/__tests__/mipmap-srgb-linear.dawn.test.ts',
    'packages/render/src/__tests__/terrain-layers.gpu-fixture.ts',
    // This opt-in terrain microbenchmark constructs paired native workloads,
    // timestamp queries and pixel readback; production terrain preparation uses RHI.
    'packages/render/benchmarks/terrain-layer-cost.ts',
    // Array/cube mip Dawn evidence observes native validation and destroys
    // fresh test devices; texture production, capture and readback stay on RHI.
    'packages/render/src/__tests__/texture-array-mips.dawn.test.ts',
    // Cached-depth Browser/Dawn verification observes native validation errors
    // and disposes its fresh test device. All capture and replay work uses RHI.
    'packages/rhi-debug/src/__tests__/cached-depth.fixture.ts',
    // Seven-target skin replay observes native validation; the offline curved
    // receiver probe disposes fresh test devices. Recording and readback use RHI.
    'packages/runtime/src/__tests__/standard-deferred-parity.dawn.test.ts',
    'apps/hello/terrain/scripts/curved-shadow-replay.mjs',
    // Independent Standard map probes observe native validation and destroy
    // test devices; all draw, capture, replay and readback work stays on RHI.
    'packages/render/src/__tests__/standard-independent-maps.dawn.test.ts',
    // Standard GBuffer and public MRT Browser/Dawn verification retain fresh replay devices
    // until the live Renderer journey ends, observes native validation errors,
    // and explicitly destroys those test-owned devices during final cleanup.
    // Capture, replay, and readback themselves remain on the RHI-debug surface.
    'packages/runtime/src/__tests__/standard-gbuffer-replay.fixture.ts',
    // Local-light IES evidence observes native validation and destroys its fresh
    // replay device; capture, work inspection and readback remain on RHI Debug.
    'packages/runtime/src/__tests__/ies-local-lights-replay.fixture.ts',
    // Generated LOD evidence scopes native validation and destroys its fresh
    // replay devices; capture, work inspection and pixel readback use RHI Debug.
    'packages/runtime/src/__tests__/generated-lod.fixture.ts',
    // Ordinary Renderer Global-probe replay observes validation and destroys
    // its fresh replay device. Replay and post-work inspection remain on RHI Debug.
    'packages/runtime/src/__tests__/renderer-probe-global.dawn.test.ts',
    // SSS Dawn evidence destroys only its fresh replay device through the raw
    // handle; Renderer work, capture, replay and selected readback use RHI Debug.
    'packages/runtime/src/__tests__/subsurface.dawn.test.ts',
    // Irradiance-field, screen-probe and Lite-reflection Renderer tests observe
    // native validation and destroy their test-owned devices; GI work, capture
    // and readback stay on the Renderer/RHI surface.
    'packages/runtime/src/__tests__/renderer-irradiance-field.dawn.test.ts',
    'packages/runtime/src/__tests__/renderer-irradiance-field-edit.dawn.test.ts',
    'packages/runtime/src/__tests__/renderer-irradiance-field-clipmap.dawn.test.ts',
    'packages/runtime/src/__tests__/renderer-screen-probe.dawn.test.ts',
    // Real Card world-kernel regression observes native validation and cleans
    // up its test-owned device; dispatch, capture and readback remain on RHI.
    'packages/render/src/__tests__/raytracing/screen-probe-card-sampling.dawn.test.ts',
    'packages/runtime/src/__tests__/renderer-baked-field.dawn.test.ts',
    'packages/runtime/src/__tests__/renderer-radiance-cache.dawn.test.ts',
    'packages/runtime/src/__tests__/renderer-reflection-denoise.dawn.test.ts',
    'packages/runtime/src/__tests__/renderer-reflections.fixture.ts',
    // The GI coverage diagnostic dispatches its kernel and reads the retained
    // field's Global SDF and Card atlas on the Renderer's native device; the
    // Renderer journey, capture and tape inspection stay on RHI.
    'packages/runtime/src/__tests__/renderer-gi-coverage.dawn.test.ts',
    // Visible-surface diagnostics observe native attachments and pause a real
    // mapAsync completion to inject loss. Fresh replay devices are test-owned;
    // production observation, capture and replay continue through RHI.
    'packages/runtime/src/__tests__/visible-surface-replay.fixture.ts',
    // Normal/bump replay uses the same validation-only and device-cleanup boundary.
    'packages/runtime/src/__tests__/normal-bump.fixture.ts',
    // Standard displacement replay uses the native boundary only for validation
    // scopes and fresh test-device cleanup. Draw, capture, replay, and readback
    // remain on the RHI and RHI Debug surfaces.
    'packages/runtime/src/__tests__/standard-displacement.fixture.ts',
    // Outline replay uses the native boundary only to destroy its fresh
    // test-owned device; capture, replay and pixel inspection remain on RHI.
    'packages/runtime/src/__tests__/outline.fixture.ts',
    // Adaptive DRS replay uses the same cleanup-only boundary for its fresh
    // test-owned device; capture, replay and pixel inspection remain on RHI.
    'packages/runtime/src/__tests__/adaptive-drs.fixture.ts',
    // TAA maturity capture/displacement evidence destroys only its test-owned
    // fresh replay devices. Capture, per-work readback and replay remain on RHI Debug.
    'packages/runtime/src/__tests__/taa-maturity-rhi.dawn.test.ts',
    'packages/runtime/src/__tests__/displacement-temporal.dawn.test.ts',
    // SMAA replay uses this boundary only to destroy its fresh test-owned
    // device; all capture, replay and stage readback remain on RHI Debug.
    'packages/runtime/src/__tests__/smaa.fixture.ts',
    // Offline evidence verifier: native validation observation and device disposal only.
    // All replay, resource inspection and HDR/pixel readbacks use RHI Debug.
    'apps/hello/ssr/scripts/replay-atmosphere-evidence.mjs',
    'packages/runtime/src/__tests__/material-mrt.fixture.ts',
    // Clipping Browser/Dawn evidence uses native error scopes and disposes
    // fresh test-owned devices; all GPU work and readback remain on RHI Debug.
    'packages/runtime/src/__tests__/clipping-planes.fixture.ts',
    // Current-pose picking observes native validation and destroys fresh test
    // devices; capture, replay, palette/VBO and pixel inspection use RHI Debug.
    'packages/picking/src/__tests__/skinned-triangle-gpu.fixture.ts',
    // Planar reflection Dawn evidence listens for validation errors and
    // destroys its fresh replay device; capture and readback stay on RHI.
    'packages/runtime/src/__tests__/planar-reflection.dawn.test.ts',
    // Native test canvas, validation observation and cleanup only; capture,
    // resource recovery and target content remain on Renderer/RHI Debug.
    'packages/runtime/src/__tests__/scene-material-capture-recovery.dawn.test.ts',
    // Canvas Browser evidence observes native validation and destroys fresh
    // test-owned devices; upload, capture, replay and readback stay on RHI.
    'packages/runtime/src/__tests__/canvas-texture.browser.test.ts',

    // Shared-material/PT fixtures observe native validation and destroy their
    // test-owned devices. GPU work, capture and replay stay on the RHI surface.
    'packages/render/src/__tests__/raytracing/path-lighting.fixture.ts',
    'packages/render/src/__tests__/raytracing/path-tracer.fixture.ts',
    'packages/render/src/__tests__/raytracing/path-buffer.fixture.ts',
    'packages/render/src/__tests__/raytracing/raster-source.fixture.ts',
    'packages/render/src/__tests__/raytracing/probe-placement.fixture.ts',
    'packages/render/src/__tests__/raytracing/probe-card-support.fixture.ts',
    // Retained-scene query fixture observes native validation; all work uses RHI.
    'packages/render/src/__tests__/raytracing/scene-projection.gpu-fixture.ts',
    'packages/render/src/__tests__/raytracing/material-publication.gpu-fixture.ts',
    'packages/render/src/__tests__/raytracing/submitted-textures.gpu-fixture.ts',
    // Observe validation and destroy the captured source device before fresh replay.
    'packages/render/src/__tests__/raytracing/normal-frame.fixture.ts',
    'packages/render/src/__tests__/raytracing/surface-bsdf.fixture.ts',
    // SDF/card fixtures use native access only for validation and test-device cleanup.
    'packages/render/src/__tests__/raytracing/sdf-cards.fixture.ts',
    'packages/render/src/__tests__/raytracing/sdf-cases.fixture.ts',
    'packages/render/src/__tests__/raytracing/sdf-material.fixture.ts',
    'packages/render/src/__tests__/raytracing/card-coverage.fixture.ts',
    'packages/render/src/__tests__/raytracing/sdf-two-sided.fixture.ts',
    'packages/render/src/__tests__/raytracing/multi-material-cards.fixture.ts',
    'packages/render/src/__tests__/raytracing/global-sdf.fixture.ts',
    // Managed collision observes validation and destroys test-owned replay devices.
  'packages/render/src/__tests__/scene-sdf.fixture.ts',
  'apps/hello/boss-lightning/scripts/smoke-sdf-dawn.mjs',
  // Diagnostic SDF page destroys only its fresh replay device after App disposal;
  // capture, replay, particle and pixel inspection stay on RHI Debug.
  'apps/hello/boss-lightning/src/sdf-evidence.ts',
    // Native world support observes validation and destroys its owned test device;
    // budgeted builds, Graph coverage copies, traversal and readback stay on RHI.
    'packages/render/src/__tests__/raytracing/world-acceleration-support.dawn.test.ts',
    // Live-field visibility records adapter identity and observes native validation;
    // composition, projection, paired sampling and readback all execute through RHI.
    'packages/render/src/__tests__/raytracing/irradiance-field-visibility.dawn.test.ts',
    'packages/render/src/__tests__/raytracing/global-sdf-query.fixture.ts',
    // GPU-origin fixture observes validation and destroys its source device before fresh replay.
    'packages/render/src/__tests__/raytracing/global-sdf-gpu-rays.fixture.ts',
    // Borrowed recorders observe native validation and destroy only test-owned devices.
    'packages/render/src/__tests__/raytracing/global-sdf-compose.fixture.ts',
    'packages/render/src/__tests__/raytracing/probe-rays.fixture.ts',
    'packages/render/src/__tests__/raytracing/software-sdf-query.fixture.ts',
    'packages/render/src/__tests__/raytracing/global-card-lookup.fixture.ts',
    'packages/render/src/__tests__/raytracing/global-sdf-step.fixture.ts',
    'packages/render/src/__tests__/raytracing/sdf-visibility.fixture.ts',
    'packages/render/src/__tests__/raytracing/sdf-storage.fixture.ts',
    'packages/render/src/__tests__/raytracing/sdf-expansion.fixture.ts',
    'packages/render/src/__tests__/raytracing/card-sampling.fixture.ts',
    'packages/render/src/__tests__/raytracing/visibility-cards.fixture.ts',
    // Diffuse GI observes native validation and destroys fresh test devices;
    // raster, compute, PT reference, capture and replay work remain on RHI.
    'packages/render/src/__tests__/raytracing/diffuse-gi.fixture.ts',
    'packages/render/src/__tests__/raytracing/diffuse-gi-reference.fixture.ts',
    'packages/render/src/__tests__/raytracing/gi-view.fixture.ts',
    // Ordinary Renderer GI destroys only its fresh test-owned replay device;
    // draw, transport, capture, replay, and readback remain on RHI.
    'packages/runtime/src/__tests__/renderer-diffuse.fixture.ts',
    // These fixtures release only their caller-owned replay devices after
    // the live Renderer ends; capture, replay and readback remain on RHI.
    'packages/runtime/src/__tests__/continuous-lines.fixture.ts',
    'packages/runtime/src/__tests__/display-p3.fixture.ts',
    // Diffuse reconstruction observes validation and disposes fresh test devices.
    // All production filtering and replay use the RHI surface.
    'packages/render/src/__tests__/raytracing/diffuse-reconstruction.fixture.ts',
    // Rect source-texture Dawn evidence scopes validation on and destroys its
    // fresh replay devices; capture, replay and readback stay on RHI Debug.
    'packages/runtime/src/__tests__/rect-light-source-texture.dawn.test.ts',
    // External-texture evidence counts raw importExternalTexture /
    // copyExternalImageToTexture calls to prove the zero-copy path, observes
    // validation and destroys fresh replay devices; rendering stays on RHI.
    'packages/runtime/src/__tests__/external-texture.browser.test.ts',
    'packages/runtime/src/__tests__/external-texture-perf.browser.test.ts',
    // Channel replay/capture evidence observes native validation and releases
    // fresh test-owned devices; rendering and readback stay on RHI Debug.
    'packages/runtime/src/__tests__/lighting-channels-replay.fixture.ts',
    'packages/runtime/src/__tests__/lighting-channels-views.fixture.ts',
    // Independent native outer timing brackets the original Renderer command
    // buffers in one submit. Only this opt-in test installs the native markers.
    'packages/runtime/src/__tests__/lighting-channels-performance.dawn.test.ts',
  ]);
  // feat-20260510-rhi-resource-creation M4 (w28 / w29): the previous
  // `apps/hello/triangle/src/main.ts` allow-list entry was removed - the
  // D-S1 single-point escape hatch is gone, replaced by
  // `rhi.acquireCanvasContext` -> `RhiCanvasContext.configure`.
  // `apps/hello/cube/scripts/smoke-dawn.mjs` retains the renamed-import form
  // (`{ _internal_getRawDevice: captureRawDevice, rhi }`) which does NOT
  // match the regex `/_internal_getRawDevice\s*\(/` (the regex matches the
  // call form `_internal_getRawDevice(`; renamed-imports use the alias at
  // call sites). M6 will fully migrate the hello-cube smoke harness.
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const offending = [];
  for (const sub of ['packages', 'apps']) {
    const root = join(REPO_ROOT, sub);
    for (const fp of walkSourceFiles(root, exts)) {
      let text;
      try {
        text = readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      const rel = fp.slice(REPO_ROOT.length + 1);
      const lines = text.split('\n');
      for (let idx = 0; idx < lines.length; idx++) {
        const codePart = stripLineComment(lines[idx]);
        // Match the call form `_internal_getRawDevice(` (open paren). Function
        // definition and import statements also match because they contain the
        // identifier; whitelist by file path covers all sanctioned sites.
        if (/_internal_getRawDevice\s*\(/.test(codePart)) {
          if (!ALLOWED_CALL_SITES.has(rel)) {
            offending.push(`${rel}:${idx + 1}: ${lines[idx]}`);
          }
        }
      }
    }
  }
  if (offending.length === 0) {
    record(
      'h',
      'PASS',
      `_internal_getRawDevice( call sites confined to ${ALLOWED_CALL_SITES.size} D-S1 allow-list paths`,
    );
  } else {
    record(
      'h',
      'FAIL',
      `_internal_getRawDevice( call sites outside D-S1 allow-list:\n${offending.join('\n')}`,
    );
  }
}

// ─── (i) webgpu-backend.ts must not contain raw GPU recording calls ────────
{
  const target = join(REPO_ROOT, 'packages/runtime/src/internal/webgpu-backend.ts');
  const text = readSafely(target);
  if (text == null) {
    // feat-20260509-ecs-render-bridge-mvp M2 (w15 / D-S11): the
    // webgpu-backend.ts file was deleted as part of the drawTriangle removal.
    // The gate's intent (no raw GPU recording calls leaking through this
    // path) is trivially satisfied when the file no longer exists - the
    // entire raw recording surface has been migrated to RenderSystem (which
    // goes through the @forgeax/engine-rhi interface only). Treat absence as PASS
    // so the gate keeps signalling "intent held" rather than "scan failed".
    record(
      'i',
      'PASS',
      `webgpu-backend.ts absent (D-S11 / M2 w15 deletion): raw GPU recording entry-points removed; AC-RSC-06 intent trivially held`,
    );
  } else {
    // Banned tokens, evaluated against non-comment lines only.
    const bannedPatterns = [
      // word-boundary getRawDevice (NOT matching _internal_getRawDevice)
      { name: 'getRawDevice (bare)', regex: /(?:^|\W)getRawDevice(?=\W|$)/ },
      { name: 'rawDevice.queue', regex: /\brawDevice\.queue\b/ },
      { name: 'rawDevice.createCommandEncoder', regex: /\brawDevice\.createCommandEncoder\b/ },
      { name: 'rawDevice.createBuffer', regex: /\brawDevice\.createBuffer\b/ },
      { name: 'rawDevice.createTexture', regex: /\brawDevice\.createTexture\b/ },
      { name: 'rawDevice.createRenderPipeline', regex: /\brawDevice\.createRenderPipeline\b/ },
      { name: 'rawDevice.createShaderModule', regex: /\brawDevice\.createShaderModule\b/ },
      { name: 'RAW_DEVICE_MAP', regex: /\bRAW_DEVICE_MAP\b/ },
    ];
    const offending = [];
    const lines = text.split('\n');
    for (let idx = 0; idx < lines.length; idx++) {
      const codePart = stripLineComment(lines[idx]);
      for (const { name, regex } of bannedPatterns) {
        if (regex.test(codePart)) {
          offending.push(`${idx + 1}: [${name}] ${lines[idx]}`);
          break;
        }
      }
    }
    if (offending.length === 0) {
      record(
        'i',
        'PASS',
        `webgpu-backend.ts has 0 raw GPU recording entry-point calls (${bannedPatterns.length} banned tokens checked on non-comment lines)`,
      );
    } else {
      record(
        'i',
        'FAIL',
        `webgpu-backend.ts contains raw GPU recording entry-point calls (AC-RSC-06 violation):\n${offending.join('\n')}`,
      );
    }
  }
}

// ─── (j) forbidden cast patterns in engine/apps source ─────────────────────
{
  const ROOTS = [
    join(REPO_ROOT, 'packages/runtime/src'),
    join(REPO_ROOT, 'apps/hello/triangle/src'),
  ];
  const exts = ['.ts', '.tsx'];
  // Match `as Rhi<UpperCase>` / `as Command<UpperCase>` / `as GPU<UpperCase>`
  // word-bounded cast patterns; these would leak shim implementation details
  // past the RHI surface (charter proposition 5 red line). Allowed two-step
  // `as unknown as ...` casts are not flagged because they are explicit
  // opt-ins to known-unsafe assertions (different signal).
  const bannedRegex = /\bas\s+(?:Rhi|Command|GPU)[A-Z][A-Za-z0-9_]*\b/;
  const offending = [];
  for (const root of ROOTS) {
    for (const fp of walkSourceFiles(root, exts)) {
      let text;
      try {
        text = readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      const rel = fp.slice(REPO_ROOT.length + 1);
      const lines = text.split('\n');
      for (let idx = 0; idx < lines.length; idx++) {
        const codePart = stripLineComment(lines[idx]);
        // Skip `as unknown as Xxx` (the canonical two-step explicit cast).
        if (/\bas\s+unknown\s+as\b/.test(codePart)) continue;
        if (bannedRegex.test(codePart)) {
          offending.push(`${rel}:${idx + 1}: ${lines[idx]}`);
        }
      }
    }
  }
  if (offending.length === 0) {
    record(
      'j',
      'PASS',
      'no `as Rhi/Command/GPU<Type>` single-step casts in engine/apps source (charter proposition 5 red line)',
    );
  } else {
    record(
      'j',
      'FAIL',
      `forbidden cast patterns leak shim internals past the RHI surface:\n${offending.join('\n')}`,
    );
  }
}

// ─── (k) feat-20260510-rhi-resource-creation AC-11 charter / arch-principles
//    boundary gate (w50 tightening):
//
//    Original AC-11 phrasing was the loose form "grep `charter <prop8>` 0 hit
//    in the closed-loop products" (where <prop8> is the 2-CJK-char form
//    U+547D U+9898 + " 8"). That phrasing suffered self-loop failure - the AC
//    statement itself carries the literal `charter <prop8>` inside the
//    gate-description text, and so do the requirements review audit docs that
//    record the F-1 finding history (which are append-only by Architecture
//    Principle #7). w50 tightens the gate to:
//
//    (i)  Substantive references use the FULL 7-CJK-char phrase "charter
//         <prop8> <human-final-authority>" (where <human-final-authority> is
//         U+4EBA U+7C7B U+7EC8 U+5BA1 U+6743). That phrase DOES indicate a
//         SSOT anchor mistake. The looser literal "charter <prop8>" alone may
//         legitimately appear inside gate / review text describing the very
//         anti-pattern this gate enforces.
//    (ii) Exclude meta self-references: AC-11 statement self, the gate script
//         itself, and review-audit docs whose append-only history records the
//         F-1 finding lineage (the docs DESCRIBE the anti-pattern; they do NOT
//         re-introduce it as a SSOT anchor).
//
//    The substantive phrase MUST be 0 hit in production-doc anchors:
//    requirements.md (excluding the AC-11 self-reference line) /
//    research.md / plan-strategy.md / plan-decisions.md / plan-tasks.* /
//    requirements.json discoverabilityNotes - i.e. the products consumed
//    downstream by AI users at implement / verify time.
//
//    Gate (k) FAILS only if a substantive reference leaks back into a
//    production anchor. The exclusion list below is the closed allow-set.
{
  const FEATURE_DIR = join(
    REPO_ROOT,
    'artifacts/engineering-gates/feat-20260510-rhi-resource-creation',
  );
  // Tightened substantive phrase (w50 option a). Encoded via \uXXXX so the
  // gate script itself stays English-only under check_english_only.py --code,
  // while the runtime literal byte-matches the CJK phrase recorded in the
  // closed-loop products.
  // Decodes to: "charter " + U+547D U+9898 + " 8 " + U+4EBA U+7C7B U+7EC8
  //              U+5BA1 U+6743   (i.e. the 7-CJK-char SSOT-anchor phrase).
  // The leading "charter " keeps the anchor form intact so partial-phrase
  // matches (e.g. arch-principles #8 references) do NOT trip the gate.
  const SUBSTANTIVE_PHRASE =
    'charter \u547D\u9898 8 \u4EBA\u7C7B\u7EC8\u5BA1\u6743';
  // Short "proposition" literal for messages: U+547D U+9898.
  const PROPOSITION_LITERAL = '\u547D\u9898';
  // Short "correction note" literal for the meta self-description regex:
  // U+7EA0 U+9519 (decodes to the 2-CJK-char "correction" label).
  const META_CORRECTION_LITERAL = '\u7EA0\u9519';
  // Allow-listed paths (closed-loop relative paths) where the phrase may
  // appear as audit history without counting as a SSOT-anchor leak. The
  // append-only review docs record the F-1 finding lineage by construction;
  // mutating them would violate Architecture Principle #7. AC-11 statement
  // (lines that describe the gate itself) and gate-script self lines are the
  // other two unavoidable self-references.
  const META_ALLOWLIST = new Set([
    // append-only audit history of the F-1 finding (Architecture Principle #7)
    'requirements-review.md',
    'requirements-ai-user-review.md',
    'requirements-ai-user-review.json',
    // plan-review trail (also append-only audit)
    'plan-review.md',
    'plan-ai-user-review.md',
    'plan-ai-user-review.json',
  ]);
  // AC-11 self-reference predicate: a line is a meta self-description if it
  // contains "AC-11" together with one of the gate-anchor literals
  // ("grep" / "0 hit" / "discoverabilityNotes" / "exclude" / "self-loop").
  // Such lines are part of the gate's own definition; counting them as hits
  // would force the gate to fail by self-reference (the F-3 of grep gates).
  const isMetaSelfDescriptionLine = (line) =>
    /AC-11/.test(line) &&
    /(grep|0 hit|discoverabilityNotes|exclude|self-loop|meta\s*\u7EA0\u9519)/.test(line);
  if (!existsSync(FEATURE_DIR)) {
    record(
      'k',
      'PASS',
      `closed-loop dir absent (${FEATURE_DIR}); AC-11 gate trivially held (gate enforces production-anchor cleanliness; absent dir means no anchors to leak)`,
    );
  } else {
    // Walk the closed-loop dir, extension-filtered (md / json) to keep the
    // scan bounded; jsonl event logs are excluded because they are
    // append-only event streams (Architecture Principle #7), not SSOT
    // anchors that AI users consume.
    const offending = [];
    function* walkClosedLoop(dir) {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          yield* walkClosedLoop(full);
        } else if (st.isFile()) {
          if (/\.(md|json)$/.test(name) && !name.endsWith('.jsonl')) yield full;
        }
      }
    }
    for (const fp of walkClosedLoop(FEATURE_DIR)) {
      const rel = fp.slice(FEATURE_DIR.length + 1);
      if (META_ALLOWLIST.has(rel)) continue;
      let text;
      try {
        text = readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        if (!line.includes(SUBSTANTIVE_PHRASE)) continue;
        if (isMetaSelfDescriptionLine(line)) continue;
        offending.push(`${rel}:${idx + 1}: ${line.slice(0, 200)}`);
      }
    }
    if (offending.length === 0) {
      record(
        'k',
        'PASS',
        `AC-11 substantive 'charter ${'\u547D\u9898'} 8 ${'\u4EBA\u7C7B\u7EC8\u5BA1\u6743'}' references = 0 in closed-loop production anchors (allow-list size = ${META_ALLOWLIST.size}; meta self-description lines tolerated)`,
      );
    } else {
      record(
        'k',
        'FAIL',
        `AC-11 substantive references leaked into production anchors (charter / arch-principles boundary breached - 'charter ${'\u547D\u9898'} 8' should be 'architecture-principles #8' in production text):\n${offending.join('\n')}`,
      );
    }
  }
}

// ─── (l) workflow SSOT lint via scripts/check-workflow-ssot.mjs ────────────
//
// Delegates to the standalone root lint (architecture principle #5 Fail Fast
// + plan-strategy K-6 dual-layer). Non-zero exit on the child script flips
// gate (l) to FAIL; child stderr is preserved verbatim in the gate detail
// for the [reason]/[rerun]/[hint] structured triple (plan-strategy §7.3).
{
  const lintScript = join(REPO_ROOT, 'scripts/check-workflow-ssot.mjs');
  if (!existsSync(lintScript)) {
    record(
      'l',
      'FAIL',
      `${lintScript} missing (feat-20260510-ci-metrics-coverage-drift M3 w13 not landed)`,
    );
  } else {
    const r = spawnSync('node', [lintScript], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status === 0) {
      record(
        'l',
        'PASS',
        `scripts/check-workflow-ssot.mjs exit=0 (install-playwright-chrome-beta composite action reused; no inline chrome-beta drift)`,
      );
    } else {
      record(
        'l',
        'FAIL',
        `scripts/check-workflow-ssot.mjs exit=${r.status}\n${(r.stderr ?? '').trim()}`,
      );
    }
  }
}

// ─── (13) verify -- '--auto' not in finalize.json (LLM convention drift detector;
//    feat-20260510-ci-merge-gate-hardening K-5)
//
// Gate 13 closes the verify-phase loop on Step 5 of finalizer.md: AI users
// drift over time and may sneak `--auto` back into the merge command (the
// silent fallback path that bypasses required checks under no-protection
// repos). gate 13 greps the recorded `finalize.json` to flip process drift
// (LLM convention) into file drift (machine-checkable) at verify time.
//
// Inputs:
//   - CLI arg `--finalize-path <abs-or-rel-path>` (test injection;
//     when provided, skip featureId lookup and read this exact path)
//   - else: read featureId from loop-state.json (sibling of feature dirs);
//     finalize path = <repoRoot>/artifacts/engineering-gates/<featureId>/finalize.json
//
// Behavior:
//   - missing finalize.json + path was explicitly requested via --finalize-path
//     -> FAIL (test fixture (c); also catches genuine corruption)
//   - missing finalize.json + auto-discovery from loop-state.json
//     -> PASS with note (pre-finalize loops do not yet have finalize.json;
//     gate 13 only enforces the constraint once the file exists)
//   - finalize.json present + literal `--auto` substring hit count == 0 -> PASS
//   - finalize.json present + literal `--auto` substring hit count >= 1 -> FAIL
//     with three-segment stderr (plan-strategy section 7.3 templates)
{
  // CLI arg parser - minimal, no deps; gate-script convention
  let finalizePath = null;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--finalize-path' && i + 1 < argv.length) {
      finalizePath = argv[i + 1];
      // resolve relative paths against process.cwd(), absolute passes through
      finalizePath = resolve(process.cwd(), finalizePath);
    }
  }

  let pathExplicit = finalizePath !== null;

  if (finalizePath === null) {
    // auto-discovery via loop-state.json (sibling of feature dirs)
    const loopRoot = join(REPO_ROOT, 'artifacts/engineering-gates');
    // find the most recent feature-dir with a loop-state.json that points at it.
    // The loop-state.json schema embeds featureId, so we walk feature dirs
    // and pick the one whose loop-state.featureId matches the dir name.
    let activeFeatureId = null;
    if (existsSync(loopRoot)) {
      let entries;
      try {
        entries = readdirSync(loopRoot);
      } catch {
        entries = [];
      }
      for (const name of entries) {
        if (!name.startsWith('feat-')) continue;
        const lsPath = join(loopRoot, name, 'loop-state.json');
        if (!existsSync(lsPath)) continue;
        try {
          const ls = JSON.parse(readFileSync(lsPath, 'utf8'));
          if (ls.featureId === name) {
            // pick last one wins (sorted lexicographically by feature-dir name);
            // gate 13 is run inside one feature loop at a time, so a single
            // active feature is the common case. multi-feature drift is logged
            // by the workflow SSOT lint (gate l) and not gate 13 concern.
            activeFeatureId = name;
          }
        } catch {
          // malformed loop-state.json: skip; gate 13 not the place to whine
        }
      }
    }
    if (activeFeatureId !== null) {
      finalizePath = join(loopRoot, activeFeatureId, 'finalize.json');
    }
  }

  if (finalizePath === null) {
    // No active feature loop discovered. Pre-finalize loops have no
    // finalize.json yet; gate 13 only fires on the explicit request path.
    record(
      '13',
      'PASS',
      `no active feature loop with loop-state.json discovered; gate 13 enforces '--auto' literal absence in finalize.json once the file exists. Pass --finalize-path <path> to test a specific fixture.`,
    );
  } else if (!existsSync(finalizePath)) {
    // missing finalize.json
    if (pathExplicit) {
      // explicit path: FAIL with three-segment stderr (test fixture (c))
      const reason = `[reason] gate 13 finalize.json not found at ${finalizePath}`;
      const rerun = `[rerun]  node apps/hello/triangle/scripts/ac-08-grep-gate.mjs --finalize-path ${finalizePath}`;
      const hint = `[hint]   feat-20260510-ci-merge-gate-hardening K-5 / AC-05 (c): once finalize.json exists in a feature loop dir, gate 13 must find it. Verify the path or feature-dir state.`;
      console.error(reason);
      console.error(rerun);
      console.error(hint);
      record('13', 'FAIL', `finalize.json not found at ${finalizePath} (explicit --finalize-path)`);
    } else {
      // auto-discovery path resolved to nonexistent finalize.json (pre-finalize loop)
      record(
        '13',
        'PASS',
        `auto-discovered finalize path ${finalizePath} does not exist yet; pre-finalize loop state is normal. Gate 13 only enforces '--auto' literal absence once finalize.json is written by FinalizerAgent Step 5.`,
      );
    }
  } else {
    // finalize.json exists - grep literal '--auto'
    let text;
    try {
      text = readFileSync(finalizePath, 'utf8');
    } catch (err) {
      const reason = `[reason] gate 13 cannot read finalize.json at ${finalizePath}: ${err.message}`;
      const rerun = `[rerun]  cat ${finalizePath}`;
      const hint = `[hint]   feat-20260510-ci-merge-gate-hardening K-5: gate 13 needs read access to finalize.json. Check fs permissions or worktree mount.`;
      console.error(reason);
      console.error(rerun);
      console.error(hint);
      record('13', 'FAIL', `read failed at ${finalizePath}: ${err.message}`);
      // skip the substring check
      // fall through to report
    }

    if (text != null) {
      // literal substring hit count over the entire file body
      let count = 0;
      let idx = 0;
      while ((idx = text.indexOf('--auto', idx)) !== -1) {
        count++;
        idx += '--auto'.length;
      }

      if (count === 0) {
        record(
          '13',
          'PASS',
          `finalize.json at ${finalizePath} has 0 '--auto' literal hits (LLM convention not drifted; merge gate intact)`,
        );
      } else {
        const reason = `[reason] LLM convention drift detected: '--auto' literal in ${finalizePath} (hit count ${count})`;
        const rerun = `[rerun]  grep -- '--auto' ${finalizePath}`;
        const hint = `[hint]   review .claude/skills/forgeax-step-finalize/agents/finalizer.md Step 5; cat ${finalizePath}; '--auto' lets gh merge bypass required checks (feat-20260510-ci-merge-gate-hardening K-5 / AC-05 (c)).`;
        console.error(reason);
        console.error(rerun);
        console.error(hint);
        record(
          '13',
          'FAIL',
          `'--auto' literal in ${finalizePath} (count=${count}); finalizer.md Step 5 self-gate has been bypassed`,
        );
      }
    }
  }
}

// ─── report ──────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === 'FAIL');
console.log(
  '═══ AC-08 grep gate + F-3 SSOT diff + RHI surface gates + AC-11 boundary + workflow SSOT + finalize merge-gate (feat-20260508-verify-gpu-smoke-gate w18 + feat-20260508-rhi-surface-completion w11 + feat-20260509-ecs-render-bridge-mvp w22 + feat-20260510-rhi-resource-creation w50 + feat-20260510-ci-metrics-coverage-drift w14 + feat-20260510-ci-merge-gate-hardening w17) ═══',
);
for (const r of results) {
  const icon = r.status === 'PASS' ? '✓' : '✗';
  console.log(`  ${icon} (${r.name}) ${r.status}: ${r.detail}`);
}
console.log('');
if (failed.length === 0) {
  console.log(
    `✓ all ${results.length} gates PASS - AC-08 + F-3 three-way SSOT byte-for-byte + RHI surface gates (g)-(j) + AC-11 charter/arch-principles boundary (k) + workflow SSOT (l) + finalize merge-gate (13)`,
  );
  process.exit(0);
} else {
  console.error(
    `✗ ${failed.length} / ${results.length} gates FAIL - stance drift signal, must fix`,
  );
  process.exit(1);
}
