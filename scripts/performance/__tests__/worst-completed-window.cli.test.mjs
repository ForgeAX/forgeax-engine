import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../worst-completed-window.mjs', import.meta.url));
const run = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });

test('actual CLI help succeeds without capture inputs', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*ordinary-frames/);
  assert.match(result.stdout, /Output must be new/);
});

test('actual CLI preserves inputs and existing outputs through path, symlink and hardlink aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worst-completed-cli-'));
  try {
    const game = join(directory, 'game');
    const performance = join(game, 'scripts/performance');
    await mkdir(performance, { recursive: true });
    // This fixture exercises authenticated CLI I/O, not the already-covered timing algorithm.
    const sources = new Map([
      [
        join(performance, 'completed-frame-window.mjs'),
        'export const summarizeCompletedFrames = () => ({rollingOneSecondMinFps: 2.5, rollingOneSecondWindows: 1});\n',
      ],
      [
        join(performance, 'terrain-gradient-ab-evidence.mjs'),
        "import { identity } from './fixture-authority.mjs';\nexport const liveCompletionWindow = identity;\n",
      ],
      [join(performance, 'fixture-authority.mjs'), 'export const identity = value => value;\n'],
      [join(game, 'scripts/perf-combat-browser.mjs'), '// authenticated collector fixture\n'],
    ]);
    for (const [path, bytes] of sources) await writeFile(path, bytes);
    const git = (args) => execFileSync('git', args, { cwd: game, encoding: 'utf8' });
    git(['init', '--quiet']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=CLI fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'CLI authority fixture',
    ]);
    const frames = join(directory, 'frames.json');
    const report = join(directory, 'report.json');
    const rows = [0, 400, 800, 1200].map((at, frameId) => ({
      at,
      frameId,
      worldIdentity: 'world',
      deviceGeneration: 0,
    }));
    await writeFile(
      frames,
      JSON.stringify({ start: 0, end: 1200, frames: rows.slice(0, -1), closingFrame: rows.at(-1) }),
    );
    await writeFile(
      report,
      JSON.stringify({
        gameCommit: git(['rev-parse', 'HEAD']).trim(),
        driverSha256: createHash('sha256')
          .update(sources.get(join(game, 'scripts/perf-combat-browser.mjs')))
          .digest('hex'),
        ok: true,
      }),
    );
    const inputs = [frames, report, ...sources.keys()];
    const originals = await Promise.all(inputs.map((path) => readFile(path)));
    const assertInputsUnchanged = async () => {
      for (let index = 0; index < inputs.length; index++)
        assert.deepEqual(await readFile(inputs[index]), originals[index], inputs[index]);
    };
    const args = (output, sourceGame = game) => [frames, report, sourceGame, output, 'full'];
    const refused = (output, sourceGame) => {
      const result = run(args(output, sourceGame));
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /Output must not overwrite an input/);
    };
    for (let index = 0; index < inputs.length; index++) {
      refused(inputs[index]);
      const alias = join(directory, `input-alias-${index}`);
      await symlink(inputs[index], alias);
      refused(alias);
      await assertInputsUnchanged();
    }
    const gameAlias = join(directory, 'game-alias');
    await symlink(game, gameAlias);
    refused(join(gameAlias, 'scripts/performance/fixture-authority.mjs'));
    refused(join(performance, 'fixture-authority.mjs'), gameAlias);
    const hardlink = join(directory, 'input-hardlink');
    await link(frames, hardlink);
    refused(hardlink);
    await assertInputsUnchanged();

    const output = join(directory, 'new-output.json');
    const success = run(args(output));
    assert.equal(success.status, 0, success.stderr);
    const originalOutput = await readFile(output);
    assert.equal(JSON.parse(originalOutput).worst.fps, 2.5);
    const outputAlias = join(directory, 'existing-output-alias');
    await symlink(output, outputAlias);
    for (const destination of [output, outputAlias]) {
      const existing = run(args(destination));
      assert.equal(existing.status, 1, existing.stdout);
      assert.match(existing.stderr, /EEXIST/);
      assert.deepEqual(await readFile(output), originalOutput);
    }
    await assertInputsUnchanged();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
