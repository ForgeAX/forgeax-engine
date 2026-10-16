#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SABOTAGES = [
  'm17-disconnect-recovery',
  'm17-duplicate-exactly-once',
  'm17-out-of-order-baseline',
  'm17-delayed-delivery',
  'm17-late-join-baseline',
];
const artifactDir = resolve(
  process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ?? mkdtempSync(resolve(tmpdir(), 'forgeax-m17-network-')),
);
mkdirSync(artifactDir, { recursive: true });

function run(label, command, args, overrides = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FORGEAX_SKIP_HARNESS_SYNC: '1',
      ...overrides,
    },
    encoding: 'utf8',
    // The real chaos evidence includes bounded frame lineage for three
    // repeats; keep the subprocess capture above that deterministic payload.
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(resolve(artifactDir, `${label}.stdout.log`), stdout);
  writeFileSync(resolve(artifactDir, `${label}.stderr.log`), stderr);
  if (result.error !== undefined) {
    writeFileSync(
      resolve(artifactDir, `${label}.spawn-error.json`),
      `${JSON.stringify({ message: result.error.message }, null, 2)}\n`,
    );
  }
  return { status: result.status ?? 1, stdout, stderr };
}

function extractJson(output, marker, label) {
  const line = output.split(/\r?\n/).find((candidate) => candidate.includes(marker));
  if (line === undefined) throw new Error(`${label}: missing ${marker} evidence`);
  try {
    return JSON.parse(line.slice(line.indexOf(marker) + marker.length));
  } catch (cause) {
    throw new Error(`${label}: invalid ${marker} evidence: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function requirePositiveControls(evidence, label) {
  const controls = evidence?.controls;
  if (controls === undefined || evidence?.cleanup === undefined)
    throw new Error(`${label}: incomplete chaos evidence`);
  const required = [
    ['disconnect', controls.disconnect?.delivered > 0],
    ['duplicate', controls.duplicate?.copies > 0],
    ['out-of-order', controls['out-of-order']?.staleReplayed > 0],
    ['delayed-delivery', controls['delayed-delivery']?.delayedFrames > 0],
    ['late-join', controls['late-join']?.observed > 0],
  ];
  const missing = required.filter(([, passed]) => !passed).map(([name]) => name);
  if (missing.length > 0) throw new Error(`${label}: controls not applied: ${missing.join(', ')}`);
  if (evidence.authorityPendingDrained === false ||
    evidence.acceptedMutationIdentities?.replicaRowsUnique === false ||
    evidence.clientCleanup?.allRetired === false ||
    evidence.clientCleanup?.allZeroOwnedResources === false)
    throw new Error(`${label}: lifecycle or exactly-once proof failed`);
  if (evidence.acceptedMutationIdentities !== undefined &&
    evidence.acceptedMutationIdentities.duplicateWireKeys?.length === 0)
    throw new Error(`${label}: duplicate wire identity was not recorded`);
  if (evidence.baseline !== undefined &&
    (evidence.baseline.packet?.kind !== 'baseline' || evidence.baseline.packet?.sequence !== 1 ||
      evidence.baseline.beforeDelta !== true))
    throw new Error(`${label}: fresh baseline ordering proof failed`);
  if (evidence.interaction !== undefined && evidence.interaction.accepted !== true)
    throw new Error(`${label}: post-recovery browser interaction proof failed`);
  const resources = evidence.cleanup.resources ?? evidence.cleanup.proxy?.resources;
  if (resources === undefined || Object.values(resources).some((value) => value !== false && value !== 0))
    throw new Error(`${label}: cleanup resources did not drain: ${JSON.stringify(resources)}`);
}

function requireProcessMatrix(runResult) {
  if (runResult.status !== 0) throw new Error(`process positive matrix failed with exit ${runResult.status}`);
  const evidence = extractJson(runResult.stdout, '[m17-net] evidence: ', 'process positive matrix');
  if (evidence.repeats !== 3 || !Array.isArray(evidence.cases) || evidence.cases.length !== 3)
    throw new Error(`process positive matrix did not repeat three times: ${JSON.stringify(evidence)}`);
  for (const [index, item] of evidence.cases.entries()) requirePositiveControls(item, `process repeat ${index + 1}`);
  writeFileSync(resolve(artifactDir, 'm17-process-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

function requireBrowserRun(runResult, index) {
  if (runResult.status !== 0) throw new Error(`browser positive repeat ${index} failed with exit ${runResult.status}`);
  const line = runResult.stdout.split(/\r?\n/).find((candidate) => candidate.includes('"m17ChaosEvidence":'));
  if (line === undefined) throw new Error(`browser repeat ${index}: missing m17ChaosEvidence evidence`);
  let evidence;
  try {
    evidence = JSON.parse(line).m17ChaosEvidence;
  } catch (cause) {
    throw new Error(`browser repeat ${index}: invalid m17ChaosEvidence evidence: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  requirePositiveControls(evidence, `browser repeat ${index}`);
  writeFileSync(
    resolve(artifactDir, `m17-browser-evidence-${index}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

const processResult = run(
  'm17-process-positive',
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    'src/__tests__/process-e2e.test.ts',
    '-t',
    'M17 real WebSocket chaos gauntlet',
    '--reporter=verbose',
    '--disableConsoleIntercept',
  ],
  { M17_CHAOS_MODE: 'all', M17_SABOTAGE: '' },
);
try {
  requireProcessMatrix(processResult);
  for (let index = 1; index <= 3; index += 1) {
    const browserResult = run(
      `m17-browser-positive-${index}`,
      'node',
      ['scripts/browser-e2e.mjs'],
      {
        FORGEAX_ENGINE_RHI_DEBUG: '1',
        M17_CHAOS_MODE: 'all',
        M17_SABOTAGE: '',
        SNAKE_SABOTAGE: '',
        FORGEAX_VISUAL_EVIDENCE_DIR: resolve(artifactDir, `browser-${index}`),
      },
    );
    requireBrowserRun(browserResult, index);
  }
  for (const sabotage of SABOTAGES) {
    const sabotageResult = run(
      `m17-sabotage-${sabotage}`,
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        'src/__tests__/process-e2e.test.ts',
        '-t',
        'M17 real WebSocket chaos gauntlet',
        '--reporter=verbose',
        '--disableConsoleIntercept',
      ],
      { M17_CHAOS_MODE: 'all', M17_REPEATS: '1', M17_SABOTAGE: sabotage },
    );
    const marker = `[m17-sabotage:${sabotage}]`;
    const output = `${sabotageResult.stdout}\n${sabotageResult.stderr}`;
    // Vitest's verbose reporter renders a thrown Error as `→ [marker]` and
    // omits the `Error:` prefix. The subprocess exit remains the failure
    // oracle; the marker only identifies the intended sabotage.
    if (sabotageResult.status === 0 || !output.includes(marker))
      throw new Error(`${sabotage}: expected a failing named sabotage, got exit ${sabotageResult.status}`);
    process.stdout.write(`[m17-net] sabotage ${sabotage}: PASS\n`);
  }
  process.stdout.write('[m17-net] complete real-WebSocket chaos matrix repeats=3: PASS\n');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
