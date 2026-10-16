#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  createBuiltinMaterialAsset,
} from '@forgeax/engine-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(new URL('..', import.meta.url).pathname);
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const SHADER_ROOT = resolve(REPO_ROOT, 'packages/shader/src');
const FIXTURE_ROOT = resolve(REPO_ROOT, 'scripts/forgeax/material-witness-fixtures');
const WASM_PROVENANCE_PATH = resolve(REPO_ROOT, 'packages/wgpu-wasm/pkg/provenance.json');
const FRAME_TARGET = 60;

function materialParametersFromSchema(schema) {
  return schema.map((parameter) => ({
    ...parameter,
    type: parameter.type === 'texture2d' ? 'texture' : parameter.type,
  }));
}

const GUIDS = {
  runtime: '019f0000-0000-7000-8000-000000000101',
  builtin: '019f0000-0000-7000-8000-000000000102',
  gltf: '019f0000-0000-7000-8000-000000000103',
  fbx: '019f0000-0000-7000-8000-000000000104',
  consumer: '019f0000-0000-7000-8000-000000000105',
};

const CONFIG = {
  runtime: { material: 'standard', smoke: ['@forgeax/hello-cube', 'smoke'], source: 'builtin' },
  builtin: { material: 'unlit', smoke: ['@forgeax/hello-triangle', 'smoke'], source: 'builtin' },
  gltf: { smoke: ['@forgeax/hello-gltf', 'smoke'], source: 'gltf' },
  fbx: { smoke: ['@forgeax/hello-fbx-cube', 'smoke'], source: 'fbx' },
  consumer: { smoke: ['@forgeax/hello-fbx-cube', 'smoke'], source: 'fbx' },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A witness may be blocked by an unavailable producer-owned root contract.
 * Keep this separate from a smoke failure: the witness must report the
 * missing authority without synthesising a parent material or its schema.
 */
export class MaterialWitnessBlockedError extends Error {
  constructor({ code, expected, hint, detail }) {
    super(expected);
    this.name = 'MaterialWitnessBlockedError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

function blocked({ code, expected, hint, detail }) {
  throw new MaterialWitnessBlockedError({ code, expected, hint, detail });
}

async function readSourceDeclaration(kind, sourcePath) {
  const metaPath = `${sourcePath}.meta.json`;
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch (error) {
    blocked({
      code: 'material-canonical-root-not-declared',
      expected: 'the imported source Meta sidecar to declare a canonical Standard root',
      hint: 'repair the source Meta and set importSettings.standardMaterialGuid before rerunning the witness',
      detail: {
        kind,
        sourcePath,
        metaPath,
        reason: 'meta-unreadable',
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    blocked({
      code: 'material-canonical-root-not-declared',
      expected: 'the imported source Meta sidecar to declare a canonical Standard root',
      hint: 'repair the source Meta and set importSettings.standardMaterialGuid before rerunning the witness',
      detail: { kind, sourcePath, metaPath, reason: 'meta-not-an-object' },
    });
  }
  return { metaPath, meta };
}

/** Read only the producer-declared canonical Standard root identity. */
export function canonicalRootGuidFromMeta(meta, { kind, sourcePath, metaPath }) {
  const settings =
    meta?.importSettings !== null &&
    typeof meta?.importSettings === 'object' &&
    !Array.isArray(meta.importSettings)
      ? meta.importSettings
      : undefined;
  const rootGuid = settings?.standardMaterialGuid;
  if (typeof rootGuid !== 'string' || rootGuid.length === 0) {
    blocked({
      code: 'material-canonical-root-not-declared',
      expected: 'importSettings.standardMaterialGuid to name the canonical Standard root',
      hint: 'declare the project-owned Standard root in the source Meta and re-run the importer',
      detail: {
        kind,
        sourcePath,
        metaPath,
        field: 'importSettings.standardMaterialGuid',
        reason: 'missing-standard-material-guid',
      },
    });
  }
  if (!GUID_RE.test(rootGuid)) {
    blocked({
      code: 'material-canonical-root-invalid',
      expected: 'importSettings.standardMaterialGuid to contain a valid AssetGuid',
      hint: 'repair the source Meta with the exact canonical Standard root GUID',
      detail: {
        kind,
        sourcePath,
        metaPath,
        field: 'importSettings.standardMaterialGuid',
        reason: 'invalid-standard-material-guid',
        actual: rootGuid,
      },
    });
  }
  return rootGuid;
}

/**
 * Require the Pack-owned root table at the NativeCooker boundary. A witness
 * may not silently turn a parent-bearing child into a leaf or manufacture a
 * replacement root contract.
 */
export function assertNativeCookerRootTable(kind, material, sourcePath, table) {
  if (material?.parent === undefined) return;
  if (table?.[material.parent] !== undefined) return;
  blocked({
    code: 'material-canonical-root-table-unavailable',
    expected: 'NativeCooker input to receive the Pack root table containing the canonical Standard parent',
    hint: 'route the witness through Pack publication after the cooker accepts the same root table; do not copy the root schema or add fallback parameters',
    detail: {
      kind,
      sourcePath,
      parentGuid: material.parent,
      cooker: 'createMaterialPackCooker',
      table: table === undefined ? 'missing' : 'canonical-root-row-missing',
      reason: 'native-cooker-input-has-no-pack-root-table',
    },
  });
}

/** Add the default Standard surface slot only to a root's actual passes. */
export function ensureStandardSurfaceModuleSlot(material) {
  if (material?.parent !== undefined || !Array.isArray(material?.passes)) return material;
  return {
    ...material,
    passes: material.passes.map((pass) => ({
      ...pass,
      program: {
        ...pass.program,
        moduleSlots: {
          ...pass.program.moduleSlots,
          surface: 'forgeax_material::default_standard_surface',
        },
      },
    })),
  };
}

/** Source-owned Pack publications for each imported witness source. */
function canonicalRootPublicationSources(kind) {
  switch (kind) {
    case 'fbx':
      return [
        {
          format: 'json',
          path: resolve(
            REPO_ROOT,
            'forgeax-engine-assets/vendor/fbx-test/standard-material-root.pack.json',
          ),
          sourceKey: 'material/standard-root',
        },
      ];
    case 'gltf':
      return [
        {
          format: 'ts',
          path: resolve(REPO_ROOT, 'templates/game-3d/assets/materials.pack.ts'),
          sourceKey: 'material/standard-root',
        },
      ];
    default:
      return [];
  }
}

function materialPublicationRows(pack, path, format, sourceKey) {
  if (pack === null || typeof pack !== 'object' || !Array.isArray(pack.assets)) return [];
  return pack.assets
    .filter((row) => row !== null && typeof row === 'object' && row.kind === 'material')
    .map((row) => ({
      guid: row.guid,
      asset: row.payload,
      path,
      format,
      sourceKey: typeof row.sourceKey === 'string' ? row.sourceKey : sourceKey,
    }));
}

async function readCanonicalRootPublications(kind) {
  const rows = [];
  for (const source of canonicalRootPublicationSources(kind)) {
    if (source.format === 'json') {
      const pack = JSON.parse(await readFile(source.path, 'utf8'));
      rows.push(...materialPublicationRows(pack, source.path, source.format, source.sourceKey));
      continue;
    }
    const result = await execFileAsync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        "import pack from './templates/game-3d/assets/materials.pack.ts'; import { AssetGuid } from '@forgeax/engine-pack/guid'; const built = await pack.build(); if (!built.ok) throw new Error(`game-3d materials Pack build failed: ${JSON.stringify(built.error)}`); process.stdout.write(JSON.stringify(Object.keys(built.value).map((sourceKey) => ({ sourceKey, guid: AssetGuid.format(AssetGuid.derive(pack.packageId, sourceKey)), asset: built.value[sourceKey] }))));",
      ],
      { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
    );
    const published = JSON.parse(result.stdout);
    if (Array.isArray(published)) {
      rows.push(
        ...published.map((row) => ({
          guid: row?.guid,
          asset: row?.asset,
          path: source.path,
          format: source.format,
          sourceKey: row?.sourceKey,
        })),
      );
    }
  }
  return rows;
}

/** Select one exact source-declared root publication; never synthesize/fallback. */
export function selectCanonicalRootPublication(rootGuid, kind, sourcePath, publications) {
  const matches = publications.filter(
    (publication) =>
      typeof publication?.guid === 'string' &&
      publication.guid.toLowerCase() === rootGuid.toLowerCase() &&
      publication.asset !== null &&
      typeof publication.asset === 'object' &&
      publication.asset.kind === 'material' &&
      typeof publication.path === 'string' &&
      typeof publication.format === 'string' &&
      typeof publication.sourceKey === 'string',
  );
  if (matches.length === 0) {
    blocked({
      code: 'material-canonical-root-not-published',
      expected: 'a configured source Pack to publish the exact canonical Standard root GUID',
      hint: 'repair the source-owned Pack publication and rerun the witness',
      detail: {
        kind,
        sourcePath,
        rootGuid,
        sources: canonicalRootPublicationSources(kind).map((source) => source.path),
        matchCount: 0,
        reason: 'source-pack-root-row-unavailable',
      },
    });
  }
  if (matches.length > 1) {
    blocked({
      code: 'material-canonical-root-ambiguous',
      expected: 'exactly one source Pack publication for the canonical Standard root GUID',
      hint: 'remove duplicate source-owned root rows before rerunning the witness',
      detail: {
        kind,
        sourcePath,
        rootGuid,
        matches: matches.map((match) => ({ path: match.path, sourceKey: match.sourceKey })),
        matchCount: matches.length,
        reason: 'duplicate-source-pack-root-rows',
      },
    });
  }
  const selected = matches[0];
  return {
    asset: selected.asset,
    provenance: {
      guid: selected.guid,
      format: selected.format,
      path: compactSourcePath(selected.path),
      sourceKey: selected.sourceKey,
    },
  };
}

/** Load one exact root row from the configured source Pack publication. */
async function canonicalStandardRoot(rootGuid, kind, sourcePath) {
  let publications;
  try {
    publications = await readCanonicalRootPublications(kind);
  } catch (error) {
    blocked({
      code: 'material-canonical-root-not-published',
      expected: 'a readable configured source Pack publication for the canonical Standard root',
      hint: 'repair the source-owned Pack publication and rerun the witness',
      detail: {
        kind,
        sourcePath,
        rootGuid,
        sources: canonicalRootPublicationSources(kind).map((source) => source.path),
        reason: 'source-pack-root-row-unreadable',
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return selectCanonicalRootPublication(rootGuid, kind, sourcePath, publications);
}

async function engineSources() {
  const entries = await readdir(SHADER_ROOT, { withFileTypes: true });
  const result = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.wgsl')) continue;
    const path = resolve(SHADER_ROOT, entry.name);
    const source = await readFile(path, 'utf8');
    const header = /^\s*#define_import_path\s+([^\s]+)/m.exec(source)?.[1];
    if (header === undefined) continue;
    result.set(header, { path, source });
  }
  return result;
}

async function materialFromSource(kind, sources) {
  if (kind === 'builtin') {
    return {
      ...createBuiltinMaterialAsset('unlit'),
      parameters: materialParametersFromSchema(DEFAULT_UNLIT_PARAM_SCHEMA),
    };
  }
  if (kind === 'gltf') {
    const path = resolve(REPO_ROOT, 'apps/hello/gltf/assets/box.gltf');
    const declaration = await readSourceDeclaration(kind, path);
    const standardRootGuid = canonicalRootGuidFromMeta(declaration.meta, {
      kind,
      sourcePath: path,
      metaPath: declaration.metaPath,
    });
    const { parseGltf, toMaterialAsset } = await import('@forgeax/engine-gltf');
    const parsed = await parseGltf(JSON.parse(await readFile(path, 'utf8')), async () => {
      throw new Error('gltf witness unexpectedly requested an external URI');
    }, path);
    assert(parsed.ok, `gltf source import failed: ${JSON.stringify(parsed.error)}`);
    const material = parsed.value.materials[0];
    assert(material !== undefined, 'gltf source has no material');
    return toMaterialAsset(material, { standardRootGuid });
  }
  const root = resolve(REPO_ROOT, 'forgeax-engine-assets/vendor/fbx-test');
  const metaPath = resolve(root, 'cube.fbx.meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const sourcePath = resolve(root, meta.source);
  const standardRootGuid = canonicalRootGuidFromMeta(meta, {
    kind,
    sourcePath,
    metaPath,
  });
  const bytes = new Uint8Array(await readFile(sourcePath));
  const { fbxImporter } = await import('@forgeax/engine-fbx');
  const imported = await fbxImporter.import({
    source: sourcePath,
    readSource: async () => ({ ok: true, value: bytes }),
    subAssets: meta.subAssets,
    importSettings: meta.importSettings ?? {},
  });
  assert(imported.ok, `fbx source import failed: ${JSON.stringify(imported.error)}`);
  const materialAsset = imported.value.assets.find((asset) => asset.kind === 'material');
  assert(materialAsset !== undefined, 'fbx source import produced no material');
  if (materialAsset.payload.parent !== standardRootGuid) {
    blocked({
      code: 'material-canonical-root-not-projected',
      expected: 'the FBX importer to project importSettings.standardMaterialGuid to MaterialAsset.parent',
      hint: 'repair the FBX importer bridge before publishing a parent-bearing material witness',
      detail: {
        kind,
        sourcePath,
        metaPath,
        field: 'MaterialAsset.parent',
        expectedParentGuid: standardRootGuid,
        actualParentGuid: materialAsset.payload.parent,
        reason: 'fbx-importer-did-not-project-standard-material-guid',
      },
    });
  }
  return materialAsset.payload;
}

async function cook(kind) {
  const config = CONFIG[kind];
  const guid = GUIDS[kind];
  const allSources = await engineSources();
  let material = config.material === 'standard'
    ? {
        ...createBuiltinMaterialAsset('standard'),
        parameters: materialParametersFromSchema(DEFAULT_STANDARD_PBR_PARAM_SCHEMA),
      }
    : await materialFromSource(config.source, allSources);
  const rootGuid = material.parent;
  const rootSelection = rootGuid === undefined
    ? undefined
    : await canonicalStandardRoot(
        rootGuid,
        config.source,
        config.source === 'fbx'
          ? resolve(REPO_ROOT, 'forgeax-engine-assets/vendor/fbx-test/cube.fbx')
          : resolve(REPO_ROOT, 'apps/hello/gltf/assets/box.gltf'),
      );
  let rootMaterial = rootSelection?.asset;
  const selected =
    material.passes?.[0]?.program.module ?? rootMaterial?.passes?.[0]?.program.module;
  assert(selected !== undefined, `${kind} material has no shader module`);
  if (
    selected === 'forgeax::default-standard-pbr' ||
    selected === 'forgeax_material::standard'
  ) {
    if (rootGuid === undefined) material = ensureStandardSurfaceModuleSlot(material);
    else rootMaterial = ensureStandardSurfaceModuleSlot(rootMaterial);
  }
  const selectedFile = selected === 'forgeax::default-unlit'
    ? 'unlit.wgsl'
    : selected === 'forgeax_material::unlit'
      ? 'unlit.wgsl'
      : selected === 'forgeax::default-standard-pbr'
        ? 'default-standard-pbr.wgsl'
        : selected === 'forgeax_material::standard'
          ? 'default-standard-pbr.wgsl'
            : selected === 'forgeax::pbr-skin'
            ? 'default-standard-pbr-skin.wgsl'
            : selected === 'forgeax_material::pbr-skin'
              ? 'default-standard-pbr-skin.wgsl'
        : undefined;
  assert(selectedFile !== undefined, `${kind} material uses unsupported module ${selected}`);
  const selectedPath = resolve(SHADER_ROOT, selectedFile);
  const table = rootGuid === undefined
    ? undefined
    : { [rootGuid]: rootMaterial, [guid]: material };
  assertNativeCookerRootTable(kind, material, selectedPath, table);
  const producer = createMaterialPackCooker([SHADER_ROOT]);
  const wasm = JSON.parse(await readFile(WASM_PROVENANCE_PATH, 'utf8'));
  const cookOne = (cookGuid, source) => producer.cook({
    guid: cookGuid,
    source,
    ...(table === undefined ? {} : { table }),
    sourcePath: selectedPath,
    sourceKey: basename(selectedPath),
    refs: [],
    compilerFingerprint: wasm.compilerFingerprint,
    wasm,
  });
  const draft = await cookOne(guid, material);
  const record = draft.payload.cooked;
  assert(record !== undefined, `${kind} production cook did not publish a cooked record`);
  const artifactPath = Object.keys(draft.artifacts)[0];
  assert(artifactPath !== undefined, `${kind} production cook did not publish an artifact`);
  const artifact = draft.artifacts[artifactPath];
  const rootDraft = rootGuid === undefined || rootMaterial === undefined
    ? undefined
    : await cookOne(rootGuid, rootMaterial);
  const rootRecord = rootDraft?.payload.cooked;
  const rootArtifactPath = rootDraft === undefined ? undefined : Object.keys(rootDraft.artifacts)[0];
  const rootArtifact =
    rootDraft === undefined || rootArtifactPath === undefined
      ? undefined
      : rootDraft.artifacts[rootArtifactPath];
  return {
    guid,
    material,
    refs: draft.refs,
    rootGuid,
    rootPublicationSource: rootSelection?.provenance,
    rootMaterial,
    rootPublication:
      rootRecord === undefined || rootArtifact === undefined
        ? undefined
        : {
            record: rootRecord,
            artifactBytes: rootArtifact.bytes,
            artifactDigest: rootRecord.artifactDigest,
          },
    publication: {
      record,
      artifactBytes: artifact.bytes,
      artifactDigest: record.artifactDigest,
    },
    sourceClosure: record.receipt.sourceClosure,
  };
}

function compactSourcePath(source) {
  return isAbsolute(source) ? relative(REPO_ROOT, source) : source;
}

/**
 * A witness is a standalone producer gate, so it cannot depend on a caller
 * having materialized an unrelated app dist first. Reuse an existing manifest
 * when present; clean runners build the one app that owns this smoke before
 * invoking its real Dawn path.
 */
async function ensureSmokeBuild(filter) {
  const prefix = '@forgeax/hello-';
  assert(filter.startsWith(prefix), `unsupported material witness smoke package ${filter}`);
  const appName = filter.slice(prefix.length);
  const manifestPath = resolve(REPO_ROOT, 'apps/hello', appName, 'dist/shaders/manifest.json');
  try {
    await readFile(manifestPath);
    return;
  } catch {
    // The clean-runner path is expected to have no app dist yet.
  }
  try {
    await execFileAsync('pnpm', ['--filter', filter, 'build'], {
      cwd: REPO_ROOT,
      env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `${filter} material witness build failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function compactSourceClosure(sourceClosure) {
  return sourceClosure.map(compactSourcePath);
}

function authoredKeyCensus(material) {
  const forbiddenFields = ['colorSpace', 'passes', 'parameters'].filter((field) =>
    Object.prototype.hasOwnProperty.call(material, field),
  );
  return {
    authoredKeys: Object.keys(material).sort(),
    forbiddenFields,
  };
}

/** A reproducible witness projection; never persist cooked WGSL bytes or absolute paths. */
export function buildMaterialWitnessReceipt(kind, cooked) {
  const identity = cooked.publication.record.receipt?.identity;
  assert(identity !== undefined, `${kind} production cook did not publish receipt identity`);
  const census = authoredKeyCensus(cooked.material);
  return {
    schemaVersion: 'material-witness-receipt/1',
    kind: 'material-witness-receipt',
    sourceKind: kind,
    materialGuid: cooked.guid,
    rootGuid: cooked.rootGuid ?? cooked.guid,
    rootPublication: cooked.rootPublicationSource ?? null,
    child: census,
    receipt: { identity },
    artifactDigest: cooked.publication.record.artifactDigest,
    sourceClosure: compactSourceClosure(cooked.sourceClosure),
  };
}

async function writeFixture(kind, cooked) {
  const path = resolve(FIXTURE_ROOT, `${kind}.receipt.json`);
  const receipt = buildMaterialWitnessReceipt(kind, cooked);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return relative(REPO_ROOT, path);
}

function parseReadback(output) {
  const line = output.split('\n').find((entry) => entry.includes('pixelSamples='));
  if (line === undefined) return undefined;
  try {
    const samples = JSON.parse(line.slice(line.indexOf('pixelSamples=') + 'pixelSamples='.length));
    return samples.ndcCenter ?? samples.center ?? Object.values(samples)[0];
  } catch {
    return undefined;
  }
}

async function runSmoke(kind, cooked) {
  const [filter, script] = CONFIG[kind].smoke;
  let result;
  try {
    await ensureSmokeBuild(filter);
    const completed = await execFileAsync('pnpm', ['--filter', filter, script], {
      cwd: REPO_ROOT,
      env: { ...process.env, SMOKE_MIN_FRAMES: String(FRAME_TARGET) },
      maxBuffer: 16 * 1024 * 1024,
    });
    result = { stdout: completed.stdout, stderr: completed.stderr, exitCode: 0 };
  } catch (error) {
    result = { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code ?? 1 };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const frames = Number(/frames(?: observed)?[=:](\d+)/i.exec(output)?.[1] ?? 0);
  const pixel = parseReadback(output);
  assert(result.exitCode === 0, `${kind} smoke exited with ${result.exitCode}: ${output.slice(-800)}`);
  assert(frames >= FRAME_TARGET, `${kind} smoke observed ${frames} frames`);
  assert(Array.isArray(pixel) && pixel.length >= 3 && pixel.some((value) => Number(value) > 0), `${kind} smoke had no non-zero Dawn readback`);
  return {
    status: 'pass',
    renderer: 'forgeax-runtime',
    backend: 'dawn-webgpu',
    frames,
    pixel: [...pixel, 1],
    // The receipt identity intentionally omits the asset GUID because it is
    // derived from the cook contract.  Fleet provenance still needs the
    // imported child identity (not its inherited root) to match the witness
    // declaration, so attach the producer GUID at this output boundary.
    materialIdentity: {
      ...cooked.publication.record.receipt.identity,
      materialGuid: cooked.guid,
    },
    rootGuid: cooked.rootGuid ?? cooked.guid,
    rootPublication: cooked.rootPublicationSource ?? null,
    observed: {
      draw: true,
      readback: 'Dawn copyTextureToBuffer',
      sourceClosure: compactSourceClosure(cooked.sourceClosure),
    },
    verdict: 'pass',
    confidence: 'high',
  };
}

function blockedEvidence(kind, error) {
  return {
    status: 'blocked',
    verdict: 'blocked',
    witness: { kind, materialGuid: GUIDS[kind] },
    blocked: {
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: error.detail,
    },
  };
}

async function main() {
  const kind = process.argv[2];
  const write = process.argv.includes('--write-fixture');
  assert(
    typeof kind === 'string' && CONFIG[kind] !== undefined,
    `usage: ${basename(process.argv[1])} <runtime|builtin|gltf|fbx|consumer> [--write-fixture]`,
  );
  try {
    const cooked = await cook(kind);
    const fixture = write ? await writeFixture(kind, cooked) : undefined;
    const evidence = await runSmoke(kind, cooked);
    console.log(JSON.stringify({
      ...evidence,
      fixture: fixture ?? `scripts/forgeax/material-witness-fixtures/${kind}.receipt.json`,
      source: compactSourceClosure(cooked.sourceClosure),
    }));
  } catch (error) {
    if (!(error instanceof MaterialWitnessBlockedError)) throw error;
    console.log(JSON.stringify(blockedEvidence(kind, error)));
    process.exitCode = 2;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
