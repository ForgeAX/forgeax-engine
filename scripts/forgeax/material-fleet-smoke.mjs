#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);
const ROSTER_ROOTS = ['apps/hello', 'apps/learn-render'];
const FRAME_TARGET = 60;
const MATERIAL_DECLARATION_PATH = 'scripts/forgeax/material-acceptance.declaration.json';
const MATERIAL_CORE_IDENTITY_FIELDS = [
  'layoutIdentity',
  'programIdentity',
  'pipelineIdentity',
  'cookIdentity',
  'compilerFingerprint',
  'artifactDigest',
];
const MATERIAL_RECEIPT_IDENTITY_FIELDS = [
  ...MATERIAL_CORE_IDENTITY_FIELDS,
  'materialPublicationIdentity',
  'valueGeneration',
  'dependencyGeneration',
  'cookGeneration',
];
const MATERIAL_GENERATION_FIELDS = new Set([
  'valueGeneration',
  'dependencyGeneration',
  'cookGeneration',
]);
const MATERIAL_WITNESS_RECEIPT_SCHEMA = 'material-witness-receipt/1';
const MATERIAL_WITNESS_RECEIPT_KIND = 'material-witness-receipt';
const MATERIAL_CHILD_FORBIDDEN_FIELDS = ['colorSpace', 'passes', 'parameters'];
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedGuid(value) {
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function isMaterialIdentityValue(field, value) {
  return MATERIAL_GENERATION_FIELDS.has(field)
    ? Number.isSafeInteger(value) && value >= 1
    : typeof value === 'string' && value.length > 0;
}

function readPackage(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

function discoverRoster(root) {
  const absoluteRoot = resolve(REPO_ROOT, root);
  const found = [];
  for (const name of readdirSync(absoluteRoot).sort()) {
    const dir = join(absoluteRoot, name);
    if (!statSync(dir).isDirectory() || name === 'node_modules') continue;
    const packageJson = readPackage(dir);
    if (packageJson !== undefined) found.push({ dir, root, packageJson });
    found.push(...discoverNested(dir, root));
  }
  return found;
}

function discoverNested(parent, root) {
  const found = [];
  for (const name of readdirSync(parent).sort()) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue;
    const dir = join(parent, name);
    if (!statSync(dir).isDirectory()) continue;
    const packageJson = readPackage(dir);
    if (packageJson !== undefined) found.push({ dir, root, packageJson });
    found.push(...discoverNested(dir, root));
  }
  return found;
}

function findFrameCount(value) {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    return value.reduce((max, entry) => Math.max(max, findFrameCount(entry) ?? 0), 0) || undefined;
  }
  let max;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /^(?:frames|frameCount|observedFrames|frameTarget)$/.test(key) &&
      typeof entry === 'number'
    ) {
      max = Math.max(max ?? 0, entry);
    }
    const nested = findFrameCount(entry);
    if (nested !== undefined) max = Math.max(max ?? 0, nested);
  }
  return max;
}

function findMaterialIdentity(value) {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const identity = findMaterialIdentity(entry);
      if (identity !== undefined) return identity;
    }
    return undefined;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'materialIdentity' && entry !== null && typeof entry === 'object') return entry;
    const identity = findMaterialIdentity(entry);
    if (identity !== undefined) return identity;
  }
  return undefined;
}

export function parseSmokeOutput(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonRecords = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === 'object') jsonRecords.push(value);
    } catch {
      // Smoke scripts may prefix their JSON with a human-readable marker.
    }
  }
  const jsonFrameCount = findFrameCount(jsonRecords);
  const textFrameCounts = lines.flatMap((line) =>
    [
      ...line.matchAll(
        /["']?(?:frames?|frameCount|observedFrames)["']?\s*(?:observed\s*)?(?:=|:)\s*(\d+)/gi,
      ),
      ...line.matchAll(
        /\b(?:rendered|observed|completed|processed|ran)\s*[:=]?\s*(\d+)\s+frames?\b/gi,
      ),
      ...line.matchAll(/\b(\d+)\s+frames?\b/gi),
    ].map((match) => Number(match[1])),
  );
  const frameCount = Math.max(jsonFrameCount ?? 0, ...textFrameCounts, 0);
  const pixel =
    jsonRecords.some((record) => JSON.stringify(record).includes('pixel')) ||
    lines.some((line) => /["']pixel(?:Samples)?["']\s*:/i.test(line));
  const structural =
    jsonRecords.some((record) => JSON.stringify(record).includes('structural')) ||
    lines.some((line) => /["']structural["']\s*:/i.test(line));
  const jsonSuccess = jsonRecords.some((record) => record.ok === true);
  const declaredPass = lines.some((line) => /\bPASS\b/.test(line)) || jsonSuccess;
  const expectedDeviceLossPass = lines.some((line) =>
    /\[m7-browser-device-loss\]\s+PASS\b/.test(line),
  );
  const rawMarkers = lines.filter((line) => {
    if (expectedDeviceLossPass && /\[RhiError\s+device-lost\]/i.test(line)) return false;
    if (
      /\bRhiError\b/i.test(line) &&
      !/\bRhiError\b(?:\s*(?:count|total)\s*)?[=:]\s*0\b/i.test(line)
    ) {
      return true;
    }
    return /\b(?:FAIL(?:ED|URE)?|shader-compile-failed|material-(?:derived-interface-mismatch|texture-coordinate-invalid)|queue-submit-failed|limit-exceeded)\b/.test(
      line,
    );
  });
  const expectedFalsifierPass = lines.some((line) =>
    /(?:expected\s+non-zero\s+falsifier|falsifier.*\b(?:PASS|GREEN)\b)/i.test(line),
  );
  const compositePass = lines.some((line) =>
    /\bPASS\b.*(?:\bGREEN\b|\bgates?\b|\bcriteria\b|\ball\s+\d+\s+modes?\b)/i.test(line),
  );
  const markers = compositePass && expectedFalsifierPass ? [] : rawMarkers;
  return {
    frameCount: frameCount ?? 0,
    criterion:
      pixel || structural || frameCount >= FRAME_TARGET
        ? pixel
          ? 'pixel'
          : 'structural'
        : declaredPass
          ? 'declared'
          : 'unreported',
    declaredPass,
    expectedFalsifierPass,
    materialIdentity: findMaterialIdentity(jsonRecords),
    markers,
    tail: lines.slice(-8),
  };
}

export function validateMaterialAcceptanceDeclaration(declaration, pathExists = existsSync) {
  const errors = [];
  if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
    return { ok: false, errors: ['declaration must be an object'] };
  }
  if (declaration.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (declaration.kind !== 'material-acceptance-declaration') {
    errors.push('kind must be material-acceptance-declaration');
  }
  if (typeof declaration.producer !== 'string' || declaration.producer.length === 0) {
    errors.push('producer must be a non-empty string');
  }
  if (
    !Array.isArray(declaration.requiredCategories) ||
    declaration.requiredCategories.length === 0
  ) {
    errors.push('requiredCategories must be a non-empty array');
  }
  if (!Array.isArray(declaration.witnesses) || declaration.witnesses.length === 0) {
    errors.push('witnesses must be a non-empty array');
    return { ok: errors.length === 0, errors };
  }
  const ids = new Set();
  const categories = new Set();
  for (const witness of declaration.witnesses) {
    if (witness === null || typeof witness !== 'object' || Array.isArray(witness)) {
      errors.push('each witness must be an object');
      continue;
    }
    if (typeof witness.id !== 'string' || witness.id.length === 0 || ids.has(witness.id)) {
      errors.push(`witness id is missing or duplicated: ${String(witness.id)}`);
    }
    ids.add(witness.id);
    if (typeof witness.category !== 'string' || witness.category.length === 0) {
      errors.push(`${witness.id ?? '<unknown>'} category is missing`);
    } else {
      categories.add(witness.category);
    }
    if (typeof witness.subject !== 'string' || witness.subject.length === 0) {
      errors.push(`${witness.id ?? '<unknown>'} subject is missing`);
    }
    if (typeof witness.fixture !== 'string' || witness.fixture.length === 0) {
      errors.push(`${witness.id ?? '<unknown>'} fixture is missing`);
    } else if (!pathExists(resolve(REPO_ROOT, witness.fixture))) {
      errors.push(`${witness.id ?? '<unknown>'} fixture is missing: ${witness.fixture}`);
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        witness.materialGuid ?? '',
      )
    ) {
      errors.push(`${witness.id ?? '<unknown>'} materialGuid is invalid`);
    }
    if (witness.evidence !== 'browser' && witness.evidence !== 'dawn') {
      errors.push(`${witness.id ?? '<unknown>'} evidence must be browser or dawn`);
    }
    if (
      witness.command === null ||
      typeof witness.command !== 'object' ||
      typeof witness.command.program !== 'string' ||
      !Array.isArray(witness.command.args)
    ) {
      errors.push(`${witness.id ?? '<unknown>'} command must contain program and args`);
    }
  }
  for (const category of declaration.requiredCategories ?? []) {
    if (typeof category !== 'string' || category.length === 0)
      errors.push('required category is invalid');
  }
  if (
    new Set(declaration.requiredCategories ?? []).size !==
    (declaration.requiredCategories ?? []).length
  ) {
    errors.push('requiredCategories must be unique');
  }
  return { ok: errors.length === 0, errors, declaredCategories: [...categories] };
}

export function hasRealMaterialEvidence(evidence, mode) {
  if (evidence === null || typeof evidence !== 'object') return false;
  const identity = evidence.materialIdentity;
  if (identity === null || typeof identity !== 'object') return false;
  if (
    MATERIAL_CORE_IDENTITY_FIELDS.some((field) => !isMaterialIdentityValue(field, identity[field]))
  ) {
    return false;
  }
  if (mode === 'browser') {
    const readback =
      evidence.readback ?? evidence.renderDiagnostics?.readback ?? evidence.browserVisual;
    const pixel = evidence.pixel;
    return (
      evidence.browserPath === true &&
      evidence.webgpu === true &&
      readback?.status === 'ok' &&
      Number(readback.nonZeroBytes) > 0 &&
      Number(readback.nonZeroAlphaPixels) > 0 &&
      Array.isArray(pixel) &&
      pixel.length >= 4 &&
      pixel.slice(0, 3).some((value) => Number(value) > 0) &&
      Number(pixel[3]) > 0
    );
  }
  return (
    evidence.frames >= FRAME_TARGET &&
    Array.isArray(evidence.pixel) &&
    evidence.pixel.length >= 4 &&
    evidence.pixel.some((value, index) => index < 3 && Number(value) > 0) &&
    Number(evidence.pixel[3]) > 0
  );
}

export function buildMaterialAcceptanceVerdict(declaration, witnessResults) {
  const results = Array.isArray(witnessResults) ? witnessResults : [];
  const byId = new Map(results.map((result) => [result.witnessId, result]));
  const missingWitnesses = declaration.witnesses
    .filter((witness) => !byId.has(witness.id))
    .map((witness) => witness.id);
  const failedWitnesses = declaration.witnesses
    .filter((witness) => byId.get(witness.id)?.verdict !== 'pass')
    .map((witness) => witness.id);
  const observedCategories = new Set(
    declaration.witnesses
      .map((witness) => (byId.get(witness.id)?.verdict === 'pass' ? witness.category : undefined))
      .filter((category) => category !== undefined),
  );
  const missingCategories = (declaration.requiredCategories ?? []).filter(
    (category) => !observedCategories.has(category),
  );
  return {
    schemaVersion: 1,
    requiredWitnessCount: declaration.witnesses.length,
    observedWitnessCount: results.filter((result) => result.verdict === 'pass').length,
    requiredCategories: declaration.requiredCategories ?? [],
    observedCategories: [...observedCategories].sort(),
    missingWitnesses,
    failedWitnesses: [...new Set(failedWitnesses.filter((id) => id !== undefined))],
    missingCategories,
    verdict:
      missingWitnesses.length === 0 &&
      failedWitnesses.length === 0 &&
      missingCategories.length === 0
        ? 'pass'
        : 'fail',
    witnesses: results,
  };
}

function jsonRecords(stdout, stderr) {
  return `${stdout}\n${stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value !== null && typeof value === 'object' ? [value] : [];
      } catch {
        return [];
      }
    });
}

function isMaterialPassRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.status === 'pass' &&
    value.materialIdentity !== null &&
    typeof value.materialIdentity === 'object' &&
    !Array.isArray(value.materialIdentity)
  );
}

function findCookedFixture(value, materialGuid) {
  if (value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCookedFixture(entry, materialGuid);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const valueGuid = normalizedGuid(value.guid);
  const targetGuid = normalizedGuid(materialGuid);
  if (valueGuid !== undefined && valueGuid === targetGuid) {
    const cooked = value.payload?.cooked;
    if (cooked !== null && typeof cooked === 'object') return cooked;
  }
  for (const entry of Object.values(value)) {
    const found = findCookedFixture(entry, materialGuid);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function compactFixtureIdentity(fixture, witness) {
  const errors = [];
  if (fixture.schemaVersion !== MATERIAL_WITNESS_RECEIPT_SCHEMA) {
    errors.push(`fixture schema must be ${MATERIAL_WITNESS_RECEIPT_SCHEMA}`);
  }
  if (fixture.kind !== MATERIAL_WITNESS_RECEIPT_KIND) {
    errors.push(`fixture kind must be ${MATERIAL_WITNESS_RECEIPT_KIND}`);
  }
  const materialGuid = normalizedGuid(fixture.materialGuid);
  const rootGuid = normalizedGuid(fixture.rootGuid);
  if (typeof fixture.materialGuid !== 'string' || !GUID_RE.test(fixture.materialGuid)) {
    errors.push('fixture materialGuid is invalid');
  }
  if (typeof fixture.rootGuid !== 'string' || !GUID_RE.test(fixture.rootGuid)) {
    errors.push('fixture rootGuid is invalid');
  }
  if (materialGuid !== normalizedGuid(witness?.materialGuid)) {
    errors.push(`fixture material GUID mismatch: expected ${witness.materialGuid}`);
  }
  const rootPublication = fixture.rootPublication;
  const rootPublicationValid =
    rootPublication !== null &&
    typeof rootPublication === 'object' &&
    typeof rootPublication.guid === 'string' &&
    GUID_RE.test(rootPublication.guid) &&
    typeof rootPublication.format === 'string' &&
    typeof rootPublication.path === 'string' &&
    !isAbsolute(rootPublication.path) &&
    typeof rootPublication.sourceKey === 'string';
  if (rootPublication !== null && !rootPublicationValid) {
    errors.push('fixture rootPublication must be null or a relative source provenance object');
  }
  if (rootPublicationValid && normalizedGuid(rootPublication.guid) !== rootGuid) {
    errors.push('fixture rootPublication guid must equal rootGuid');
  }
  if (rootGuid !== materialGuid && rootPublication === null) {
    errors.push('parent-bearing fixture must contain rootPublication provenance');
  }
  const child = fixture.child;
  if (
    child === null ||
    typeof child !== 'object' ||
    !Array.isArray(child.authoredKeys) ||
    !Array.isArray(child.forbiddenFields)
  ) {
    errors.push('fixture child must contain authoredKeys and forbiddenFields arrays');
  } else {
    const authoredKeys = [...child.authoredKeys].sort();
    const forbiddenFields = [...child.forbiddenFields].sort();
    if (!authoredKeys.every((key) => typeof key === 'string')) {
      errors.push('fixture child authoredKeys must contain strings');
    }
    if (!forbiddenFields.every((field) => MATERIAL_CHILD_FORBIDDEN_FIELDS.includes(field))) {
      errors.push('fixture child forbiddenFields contains an unknown field');
    }
    if (rootGuid !== materialGuid) {
      const expectedKeys = ['kind', 'parent', 'values'];
      if (JSON.stringify(authoredKeys) !== JSON.stringify(expectedKeys)) {
        errors.push(`fixture child authoredKeys must equal ${expectedKeys.join(',')}`);
      }
      if (forbiddenFields.length > 0) errors.push('fixture child must have no forbidden fields');
    }
  }
  const identity = fixture.receipt?.identity;
  if (identity === null || typeof identity !== 'object') {
    errors.push('fixture does not contain a receipt identity');
  } else {
    const missing = MATERIAL_RECEIPT_IDENTITY_FIELDS.filter(
      (field) => !isMaterialIdentityValue(field, identity[field]),
    );
    if (missing.length > 0) errors.push(`fixture receipt identity lacks ${missing.join(', ')}`);
    const wasm = identity.wasm;
    const missingWasm =
      wasm === null || typeof wasm !== 'object'
        ? ['wasm.sourceContentKey', 'wasm.artifactSha256', 'wasm.glueSha256']
        : ['sourceContentKey', 'artifactSha256', 'glueSha256']
            .filter(
              (field) =>
                typeof wasm[field] !== 'string' ||
                wasm[field].length === 0 ||
                wasm[field] === 'unavailable',
            )
            .map((field) => `wasm.${field}`);
    if (missingWasm.length > 0)
      errors.push(`fixture receipt identity lacks ${missingWasm.join(', ')}`);
  }
  if (typeof fixture.artifactDigest !== 'string' || fixture.artifactDigest.length === 0) {
    errors.push('fixture artifactDigest is missing');
  }
  if (
    !Array.isArray(fixture.sourceClosure) ||
    !fixture.sourceClosure.every((source) => typeof source === 'string' && !isAbsolute(source))
  ) {
    errors.push('fixture sourceClosure must contain repository-relative paths or module IDs');
  }
  return errors.length === 0
    ? {
        schemaVersion: MATERIAL_WITNESS_RECEIPT_SCHEMA,
        identity,
        artifactDigest: fixture.artifactDigest,
        materialGuid: fixture.materialGuid,
        rootGuid: fixture.rootGuid,
        rootPublication,
        child,
        sourceClosure: fixture.sourceClosure,
      }
    : { error: errors.join('; ') };
}

function fixtureIdentity(witness) {
  const fixturePath = resolve(REPO_ROOT, witness.fixture);
  if (!fixturePath.endsWith('.json')) {
    return { error: 'fixture is not a JSON cooked material package' };
  }
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  } catch (error) {
    return {
      error: `fixture JSON could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (fixture?.schemaVersion === MATERIAL_WITNESS_RECEIPT_SCHEMA) {
    return compactFixtureIdentity(fixture, witness);
  }
  const cooked = findCookedFixture(fixture, witness.materialGuid);
  const identity = cooked?.receipt?.identity;
  if (cooked?.receipt?.schemaVersion !== 'material-cook/4') {
    return { error: 'fixture does not contain a material-cook/4 receipt' };
  }
  if (identity === null || typeof identity !== 'object') {
    return { error: 'fixture does not contain a receipt identity' };
  }
  const missing = MATERIAL_RECEIPT_IDENTITY_FIELDS.filter(
    (field) => !isMaterialIdentityValue(field, identity[field]),
  );
  const wasm = identity.wasm;
  const missingWasm =
    wasm === null || typeof wasm !== 'object'
      ? ['wasm.sourceContentKey', 'wasm.artifactSha256', 'wasm.glueSha256']
      : ['sourceContentKey', 'artifactSha256', 'glueSha256']
          .filter(
            (field) =>
              typeof wasm[field] !== 'string' ||
              wasm[field].length === 0 ||
              wasm[field] === 'unavailable',
          )
          .map((field) => `wasm.${field}`);
  return missing.length === 0 && missingWasm.length === 0
    ? { identity, artifactDigest: cooked.artifactDigest }
    : { error: `fixture receipt identity lacks ${[...missing, ...missingWasm].join(', ')}` };
}

export function compareCompactFixtureToLive(fixture, evidence) {
  if (fixture?.schemaVersion !== MATERIAL_WITNESS_RECEIPT_SCHEMA) return [];
  if (fixture.error !== undefined || evidence === null || typeof evidence !== 'object') return [];
  const errors = [];
  const liveIdentity = evidence.materialIdentity;
  if (normalizedGuid(fixture.materialGuid) !== normalizedGuid(liveIdentity?.materialGuid)) {
    errors.push(`fixture/live material GUID mismatch: expected ${fixture.materialGuid}`);
  }
  if (normalizedGuid(fixture.rootGuid) !== normalizedGuid(evidence.rootGuid)) {
    errors.push(`fixture/live root GUID mismatch: expected ${fixture.rootGuid}`);
  }
  for (const field of MATERIAL_RECEIPT_IDENTITY_FIELDS) {
    if (fixture.identity?.[field] !== liveIdentity?.[field]) {
      errors.push(`stale fixture identity ${field}`);
    }
  }
  if (fixture.artifactDigest !== liveIdentity?.artifactDigest) {
    errors.push('stale fixture artifactDigest');
  }
  const expectedRootPublication = fixture.rootPublication;
  const liveRootPublication = evidence.rootPublication;
  if (!Object.hasOwn(evidence, 'rootPublication')) {
    errors.push('live rootPublication is missing');
  } else if (expectedRootPublication === null) {
    if (liveRootPublication !== null) errors.push('fixture/live rootPublication mismatch');
  } else if (
    expectedRootPublication === null ||
    typeof expectedRootPublication !== 'object' ||
    Array.isArray(expectedRootPublication) ||
    liveRootPublication === null ||
    typeof liveRootPublication !== 'object' ||
    Array.isArray(liveRootPublication) ||
    typeof liveRootPublication.guid !== 'string' ||
    !GUID_RE.test(liveRootPublication.guid) ||
    typeof liveRootPublication.format !== 'string' ||
    typeof liveRootPublication.path !== 'string' ||
    isAbsolute(liveRootPublication.path) ||
    typeof liveRootPublication.sourceKey !== 'string'
  ) {
    errors.push('live rootPublication is missing or invalid');
  } else {
    if (normalizedGuid(liveRootPublication.guid) !== normalizedGuid(fixture.rootGuid)) {
      errors.push('live rootPublication guid must equal rootGuid');
    }
    for (const field of ['guid', 'path', 'sourceKey', 'format']) {
      const expected = expectedRootPublication[field];
      const actual = liveRootPublication[field];
      const equal =
        field === 'guid'
          ? normalizedGuid(expected) === normalizedGuid(actual)
          : expected === actual;
      if (!equal) errors.push(`stale fixture rootPublication ${field}`);
    }
  }
  const liveClosure = evidence.source ?? evidence.observed?.sourceClosure;
  if (!Array.isArray(liveClosure)) {
    errors.push('live sourceClosure is missing');
  } else if (JSON.stringify(fixture.sourceClosure) !== JSON.stringify(liveClosure)) {
    errors.push('stale fixture sourceClosure');
  }
  return errors;
}

export async function runMaterialWitness(witness) {
  const fixture = fixtureIdentity(witness);
  const command = witness.command;
  let result;
  try {
    const commandResult = await execFileAsync(command.program, command.args, {
      cwd: command.cwd === undefined ? REPO_ROOT : resolve(REPO_ROOT, command.cwd),
      env: { ...process.env, SMOKE_MIN_FRAMES: String(FRAME_TARGET) },
      maxBuffer: 16 * 1024 * 1024,
    });
    result = { stdout: commandResult.stdout, stderr: commandResult.stderr, exitCode: 0 };
  } catch (error) {
    result = {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.code ?? 1,
    };
  }
  const records = jsonRecords(result.stdout, result.stderr);
  const parsed = parseSmokeOutput(result.stdout, result.stderr);
  const rawEvidence = records.at(-1) ?? {};
  const passEvidence = [...records].reverse().find(isMaterialPassRecord);
  const materialIdentity =
    passEvidence?.materialIdentity ?? parsed.materialIdentity ?? rawEvidence.materialIdentity;
  const normalizedEvidence = {
    ...(passEvidence ?? {}),
    ...rawEvidence,
    materialIdentity:
      materialIdentity === null || typeof materialIdentity !== 'object'
        ? materialIdentity
        : {
            ...materialIdentity,
            materialGuid: materialIdentity.materialGuid ?? rawEvidence.rootGuid,
          },
    rootGuid: rawEvidence.rootGuid ?? passEvidence?.rootGuid,
    source: rawEvidence.source ?? passEvidence?.source,
    observed: rawEvidence.observed ?? passEvidence?.observed,
    pixel: rawEvidence.pixel ?? passEvidence?.pixel,
    browserPath: rawEvidence.browserPath ?? passEvidence?.browserPath,
    webgpu: rawEvidence.webgpu ?? passEvidence?.webgpu,
    frames: rawEvidence.frames ?? passEvidence?.frames ?? parsed.frameCount,
  };
  const errors = [];
  if (result.exitCode !== 0) errors.push(`command exited with ${result.exitCode}`);
  if (fixture.error !== undefined) errors.push(fixture.error);
  if (
    normalizedGuid(normalizedEvidence.materialIdentity?.materialGuid) !==
    normalizedGuid(witness.materialGuid)
  ) {
    errors.push(`material GUID mismatch: expected ${witness.materialGuid}`);
  }
  errors.push(...compareCompactFixtureToLive(fixture, normalizedEvidence));
  if (!hasRealMaterialEvidence(normalizedEvidence, witness.evidence)) {
    errors.push(`missing real ${witness.evidence} WebGPU draw/readback evidence`);
  }
  return {
    witnessId: witness.id,
    category: witness.category,
    evidenceMode: witness.evidence,
    command: [command.program, ...command.args].join(' '),
    verdict: errors.length === 0 ? 'pass' : 'fail',
    errors,
    evidence: normalizedEvidence,
    fixture,
    observed: {
      frames: normalizedEvidence.frames ?? 0,
      materialIdentity: normalizedEvidence.materialIdentity,
      pixel: normalizedEvidence.pixel,
      browserPath: normalizedEvidence.browserPath,
      webgpu: normalizedEvidence.webgpu,
      outputTail: parsed.tail,
    },
    confidence: errors.length === 0 ? 'high' : 'none',
  };
}

function gateDeclaration(packageJson) {
  const gate = packageJson.forgeax?.metrics?.gate;
  return gate !== null && typeof gate === 'object' ? gate : undefined;
}

function gateRequired(packageJson) {
  return gateDeclaration(packageJson)?.enabled !== false;
}

async function runSmoke(entry) {
  const scriptName =
    entry.packageJson.scripts?.['smoke:dawn'] !== undefined ? 'smoke:dawn' : 'smoke';
  const relativeDir = relative(REPO_ROOT, entry.dir);
  const startedAt = new Date().toISOString();
  const required = gateRequired(entry.packageJson);
  const gate = gateDeclaration(entry.packageJson);
  let build;
  if (entry.packageJson.scripts?.build !== undefined) {
    try {
      const buildResult = await execFileAsync('pnpm', ['--dir', relativeDir, 'run', 'build'], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        maxBuffer: 8 * 1024 * 1024,
      });
      build = {
        exitCode: 0,
        outputTail: `${buildResult.stdout}\n${buildResult.stderr}`.trim().split('\n').slice(-8),
      };
    } catch (error) {
      build = {
        exitCode: error.code ?? 1,
        outputTail: `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim().split('\n').slice(-8),
      };
    }
  }
  if (typeof entry.smoke !== 'string') {
    const buildFailureReason =
      build?.exitCode !== undefined && build.exitCode !== 0
        ? `build exited with ${build.exitCode}`
        : undefined;
    const missingGateReason =
      buildFailureReason === undefined && gate?.command === undefined
        ? 'package declares no smoke script or gate command'
        : undefined;
    const reason =
      buildFailureReason ??
      missingGateReason ??
      'declared gate is the package build; build completed';
    const failureReason = buildFailureReason ?? missingGateReason;
    const deferred = !required && failureReason !== undefined;
    return {
      app: relativeDir,
      package: entry.packageJson.name ?? relativeDir,
      script: null,
      startedAt,
      build,
      frameTarget: FRAME_TARGET,
      frames: 0,
      criterion: failureReason === undefined ? 'build' : 'unreported',
      required,
      verdict: deferred ? 'deferred' : failureReason === undefined ? 'pass' : 'fail',
      reason: deferred ? `declared gate disabled: ${gate?.reason ?? reason}` : reason,
      outputTail: build?.outputTail ?? [],
    };
  }
  let result;
  try {
    result = await execFileAsync('pnpm', ['--dir', relativeDir, 'run', scriptName], {
      cwd: REPO_ROOT,
      env: { ...process.env, SMOKE_MIN_FRAMES: String(FRAME_TARGET) },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    result = {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.code ?? 1,
    };
  }
  const parsed = parseSmokeOutput(result.stdout, result.stderr);
  const failureReason =
    result.exitCode !== undefined && result.exitCode !== 0
      ? `smoke exited with ${result.exitCode}`
      : parsed.markers.length > 0
        ? `smoke reported failure markers: ${parsed.markers.join(' | ')}`
        : parsed.criterion === 'unreported'
          ? 'smoke did not report a declared, structural, or pixel criterion'
          : undefined;
  const buildFailureReason =
    build?.exitCode !== undefined && build.exitCode !== 0
      ? `build exited with ${build.exitCode}`
      : undefined;
  const finalReason =
    buildFailureReason === undefined
      ? failureReason
      : `${buildFailureReason}; ${failureReason ?? 'smoke was not trusted'}`;
  const deferred = !required && finalReason !== undefined;
  return {
    app: relativeDir,
    package: entry.packageJson.name ?? relativeDir,
    script: scriptName,
    startedAt,
    build,
    frameTarget: FRAME_TARGET,
    frames: parsed.frameCount,
    materialIdentity: parsed.materialIdentity,
    criterion: parsed.criterion,
    required,
    verdict: deferred ? 'deferred' : finalReason === undefined ? 'pass' : 'fail',
    reason: deferred ? `declared gate disabled: ${gate?.reason ?? finalReason}` : finalReason,
    outputTail: parsed.tail,
  };
}

export function discoverMaterialFleet() {
  const entries = ROSTER_ROOTS.flatMap(discoverRoster).sort((left, right) =>
    relative(REPO_ROOT, left.dir).localeCompare(relative(REPO_ROOT, right.dir)),
  );
  return entries.map((entry) => ({
    ...entry,
    smoke: entry.packageJson.scripts?.['smoke:dawn'] ?? entry.packageJson.scripts?.smoke,
    gate: gateDeclaration(entry.packageJson),
  }));
}

export function buildReceipt(revision, results, materialAcceptanceInput) {
  const materialAcceptance =
    materialAcceptanceInput?.material ??
    (materialAcceptanceInput?.declaration === undefined
      ? undefined
      : buildMaterialAcceptanceVerdict(
          materialAcceptanceInput.declaration,
          materialAcceptanceInput.witnessResults ?? [],
        ));
  const repositoryRegressionVerdict =
    results.length === 0
      ? 'not-run'
      : results
            .filter((result) => result.required !== false)
            .every((result) => result.verdict === 'pass')
        ? 'pass'
        : 'fail';
  return {
    schemaVersion: 2,
    revision,
    frameTarget: FRAME_TARGET,
    rosterCount: results.length,
    requiredCount: results.filter((result) => result.required !== false).length,
    deferredCount: results.filter((result) => result.verdict === 'deferred').length,
    materialEvidenceCount: materialAcceptance?.observedWitnessCount ?? 0,
    materialAcceptanceVerdict: materialAcceptance?.verdict ?? 'unavailable',
    repositoryRegressionVerdict,
    verdict:
      materialAcceptance?.verdict === 'pass' &&
      (repositoryRegressionVerdict === 'pass' || repositoryRegressionVerdict === 'not-run')
        ? 'pass'
        : 'fail',
    materialAcceptance,
    apps: results,
  };
}

export function materialOnlyExitCode(declarationValidation, materialAcceptance) {
  return declarationValidation?.ok === true && materialAcceptance?.verdict === 'pass' ? 0 : 1;
}

async function main() {
  const materialOnly = process.argv.includes('--material-only');
  const outputArgument = process.argv.find((argument) => argument.startsWith('--output='));
  const output =
    outputArgument === undefined ? undefined : outputArgument.slice('--output='.length);
  const entries = materialOnly ? [] : discoverMaterialFleet();
  const missingSmoke = entries.filter(
    (entry) =>
      typeof entry.smoke !== 'string' &&
      gateRequired(entry.packageJson) &&
      entry.gate?.command === undefined,
  );
  const results = [];
  for (const entry of entries) {
    if (typeof entry.smoke !== 'string') {
      results.push(await runSmoke(entry));
      continue;
    }
    process.stderr.write(`[material-fleet-smoke] ${relative(REPO_ROOT, entry.dir)}\n`);
    results.push(await runSmoke(entry));
  }
  if (missingSmoke.length > 0) {
    process.stderr.write(`[material-fleet-smoke] missing smoke scripts=${missingSmoke.length}\n`);
  }
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
  const declarationPath = resolve(REPO_ROOT, MATERIAL_DECLARATION_PATH);
  let declaration;
  let declarationValidation;
  const witnessResults = [];
  try {
    declaration = JSON.parse(readFileSync(declarationPath, 'utf8'));
    declarationValidation = validateMaterialAcceptanceDeclaration(declaration);
    if (declarationValidation.ok) {
      for (const witness of declaration.witnesses) {
        process.stderr.write(`[material-fleet-smoke] material witness ${witness.id}\n`);
        witnessResults.push(await runMaterialWitness(witness));
      }
    }
  } catch (error) {
    declarationValidation = {
      ok: false,
      errors: [
        `declaration could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const materialAcceptance =
    declarationValidation?.ok === true
      ? buildMaterialAcceptanceVerdict(declaration, witnessResults)
      : {
          schemaVersion: 1,
          requiredWitnessCount: 0,
          observedWitnessCount: 0,
          requiredCategories: [],
          observedCategories: [],
          missingWitnesses: [],
          failedWitnesses: [],
          missingCategories: [],
          verdict: 'fail',
          declarationErrors: declarationValidation?.errors ?? ['declaration validation failed'],
          witnesses: witnessResults,
        };
  const receipt = buildReceipt(stdout.trim(), results, { material: materialAcceptance });
  receipt.materialAcceptanceDeclaration = MATERIAL_DECLARATION_PATH;
  receipt.materialAcceptanceDeclarationValidation = declarationValidation;
  if (output !== undefined) {
    const outputPath = isAbsolute(output) ? output : resolve(REPO_ROOT, output);
    writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (materialOnly) {
    const exitCode = materialOnlyExitCode(declarationValidation, materialAcceptance);
    if (exitCode !== 0) process.exitCode = exitCode;
  } else if (receipt.verdict !== 'pass') {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
