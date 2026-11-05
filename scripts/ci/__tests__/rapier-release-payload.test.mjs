import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  hydrateRapierPayload,
  installRapierArchive,
  installRapierPayload,
  packRapierPayload,
  rapierAssetName,
} from '../rapier-release-payload.mjs';

test('Rapier verifies local/release bytes before optional cache and preserves source fallback', () => {
  const steps = parse(readFileSync('.github/actions/prepare-rapier-wasm/action.yml', 'utf8')).runs
    .steps;
  const current = steps.findIndex((step) => step.id === 'current');
  const cache = steps.findIndex((step) => step.id === 'payload-cache');
  const verify = steps.findIndex((step) => step.id === 'payload');
  assert.ok(current >= 0 && current < cache && cache < verify);
  assert.equal(steps[cache].if, "steps.current.outputs.ready != 'true'");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal Actions token expression.
  assert.equal(steps[current].env.GITHUB_TOKEN, '${{ github.token }}');
  assert.match(steps[current].run, /--hydrate/);
  assert.match(steps[current].run, /2d 3d/);
  assert.equal(
    steps.find((step) => step.name === 'Build Rapier from pinned sources and patches').if,
    "steps.payload.outputs.needs_build == 'true'",
  );
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-rapier-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'scripts/lib',
    'packages/physics-rapier3d/scripts',
    'packages/physics-rapier3d/patches',
  ]) {
    mkdirSync(join(root, path), { recursive: true });
    cpSync(resolve(path), join(root, path), { recursive: true });
  }
  mkdirSync(join(root, 'scripts/forgeax'), { recursive: true });
  cpSync(
    resolve('scripts/forgeax/build-rapier-native.mjs'),
    join(root, 'scripts/forgeax/build-rapier-native.mjs'),
  );
  cpSync(resolve('package.json'), join(root, 'package.json'));
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  for (const dim of ['2d', '3d']) {
    const owner = `packages/physics-rapier${dim}`;
    mkdirSync(join(root, owner), { recursive: true });
    cpSync(resolve(owner, 'package.json'), join(root, owner, 'package.json'));
    symlinkSync(resolve(owner, 'node_modules'), join(root, owner, 'node_modules'), 'dir');
  }
  return root;
}

async function seed(root, dimension, directory) {
  const name = await rapierAssetName(dimension, root);
  const contentKey = name.match(/-([a-f0-9]{64})\.tar\.gz$/)[1];
  mkdirSync(directory, { recursive: true });
  const bytes = 'throw new Error("admission must not execute payload JavaScript");';
  writeFileSync(join(directory, 'rapier.mjs'), bytes);
  if (process.platform === 'darwin')
    execFileSync('xattr', [
      '-w',
      'com.forgeax.ci-fixture',
      'metadata',
      join(directory, 'rapier.mjs'),
    ]);
  writeFileSync(
    join(directory, 'provenance.json'),
    JSON.stringify({
      contentKey,
      artifacts: { 'rapier.mjs': createHash('sha256').update(bytes).digest('hex') },
    }),
  );
}

for (const dimension of ['2d', '3d']) {
  test(`Rapier ${dimension} release roundtrip uses the actual unchanged producer`, async (t) => {
    const root = fixture(t);
    const input = join(root, 'input');
    await seed(root, dimension, input);
    const archive = await packRapierPayload(dimension, input, join(root, 'out'), root);
    assert.equal(archive, join(root, 'out', await rapierAssetName(dimension, root)));
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((name) => !name.endsWith('/'))
      .map((name) => name.replace(/^\.\//, ''))
      .sort();
    assert.deepEqual(members, ['provenance.json', 'rapier.mjs']);

    const pkg = join(root, `packages/physics-rapier${dimension}/pkg`);
    rmSync(pkg, { recursive: true });
    await installRapierArchive(dimension, archive, root);
    assert.equal(
      readFileSync(join(pkg, 'rapier.mjs'), 'utf8'),
      readFileSync(join(input, 'rapier.mjs'), 'utf8'),
    );
    // A current publication must finish before reaching any network lookup.
    await hydrateRapierPayload(dimension, root);
  });
}

for (const invalid of ['stale-source', 'corrupt-bytes', 'missing-file', 'extra-file']) {
  test(`Rapier admission rejects ${invalid} and restores the previous receiver bytes`, async (t) => {
    const root = fixture(t);
    const input = join(root, 'input');
    await seed(root, '3d', input);
    if (invalid === 'stale-source') {
      const path = join(input, 'provenance.json');
      const receipt = JSON.parse(readFileSync(path));
      receipt.contentKey = '0'.repeat(64);
      writeFileSync(path, JSON.stringify(receipt));
    }
    if (invalid === 'corrupt-bytes') writeFileSync(join(input, 'rapier.mjs'), 'changed');
    if (invalid === 'missing-file') rmSync(join(input, 'rapier.mjs'));
    if (invalid === 'extra-file') writeFileSync(join(input, 'unexpected'), 'extra');
    const pkg = join(root, 'packages/physics-rapier3d/pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'previous'), 'retain receiver bytes');
    await assert.rejects(installRapierPayload('3d', input, root));
    assert.equal(readFileSync(join(pkg, 'previous'), 'utf8'), 'retain receiver bytes');
  });
}

test('Rapier archive rejects linked payloads before receiver installation', async (t) => {
  const root = fixture(t);
  const input = join(root, 'input');
  mkdirSync(input);
  symlinkSync('../outside', join(input, 'linked'));
  const archive = join(root, 'linked.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', input, '.']);
  await assert.rejects(installRapierArchive('3d', archive, root), /link or special file/);
});

test('Rapier release publication stays on main and preserves all runtime gates', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const job = workflow.jobs['publish-rapier-wasm-release'];
  assert.ok(job);
  assert.equal(job.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
  assert.equal(job.needs, 'core-build');
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.permissions.contents, 'write');
  const core = workflow.jobs['core-build'].steps;
  const stance = core.findIndex((step) => step.name === 'Workflow stance preflight');
  const native = core.findIndex((step) => step.name === 'Prepare current wgpu-wasm');
  assert.ok(stance >= 0 && stance < native, 'reject source policy drift before native preparation');
  assert.equal(core[stance].run, 'node apps/hello/triangle/scripts/ac-08-grep-gate.mjs');

  const script = job.steps.find(
    (step) => step.name === 'Verify, pack and publish both Rapier payloads',
  ).run;
  assert.match(script, /for dimension in 2d 3d/);
  assert.match(script, /--pack/);
  assert.match(script, /publish-wasm-release\.mjs/);
  assert.match(script, /build-output\/packages\/physics-rapier/);
  for (const gate of [
    'coverage-pnpm',
    'vitest-browser',
    'vitest-dawn',
    'smoke-fleet',
    'bevy-smoke-fleet',
  ]) {
    assert.ok(!workflow.jobs[gate].needs.includes('publish-rapier-wasm-release'));
  }
  assert.ok(
    workflow.jobs['cleanup-transient-artifacts'].needs.includes('publish-rapier-wasm-release'),
  );
});

test('native publication satisfies the unchanged engineering stance gate', () => {
  execFileSync(process.execPath, ['apps/hello/triangle/scripts/ac-08-grep-gate.mjs'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
});
