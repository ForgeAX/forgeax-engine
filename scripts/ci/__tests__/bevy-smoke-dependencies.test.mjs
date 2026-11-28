import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const bevyRoot = join(process.cwd(), 'apps', 'bevy');

test('existing smoke workers own every Bevy gate and protected Bevy names only project their result', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const worker = workflow.jobs['smoke-fleet'];
  const legacy = workflow.jobs['bevy-smoke-fleet'];
  assert.deepEqual(worker.strategy.matrix.group, [0, 1, 2, 3]);
  assert.deepEqual(legacy.strategy.matrix.group, [0, 1, 2]);
  assert.deepEqual(legacy.needs, ['smoke-fleet']);
  assert.match(legacy['runs-on'], /standard/);
  assert.equal(legacy.steps.length, 1);
  assert.match(legacy.steps[0].run, /success\|skipped/);
  assert.match(legacy.steps[0].env.MATRIX_RESULT, /needs.smoke-fleet.result/);
  const install = worker.steps.findIndex(
    (step) => step.uses === './.github/actions/install-playwright-chrome',
  );
  const bevy = worker.steps.findIndex(
    (step) => step.name === 'Bevy examples headless smokes (dawn-node)',
  );
  assert.ok(install >= 0 && bevy > install);
  assert.equal(worker.steps[bevy].if, "steps.ci-repair.outputs.reused != 'true'");
  assert.match(worker.steps[bevy].run, /--groups 4 --concurrency auto/);
  assert.ok(!worker.steps.some((step) => step.run?.includes('--app-root apps/bevy')));
  assert.match(
    readFileSync('scripts/bevy-demo.mjs', 'utf8'),
    /apps\.flatMap\(\(app\) => \[.*--app-root/,
  );
  assert.equal(worker.steps[bevy].env.SMOKE_MIN_FRAMES, 60);
  assert.equal(worker.steps[bevy].env.SMOKE_DURATION_MS, 1000);
  assert.ok(!worker.steps[install]['continue-on-error']);
  const evidence = worker.steps.find((step) => step.name === 'Preserve Bevy SSAO failure evidence');
  assert.equal(evidence.with.path, 'apps/bevy/ssao/artifacts/');
  assert.match(evidence.if, /failure\(\)/);
  const skybox = JSON.parse(readFileSync(join(bevyRoot, 'skybox/package.json'), 'utf8'));
  assert.match(skybox.scripts.smoke, /smoke:webgl2/);
});

test('Bevy smoke scripts declare every direct ForgeAX package import', () => {
  const missing = [];
  for (const app of readdirSync(bevyRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appRoot = join(bevyRoot, app.name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    let scripts;
    try {
      scripts = readdirSync(join(appRoot, 'scripts'));
    } catch {
      continue;
    }
    for (const file of scripts.filter((name) => name.endsWith('.mjs'))) {
      const source = readFileSync(join(appRoot, 'scripts', file), 'utf8');
      const imports = source.matchAll(/(?:from\s+|import\()\s*['"](@forgeax\/[^/'"]+)/g);
      for (const match of imports) {
        const packageName = match[1];
        if (!declared.has(packageName)) missing.push(`${app.name}/${file}: ${packageName}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('four merged Bevy partitions execute every registered example exactly once', () => {
  const reference = spawnSync(process.execPath, ['scripts/bevy-demo.mjs', 'smokes', '--dry-run'], {
    encoding: 'utf8',
  });
  assert.equal(reference.status, 0, reference.stderr);
  const members = (output) =>
    [...output.matchAll(/\[bevy-smoke\] pnpm --filter (\S+) smoke/g)].map((match) => match[1]);
  const expected = members(reference.stdout).sort();
  assert.ok(expected.length > 0);
  const actual = [];
  for (let group = 0; group < 4; group++) {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/bevy-demo.mjs',
        'smokes',
        '--dry-run',
        '--prepared-inputs',
        '--group',
        String(group),
        '--groups',
        '4',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    actual.push(...members(result.stdout));
  }
  assert.equal(new Set(actual).size, actual.length);
  assert.deepEqual(actual.sort(), expected);
});
