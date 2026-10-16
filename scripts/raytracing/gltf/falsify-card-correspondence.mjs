import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const [cards, association, reference, output] = process.argv.slice(2).map((p) => resolve(p));
assert(
  cards && association && reference && output,
  'falsify-card-correspondence <cards.json> <association-output> <material-reference-output> <report.json>',
);
const scratch = await mkdtemp(resolve(tmpdir(), 'card-correspondence-'));
const report = [];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const baseline = JSON.parse(await readFile(resolve(reference, 'gpu.json'), 'utf8'));
const name = baseline.cohorts[0].name;
try {
  for (const mode of [
    'material-bytes',
    'cohort-rays',
    'missing-replay',
    'missing-source-check',
    'global-position',
    'card-position',
  ]) {
    const target = resolve(scratch, mode);
    await mkdir(target);
    const replaced = new Map();
    const gpu = structuredClone(baseline);
    if (mode === 'material-bytes') {
      const bytes = await readFile(resolve(reference, `${name}-inputs.bin`));
      bytes[208] ^= 1;
      replaced.set(`${name}-inputs.bin`, bytes);
    } else if (mode === 'cohort-rays') {
      const cohorts = JSON.parse(await readFile(resolve(reference, 'cohorts.json'), 'utf8'));
      cohorts[0].rays[0].origin[0] += 1;
      const bytes = Buffer.from(JSON.stringify(cohorts));
      replaced.set('cohorts.json', bytes);
      // Re-seal the changed file: the cross-capture input comparison must still reject it.
      gpu.artifacts['cohorts.json'] = sha(bytes);
    } else if (mode === 'missing-replay') gpu.checks.pop();
    else if (mode === 'missing-source-check') gpu.sourceChecks[0].initialSeedsByteExact = false;
    replaced.set('gpu.json', Buffer.from(JSON.stringify(gpu)));
    for (const file of await readdir(reference)) {
      if (replaced.has(file)) await writeFile(resolve(target, file), replaced.get(file));
      else await symlink(resolve(reference, file), resolve(target, file));
    }
    // Use a private output directory even if a falsifier unexpectedly passes.
    const assoc = resolve(target, 'association');
    await mkdir(assoc);
    for (const file of await readdir(association)) {
      if (file === 'gap-diagnosis.json' && mode.endsWith('-position')) {
        const diagnosis = JSON.parse(await readFile(resolve(association, file), 'utf8'));
        const ray = diagnosis.rows[0].perRay.find((r) => r.actual.some((c) => c.selected));
        assert(ray);
        if (mode === 'global-position') ray.position[0] += 1;
        else ray.actual.find((c) => c.selected).selected.positions[0][0] += 1;
        await writeFile(resolve(assoc, file), JSON.stringify(diagnosis));
      } else if (file !== 'material-correspondence.json')
        await symlink(resolve(association, file), resolve(assoc, file));
    }
    const result = spawnSync(
      process.execPath,
      [
        new URL('./inspect-card-correspondence.mjs', import.meta.url).pathname,
        cards,
        assoc,
        target,
        '256',
      ],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const expected = {
      'material-bytes': 'reference digest mismatch',
      'cohort-rays': 'reference cohort differs from association rays',
      'missing-replay': 'reference.checks.length',
      'missing-source-check': 'sourceCheck?.initialSeedsByteExact',
      'global-position': 'diagnostic Global position differs from query readback',
      'card-position': 'diagnostic Card position differs from captured depth',
    }[mode];
    assert.equal(result.status, 1, `${mode}: expected assertion failure`);
    assert(result.stderr.includes(expected), `${mode}: wrong failure: ${result.stderr}`);
    report.push({ mode, exitCode: result.status, expectedFailure: expected, detected: true });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
await writeFile(output, JSON.stringify({ originalsUnmodified: true, cases: report }, null, 2));
console.log(JSON.stringify(report, null, 2));
