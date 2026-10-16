import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const roots: string[] = [];
const action = readFileSync(
  resolve(import.meta.dirname, '../../.github/actions/prepare-dawn-device-limits/action.yml'),
  'utf8',
);
// Execute the action's first literal shell block without a transitive YAML dependency.
const installScript = action.match(/^ {6}run: \|\n((?: {8}.*\n|\n)+)/m)?.[1].replace(/^ {8}/gm, '');
const warnings = ['Uniform', 'Storage'].map(
  (kind) =>
    `Warning: maxDynamic${kind}BuffersPerPipelineLayout artificially reduced from 1000000 to 16 to fit dynamic offset allocation limit.`,
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dawn-node-wrapper-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts/ci'), { recursive: true });
  writeFileSync(join(root, 'scripts/ci/patch-dawn-device-limits.mjs'), 'export {};\n');
  const env = {
    ...process.env,
    // The self-hosted runner does not guarantee that its inherited locale is
    // installed. Keep the wrapper fixture's stderr assertions independent of
    // runner locale warnings from bash.
    LANG: 'C',
    LC_ALL: 'C',
    LANGUAGE: 'C',
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    NODE_OPTIONS: '',
    BASH_ENV: '',
    GITHUB_WORKSPACE: root,
    RUNNER_TEMP: root,
    GITHUB_PATH: join(root, 'github-path'),
    GITHUB_ENV: join(root, 'github-env'),
  };
  expect(installScript).toBeTypeOf('string');
  const installed = spawnSync('bash', ['-c', installScript ?? ''], {
    env,
    encoding: 'utf8',
  });
  expect(installed.stderr).toBe('');
  expect(installed.status).toBe(0);
  return { wrapper: join(root, 'forgeax-dawn-node-bin/node'), env };
}

function killProcessGroup(pid: number | undefined) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

test.skipIf(process.platform === 'win32')(
  'streams actual failures before stderr closes',
  async () => {
    const { wrapper, env } = fixture();
    const similarWarning = `${warnings[0]} unexpected context`;
    const child = spawn(
      wrapper,
      [
        '-e',
        `for (const line of ${JSON.stringify([...warnings, similarWarning, 'actual smoke failure'])}) console.error(line); setInterval(() => {}, 1000);`,
      ],
      { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      await expect.poll(() => stderr, { timeout: 2000 }).toContain('actual smoke failure\n');
      expect(stderr).toBe([...warnings, similarWarning, 'actual smoke failure', ''].join('\n'));
      expect(child.exitCode).toBeNull();
    } finally {
      killProcessGroup(child.pid);
      await closed;
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'preserves the failing exit code and complete stderr including its unterminated final line',
  () => {
    const { wrapper, env } = fixture();
    const result = spawnSync(
      wrapper,
      [
        '-e',
        `console.error(${JSON.stringify(warnings[0])}); process.stderr.write('failure without newline'); process.exitCode = 7;`,
      ],
      { env, encoding: 'utf8' },
    );
    expect(result.status).toBe(7);
    expect(result.stderr).toBe(`${warnings[0]}\nfailure without newline`);
  },
);
