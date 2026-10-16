import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUnifiedCli } from '@forgeax/engine/devkit';
import { runProfilerCli } from '@forgeax/engine/profiler/cli';
import { sampleCapture } from '../../features/profiler-remote-debug/_shared/sample-capture';
import { defineFeature } from '../../lab/feature';

interface Envelope {
  ok?: boolean;
  value?: Record<string, unknown>;
  error?: { code?: string };
}

async function forgeax(args: readonly string[]): Promise<{ code: number; json: Envelope }> {
  const json = (await runUnifiedCli(args)) as Envelope;
  return { code: json.ok === true ? 0 : 1, json };
}

export default defineFeature({
  title: 'Profiler CLI',
  catalog: 'Profiler CLI',
  kind: 'headless',
  summary:
    'forgeax profile summary/compare (dispatched in-process through runUnifiedCli, the same path the forgeax bin uses) and the package-owned profiler cli project saved ProfileCapture JSON offline into structured summaries and per-phase deltas without a browser.',
  expect:
    'summary reports captureId, frameCount 3 and p95 3000us; compare returns left/right summaries and a frame-total phase row; a missing file exits non-zero with cli-input-file-read-failed; the in-process CLI rejects an unknown flag with exit 2.',
  async run(checks) {
    const dir = await mkdtemp(join(tmpdir(), 'fl-profile-cli-'));
    try {
      const left = join(dir, 'left.json');
      const right = join(dir, 'right.json');
      await writeFile(left, JSON.stringify(sampleCapture('capture-0001', [1000, 2000, 3000])));
      await writeFile(right, JSON.stringify(sampleCapture('capture-0002', [2000, 4000, 6000])));

      const summary = await forgeax(['profile', 'summary', '--artifact', left, '--json']);
      checks.ok(
        'summary exit 0',
        summary.code === 0 && summary.json.ok === true,
        JSON.stringify(summary.json.error),
      );
      checks.equal('summary captureId', summary.json.value?.captureId, 'capture-0001');
      checks.equal('summary frameCount', summary.json.value?.frameCount, 3);
      checks.equal('summary p95', summary.json.value?.p95DurationMicros, 3000);

      const compare = await forgeax([
        'profile',
        'compare',
        '--left-file',
        left,
        '--right-file',
        right,
        '--json',
      ]);
      checks.ok(
        'compare exit 0',
        compare.code === 0 && compare.json.ok === true,
        JSON.stringify(compare.json.error),
      );
      const phases = (compare.json.value?.phases ?? []) as { identity?: { phase?: string } }[];
      checks.ok(
        'compare frame-total row',
        phases.some((row) => row.identity?.phase === 'frame-total'),
        `${phases.length} rows`,
      );
      const rightSide = compare.json.value?.right as
        | { summary?: { p95DurationMicros?: number } }
        | undefined;
      checks.equal('compare right p95', rightSide?.summary?.p95DurationMicros, 6000);

      const missing = await forgeax([
        'profile',
        'summary',
        '--artifact',
        join(dir, 'none.json'),
        '--json',
      ]);
      checks.ok(
        'missing artifact is structured',
        missing.code !== 0 &&
          missing.json.ok === false &&
          missing.json.error?.code === 'cli-input-file-read-failed',
        `exit ${missing.code} ${missing.json.error?.code}`,
      );

      const bad = runProfilerCli(['--bogus', 'x'], '');
      const badCode = (JSON.parse(bad.stderr || '{}') as { error?: { code?: string } }).error?.code;
      checks.ok(
        'in-process unknown flag',
        bad.exitCode === 2 && badCode === 'cli-arguments-invalid',
        `${bad.exitCode} ${badCode}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});
