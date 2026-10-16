import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPackages } from '../build-task-cache.mjs';
import { pnpmCommand } from '../lib/pnpm-command.mjs';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

export const ROSTER_SCHEMA_VERSION = 3;
export const SHARD_COUNT = 4;
export const SMOKE_MIN_FRAMES = 60;
export const ENTRY_TIMEOUT_MS = 300_000;
export const RECEIPT_PREFIX = '[forgeax-smoke-receipt] ';
export const RECEIPT_PARSER_ID = 'forgeax-smoke-receipt-v1';

export function parseSmokeFrameBudget(value = SMOKE_MIN_FRAMES) {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !/^[0-9]+$/.test(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < SMOKE_MIN_FRAMES
  )
    throw new Error(
      `smoke frame budget must be a safe integer >=${SMOKE_MIN_FRAMES}: ${String(value)}`,
    );
  return Number(value);
}

export function selectSmokeEntries(resolved, scope = 'sharded') {
  if (scope === 'sharded') return resolved.runnableGates ?? resolved.runnable;
  if (scope === 'full')
    return [...resolved.runnable, ...resolved.independent].filter(
      (entry) => entry.classification !== 'supplemental',
    );
  throw new Error(`unknown smoke scope: ${scope}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const defaultRosterPath = resolve(root, 'scripts/ci/dawn-smoke-roster.json');
const defaultReportsPath = resolve(root, 'artifacts/renderer-device-loss/smoke-roster');

function packagePaths(directory) {
  const result = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'artifacts')
        continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === 'package.json') result.push(path);
    }
  };
  walk(directory);
  return result.sort();
}

function entryKey(entry) {
  return `${entry.package}\n${entry.path}`;
}

function gateKey(entry) {
  return `${entry.gateId}\n${entry.commandId}`;
}

function pathWithinRoots(path, roots) {
  return roots.some((rootPath) => path === rootPath || path.startsWith(`${rootPath}/`));
}

function stable(value) {
  return JSON.stringify(value);
}

function rosterDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateRoster(roster, { roots = roster.roots } = {}) {
  if (roster?.schemaVersion !== ROSTER_SCHEMA_VERSION)
    throw new Error(`roster schemaVersion must be ${ROSTER_SCHEMA_VERSION}`);
  if (!Array.isArray(roster.roots) || roster.roots.length === 0)
    throw new Error('roster roots must be a non-empty array');
  if (stable(roster.roots) !== stable(roots)) throw new Error('roster roots drift');
  if (!Array.isArray(roster.entries)) throw new Error('roster entries must be an array');
  const keys = new Set();
  const packages = new Set();
  for (const entry of roster.entries) {
    if (!entry || typeof entry.package !== 'string' || typeof entry.path !== 'string')
      throw new Error('roster entry requires package and path');
    if (entry.classification !== 'supplemental' && !pathWithinRoots(entry.path, roots))
      throw new Error(`roster path outside roots: ${entry.path}`);
    if (!['run', 'excluded', 'supplemental'].includes(entry.classification))
      throw new Error(`invalid roster classification: ${entry.path}`);
    if (keys.has(entryKey(entry))) throw new Error(`duplicate roster entry: ${entry.path}`);
    if (packages.has(entry.package)) throw new Error(`duplicate roster package: ${entry.package}`);
    if ('command' in entry) throw new Error(`roster must not own command: ${entry.path}`);
    if (
      entry.classification === 'excluded' &&
      (typeof entry.reason !== 'string' || entry.reason.trim() === '')
    )
      throw new Error(`excluded entry needs reason: ${entry.path}`);
    if (entry.classification === 'run' && 'reason' in entry)
      throw new Error(`runnable entry must not carry exclusion reason: ${entry.path}`);
    if (!Array.isArray(entry.gates) || entry.gates.length === 0)
      throw new Error(`roster entry needs gate definitions: ${entry.path}`);
    const gateIds = new Set();
    for (const gate of entry.gates) {
      if (
        !gate ||
        typeof gate.gateId !== 'string' ||
        typeof gate.commandId !== 'string' ||
        typeof gate.executionClass !== 'string'
      )
        throw new Error(`invalid gate definition: ${entry.path}`);
      if (gateIds.has(gate.gateId)) throw new Error(`duplicate gate: ${gate.gateId}`);
      if (!['sharded', 'independent', 'excluded'].includes(gate.executionClass))
        throw new Error(`invalid gate execution class: ${gate.gateId}`);
      if (gate.script !== undefined && (typeof gate.script !== 'string' || !gate.script.trim()))
        throw new Error(`invalid package script: ${gate.gateId}`);
      if ('artifactRequirements' in gate) {
        const packGuids = gate.artifactRequirements?.packGuids;
        if (
          !Array.isArray(packGuids) ||
          packGuids.some(
            (guid) =>
              typeof guid !== 'string' ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid),
          ) ||
          new Set(packGuids).size !== packGuids.length
        )
          throw new Error(`invalid artifact requirements: ${gate.gateId}`);
      }
      if (!['frameReceipt', 'assertion', 'composite'].includes(gate.oracle))
        throw new Error(`invalid gate oracle: ${gate.gateId}`);
      gateIds.add(gate.gateId);
    }
    if (
      entry.classification === 'excluded' &&
      entry.gates.some((gate) => gate.executionClass !== 'excluded')
    )
      throw new Error(`excluded entry has runnable gate: ${entry.path}`);
    if (
      entry.classification !== 'excluded' &&
      entry.gates.some((gate) => gate.executionClass === 'excluded')
    )
      throw new Error(`runnable entry has excluded gate: ${entry.path}`);
    keys.add(entryKey(entry));
    packages.add(entry.package);
  }
  return roster;
}

export function readRoster(path = defaultRosterPath) {
  const roster = JSON.parse(readFileSync(path, 'utf8'));
  return validateRoster(roster);
}

export function discoverCandidates({
  repoRoot = root,
  roots = ['apps/hello', 'apps/learn-render'],
  supplementalEntries = [],
} = {}) {
  const candidates = [];
  for (const relativeRoot of roots) {
    const absoluteRoot = resolve(repoRoot, relativeRoot);
    if (!existsSync(absoluteRoot)) throw new Error(`smoke root missing: ${relativeRoot}`);
    for (const path of packagePaths(absoluteRoot)) {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (!Object.hasOwn(pkg?.forgeax ?? {}, 'smokeInvocation')) continue;
      candidates.push({
        package: pkg.name,
        path: relative(repoRoot, path).replaceAll('\\', '/'),
      });
    }
  }
  for (const entry of supplementalEntries) {
    const path = resolve(repoRoot, entry.path);
    if (!existsSync(path)) throw new Error(`supplemental smoke manifest missing: ${entry.path}`);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    if (!Object.hasOwn(pkg?.forgeax ?? {}, 'smokeInvocation')) continue;
    candidates.push({ package: pkg.name, path: relative(repoRoot, path).replaceAll('\\', '/') });
  }
  const keys = new Set();
  for (const candidate of candidates) {
    if (keys.has(entryKey(candidate)))
      throw new Error(`duplicate manifest candidate: ${candidate.path}`);
    keys.add(entryKey(candidate));
  }
  return candidates.sort(
    (a, b) => a.package.localeCompare(b.package) || a.path.localeCompare(b.path),
  );
}

export function resolveRunnableEntries({ repoRoot = root, roster, roots = roster.roots } = {}) {
  validateRoster(roster, { roots });
  const supplementalEntries = roster.entries.filter(
    (entry) => entry.classification === 'supplemental',
  );
  const candidates = discoverCandidates({ repoRoot, roots, supplementalEntries });
  const candidateKeys = new Set(candidates.map(entryKey));
  const rosterKeys = new Set(roster.entries.map(entryKey));
  const missing = [...candidateKeys].filter((key) => !rosterKeys.has(key));
  const extra = [...rosterKeys].filter((key) => !candidateKeys.has(key));
  if (missing.length || extra.length) {
    throw new Error(
      `roster membership drift: missing=${missing.join(',') || 'none'} extra=${extra.join(',') || 'none'}`,
    );
  }
  const manifests = new Map(candidates.map((candidate) => [entryKey(candidate), candidate]));
  const runnable = [];
  const independent = [];
  const exclusions = [];
  const declaredGateIds = [];
  const runnableGateIds = [];
  const independentGateIds = [];
  const excludedGateIds = [];
  for (const entry of roster.entries) {
    const candidate = manifests.get(entryKey(entry));
    if (!candidate) throw new Error(`roster candidate missing: ${entry.path}`);
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, candidate.path), 'utf8'));
    const manifestCommand = manifest?.forgeax?.smokeInvocation;
    const executableGates = entry.gates.filter((gate) => gate.executionClass !== 'excluded');
    if (
      executableGates.length > 0 &&
      (typeof manifestCommand !== 'string' || manifestCommand.trim() === '')
    )
      throw new Error(`runnable manifest command missing: ${entry.path}`);
    for (const gate of entry.gates) {
      declaredGateIds.push(gate.gateId);
      const command =
        gate.script === undefined
          ? (manifestCommand ?? '').trim()
          : `pnpm --filter ${entry.package} ${gate.script}`;
      const resolvedGate = {
        package: entry.package,
        path: entry.path,
        classification: entry.classification,
        gateId: gate.gateId,
        commandId: gate.commandId,
        executionClass: gate.executionClass,
        oracle: gate.oracle,
        command,
      };
      if (gate.executionClass === 'sharded') {
        runnable.push(resolvedGate);
        runnableGateIds.push(gate.gateId);
      } else if (gate.executionClass === 'independent') {
        independent.push(resolvedGate);
        independentGateIds.push(gate.gateId);
      } else {
        excludedGateIds.push(gate.gateId);
      }
    }
    if (entry.classification === 'excluded') exclusions.push({ ...entry });
  }
  const sortEntries = (a, b) =>
    a.package.localeCompare(b.package) ||
    a.path.localeCompare(b.path) ||
    a.gateId.localeCompare(b.gateId) ||
    a.commandId.localeCompare(b.commandId);
  runnable.sort(sortEntries);
  independent.sort(sortEntries);
  return {
    declared: roster.entries.map((entry) => ({ ...entry })),
    runnable,
    independent,
    exclusions,
    declaredGateIds,
    runnableGateIds,
    independentGateIds,
    excludedGateIds,
  };
}

// Complete passing Smoke jobs in runs 38313136540 and 38316658619 supply
// median gate and post-roster seconds. Each gate includes its child startup;
// the tail includes reporting/cleanup, without obsolete screenshot uploads.
const measuredSmokeGateSeconds = new Map([
  ['app-learn-render-5-advanced-lighting-5-parallax-mapping/smoke', 7],
  ['app-learn-render-5-advanced-lighting-9-ssao/smoke', 9],
  ['app-learn-render-6-pbr-2-ibl-irradiance/smoke', 13],
  ['app-learn-render-6-pbr-3-ibl-specular/smoke', 14],
  ['app-learn-render-6-pbr-4-transmission-refraction/features-a', 94],
  ['app-learn-render-6-pbr-4-transmission-refraction/features-b', 60],
  ['app-learn-render-6-pbr-4-transmission-refraction/frames', 28],
  ['hello-boss-lightning/sdf', 15],
  ['hello-cinder-fall/smoke', 28],
  ['hello-deep-agent-feedback/smoke', 69],
  ['hello-level-switch/smoke', 9],
  ['hello-physics/smoke', 6],
  ['hello-sprite-lit/smoke', 6],
  ['hello-sprite/smoke', 5],
  ['hello-tilemap/smoke', 6],
  ['hello-transform-gizmo/browser', 101],
  ['hello-transform-gizmo/smoke', 5],
  ['hello-triangle/smoke', 3],
  ['hello-volumetric-fog/smoke', 18],
]);
const defaultSmokeGateSeconds = 11;
export const ciSmokeShardTailSeconds = Object.freeze([235, 240, 140, 250]);

export function smokeGateSeconds(entry) {
  return measuredSmokeGateSeconds.get(entry.gateId) ?? defaultSmokeGateSeconds;
}

export function partitionRunnableEntries(
  entries,
  { shardIndex, shardCount = SHARD_COUNT, scope } = {},
) {
  if (!Number.isInteger(shardCount) || shardCount < 1)
    throw new Error(`invalid shardCount: ${shardCount}`);
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount)
    throw new Error(`invalid shardIndex: ${shardIndex}`);
  const ordered = [...entries].sort(
    (a, b) =>
      a.package.localeCompare(b.package) ||
      a.path.localeCompare(b.path) ||
      a.gateId.localeCompare(b.gateId) ||
      a.commandId.localeCompare(b.commandId),
  );
  // Fixed tails exist only in the four-shard smoke-fleet (`sharded`) layout.
  const totals = Array.from({ length: shardCount }, (_value, shard) =>
    scope === 'sharded' && shardCount === ciSmokeShardTailSeconds.length
      ? ciSmokeShardTailSeconds[shard]
      : 0,
  );
  const assignment = new Map();
  const ranked = ordered
    .map((entry, index) => ({ entry, index, seconds: smokeGateSeconds(entry) }))
    .sort((left, right) => right.seconds - left.seconds || left.index - right.index);
  for (const { entry, seconds } of ranked) {
    let selected = 0;
    for (let shard = 1; shard < shardCount; shard += 1)
      if (totals[shard] < totals[selected]) selected = shard;
    assignment.set(entry, selected);
    totals[selected] += seconds;
  }
  return ordered.filter((entry) => assignment.get(entry) === shardIndex);
}

export function validateShardReport(report, { frames = SMOKE_MIN_FRAMES, scope = 'sharded' } = {}) {
  frames = parseSmokeFrameBudget(frames);
  if ((report.scope ?? 'sharded') !== scope) throw new Error('shard scope drift');
  if (report?.schemaVersion !== ROSTER_SCHEMA_VERSION || report.kind !== 'dawn-smoke-shard')
    throw new Error('invalid Dawn shard report schema');
  if (!/^[0-9a-f]{40}$/.test(report.head))
    throw new Error('shard report requires a full actual head');
  if (!/^[0-9a-f]{40}$/.test(report.expectedProductSha))
    throw new Error('shard report requires a full expectedProductSha');
  if (!/^[0-9a-f]{64}$/.test(report.rosterDigest))
    throw new Error('shard report requires a roster digest');
  if (!Number.isInteger(report.shardIndex) || !Number.isInteger(report.shardCount))
    throw new Error('shard report needs shard index/count');
  if (report.shardCount < 1 || report.shardIndex < 0 || report.shardIndex >= report.shardCount)
    throw new Error('invalid shard report index/count');
  if (report.framesExpected !== frames)
    throw new Error(`shard framesExpected must match external frame budget ${frames}`);
  for (const field of [
    'declaredGateIds',
    'runnableGateIds',
    'excludedGateIds',
    'assignedGateIds',
    'declaredEntries',
    'runnableEntries',
    'exclusions',
    'assignedEntries',
  ]) {
    if (!Array.isArray(report[field])) throw new Error(`shard report requires ${field}`);
  }
  const declaredGateIds = requireUniqueStrings(report.declaredGateIds, 'declaredGateIds');
  const runnableGateIds = requireUniqueStrings(report.runnableGateIds, 'runnableGateIds');
  const independentGateIds = requireUniqueStrings(
    report.independentGateIds ?? [],
    'independentGateIds',
  );
  const excludedGateIds = requireUniqueStrings(report.excludedGateIds, 'excludedGateIds');
  const assignedGateIds = requireUniqueStrings(report.assignedGateIds, 'assignedGateIds');
  const declared = new Set(declaredGateIds);
  const runnable = new Set(runnableGateIds);
  const independent = new Set(independentGateIds);
  const excluded = new Set(excludedGateIds);
  const assigned = new Set(assignedGateIds);
  const executable = scope === 'full' ? new Set([...runnable, ...independent]) : runnable;
  const oracleByGate = new Map(
    report.declaredEntries.flatMap((entry) =>
      (entry.gates ?? []).map((gate) => [gate.gateId, gate.oracle]),
    ),
  );
  if (!isUnionOf(runnable, independent, excluded, declared))
    throw new Error('declared gate closure drift');
  if (![...assigned].every((gateId) => executable.has(gateId)))
    throw new Error('assigned gate is outside runnable closure');
  const assignedEntryKeys = new Set();
  for (const entry of report.assignedEntries) {
    if (typeof entry?.gateId !== 'string' || typeof entry.commandId !== 'string')
      throw new Error('assigned entry requires gateId and commandId');
    const key = gateKey(entry);
    if (assignedEntryKeys.has(key)) throw new Error(`duplicate assigned entry: ${key}`);
    if (!assigned.has(entry.gateId)) throw new Error(`assigned entry outside gate closure: ${key}`);
    assignedEntryKeys.add(key);
  }
  const keys = new Set();
  for (const result of report.runnableEntries) {
    if (typeof result?.package !== 'string' || typeof result.path !== 'string')
      throw new Error('shard result requires package and path');
    if (typeof result.gateId !== 'string' || typeof result.commandId !== 'string')
      throw new Error('shard result requires gateId and commandId');
    const key = gateKey(result);
    if (keys.has(key)) throw new Error(`duplicate shard result: ${result.path}`);
    if (result.shardIndex !== report.shardIndex)
      throw new Error(`shard result index drift: ${result.path}`);
    if (!executable.has(result.gateId)) throw new Error(`result outside runnable closure: ${key}`);
    const frameReceipt = (oracleByGate.get(result.gateId) ?? 'frameReceipt') === 'frameReceipt';
    if (typeof result.command !== 'string' || result.command.trim() === '')
      throw new Error(`missing command: ${key}`);
    if (!Number.isInteger(result.exitCode) && result.exitCode !== null)
      throw new Error(`invalid exitCode: ${key}`);
    if (result.signal !== null && typeof result.signal !== 'string')
      throw new Error(`invalid signal: ${key}`);
    for (const field of ['timedOut', 'unavailable', 'skipped', 'unavailableOrSkipped']) {
      if (typeof result[field] !== 'boolean') throw new Error(`missing ${field}: ${key}`);
    }
    if (!Number.isInteger(result.framesExpected) || result.framesExpected !== frames)
      throw new Error(`shard result frame expectation drift: ${result.path}`);
    if (result.framesObserved !== null && !Number.isInteger(result.framesObserved))
      throw new Error(`invalid frame evidence: ${result.path}`);
    if (!['pass', 'fail', 'blocked'].includes(result.status))
      throw new Error(`unknown result status: ${key}`);
    if (!['pass', 'fail', 'blocked'].includes(result.result))
      throw new Error(`unknown result token: ${key}`);
    if (result.failureReason !== null && typeof result.failureReason !== 'string')
      throw new Error(`invalid failureReason: ${key}`);
    if (typeof result.logPath !== 'string' || result.logPath.trim() === '')
      throw new Error(`missing logPath: ${key}`);
    if (!/^[0-9a-f]{64}$/.test(result.logSha256)) throw new Error(`missing logSha256: ${key}`);
    if (!Number.isInteger(result.logBytes) || result.logBytes < 0)
      throw new Error(`invalid logBytes: ${key}`);
    if (!Array.isArray(result.commandResults) || result.commandResults.length === 0)
      throw new Error(`missing commandResults: ${key}`);
    if (
      result.commandResults.length !== 1 ||
      result.commandResults.some(
        (command) =>
          command.commandId !== result.commandId ||
          command.command !== result.command ||
          command.exitCode !== result.exitCode ||
          command.status !== result.status,
      )
    )
      throw new Error(`command result drift: ${key}`);
    if (!('receipt' in result)) throw new Error(`missing receipt field: ${key}`);
    if (result.receipt !== null) {
      if (typeof result.receipt !== 'object') throw new Error(`invalid receipt: ${key}`);
      validateObservedReceipt(result.receipt, {
        gateId: result.gateId,
        commandId: result.commandId,
        frames,
      });
      if (result.receipt.framesObserved !== result.framesObserved)
        throw new Error(`receipt frame mismatch: ${key}`);
    }
    if (result.status === 'blocked') {
      if (result.result !== 'blocked') throw new Error(`blocked result token drift: ${key}`);
      if (result.framesObserved !== null || result.receipt !== null)
        throw new Error(`blocked result carries frame evidence: ${key}`);
      if (result.failureReason === null)
        throw new Error(`blocked result requires a failureReason: ${key}`);
    }
    if (!frameReceipt && (result.receipt !== null || result.framesObserved !== null))
      throw new Error(`assertion/composite must not fabricate frame evidence: ${key}`);
    if (
      result.status === 'pass' &&
      (result.exitCode !== 0 ||
        result.signal !== null ||
        result.timedOut ||
        result.unavailableOrSkipped ||
        result.unavailable ||
        result.skipped ||
        result.result !== 'pass' ||
        result.failureReason !== null)
    )
      throw new Error(`passing result has failed execution: ${key}`);
    if (result.status === 'pass' && frameReceipt && result.receipt === null)
      throw new Error(`passing result requires receipt: ${key}`);
    if (result.status === 'pass' && frameReceipt && result.framesObserved < frames)
      throw new Error(`passing result has short frame evidence: ${key}`);
    keys.add(key);
  }
  if (stable(report.runnableEntries.map(gateKey).sort()) !== stable([...assignedEntryKeys].sort()))
    throw new Error('assigned result closure drift');
  if (
    stable([...assigned].sort()) !==
    stable(report.assignedEntries.map((entry) => entry.gateId).sort())
  )
    throw new Error('assigned gate ledger drift');
  return report;
}

function requireUniqueStrings(value, field) {
  if (!value.every((item) => typeof item === 'string' && item.length > 0))
    throw new Error(`${field} contains an invalid token`);
  const unique = new Set(value);
  if (unique.size !== value.length) throw new Error(`${field} contains duplicate tokens`);
  return value;
}

function isUnionOf(runnable, independent, excluded, declared) {
  if (
    [...runnable].some((gateId) => independent.has(gateId) || excluded.has(gateId)) ||
    [...independent].some((gateId) => excluded.has(gateId))
  )
    return false;
  const union = new Set([...runnable, ...independent, ...excluded]);
  return union.size === declared.size && [...union].every((gateId) => declared.has(gateId));
}

function validateObservedReceipt(receipt, identity) {
  const required = [
    'schemaVersion',
    'gateId',
    'commandId',
    'framesObserved',
    'completed',
    'rawLine',
    'rawLineSha256',
    'parserId',
  ];
  for (const field of required) {
    if (!(field in receipt)) throw new Error(`receipt requires ${field}`);
  }
  if (receipt.schemaVersion !== 1 || receipt.gateId !== identity.gateId)
    throw new Error('receipt gate identity drift');
  if (receipt.commandId !== identity.commandId) throw new Error('receipt command identity drift');
  if ('framesExpected' in receipt) throw new Error('receipt must not contain framesExpected');
  if (
    !Number.isSafeInteger(receipt.framesObserved) ||
    receipt.framesObserved < parseSmokeFrameBudget(identity.frames)
  )
    throw new Error('receipt framesObserved is below the required minimum');
  if (receipt.completed !== true) throw new Error('receipt is not completed');
  if (typeof receipt.rawLine !== 'string' || !receipt.rawLine.startsWith(RECEIPT_PREFIX))
    throw new Error('receipt rawLine is not canonical');
  if (!/^[0-9a-f]{64}$/.test(receipt.rawLineSha256)) throw new Error('receipt digest is invalid');
  if (receipt.parserId !== RECEIPT_PARSER_ID) throw new Error('receipt parser is unknown');
  if (receipt.evidenceSource !== undefined) {
    if (
      receipt.evidenceSource !== 'legacy-smoke-output' ||
      typeof receipt.frameEvidenceLine !== 'string' ||
      typeof receipt.passEvidenceLine !== 'string' ||
      !/^\[smoke\]\s+frames observed=\d+\b/.test(receipt.frameEvidenceLine) ||
      !/^\[[^\]]*smoke[^\]]*\].*\bPASS\b/.test(receipt.passEvidenceLine)
    )
      throw new Error('legacy receipt provenance is invalid');
  }
  return receipt;
}

export function parseObservedFrameReceipt(
  output,
  { gateId, commandId, frames = SMOKE_MIN_FRAMES } = {},
) {
  frames = parseSmokeFrameBudget(frames);
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RECEIPT_PREFIX));
  if (lines.length > 1)
    throw new Error(`expected exactly one observed receipt, found ${lines.length}`);
  if (lines.length === 1) return parseCanonicalReceiptLine(lines[0], { gateId, commandId, frames });

  // A small compatibility adapter keeps the canonical roster useful while
  // legacy smoke producers migrate to the receipt contract. It only accepts
  // the producer's explicit frame-completion line together with its own PASS
  // verdict; exit code alone, a target/budget number, or a copied readback can
  // never manufacture a receipt.
  const legacyLines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\[smoke\]\s+frames observed=\d+\b/.test(line));
  if (legacyLines.length !== 1)
    throw new Error(`expected exactly one observed receipt, found ${lines.length}`);
  const passLine = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^\[[^\]]*smoke[^\]]*\].*\bPASS\b/.test(line));
  if (passLine === undefined || /\b(?:FAIL|NOT-RUN|env-deferred)\b/i.test(output))
    throw new Error('legacy receipt has no unambiguous PASS verdict');
  const frameMatch = legacyLines[0].match(/^\[smoke\]\s+frames observed=(\d+)\b/);
  const framesObserved = Number(frameMatch?.[1]);
  if (!Number.isSafeInteger(framesObserved) || framesObserved < frames)
    throw new Error('legacy smoke output has insufficient frame evidence');
  const rawLine = `${RECEIPT_PREFIX}${JSON.stringify({
    schemaVersion: 1,
    gateId,
    commandId,
    framesObserved,
    completed: true,
    evidenceSource: 'legacy-smoke-output',
    frameEvidenceLine: legacyLines[0],
    passEvidenceLine: passLine,
  })}`;
  const receipt = {
    schemaVersion: 1,
    gateId,
    commandId,
    framesObserved,
    completed: true,
    evidenceSource: 'legacy-smoke-output',
    frameEvidenceLine: legacyLines[0],
    passEvidenceLine: passLine,
    rawLine,
    rawLineSha256: createHash('sha256').update(rawLine).digest('hex'),
    parserId: RECEIPT_PARSER_ID,
  };
  return validateObservedReceipt(receipt, { gateId, commandId, frames });
}

function parseCanonicalReceiptLine(rawLine, { gateId, commandId, frames } = {}) {
  let payload;
  try {
    payload = JSON.parse(rawLine.slice(RECEIPT_PREFIX.length));
  } catch (error) {
    throw new Error(`receipt JSON is invalid: ${error.message}`);
  }
  const receipt = {
    ...payload,
    rawLine,
    rawLineSha256: createHash('sha256').update(rawLine).digest('hex'),
    parserId: RECEIPT_PARSER_ID,
  };
  return validateObservedReceipt(receipt, { gateId, commandId, frames });
}

function hasCanonicalReceiptLine(output) {
  return String(output)
    .split(/\r?\n/)
    .some((line) => line.trim().startsWith(RECEIPT_PREFIX));
}

function readHead(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function hasUnavailableOrSkipped(output, { hasReceipt = false } = {}) {
  // A canonical frame receipt is the authoritative execution result.  Smoke
  // payloads may legitimately describe an optional capability as
  // "unavailable" (for example, performance admission on a correctness
  // carrier); those words must not downgrade an otherwise complete receipt.
  return (
    hasSkippedGate(output) || (!hasReceipt && /\b(?:unavailable|skipped?|skip)\b/i.test(output))
  );
}

function hasSkippedGate(output) {
  // Terminal verdict tokens, not natural-language setup progress. Existing
  // owners emit tagged NOT-RUN or env-deferred=reason; SKIP/SKIPPED are also
  // terminal statuses. Do not restrict owner tags or interpret "skipping fetch".
  return /^(?:\[[^\]]+\]\s*)?(?:NOT-RUN\b|env-deferred(?:=|:)|SKIP(?:PED)?(?:\s|:|$))/m.test(
    output,
  );
}

function writeReport(report, reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function validateLogFiles(report, reportDirectory) {
  if (!reportDirectory) return;
  for (const result of report.runnableEntries) {
    const logPath = resolve(reportDirectory, result.logPath);
    const relativePath = relative(resolve(reportDirectory), logPath);
    if (relativePath.startsWith('..') || relativePath.includes('/..'))
      throw new Error(`log path escapes report directory: ${result.gateId}`);
    if (!existsSync(logPath)) throw new Error(`missing log file: ${result.logPath}`);
    const content = readFileSync(logPath);
    if (content.byteLength !== result.logBytes) throw new Error(`log byte drift: ${result.gateId}`);
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== result.logSha256) throw new Error(`log digest drift: ${result.gateId}`);
    if (result.receipt !== null) {
      const parsed = parseObservedFrameReceipt(content.toString('utf8'), {
        gateId: result.gateId,
        commandId: result.commandId,
        frames: report.framesExpected,
      });
      if (stable(parsed) !== stable(result.receipt))
        throw new Error(`log receipt projection drift: ${result.gateId}`);
    }
  }
}

export function buildShardReport({
  resolved,
  assigned,
  head,
  expectedProductSha,
  rosterDigest: digest,
  shardIndex,
  shardCount = SHARD_COUNT,
  results,
  frames = SMOKE_MIN_FRAMES,
  scope = 'sharded',
} = {}) {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('shard report needs a full actual head');
  if (!/^[0-9a-f]{40}$/.test(expectedProductSha))
    throw new Error('shard report needs a full expectedProductSha');
  const declaredGateIds =
    resolved.declaredGateIds ?? resolved.declared.map((entry) => entry.gateId);
  const runnableGateIds =
    resolved.runnableGateIds ?? resolved.runnable.map((entry) => entry.gateId);
  const independentGateIds =
    resolved.independentGateIds ?? resolved.independent?.map((entry) => entry.gateId) ?? [];
  const excludedGateIds =
    resolved.excludedGateIds ?? resolved.exclusions.map((entry) => entry.gateId);
  if (
    ![...declaredGateIds, ...runnableGateIds, ...excludedGateIds].every(
      (id) => typeof id === 'string',
    )
  )
    throw new Error('gate-level roster is required for shard reports');
  return {
    schemaVersion: ROSTER_SCHEMA_VERSION,
    kind: 'dawn-smoke-shard',
    head,
    expectedProductSha,
    rosterDigest: digest,
    shardIndex,
    shardCount,
    framesExpected: parseSmokeFrameBudget(frames),
    scope,
    declaredGateIds,
    runnableGateIds,
    independentGateIds,
    excludedGateIds,
    assignedGateIds: [...new Set(assigned.map((entry) => entry.gateId))],
    declaredEntries: resolved.declared,
    runnableEntries: results.map((result) => ({ ...result })),
    exclusions: resolved.exclusions,
    assignedEntries: assigned.map(({ gateId, commandId }) => ({
      gateId,
      commandId,
    })),
  };
}

export function aggregateReports({
  reports,
  resolved,
  head,
  expectedProductSha,
  rosterDigest: digest,
  reportDirectory,
  shardCount = SHARD_COUNT,
  allowBlocked = false,
  frames = SMOKE_MIN_FRAMES,
  scope = 'sharded',
} = {}) {
  frames = parseSmokeFrameBudget(frames);
  if (scope === 'full' && allowBlocked) throw new Error('full fleet cannot allow blocked evidence');
  if (expectedProductSha !== undefined && head !== expectedProductSha)
    throw new Error('aggregate actual head does not match external expected product sha');
  if (!Array.isArray(reports) || reports.length !== shardCount)
    throw new Error(`missing shard report: expected ${shardCount}`);
  const declaredGateIds =
    resolved.declaredGateIds ?? resolved.declared?.map((entry) => entry.gateId);
  const runnableGateIds =
    resolved.runnableGateIds ?? resolved.runnable?.map((entry) => entry.gateId);
  const independentGateIds =
    resolved.independentGateIds ?? resolved.independent?.map((entry) => entry.gateId) ?? [];
  const excludedGateIds =
    resolved.excludedGateIds ?? resolved.exclusions?.map((entry) => entry.gateId);
  if (
    !Array.isArray(declaredGateIds) ||
    !Array.isArray(runnableGateIds) ||
    !Array.isArray(excludedGateIds)
  )
    throw new Error('gate-level resolved roster is required for aggregation');
  const expectedRunnable = selectSmokeEntries(resolved, scope);
  const expectedDeclared = resolved.declared ?? [];
  const expectedExclusions = resolved.exclusions ?? [];
  if (!Array.isArray(expectedRunnable)) throw new Error('resolved runnable gates are required');
  const byIndex = new Map();
  for (const report of reports) {
    validateShardReport(report, { frames, scope });
    validateLogFiles(report, reportDirectory);
    if (report.shardCount !== shardCount) throw new Error('shard count drift');
    if (byIndex.has(report.shardIndex)) throw new Error(`duplicate shard: ${report.shardIndex}`);
    if (report.head !== head) throw new Error(`head drift in shard ${report.shardIndex}`);
    if (expectedProductSha !== undefined && report.expectedProductSha !== expectedProductSha)
      throw new Error(`expected product sha drift in shard ${report.shardIndex}`);
    if (report.rosterDigest !== digest)
      throw new Error(`roster digest drift in shard ${report.shardIndex}`);
    if (stable(report.declaredGateIds) !== stable(declaredGateIds))
      throw new Error(`declared gate set drift in shard ${report.shardIndex}`);
    if (stable(report.runnableGateIds) !== stable(runnableGateIds))
      throw new Error(`runnable gate set drift in shard ${report.shardIndex}`);
    if (stable(report.independentGateIds ?? []) !== stable(independentGateIds))
      throw new Error(`independent gate set drift in shard ${report.shardIndex}`);
    if (stable(report.excludedGateIds) !== stable(excludedGateIds))
      throw new Error(`excluded gate set drift in shard ${report.shardIndex}`);
    if (stable(report.declaredEntries) !== stable(expectedDeclared))
      throw new Error(`declared set drift in shard ${report.shardIndex}`);
    if (stable(report.exclusions) !== stable(expectedExclusions))
      throw new Error(`exclusion set drift in shard ${report.shardIndex}`);
    byIndex.set(report.shardIndex, report);
  }
  for (let index = 0; index < shardCount; index += 1)
    if (!byIndex.has(index)) throw new Error(`missing shard: ${index}`);

  const expectedByKey = new Map(expectedRunnable.map((entry) => [gateKey(entry), entry]));
  const assignedByKey = new Map();
  const results = [];
  for (let index = 0; index < shardCount; index += 1) {
    const expected = partitionRunnableEntries(expectedRunnable, {
      shardIndex: index,
      shardCount,
      scope,
    });
    for (const entry of expected) assignedByKey.set(gateKey(entry), index);
    const report = byIndex.get(index);
    const expectedKeys = new Set(expected.map(gateKey));
    const actualKeys = new Set(report.runnableEntries.map(gateKey));
    for (const key of expectedKeys)
      if (!actualKeys.has(key)) throw new Error(`missing entry: ${key}`);
    for (const key of actualKeys)
      if (!expectedKeys.has(key)) throw new Error(`extra entry: ${key}`);
    for (const result of report.runnableEntries) {
      const key = gateKey(result);
      if (!expectedByKey.has(key)) throw new Error(`extra runnable entry: ${key}`);
      if (result.command !== expectedByKey.get(key).command)
        throw new Error(`command drift: ${key}`);
      if (
        result.package !== expectedByKey.get(key).package ||
        result.path !== expectedByKey.get(key).path
      )
        throw new Error(`owner identity drift: ${key}`);
      if (result.exitCode !== 0 || result.signal !== null) throw new Error(`entry failure: ${key}`);
      if (result.unavailableOrSkipped === true && !(allowBlocked && result.status === 'blocked'))
        throw new Error(`entry unavailable or skipped: ${key}`);
      if (result.status === 'blocked' || result.result === 'blocked') {
        if (!allowBlocked) throw new Error(`entry is blocked: ${key}`);
        if (result.receipt !== null) throw new Error(`blocked entry has observed receipt: ${key}`);
        results.push(result);
        continue;
      }
      if (result.status !== 'pass' || result.result !== 'pass')
        throw new Error(`entry result is not pass: ${key}`);
      if ((expectedByKey.get(key).oracle ?? 'frameReceipt') === 'frameReceipt') {
        if (result.receipt === null) throw new Error(`entry is missing observed receipt: ${key}`);
        if (result.framesObserved < frames) throw new Error(`short frame evidence: ${key}`);
      } else if (result.receipt !== null || result.framesObserved !== null)
        throw new Error(`assertion/composite carries fabricated frames: ${key}`);
      results.push(result);
    }
  }
  if (
    results.length !== expectedByKey.size ||
    new Set(results.map(gateKey)).size !== results.length
  )
    throw new Error('duplicate or missing runnable coverage');
  const expectedAssigned = [...assignedByKey].map(([key, shardIndex]) => ({ key, shardIndex }));
  const actualAssigned = reports
    .flatMap((report) =>
      report.assignedEntries.map(({ gateId, commandId }) => ({
        key: gateKey({ gateId, commandId }),
        shardIndex: report.shardIndex,
      })),
    )
    .sort((a, b) => a.key.localeCompare(b.key));
  if (
    stable(actualAssigned) !== stable(expectedAssigned.sort((a, b) => a.key.localeCompare(b.key)))
  )
    throw new Error('complete shard ledger drift');
  return {
    schemaVersion: ROSTER_SCHEMA_VERSION,
    kind: 'dawn-smoke-aggregate',
    status: results.some((result) => result.status === 'blocked') ? 'blocked' : 'pass',
    head,
    expectedProductSha: expectedProductSha ?? reports[0].expectedProductSha,
    rosterDigest: digest,
    shardCount,
    framesExpected: frames,
    scope,
    declaredGateIds,
    runnableGateIds,
    excludedGateIds,
    declaredEntries: expectedDeclared,
    runnableResults: results,
    exclusions: expectedExclusions,
    assignedEntries: expectedAssigned,
  };
}

export function preflightRunEntries(
  entries,
  { repoRoot = root, buildGraph = appPackages(repoRoot) } = {},
) {
  const builtDirectories = new Set(
    buildGraph.map((app) => resolve(repoRoot, app.relativeDirectory ?? app.directory)),
  );
  const failures = [];
  for (const entry of entries) {
    const packageDirectory = resolve(repoRoot, dirname(entry.path));
    if (!builtDirectories.has(packageDirectory))
      failures.push(`${entry.path}: missing canonical app build graph entry`);
    const shaderManifest = resolve(packageDirectory, 'dist', 'shaders', 'manifest.json');
    if (!existsSync(shaderManifest)) failures.push(`${entry.path}: missing ${shaderManifest}`);
  }
  if (failures.length > 0) throw new Error(`Dawn smoke preflight failed:\n${failures.join('\n')}`);
  return entries;
}

export function checkRoster({ rosterPath = defaultRosterPath, roots } = {}) {
  const roster = readRoster(rosterPath);
  const selectedRoots = roots ?? roster.roots;
  const resolved = resolveRunnableEntries({ repoRoot: root, roster, roots: selectedRoots });
  process.stdout.write(
    `[dawn-roster] check pass declared=${resolved.declared.length} runnable=${resolved.runnable.length} exclusions=${resolved.exclusions.length}\n`,
  );
  return { roster, resolved, rosterDigest: rosterDigest(rosterPath) };
}

export function resultStatus(
  result,
  observed,
  unavailableOrSkipped,
  output = '',
  frames = SMOKE_MIN_FRAMES,
) {
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !unavailableOrSkipped &&
    observed !== null &&
    observed >= frames
  )
    return 'pass';
  // A zero-exit smoke that has no canonical producer receipt is an explicit
  // evidence gap, not a passing frame gate. The caller may carry this as
  // BLOCKED only when the invocation explicitly opts into the authorized
  // defer path; the default CLI remains fail-closed.
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    observed === null &&
    !hasCanonicalReceiptLine(output || result.output)
  )
    return 'blocked';
  return 'fail';
}

function resultFailureReason(result, observed, unavailableOrSkipped, frames) {
  if (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !unavailableOrSkipped &&
    observed !== null &&
    observed >= frames
  )
    return null;
  if (result.timedOut) return 'timeout';
  if (observed === null)
    return hasCanonicalReceiptLine(result.output)
      ? 'invalid-frame-evidence'
      : 'missing-frame-evidence';
  if (observed < frames) return 'short-frame-evidence';
  if (unavailableOrSkipped) return 'unavailable-or-skipped';
  return `exit-${result.exitCode ?? result.signal}`;
}

export async function runEntry({
  entry,
  shardIndex,
  reportPath,
  timeoutMs,
  frames = SMOKE_MIN_FRAMES,
}) {
  frames = parseSmokeFrameBudget(frames);
  const frameReceipt = (entry.oracle ?? 'frameReceipt') === 'frameReceipt';
  process.stdout.write(`[dawn-roster] run ${entry.package}: ${entry.command}\n`);
  const packageScript = /^pnpm --filter ([@\w./-]+) ([\w:-]+)$/.exec(entry.command);
  const command = packageScript
    ? [...pnpmCommand(), '--filter', packageScript[1], packageScript[2]]
    : entry.command;
  const result = await runBrowserCommand(command, {
    cwd: root,
    env: {
      ...process.env,
      SMOKE_MIN_FRAMES: String(frames),
      // This owner already qualifies its lightweight correctness viewport;
      // do not enable that policy for unrelated fleet owners.
      ...(process.env.CI === 'true' && entry.gateId === 'hello-transform-gizmo/browser'
        ? { FORGEAX_BROWSER_CI_LIGHTWEIGHT: '1' }
        : {}),
    },
    timeoutMs,
    label: entry.package,
    gpuLease: true,
  });
  if (result.cancelled) throw new Error(`Dawn smoke cancelled by ${result.cancelled}`);
  // A receipt cannot authorize a process whose cleanup failed.
  if (result.status !== 0 && result.exitCode === 0) result.exitCode = result.status;
  let receipt = null;
  let receiptFailure = null;
  try {
    if (frameReceipt)
      receipt = parseObservedFrameReceipt(result.output, {
        gateId: entry.gateId,
        commandId: entry.commandId,
        frames,
      });
  } catch (error) {
    receiptFailure = error.message;
  }
  const observed = receipt?.framesObserved ?? null;
  const unavailableOrSkipped = frameReceipt
    ? hasUnavailableOrSkipped(result.output, {
        hasReceipt: receipt !== null,
      })
    : hasSkippedGate(result.output) ||
      /^\[[^\]]+\]\s+(?:FAIL\b(?!-AS-EXPECTED)|unavailable\b)/im.test(result.output);
  // Non-frame gates retain their complete command's exit/assertion semantics;
  // child frame receipts are not evidence for the composite lifecycle.
  const status = frameReceipt
    ? resultStatus(result, observed, unavailableOrSkipped, result.output, frames)
    : result.exitCode === 0 && result.signal === null && !result.timedOut && !unavailableOrSkipped
      ? 'pass'
      : 'fail';
  const logName = createHash('sha256').update(gateKey(entry)).digest('hex');
  const logPath = resolve(dirname(reportPath), 'logs', `${logName}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, result.output);
  const logBytes = Buffer.byteLength(result.output);
  const logSha256 = createHash('sha256').update(result.output).digest('hex');
  return {
    package: entry.package,
    path: entry.path,
    gateId: entry.gateId,
    commandId: entry.commandId,
    shardIndex,
    command: entry.command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    unavailable: unavailableOrSkipped && /\bunavailable\b/i.test(result.output),
    skipped: unavailableOrSkipped && /\bskip(?:ped)?\b/i.test(result.output),
    framesObserved: observed,
    framesExpected: frames,
    status,
    result: status,
    unavailableOrSkipped,
    logPath: relative(dirname(reportPath), logPath),
    logSha256,
    logBytes,
    receipt,
    commandResults: [
      {
        commandId: entry.commandId,
        command: entry.command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        status,
      },
    ],
    failureReason: frameReceipt
      ? (resultFailureReason(result, observed, unavailableOrSkipped, frames) ?? receiptFailure)
      : status === 'pass'
        ? null
        : 'assertion-or-composite-failed',
  };
}

export async function runShard({
  rosterPath = defaultRosterPath,
  reportPath = resolve(defaultReportsPath, 'shard.json'),
  roots,
  shardIndex,
  shardCount = SHARD_COUNT,
  expectedProductSha = process.env.EXPECTED_PRODUCT_SHA,
  timeoutMs = Number(process.env.DAWN_SMOKE_ENTRY_TIMEOUT_MS ?? ENTRY_TIMEOUT_MS),
  allowBlocked = false,
  frames = process.env.SMOKE_MIN_FRAMES ?? SMOKE_MIN_FRAMES,
  scope = 'sharded',
} = {}) {
  frames = parseSmokeFrameBudget(frames);
  if (scope === 'full' && allowBlocked) throw new Error('full fleet cannot allow blocked evidence');
  if (!/^[0-9a-f]{40}$/.test(expectedProductSha ?? ''))
    throw new Error('run requires a full external expectedProductSha');
  const actualHead = readHead(root);
  if (actualHead !== expectedProductSha)
    throw new Error(`checked-out product head ${actualHead} does not match expectedProductSha`);
  const { resolved, rosterDigest: digest } = checkRoster({ rosterPath, roots });
  const entries = selectSmokeEntries(resolved, scope);
  const assigned = partitionRunnableEntries(entries, { shardIndex, shardCount, scope });
  preflightRunEntries(assigned.filter((entry) => entry.oracle !== 'assertion'));
  const results = [];
  for (const entry of assigned) {
    results.push(await runEntry({ entry, shardIndex, reportPath, timeoutMs, frames }));
  }
  const report = buildShardReport({
    resolved,
    assigned,
    head: actualHead,
    expectedProductSha,
    rosterDigest: digest,
    shardIndex,
    shardCount,
    results,
    frames,
    scope,
  });
  validateShardReport(report, { frames, scope });
  writeReport(report, reportPath);
  if (
    results.some(
      (result) => result.status === 'fail' || (result.status === 'blocked' && !allowBlocked),
    )
  )
    throw new Error('Dawn smoke shard failed');
  return report;
}

export function readReports(reportDirectory, shardCount = SHARD_COUNT) {
  return Array.from({ length: shardCount }, (_, index) => {
    const path = resolve(reportDirectory, `shard-${index}.json`);
    if (!existsSync(path)) throw new Error(`missing shard report: ${path}`);
    return JSON.parse(readFileSync(path, 'utf8'));
  });
}

export function runAggregate({
  rosterPath = defaultRosterPath,
  reportDirectory = defaultReportsPath,
  roots,
  shardCount = SHARD_COUNT,
  expectedProductSha = process.env.EXPECTED_PRODUCT_SHA,
  allowBlocked = false,
  frames = process.env.SMOKE_MIN_FRAMES ?? SMOKE_MIN_FRAMES,
  scope = 'sharded',
} = {}) {
  frames = parseSmokeFrameBudget(frames);
  if (!/^[0-9a-f]{40}$/.test(expectedProductSha ?? ''))
    throw new Error('aggregate requires a full external expectedProductSha');
  const actualHead = readHead(root);
  if (actualHead !== expectedProductSha)
    throw new Error(`checked-out product head ${actualHead} does not match expectedProductSha`);
  const { resolved, rosterDigest: digest } = checkRoster({ rosterPath, roots });
  const aggregate = aggregateReports({
    reports: readReports(reportDirectory, shardCount),
    resolved,
    head: actualHead,
    expectedProductSha,
    rosterDigest: digest,
    reportDirectory,
    shardCount,
    allowBlocked,
    frames,
    scope,
  });
  writeReport(aggregate, resolve(reportDirectory, 'aggregate.json'));
  process.stdout.write(
    `[dawn-roster] aggregate ${aggregate.status} runnable=${aggregate.runnableResults.length} exclusions=${aggregate.exclusions.length}\n`,
  );
  return aggregate;
}

export function parseCli(argv) {
  const options = {
    mode: '--check',
    roots: undefined,
    shardCount: SHARD_COUNT,
    frames: parseSmokeFrameBudget(process.env.SMOKE_MIN_FRAMES),
    scope: 'sharded',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check' || arg === '--run' || arg === '--aggregate') options.mode = arg;
    else if (arg === '--manifest') options.rosterPath = resolve(root, argv[++index]);
    else if (arg === '--report') options.reportPath = resolve(root, argv[++index]);
    else if (arg === '--reports') options.reportDirectory = resolve(root, argv[++index]);
    else if (arg === '--expected-product-sha') options.expectedProductSha = argv[++index];
    else if (arg === '--shard-index') options.shardIndex = Number(argv[++index]);
    else if (arg === '--shard-count') options.shardCount = Number(argv[++index]);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--allow-blocked') options.allowBlocked = true;
    else if (arg === '--frames') {
      if (argv[index + 1] === undefined) throw new Error('--frames requires an integer budget');
      options.frames = parseSmokeFrameBudget(argv[++index]);
    } else if (arg === '--scope') {
      options.scope = argv[++index];
      if (!['sharded', 'full'].includes(options.scope)) throw new Error('invalid smoke scope');
    } else if (arg === '--roots') {
      options.roots = [];
      while (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--'))
        options.roots.push(argv[++index]);
      if (options.roots.length === 0) throw new Error('--roots requires at least one directory');
    } else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2));
    if (options.mode === '--check') checkRoster(options);
    else if (options.mode === '--run') {
      if (options.shardIndex === undefined) throw new Error('--run requires --shard-index');
      await runShard(options);
    } else runAggregate(options);
  } catch (error) {
    console.error(`[dawn-roster] ${error.message}`);
    process.exitCode = 1;
  }
}
