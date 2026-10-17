import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitJson, runCli } from '../../skills/forgeax-engine-performance/scripts/lib.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receipt = (row) => ({
  worldIdentity: row.worldIdentity,
  deviceGeneration: row.deviceGeneration,
  frameId: row.frameId,
  completedAtMs: row.at,
  submittedAtMs: row.submittedAtMs ?? null,
});
const hudFields = [
  'phase',
  'renderProfile',
  'renderStage',
  'combat',
  'normalFireline',
  'shotFx',
  'terrainMutation',
  'aiPlanning',
  'aiFirePressure',
  'navigationPlanner',
  'combatants',
  'physics',
  'renderChunks',
];

/** Raw frame ID holes can be pending presentations; never count them as pictures. */
export function validateReceipts(result) {
  const rows = [...result.frames, result.closingFrame];
  const first = rows[0];
  let previous;
  for (const row of rows) {
    assert(row && typeof row.worldIdentity === 'string' && row.worldIdentity.length > 0);
    assert(Number.isSafeInteger(row.deviceGeneration) && row.deviceGeneration >= 0);
    assert(Number.isSafeInteger(row.frameId) && row.frameId >= 0);
    assert.equal(row.worldIdentity, first.worldIdentity, 'World changed inside selected cohort');
    assert.equal(
      row.deviceGeneration,
      first.deviceGeneration,
      'Device generation changed inside selected cohort',
    );
    assert(Number.isFinite(row.at) && row.at >= result.start && row.at <= result.end);
    if (previous) {
      assert(row.at >= previous.at, 'Completion clock moved backwards');
      assert(
        row.frameId > previous.frameId,
        'Receipt repeated or moved backwards; closingFrame is appended once',
      );
    }
    previous = row;
  }
  return rows;
}

function nearestHud(samples, at) {
  const valid = (samples ?? []).filter((row) => Number.isFinite(row.at));
  const before = valid
    .filter((row) => row.at <= at)
    .reduce((a, b) => (!a || b.at > a.at ? b : a), null);
  const after = valid
    .filter((row) => row.at >= at)
    .reduce((a, b) => (!a || b.at < a.at ? b : a), null);
  const project = (row) =>
    row === null
      ? null
      : {
          observedAtMs: row.at,
          offsetFromBoundaryMs: row.at - at,
          values: Object.fromEntries(
            hudFields.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
          ),
        };
  return { before: project(before), after: project(after) };
}

/** Locate the first tied minimum using the summary's exact endpoint/count rule. */
export function locateWorstRollingWindow(result, timing) {
  const rows = validateReceipts(result);
  let cursor = 0,
    worst = null,
    windows = 0;
  for (let at = 0; at < rows.length; at++) {
    while (cursor < rows.length && rows[cursor].at < rows[at].at + 1000) cursor++;
    if (cursor === rows.length) break;
    const ms = rows[cursor].at - rows[at].at;
    const fps = ((cursor - at) * 1000) / ms;
    windows++;
    if (worst === null || fps < worst.fps) worst = { at, next: cursor, ms, fps };
  }
  assert.equal(
    windows,
    timing.rollingOneSecondWindows,
    'Locator differs from authoritative summary window count',
  );
  assert.equal(
    worst?.fps ?? null,
    timing.rollingOneSecondMinFps,
    'Locator differs from authoritative summary minimum',
  );
  if (worst === null)
    return { status: 'notObserved', reason: 'no-full-one-second-interval', timing };
  const { at, next, ms, fps } = worst;
  return {
    status: 'observed',
    timing,
    worst: {
      fps,
      intervalMs: ms,
      completedIntervals: next - at,
      endpointReceipts: next - at + 1,
      first: receipt(rows[at]),
      last: receipt(rows[next]),
      includesClosingFrame: next === rows.length - 1,
      fromFirstLiveMs: Number.isFinite(result.firstLiveAt)
        ? rows[at].at - result.firstLiveAt
        : null,
      toFirstLiveMs: Number.isFinite(result.firstLiveAt)
        ? rows[next].at - result.firstLiveAt
        : null,
      hudAtStart: nearestHud(result.samples, rows[at].at),
      hudAtEnd: nearestHud(result.samples, rows[next].at),
    },
    semantics:
      'Each start uses the first completion at or after start+1000ms. Count interval endpoints as next-start intervals, never frame-ID delta or receipts+1. Closing receipt is appended exactly once; first tied minimum wins.',
    hudScope:
      'Nearest public HUD observations on each side of each endpoint by the same Host clock. HUD samples carry no frame/world/device receipt identity and may lag gameplay. Correlation only; no CPU/GPU/resource attribution.',
  };
}

async function authenticatedModules(gameRoot, commit) {
  assert.match(commit, /^[0-9a-f]{40}$/);
  const hashes = {},
    seen = new Set();
  async function visit(path) {
    path = resolve(path);
    if (seen.has(path)) return;
    seen.add(path);
    const name = relative(gameRoot, path).replaceAll('\\', '/');
    assert(!name.startsWith('../'));
    const bytes = await readFile(path);
    const historical = execFileSync('git', ['show', `${commit}:${name}`], { cwd: gameRoot });
    assert.deepEqual(bytes, historical, `Source differs from captured Game commit: ${name}`);
    hashes[name] = sha(bytes);
    for (const match of bytes
      .toString()
      .matchAll(/\bimport\s+(?:[^;]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g)) {
      await visit(resolve(dirname(path), match[1]));
    }
  }
  const summary = resolve(gameRoot, 'scripts/performance/completed-frame-window.mjs');
  const selection = resolve(gameRoot, 'scripts/performance/terrain-gradient-ab-evidence.mjs');
  await visit(summary);
  await visit(selection);
  return {
    hashes,
    summary: await import(pathToFileURL(summary)),
    selection: await import(pathToFileURL(selection)),
  };
}

export async function deriveWorstWindow({ framesPath, authorityPath, gameRoot, scope = 'live' }) {
  assert(['live', 'full'].includes(scope));
  gameRoot = resolve(gameRoot);
  const rawBytes = await readFile(framesPath),
    authorityBytes = await readFile(authorityPath);
  const raw = JSON.parse(rawBytes),
    authority = JSON.parse(authorityBytes);
  const modules = await authenticatedModules(gameRoot, authority.gameCommit);
  const driver = await readFile(resolve(gameRoot, 'scripts/perf-combat-browser.mjs'));
  assert.equal(
    sha(driver),
    authority.driverSha256,
    'Current collector differs from capture authority',
  );
  validateReceipts(raw);
  const selected = scope === 'live' ? modules.selection.liveCompletionWindow(raw) : raw;
  const timing = modules.summary.summarizeCompletedFrames(selected);
  return {
    schemaVersion: 1,
    scope,
    ...locateWorstRollingWindow(selected, timing),
    authority: {
      capture: resolve(authorityPath),
      captureSha256: sha(authorityBytes),
      frames: resolve(framesPath),
      framesSha256: sha(rawBytes),
      gameCommit: authority.gameCommit,
      engineCommit: authority.engineCommit,
      indexHtmlSha256: authority.indexSha256,
      timeOriginMs: raw.timeOrigin ?? null,
      collectorSha256: authority.driverSha256,
      verifiedSourceSha256: modules.hashes,
    },
    captureOk: authority.ok,
    captureErrors: authority.errors ?? [],
    ordinaryFpsAcceptance:
      authority.ok === true &&
      authority.ordinaryFpsAcceptance !== false &&
      authority.diagnosticOnly !== true &&
      authority.gpuTimingEnabled !== true,
    limitation:
      'This locates the original selected completed-window minimum. It neither makes a failed capture pass nor attributes that interval. Full raw and cold/BUY evidence remain separate.',
  };
}

runCli(import.meta.url, async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node worst-completed-window.mjs ordinary-frames.json report.json GAME_ROOT output.json [live|full]\nLocates the exact worst completed rolling one-second window using captured Game source authority. Offline only; no browser, sampling or attribution. Output must be new and cannot alias any input, collector or authenticated Game dependency.\n',
    );
    return;
  }
  const [framesPath, authorityPath, gameRoot, output, scope = 'live'] = args;
  assert(
    (args.length === 4 || args.length === 5) && framesPath && authorityPath && gameRoot && output,
    'Usage: node worst-completed-window.mjs ordinary-frames.json report.json GAME_ROOT output.json [live|full]',
  );
  const result = await deriveWorstWindow({ framesPath, authorityPath, gameRoot, scope });
  await emitJson(
    result,
    output,
    [
      framesPath,
      authorityPath,
      resolve(gameRoot, 'scripts/perf-combat-browser.mjs'),
      ...Object.keys(result.authority.verifiedSourceSha256).map((name) => resolve(gameRoot, name)),
    ],
    { exclusive: true },
  );
  console.log(
    JSON.stringify({
      status: result.status,
      scope,
      fps: result.worst?.fps,
      first: result.worst?.first,
      last: result.worst?.last,
    }),
  );
});
