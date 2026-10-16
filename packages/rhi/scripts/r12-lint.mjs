#!/usr/bin/env node
// R12 lint: descriptor field-name mirror gate (D-S2 / AC-RSC-08).
//
// Walks every `export type *Descriptor` (and `*Attachment`) alias in
// `@forgeax/engine-rhi` and asserts that each property name belongs to the matching
// `GPU*Descriptor` / `GPU*Attachment` from `@webgpu/types`. Field NAMES must
// align byte-for-byte; field TYPES may diverge (e.g. view narrow Path X
// narrows the spec union for the render-pass attachment view field down to
// the forgeax TextureView opaque handle).
//
// Why ts-morph (D-S2): `Pick<GPUXxxDescriptor, 'a' | 'b'>` resolves only at
// the type-checker layer; a regex / string scan cannot expand `Pick<>` against
// the spec d.ts. ts-morph loads `@webgpu/types@^0.1.69` via the project's
// `tsconfig.json` and exposes `getApparentType().getProperties()` which yields
// the exact field set after Pick / Omit / intersection rewrites.
//
// Exit codes:
//   0 - every forgeax descriptor's field set is a subset of the spec's.
//   1 - one or more drifted fields detected (printed to stderr).
//   2 - lint script failed to load the project (missing tsconfig, bad path).
//
// CLI flags:
//   --fixture <path>  Validate a fixture file's `*Descriptor` / `*Attachment`
//                     aliases instead of `packages/rhi/src/index.ts`. Used by
//                     w15 unit tests to confirm the lint catches drift.
//
// AGENTS.md "## RHI / WebGPU" iron law #1 spec-aligned: any drift here is a
// charter proposition 4 explicit failure surfaced via CI exit non-zero.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { Project } from 'ts-morph';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RHI_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(RHI_ROOT, '..', '..');
const TSCONFIG = resolve(RHI_ROOT, 'tsconfig.json');

// Map forgeax alias name -> spec type identifier in @webgpu/types. The mapping
// is explicit (no name-mangling heuristic) so adding a new descriptor is a
// one-line edit here + a new `export type` in src/.
//
// feat-20260510-rhi-resource-creation M7 (w46): added BindGroupDescriptor +
// PipelineLayoutDescriptor entries that were missing when M1 introduced the
// matching `export type` aliases (PR #25 stale). The collect-all sweep below
// reports any future drift between `export type *Descriptor` and SPEC_MAPPING
// instead of silently skipping unmapped aliases.
const SPEC_MAPPING = {
  BufferDescriptor: 'GPUBufferDescriptor',
  TextureDescriptor: 'GPUTextureDescriptor',
  SamplerDescriptor: 'GPUSamplerDescriptor',
  BindGroupDescriptor: 'GPUBindGroupDescriptor',
  BindGroupLayoutDescriptor: 'GPUBindGroupLayoutDescriptor',
  PipelineLayoutDescriptor: 'GPUPipelineLayoutDescriptor',
  RenderPipelineDescriptor: 'GPURenderPipelineDescriptor',
  CommandEncoderDescriptor: 'GPUCommandEncoderDescriptor',
  RenderBundleEncoderDescriptor: 'GPURenderBundleEncoderDescriptor',
  RenderBundleDescriptor: 'GPURenderBundleDescriptor',
  RenderPassDescriptor: 'GPURenderPassDescriptor',
  RenderPassColorAttachment: 'GPURenderPassColorAttachment',
  RenderPassDepthStencilAttachment: 'GPURenderPassDepthStencilAttachment',
  TextureViewDescriptor: 'GPUTextureViewDescriptor',
  ComputePipelineDescriptor: 'GPUComputePipelineDescriptor',
  ComputePassDescriptor: 'GPUComputePassDescriptor',
  QuerySetDescriptor: 'GPUQuerySetDescriptor',
};

// Aliases that are intentionally NOT mapped to a spec descriptor. Examples:
// - `RequestAdapterOptions` / `RequestDeviceOptions` mirror spec request
//   options that live outside the descriptor family.
// - `CanvasConfiguration` mirrors `GPUCanvasConfiguration`, but the alias
//   already enforces field-name parity through `Pick<GPUCanvasConfiguration,
//   ...>` and is checked by the canvas-context test suite, not r12-lint.
// Adding to this set is the explicit way to silence the collect-all sweep
// for aliases whose mirror is enforced by a different gate.
const SPEC_MAPPING_ALLOWLIST_UNMAPPED = new Set([
  'RequestAdapterOptions',
  'RequestDeviceOptions',
  'CanvasConfiguration',
  'RhiLimits',
]);

function parseArgs(argv) {
  const args = { fixture: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fixture') {
      args.fixture = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function loadProject() {
  if (!existsSync(TSCONFIG)) {
    process.stderr.write(`r12-lint: tsconfig not found at ${TSCONFIG}\n`);
    process.exit(2);
  }
  return new Project({
    tsConfigFilePath: TSCONFIG,
    skipFileDependencyResolution: false,
  });
}

function getSpecPropertySet(project, specName) {
  // The spec type lives in `@webgpu/types/dist/index.d.ts`. We read it via the
  // project's TypeChecker by referencing the symbol on any source file - the
  // simplest path is the rhi index.ts itself which already triple-slashes the
  // ambient types.
  const rhiIndex = project.getSourceFile(resolve(RHI_ROOT, 'src', 'index.ts'));
  if (!rhiIndex) return null;
  // Ambient `GPUXxxDescriptor` types are global; resolve via the program's
  // TypeChecker by constructing a synthetic `type _ = GPUXxx` lookup.
  const ambientLookup = rhiIndex
    .getDescendantsOfKind(project.compilerObject?.SyntaxKind?.TypeReference ?? 0)
    .find((node) => node.getText() === specName);
  if (ambientLookup) {
    const t = ambientLookup.getType().getApparentType();
    return new Set(t.getProperties().map((p) => p.getName()));
  }
  // Fallback: synthesize a type alias at the end of the source file in-memory.
  // ts-morph allows ephemeral source files; we use one to look up the global.
  const ephemeral = project.createSourceFile(
    resolve(REPO_ROOT, '__r12_lint_lookup__.ts'),
    `/// <reference types="@webgpu/types" />\nexport type __Lookup = ${specName};\n`,
    { overwrite: true },
  );
  const alias = ephemeral.getTypeAlias('__Lookup');
  if (!alias) {
    project.removeSourceFile(ephemeral);
    return null;
  }
  const props = alias.getType().getApparentType().getProperties();
  const names = new Set(props.map((p) => p.getName()));
  project.removeSourceFile(ephemeral);
  return names;
}

function lintSourceFile(project, sourceFile) {
  const violations = [];
  for (const alias of sourceFile.getTypeAliases()) {
    if (!alias.isExported()) continue;
    const name = alias.getName();
    const specName = SPEC_MAPPING[name];
    if (!specName) {
      // collect-all sweep (w46): catch stale aliases whose name ends with
      // `Descriptor` / `Attachment` / `Configuration` (spec mirror naming)
      // but never made it into SPEC_MAPPING. Without this sweep, a future
      // descriptor added to src/index.ts without a matching SPEC_MAPPING
      // entry would silently skip the field-name parity check (M1-M3 PR
      // #25 stale lesson: BindGroupDescriptor + PipelineLayoutDescriptor
      // landed without a SPEC_MAPPING update and the lint reported 0
      // violations even though no parity check ran on those aliases).
      const isMirrorCandidate =
        /Descriptor$/.test(name) ||
        /Attachment$/.test(name) ||
        /Configuration$/.test(name);
      if (isMirrorCandidate && !SPEC_MAPPING_ALLOWLIST_UNMAPPED.has(name)) {
        violations.push({
          alias: name,
          specName: '(none)',
          kind: 'spec-mapping-missing',
          message:
            `alias "${name}" looks like a spec mirror (Descriptor / Attachment / Configuration) ` +
            `but has no SPEC_MAPPING entry — add it to SPEC_MAPPING in this file ` +
            `or to SPEC_MAPPING_ALLOWLIST_UNMAPPED if mirror parity is enforced elsewhere`,
        });
      }
      continue;
    }
    const forgeaxProps = alias
      .getType()
      .getApparentType()
      .getProperties()
      .map((p) => p.getName());
    const specProps = getSpecPropertySet(project, specName);
    if (!specProps) {
      violations.push({
        alias: name,
        specName,
        kind: 'spec-lookup-failed',
        message: `could not resolve ${specName} via TypeChecker`,
      });
      continue;
    }
    for (const prop of forgeaxProps) {
      if (!specProps.has(prop)) {
        violations.push({
          alias: name,
          specName,
          kind: 'field-name-drift',
          field: prop,
          message:
            `field "${prop}" on ${name} is not present on ${specName} ` +
            `(spec fields: ${[...specProps].sort().join(', ')})`,
        });
      }
    }
  }
  return violations;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = loadProject();
  const targets = [];
  if (args.fixture) {
    const abs = resolve(process.cwd(), args.fixture);
    if (!existsSync(abs)) {
      process.stderr.write(`r12-lint: fixture not found at ${abs}\n`);
      process.exit(2);
    }
    const sf = project.addSourceFileAtPath(abs);
    targets.push(sf);
  } else {
    const sf = project.getSourceFile(resolve(RHI_ROOT, 'src', 'index.ts'));
    if (!sf) {
      process.stderr.write('r12-lint: packages/rhi/src/index.ts not in project\n');
      process.exit(2);
    }
    targets.push(sf);
  }
  let total = 0;
  for (const sf of targets) {
    const v = lintSourceFile(project, sf);
    total += v.length;
    for (const item of v) {
      process.stderr.write(`r12-lint: drift in ${sf.getFilePath()}: ${item.message}\n`);
    }
  }
  if (total > 0) {
    process.stderr.write(`r12-lint: ${total} violation(s) detected\n`);
    process.exit(1);
  }

  // w22 — Pick<GPU*> spec-mirror anchor count gate. Counts every `Pick<GPU...`
  // occurrence in the forgeax rhi interface (descriptors + attachments +
  // configurations + queue write wrappers). Floor anchored to 20 after
  // feat-20260511-rhi-spec-realign-aggressive M3 (writeTexture + 2 Pick params,
  // copyExternalImageToTexture + 2 Pick params; net Pick<GPU> hits >= 20).
  // Regression below floor signals an accidental loosening of the narrow form.
  const PICK_FLOOR = 20;
  let pickCount = 0;
  const PICK_RE = /Pick<GPU[A-Za-z0-9]+/g;
  for (const sf of targets) {
    const body = readFileSync(sf.getFilePath(), 'utf8');
    const matches = body.match(PICK_RE);
    if (matches !== null) pickCount += matches.length;
  }
  if (pickCount < PICK_FLOOR) {
    process.stderr.write(
      `r12-lint: Pick<GPU*> count ${pickCount} < floor ${PICK_FLOOR} ` +
        '(spec-mirror anchor regression; AC-08 w22 gate)\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `r12-lint: 0 violations across descriptor mirror; Pick<GPU*> count=${pickCount} (floor=${PICK_FLOOR})\n`,
  );
  process.exit(0);
}

main();
