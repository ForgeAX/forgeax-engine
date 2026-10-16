import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import {
  bundlePath,
  graphicsEnvironment,
  parseGraphicsArgs,
  selectProducer,
  verifyArchive,
  verifyBundle,
} from '../local-graphics.mjs';
import { resolveLavapipeIcd } from '../resolve-lavapipe-icd.mjs';

test('software environment is child-scoped and overrides both stale ICD selectors', () => {
  const original = {
    VK_DRIVER_FILES: '/old.json',
    VK_ICD_FILENAMES: '/other.json',
    LD_LIBRARY_PATH: '/extra',
    LP_NUM_THREADS: '2',
  };
  const bundle = join(tmpdir(), 'bundle with spaces');
  const env = graphicsEnvironment(bundle, original);
  assert.equal(original.VK_DRIVER_FILES, '/old.json');
  assert.equal(env.VK_DRIVER_FILES, env.VK_ICD_FILENAMES);
  assert.ok(env.VK_DRIVER_FILES.startsWith(`${bundle}${sep}`));
  assert.equal(env.LP_NUM_THREADS, '2');
  assert.match(env.LD_LIBRARY_PATH, /:\/extra$/);
});

test('workflow and local invocation share explicit ICD selection and deterministic discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'graphics-icd-'));
  const explicit = join(root, 'custom driver.json');
  try {
    writeFileSync(explicit, '{}');
    writeFileSync(join(root, 'lvp_icd.b.json'), '{}');
    writeFileSync(join(root, 'lvp_icd.a.json'), '{}');
    assert.equal(resolveLavapipeIcd({}, root), join(root, 'lvp_icd.a.json'));
    assert.equal(resolveLavapipeIcd({ VK_DRIVER_FILES: explicit }, root), explicit);
    assert.equal(resolveLavapipeIcd({ VK_ICD_FILENAMES: explicit }, root), explicit);
    assert.throws(() => resolveLavapipeIcd({ VK_DRIVER_FILES: join(root, 'missing') }), /missing/);
    assert.throws(
      () => resolveLavapipeIcd({ VK_DRIVER_FILES: explicit, VK_ICD_FILENAMES: '/other' }),
      /conflicting/,
    );
    const workflow = readdirSync('.github/workflows')
      .filter((name) => name.endsWith('.yml'))
      .map((name) => readFileSync(join('.github/workflows', name), 'utf8'))
      .join('\n');
    const assignments = workflow
      .split('\n')
      .filter((line) => /^\s*(ICD_PATH|icd_path)=/.test(line));
    assert.ok(assignments.length > 0);
    for (const assignment of assignments)
      assert.match(assignment, /node scripts\/ci\/resolve-lavapipe-icd\.mjs/);
    const result = spawnSync(process.execPath, ['scripts/ci/resolve-lavapipe-icd.mjs'], {
      env: { ...process.env, VK_DRIVER_FILES: explicit, VK_ICD_FILENAMES: explicit },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), explicit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('graphics CLI forwards argv literally and rejects missing/ambiguous commands', () => {
  assert.deepEqual(parseGraphicsArgs(['--probe', 'dawn', '--', 'node', '-e', 'process.exit(37)']), {
    action: 'run',
    probe: 'dawn',
    command: ['node', '-e', 'process.exit(37)'],
  });
  assert.equal(parseGraphicsArgs(['setup']).action, 'setup');
  assert.equal(parseGraphicsArgs(['probe']).probe, 'both');
  for (const args of [
    [],
    ['--'],
    ['--probe', 'typo', '--', 'true'],
    ['setup', 'extra'],
    ['probe', '--', 'true'],
  ])
    assert.throws(() => parseGraphicsArgs(args));
});

test('corrupt downloads fail before extraction', () => {
  const bytes = Buffer.from('locked bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => verifyArchive(bytes, hash));
  assert.throws(() => verifyArchive(Buffer.from('changed'), hash), /graphics-integrity/);
});

test('missing bundle prevents the requested command from running', () => {
  const root = mkdtempSync(join(tmpdir(), 'graphics-failure-'));
  const marker = join(root, 'must-not-exist');
  try {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/ci/local-graphics.mjs',
        '--probe',
        'dawn',
        '--',
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "ran")',
        marker,
      ],
      {
        env: { ...process.env, FORGEAX_CI_GRAPHICS_ROOT: join(root, 'missing') },
        encoding: 'utf8',
      },
    );
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('older glibc hosts build the locked Mesa source instead of failing or skipping', () => {
  const lock = JSON.parse(readFileSync('scripts/ci/local-graphics.lock.json', 'utf8'));
  assert.equal(selectProducer(lock.minimumGlibc), 'prebuilt');
  assert.equal(selectProducer('2.39'), 'prebuilt');
  assert.equal(selectProducer('3.0'), 'prebuilt');
  assert.equal(selectProducer('2.35'), 'source');
  assert.match(lock.source.url, /mesa-25\.2\.8\.tar\.xz$/);
  assert.match(lock.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(lock.source.mesonOptions.includes('-Dvulkan-drivers=swrast'));
  const env = { XDG_CACHE_HOME: '/cache' };
  assert.notEqual(bundlePath(env, 'prebuilt'), bundlePath(env, 'source'));
});

test('a bundle receipt from the other producer is rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'graphics-receipt-'));
  try {
    writeFileSync(join(root, 'receipt.json'), JSON.stringify({ producer: 'prebuilt' }));
    assert.throws(() => verifyBundle(root, 'source'), /graphics-bundle-unavailable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
