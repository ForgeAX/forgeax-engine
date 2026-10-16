import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const pairedTest =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts';
const manifestPath = resolve(repoRoot, 'apps/parity/color-lighting/dist/shaders/manifest.json');
const falsifiers = ['tile-minus-one', 'wrong-tile', 'eval-spot'];
const metricTest = 'reports HDRP spot-shadow falsifier pixels';
const SHADOW_DELTA_THRESHOLD = 0.05;

function run(falsifier) {
  const outputDir = mkdtempSync(join(tmpdir(), 'forgeax-spot-shadow-'));
  const outputPath = join(outputDir, 'metrics.json');
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--project=dawn', pairedTest, '-t', metricTest, '--retry=0'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORGEAX_DAWN_SHADER_MANIFEST: manifestPath,
        FORGEAX_DAWN_SPOT_SHADOW_METRICS: '1',
        FORGEAX_DAWN_SPOT_SHADOW_PIPELINE: 'hdrp',
        FORGEAX_DAWN_SPOT_SHADOW_METRICS_OUT: outputPath,
        ...(falsifier === undefined ? {} : { FORGEAX_DAWN_SPOT_SHADOW_FALSIFIER: falsifier }),
      },
    },
  );
  try {
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      throw new Error(`metrics run failed for ${falsifier ?? 'baseline'} with status ${result.status}`);
    }
    try {
      return JSON.parse(readFileSync(outputPath, 'utf8'));
    } catch (error) {
      process.stdout.write(result.stdout ?? '');
      process.stderr.write(result.stderr ?? '');
      throw new Error(`metrics run emitted no real-pixel record for ${falsifier ?? 'baseline'}: ${error}`);
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

const baseline = run(undefined);
if (baseline.metrics.delta <= SHADOW_DELTA_THRESHOLD) {
  throw new Error(`HDRP spot-shadow baseline is not shadowed: ${JSON.stringify(baseline)}`);
}
console.log(`baseline=${JSON.stringify(baseline)}`);

for (const id of falsifiers) {
  const mutated = run(id);
  if (mutated.metrics.delta > SHADOW_DELTA_THRESHOLD) {
    throw new Error(`falsifier ${id} did not collapse the shadow ROI: ${JSON.stringify({ baseline, mutated })}`);
  }
  console.log(`falsifier=${id} mutated=${JSON.stringify(mutated)} expected=collapsed`);
}
