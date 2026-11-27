#!/usr/bin/env node
// scripts/lint/grep-pbr-ibl-callsite.mjs - feat-20260608-ci-time-cut M5 w15.
//
// Prereq: pnpm install && pnpm build (resolves @forgeax/* workspace symlinks
// when standalone-invoked outside `pnpm lint:grep`).
//
// The shared Standard lighting owner must evaluate diffuse Sky SH and sample specular IBL.
// Rigid, skin and fullscreen deferred entries must call that same owner.
// A placeholder ambient term or a detached shared helper fails this gate.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const PBR_PATH = resolve(REPO_ROOT, 'packages', 'shader', 'src', 'default-standard-pbr.wgsl');

const failures = [];
const src = readFileSync(PBR_PATH, 'utf8');
const shaderRoot = dirname(PBR_PATH);
const lighting = readFileSync(resolve(shaderRoot, 'standard-lighting.wgsl'), 'utf8');

function countCallSites(source, fnName) {
  let n = 0;
  const re = new RegExp(`\\b${fnName}\\s*\\(`);
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith('#import')) continue;
    if (trimmed.startsWith('//')) continue;
    const code = trimmed.replace(/\/\/.*$/, '');
    if (re.test(code)) n += 1;
  }
  return n;
}

if (
  countCallSites(lighting, 'evaluateSkyPolynomial') !== 1 ||
  countCallSites(lighting, 'sampleIblDiffuse') !== 0
) {
  failures.push('standard-lighting.wgsl must evaluate the shared Sky SH polynomial exactly once');
}
for (const helper of ['sampleIblRadiance', 'samplePmrem']) {
  if (countCallSites(lighting, helper) !== 1)
    failures.push(`standard-lighting.wgsl must sample shared ${helper} exactly once`);
}
// The selected environment is sampled once per lobe, including fallback sky.
if (countCallSites(lighting, 'sampleStandardReflectionRadiance') !== 3) {
  failures.push('standard-lighting.wgsl must share selected radiance between base and clearcoat');
}
// Nonlinear dielectric/metal scattering is evaluated before metalness mixing;
// radiance selection must not reintroduce a material response inside sampling.
if (countCallSites(lighting, 'environmentScatteringFromDfg') !== 2) {
  failures.push(
    'standard-lighting.wgsl must evaluate dielectric and metallic scattering separately',
  );
}

// The Forward wrapper and Deferred both reach the same scattering owner.
if (countCallSites(lighting, 'evaluateStandardEnvironmentFromRadiance') !== 2) {
  failures.push(
    'standard-lighting.wgsl must define and call the shared environment scattering owner',
  );
}
for (const entry of [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'standard-deferred-lighting.wgsl',
]) {
  const source = readFileSync(resolve(shaderRoot, entry), 'utf8');
  // Deferred selects standalone or array-layer radiance before shared
  // scattering and requests diffuse separately for subsurface diffusion.
  const deferred = entry === 'standard-deferred-lighting.wgsl';
  const environment = deferred
    ? 'evaluateStandardEnvironmentFromRadiance'
    : 'evaluateStandardEnvironment';
  const direct = deferred ? 'evaluateStandardDirectSplit' : 'evaluateStandardDirect';
  for (const helper of [environment, direct]) {
    if (
      !source.includes('#import forgeax_pbr::standard_lighting::') ||
      countCallSites(source, helper) !== 1 ||
      new RegExp(`\\bfn\\s+${helper}\\b`).test(source)
    )
      failures.push(`${entry} must call the shared ${helper} exactly once, without redefining it`);
  }
  // Physical clearcoat legitimately samples a separate specular lobe in the
  // Forward entries. Base diffuse, SH blending and clustered accumulation
  // belong only to standard-lighting, regardless of geometry or render path.
  for (const helper of [
    'sampleIblDiffuse',
    'evaluateProbeDiffuse',
    'evaluateStandardClusterLights',
  ]) {
    if (countCallSites(source, helper) !== 0)
      failures.push(`${entry} duplicates base lighting through ${helper}`);
  }
  if (!deferred && countCallSites(source, 'encodeStandardGBuffer') !== 1)
    failures.push(`${entry} must use the shared Standard G-buffer encoder exactly once`);
}

if (/M3 placeholder/.test(src)) {
  failures.push('default-standard-pbr.wgsl still carries the round-1 "M3 placeholder" comment');
}

const codeOnly = src
  .split(/\r?\n/)
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');
if (/var\s+ambient\s*=\s*vec3<f32>\(\s*0\.0\s*\)\s*;/.test(codeOnly)) {
  failures.push(
    'default-standard-pbr.wgsl still carries the hardcoded `var ambient = vec3<f32>(0.0)` placeholder',
  );
}

if (failures.length === 0) {
  console.log(
    'grep-pbr-ibl-callsite: pass (rigid, skin and Deferred share Standard environment/direct lighting; G-buffer encoder shared)',
  );
  process.exit(0);
} else {
  console.error('grep-pbr-ibl-callsite: FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
