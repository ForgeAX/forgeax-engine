import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const downstreamContract = resolve(
  repoRoot,
  'packages/render/src/transmission/__tests__/composition.integration.test.ts',
);

const cases = {
  'missing-copy': {
    file: '../../../../../packages/render/src/transmission/backdrop.ts',
    marker: "addCopyPass('transmission-backdrop-copy'",
    description: 'snapshot copy is mandatory before transmission sampling',
    testName: 'omitted-backdrop-copy',
  },
  'reverse-order': {
    file: '../../../../../packages/render/src/transmission/backdrop.ts',
    marker: "phases.push('transmission-forward', 'transparent', 'temporal')",
    description: 'transmission must precede ordinary BLEND',
    testName: 'reversed-phase-order',
  },
  'reactive-zero': {
    file: '../../../../../packages/render/src/transmission/backdrop.ts',
    marker: 'addTransmissionBackdropTemporalPass',
    description: 'transmission coverage must reach the existing temporal producer',
    testName: 'reactive-zero-coverage',
  },
};
const selected = process.env.FORGEAX_TRANSMISSION_FALSIFY;
if (selected === undefined) {
  console.log(JSON.stringify({ executionPath: 'node:carrier-falsifier', available: Object.keys(cases), verdict: 'not-run' }, null, 2));
  process.exit(0);
}
const selectedCase = cases[selected];
if (selectedCase === undefined) throw new Error(`unknown transmission falsifier: ${selected}`);
const source = await readFile(resolve(import.meta.dirname, selectedCase.file), 'utf8');
const markerPresent = source.includes(selectedCase.marker);
if (!markerPresent) throw new Error(`baseline invariant missing for ${selected}: ${selectedCase.description}`);

// The downstream integration test applies the selected mutation to the real
// pass list and asserts that the same composition contract fails. This keeps
// the falsifier coupled to RenderGraph execution rather than a string-only
// self-check in this carrier script.
const downstream = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--project=@forgeax/engine-render',
    '--maxWorkers=1',
    downstreamContract,
    '-t',
    `dev falsifier ${selectedCase.testName}`,
  ],
  { cwd: repoRoot, stdio: 'inherit', env: { ...process.env } },
);
const downstreamPassed = downstream.status === 0;
const receipt = {
  executionPath: 'node:carrier-falsifier',
  selected,
  mutation: { marker: selectedCase.marker, appliedToDownstreamCompositionTest: true },
  downstream: { command: 'composition.integration.test.ts', testName: selectedCase.testName },
  verdict: downstreamPassed ? 'pass' : 'fail',
  confidence: 'downstream-render-graph',
};
if (receipt.verdict !== 'pass') throw new Error(JSON.stringify(receipt));
console.log(JSON.stringify(receipt, null, 2));
