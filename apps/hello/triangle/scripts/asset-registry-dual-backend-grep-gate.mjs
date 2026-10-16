#!/usr/bin/env node
// asset-registry-dual-backend-grep-gate.mjs — feat-20260511-rhi-wgpu-impl w20.
//
// AssetRegistry dual-backend compatibility gate. The forgeax
// `AssetRegistry` (packages/engine/src/asset-registry.ts) must drive both
// the @forgeax/engine-rhi-webgpu and @forgeax/engine-rhi-wgpu shim layers through the
// shared @forgeax/engine-rhi interface SSOT (OQ-6 decision +
// plan-strategy §6 M2): registering / looking up assets must NOT touch
// navigator.gpu / GPUBuffer / GPUDevice / GPUQueue spec types directly;
// every device interaction must route through the RHI Result-wrapped
// surface so both backends transparently carry the asset registration.
//
// w20 red state: when this script is first introduced, the assertion that
// asset-registry.ts has been audited is intentionally NOT satisfied — the
// auditor (w21) must add a sentinel comment ('dual-backend audited:
// 2026-05-11' line) to mark the file as reviewed against the dual-impl
// stance. The audit confirms the file body uses only RhiDevice /
// RhiQueue / Buffer brand types (no navigator.gpu / GPU* spec types
// directly).
//
// Exit codes:
//   0 = all gates PASS (asset-registry.ts audited + RHI-only).
//   1 = any gate FAIL — w20 red state (sentinel comment absent) or
//                       regression (spec types leaked into asset-registry).
//
// Gates checked:
//   (g1) asset-registry.ts contains the sentinel comment:
//          `dual-backend audited: 2026-05-11` (1+ hit).
//   (g2) asset-registry.ts contains 0 hits of `navigator.gpu`.
//   (g3) asset-registry.ts contains 0 hits of bare-typed `GPUBuffer`,
//        `GPUDevice`, `GPUQueue`, `GPUTexture` (spec types must not leak
//        into the engine-level asset registry; the RHI brands carry them).
//
// The audit is grep-mechanical; no code change to asset-registry.ts is
// expected on the M2 path beyond adding the sentinel comment when the
// audit clears (charter proposition 4 explicit failure + proposition 5
// consistent abstraction red line).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..', '..');
const ASSET_REGISTRY_PATH = resolve(REPO_ROOT, 'packages/engine/src/asset-registry.ts');
const SENTINEL = 'dual-backend audited: 2026-05-11';
const FORBIDDEN_PATTERNS = [
  // spec types that must NOT leak into the engine-level asset registry
  // (the RHI brands carry them transparently across both backends).
  { name: 'navigator.gpu', regex: /\bnavigator\.gpu\b/g },
  { name: 'GPUBuffer (type ref)', regex: /\b: GPUBuffer\b/g },
  { name: 'GPUDevice (type ref)', regex: /\b: GPUDevice\b/g },
  { name: 'GPUQueue (type ref)', regex: /\b: GPUQueue\b/g },
  { name: 'GPUTexture (type ref)', regex: /\b: GPUTexture\b/g },
  // Cross-backend isolation: asset-registry must not import either shim
  // package directly (it routes through @forgeax/engine-rhi interface SSOT only).
  { name: '@forgeax/engine-rhi-webgpu import', regex: /from '@forgeax\/rhi-webgpu'/g },
  { name: '@forgeax/engine-rhi-wgpu import', regex: /from '@forgeax\/rhi-wgpu'/g },
];

function fail(message) {
  process.stderr.write(`asset-registry-dual-backend-grep-gate: FAIL — ${message}\n`);
}

function pass(message) {
  process.stdout.write(`asset-registry-dual-backend-grep-gate: PASS — ${message}\n`);
}

function main() {
  if (!existsSync(ASSET_REGISTRY_PATH)) {
    fail(`asset-registry.ts not found at ${ASSET_REGISTRY_PATH}`);
    process.exit(1);
  }
  const content = readFileSync(ASSET_REGISTRY_PATH, 'utf8');

  let failures = 0;

  // (g1) sentinel
  if (content.includes(SENTINEL)) {
    pass(`sentinel comment '${SENTINEL}' present`);
  } else {
    fail(
      `sentinel comment '${SENTINEL}' missing — auditor must add the comment to mark asset-registry.ts as reviewed against the dual-impl stance (w21 green-tier action)`,
    );
    failures += 1;
  }

  // (g2) + (g3) forbidden patterns
  for (const { name, regex } of FORBIDDEN_PATTERNS) {
    const matches = content.match(regex);
    if (matches === null || matches.length === 0) {
      pass(`forbidden pattern '${name}' has 0 hits`);
    } else {
      fail(
        `forbidden pattern '${name}' has ${matches.length} hit(s) — asset-registry.ts must route through the @forgeax/engine-rhi interface SSOT (OQ-6 + plan-strategy §6 M2); use RhiDevice / RhiQueue / Buffer brand types instead`,
      );
      failures += 1;
    }
  }

  if (failures > 0) {
    process.stderr.write(
      `asset-registry-dual-backend-grep-gate: ${failures} gate(s) failed; w21 (refactor) audits the file and adds the sentinel comment to clear the gate\n`,
    );
    process.exit(1);
  }
  process.stdout.write('asset-registry-dual-backend-grep-gate: all gates PASS\n');
  process.exit(0);
}

main();
