import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [baselinePath, candidatePath, output] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !output)
  throw Error('Pass baseline.js candidate.js output.json');
const baseline = await import(pathToFileURL(resolve(baselinePath)).href);
const candidate = await import(pathToFileURL(resolve(candidatePath)).href);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const before = loadavg();
const results = [];
for (const mode of baseline.modes) {
  const a = await baseline.createCase(mode),
    b = await candidate.createCase(mode);
  try {
    for (let warm = 0; warm < 12; warm++) {
      a.run(5);
      b.run(5);
    }
    const samples = [];
    for (let pair = 0; pair < 41; pair++) {
      let old, changed;
      if (pair % 2) {
        changed = b.run(5);
        old = a.run(5);
      } else {
        old = a.run(5);
        changed = b.run(5);
      }
      samples.push({ baselineMs: old, candidateMs: changed });
    }
    const row = {
      mode,
      baselineMedianMs: median(samples.map((s) => s.baselineMs)),
      candidateMedianMs: median(samples.map((s) => s.candidateMs)),
      medianPairedRatio: median(samples.map((s) => s.candidateMs / s.baselineMs)),
      baselineWork: a.inspect(),
      candidateWork: b.inspect(),
      samples,
    };
    results.push(row);
    console.log(
      JSON.stringify({
        mode,
        baselineMs: row.baselineMedianMs,
        candidateMs: row.candidateMedianMs,
        ratio: row.medianPairedRatio,
      }),
    );
  } finally {
    a.close();
    b.close();
  }
}
await writeFile(
  output,
  JSON.stringify(
    {
      node: process.version,
      cpu: cpus()[0]?.model,
      loadBefore: before,
      loadAfter: loadavg(),
      warmupCallsPerArm: 60,
      measuredCallsPerArm: 205,
      method:
        'Alternating paired same-process real production owner; no spies. Fixture preparation, claim-table construction and assertions outside timed regions. CPU-only; no FPS/GPU inference.',
      sha256: Object.fromEntries(
        await Promise.all(
          [baselinePath, candidatePath].map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]),
        ),
      ),
      results,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
