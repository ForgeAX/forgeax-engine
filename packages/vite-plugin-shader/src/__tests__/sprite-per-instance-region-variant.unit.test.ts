// sprite-per-instance-region-variant.unit.test.ts
// bug-20260708-sprite-wgsl-per-instance-region-compile-time-branch M1 / m1-1
//
// AC-01 falsifier gate: sprite.wgsl's `PER_INSTANCE_REGION` compile-time
// variant must produce byte-different composed WGSL modules when driven by
// `defines.PER_INSTANCE_REGION = true` vs `false`. The field-diagnosed
// buggy signal (research-decisions §R-1) is that sm6 (PIR=false) and sm240
// (PIR=true) WGSL bytes dumped from an asi-world RHI tape frame were
// byte-identical -- the two "variants" appear to be a shape-only lie. In
// that state non-SpriteInstances entities (character + per-tile-fold
// terrain when they bind the non-region pipeline) always land on
// `instances[idx].region` via the identity buffer's zero-filled region
// slot, producing zero-area UV sampling and transparent output.
//
// Test placement (plan deviation, documented in the M1 milestone report):
//   The nominal plan-tasks target for m1-1 is
//     `packages/shader/src/__tests__/sprite-variants.unit.test.ts`
//   but that package is under AC-06 physical-isolation constraints (grep
//   gates scripts/check-shader-runtime-deps.mjs + scripts/check-shader-no-
//   compiler-import.mjs) that forbid `@forgeax/engine-shader-compiler` in
//   its deps / devDeps and forbid importing it from src. This test needs
//   `compileShader` real compose to compute the SHA-256 diff (requirements
//   §AC-01), which cannot resolve from within `packages/shader`. This file
//   lives under `packages/vite-plugin-shader` where the plugin legitimately
//   consumes `@forgeax/engine-shader-compiler` (same package that already
//   composes sprite.wgsl in production; see vite-plugin-shader.unit.test.ts
//   compileEntry helper).
//
// Assertions (three, per requirements §AC-01 + plan-strategy §4 R-6):
//   (i)   SHA-256(compose({PIR:true}).wgsl) != SHA-256(compose({PIR:false}).wgsl)
//   (ii)  compose({PIR:true}).wgsl contains an `instances[<idx>].region` access
//   (iii) compose({PIR:false}).wgsl does NOT contain any `instances[<idx>].region`
//         access AND does contain `material.region` (the fallback path)
//
// M1 outcome (Round 1): all three assertions GREEN. The shader-compiler +
// naga_oil `#if PER_INSTANCE_REGION == true` composition DOES produce
// byte-different WGSL for the two define values (5653 B vs 5575 B; SHA-256
// diverges) and the PIR=false variant does NOT contain `instances[<idx>].region`
// while PIR=true does. This contradicts the plan-strategy §2 D-1 hypothesis
// (a) that the compose stage emits identical bytes, and per plan-strategy §7
// M1 acceptance ("if M1 turns green -- e.g. shader-compiler already works
// correctly -- the bug premise collapses and orchestrator escalates") the
// bug premise must be re-derived: root cause lives downstream of compose
// (candidates: vite-plugin-shader manifest generation, runtime pipeline
// binding, rhi-wgpu shader module cache, or the R-1 RHI tape dump slot
// indexing itself). See M1 milestone report `concerns` field for the full
// escalation.
//
// Anchors:
//   - requirements.md §AC-01 (SHA-256 diff + region-source presence/absence)
//   - research-decisions.md §R-1 (sm6.wgsl == sm240.wgsl byte-identical)
//   - plan-strategy.md §2 D-1 (M1 minimum repro), §4 R-1 / R-2 / R-6, §7 M1

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileShader } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHADER_SRC = resolve(HERE, '..', '..', '..', 'shader', 'src');

function readWgsl(file: string): string {
  return readFileSync(resolve(SHADER_SRC, file), 'utf8');
}

// Mirror the production strip pattern (packages/vite-plugin-shader/src/index.ts
// stripPragmas) so the entry source presented to compileShader matches what
// the plugin ships to naga_oil at build time.
const PRAGMA_RE = /^\s*#pragma\s+\S.*$/gm;
function stripPragmas(source: string): string {
  return source.replace(PRAGMA_RE, '');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function composeSpriteWithPir(perInstanceRegion: boolean): Promise<string> {
  const spriteSrc = stripPragmas(readWgsl('sprite.wgsl'));
  const entries = await loadEngineShaderEntries();
  const r = await compileShader(spriteSrc, {
    id: `sprite-pir-${perInstanceRegion}`,
    imports: entries.imports,
    defines: {
      STORAGE_BUFFER_AVAILABLE: true,
      ATMOSPHERE_AVAILABLE: false,
      PER_INSTANCE_REGION: perInstanceRegion,
    },
  });
  if (!r.ok) {
    throw new Error(
      `compileShader failed for PER_INSTANCE_REGION=${perInstanceRegion}: ${r.error.message}`,
    );
  }
  return r.value.wgsl;
}

// naga_oil composes imports by renaming module-scope symbols. The composer
// suffixes them with `X_naga_oil_mod_<base32>` so the imported `instances`
// storage buffer surfaces as `instancesX_naga_oil_mod_MZXXEZ3FMF4F65TJMV3...`
// in the composed WGSL. This regex tolerates both the raw and renamed forms.
const INSTANCES_REGION_RE = /instances[A-Za-z0-9_]*\s*\[[^\]]+\]\s*\.\s*region/;

describe('AC-01: PER_INSTANCE_REGION variant produces byte-different shader modules', () => {
  it('(i) SHA-256 of compose({PIR:true}) differs from compose({PIR:false})', async () => {
    const wgslTrue = await composeSpriteWithPir(true);
    const wgslFalse = await composeSpriteWithPir(false);
    const hashTrue = sha256(wgslTrue);
    const hashFalse = sha256(wgslFalse);
    expect(
      hashTrue,
      `expected byte-different WGSL for PIR=true (${hashTrue}) vs PIR=false (${hashFalse})`,
    ).not.toBe(hashFalse);
  });

  it('(ii) compose({PIR:true}) contains an instances[idx].region access', async () => {
    const wgslTrue = await composeSpriteWithPir(true);
    expect(
      wgslTrue,
      'PIR=true variant should read the per-instance region field (instances[idx].region)',
    ).toMatch(INSTANCES_REGION_RE);
  });

  it('(iii) compose({PIR:false}) uses material.region and lacks instances[idx].region', async () => {
    const wgslFalse = await composeSpriteWithPir(false);
    expect(
      wgslFalse,
      'PIR=false variant should still reference material.region (fallback path)',
    ).toMatch(/material\.region/);
    expect(
      wgslFalse,
      'PIR=false variant MUST NOT read the per-instance region field (instances[idx].region)',
    ).not.toMatch(INSTANCES_REGION_RE);
  });
});
