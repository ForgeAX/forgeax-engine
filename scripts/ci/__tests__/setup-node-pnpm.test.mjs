import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { parse } from 'yaml';
import { prepareCiEnvironment, registerBashEnvironment } from '../ci-bash-environment.mjs';

const action = resolve('.github/actions/setup-node-pnpm/action.yml');

test('Browser checkout clears only its stale root dependencies before git clean', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const steps = workflow.jobs['vitest-browser-shard'].steps;
  const cleanupIndex = steps.findIndex((step) =>
    step.name?.startsWith('Clear stale root dependency links'),
  );
  const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(cleanupIndex >= 0 && cleanupIndex < checkoutIndex);
  const cleanup = steps[cleanupIndex];
  assert.equal(cleanup.if, "runner.environment == 'self-hosted'");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expands the runner directory.
  assert.equal(cleanup['working-directory'], '${{ runner.temp }}');
  assert.equal(cleanup.shell, 'bash');
  assert.match(cleanup.run, /sudo -n rm -rf --/);
  if (process.platform === 'win32') return;

  const directory = mkdtempSync(join(tmpdir(), 'forgeax-checkout-dependencies-'));
  try {
    const workspace = join(directory, "runner's workspace");
    const shared = join(directory, 'shared store');
    mkdirSync(workspace);
    mkdirSync(shared);
    const guard = join(workspace, 'source.ts');
    const sharedGuard = join(shared, 'keep');
    writeFileSync(guard, 'preserve source');
    writeFileSync(sharedGuard, 'preserve shared dependencies');
    const sudo = join(directory, 'sudo');
    // Exercise the exact shell without requiring local administrator access.
    writeFileSync(sudo, '#!/bin/sh\n[ "$1" = "-n" ] || exit 91\nshift\nexec "$@"\n');
    chmodSync(sudo, 0o755);
    const command = join(directory, 'cleanup.sh');
    writeFileSync(command, cleanup.run);
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_WORKSPACE: workspace,
    };
    const dependencies = join(workspace, 'node_modules');
    mkdirSync(dependencies);
    writeFileSync(join(dependencies, 'stale'), 'old shim');
    for (const linked of [false, true]) {
      if (linked) symlinkSync(shared, dependencies);
      const result = spawnSync('bash', ['-e', command], { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(dependencies), false);
      assert.equal(readFileSync(guard, 'utf8'), 'preserve source');
      assert.equal(readFileSync(sharedGuard, 'utf8'), 'preserve shared dependencies');
    }
    const missing = spawnSync('bash', ['-e', command], {
      cwd: directory,
      env: { ...env, GITHUB_WORKSPACE: '' },
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0, 'An absent workspace must fail before cleanup');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflows install pnpm only through the retrying setup action', () => {
  const workflows = resolve('.github/workflows');
  for (const name of readdirSync(workflows)) {
    const source = readFileSync(resolve(workflows, name), 'utf8');
    assert.doesNotMatch(source, /uses: pnpm\/setup@/, `${name} must use setup-node-pnpm`);
  }
});

test('setup action retries the pinned pnpm download a bounded number of times', () => {
  const source = readFileSync(action, 'utf8');
  assert.equal(source.match(/uses: pnpm\/setup@v3/g)?.length, 3);
  assert.equal(source.match(/continue-on-error: true/g)?.length, 2);
  assert.match(source, /- if: steps\.pnpm-2\.outcome == 'failure'\n {6}uses: pnpm\/setup@v3/);
});

test('Dawn preparation preserves an existing Bash environment across runner steps', {
  skip: process.platform !== 'linux',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-ci-environment-'));
  try {
    const previous = join(directory, "existing toolchain's environment.sh");
    const environmentFile = join(directory, 'github-env');
    const pathFile = join(directory, 'github-path');
    writeFileSync(previous, 'export FORGEAX_EXISTING_CI_ENV=preserved\n');
    writeFileSync(environmentFile, '');
    writeFileSync(pathFile, '');
    const dawn = parse(
      readFileSync('.github/actions/prepare-dawn-device-limits/action.yml', 'utf8'),
    );
    const preparation = join(directory, 'prepare.sh');
    writeFileSync(preparation, dawn.runs.steps[0].run);
    const prepared = spawnSync('bash', ['-e', preparation], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        BASH_ENV: previous,
        RUNNER_TEMP: directory,
        GITHUB_WORKSPACE: resolve('.'),
        GITHUB_ENV: environmentFile,
        GITHUB_PATH: pathFile,
      },
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    const updates = Object.fromEntries(
      readFileSync(environmentFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    // A runner starts each step separately; shell exports from preparation do
    // not replace preserving the original BASH_ENV in the next step.
    const nextStep = join(directory, 'next-step.sh');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expands the runner environment.
    writeFileSync(nextStep, 'printf "%s" "${FORGEAX_EXISTING_CI_ENV:-missing}"');
    const probe = spawnSync('bash', ['-e', nextStep], {
      encoding: 'utf8',
      env: { ...process.env, BASH_ENV: previous, ...updates },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, 'preserved');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('shared native policy composes toolchain fragments once and reaches descendants', {
  skip: process.platform === 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-ci-policy-'));
  try {
    const previous = join(directory, "previous toolchain's env.sh");
    const next = join(directory, "next toolchain's env.sh");
    writeFileSync(previous, 'export FORGEAX_PREVIOUS_POLICY=preserved\n');
    writeFileSync(next, 'export FORGEAX_NEXT_POLICY=preserved\n');
    const environment = {
      RUNNER_TEMP: directory,
      GITHUB_ENV: join(directory, 'github-env'),
      BASH_ENV: previous,
    };
    const first = prepareCiEnvironment({ environment, platform: 'linux' });
    environment.BASH_ENV = first.bootstrap;
    const second = registerBashEnvironment(next, { environment, platform: 'linux' });
    const repeated = registerBashEnvironment(next, { environment, platform: 'linux' });
    assert.deepEqual(repeated.sources, second.sources);
    assert.equal(repeated.sources.length, 3);
    const nextStep = join(directory, 'next-step.sh');
    writeFileSync(
      nextStep,
      'printf "%s|%s|%s|%s" "$FORGEAX_PREVIOUS_POLICY" "$FORGEAX_NEXT_POLICY" "$(ulimit -c)" "$(bash -c \'ulimit -c\')"',
    );
    const probe = spawnSync('bash', ['-e', nextStep], {
      encoding: 'utf8',
      env: { ...process.env, BASH_ENV: first.bootstrap },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout, 'preserved|preserved|0|0');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('shared environment bootstrap loads without workspace dependencies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-ci-cold-policy-'));
  try {
    const script = join(directory, 'environment.mjs');
    copyFileSync('scripts/ci/ci-bash-environment.mjs', script);
    const probe = spawnSync(process.execPath, [script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        NODE_PATH: '',
        BASH_ENV: '',
        RUNNER_TEMP: directory,
        GITHUB_ENV: join(directory, 'github-env'),
      },
    });
    assert.equal(probe.status, 0, probe.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('shared process policy leaves non-Linux environments unchanged', () => {
  for (const platform of ['darwin', 'win32'])
    assert.deepEqual(prepareCiEnvironment({ environment: {}, platform }), { active: false });
});

test('every shared toolchain setup installs the process policy after Node and before npm', () => {
  const steps = parse(readFileSync(action, 'utf8')).runs.steps;
  const node = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
  const policy = steps.findIndex((step) => step.run?.includes('ci-bash-environment.mjs'));
  const npm = steps.findIndex((step) => step.uses === './.github/actions/setup-npm');
  assert.ok(node >= 0 && policy > node && npm > policy);
});

function workspaceImports(entrypoint, seen = new Set()) {
  const filename = resolve(entrypoint);
  if (seen.has(filename)) return [];
  seen.add(filename);
  const dependencies = [];
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node) => {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;
    if (specifier && ts.isStringLiteral(specifier)) {
      const name = specifier.text;
      if (name.startsWith('.'))
        dependencies.push(...workspaceImports(resolve(dirname(filename), name), seen));
      else if (!isBuiltin(name)) dependencies.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return dependencies;
}

function coldTestDependencies(steps) {
  const dependencies = [];
  for (const step of steps) {
    const command = step.run ?? '';
    // Only a root workspace install admits arbitrary source-test dependencies.
    if (
      /prepare-pnpm-workspace\.mjs --install(?! --filter)/.test(command) ||
      /(?:^|\n)\s*(?:pnpm install|npm ci)\b/.test(command)
    )
      break;
    if (!/\bnode --test\b/.test(command)) continue;
    for (const [entrypoint] of command.matchAll(/(?:scripts|packages)\/[\w./*-]+\.test\.mjs\b/g)) {
      assert.ok(
        !entrypoint.includes('*'),
        `Install dependencies before globbed tests: ${entrypoint}`,
      );
      dependencies.push(...workspaceImports(entrypoint));
    }
  }
  return dependencies;
}

test('every workflow keeps dependency-using Node test guards after the workspace install', () => {
  for (const name of readdirSync('.github/workflows')) {
    const workflow = parse(readFileSync(resolve('.github/workflows', name), 'utf8'));
    for (const [id, job] of Object.entries(workflow.jobs)) {
      assert.deepEqual(coldTestDependencies(job.steps ?? []), [], `${name}: ${id}`);
    }
  }
});

test('cold workflow guard rejects a dependency import and admits the locked install first', () => {
  const steps = [{ run: 'node --test scripts/ci/__tests__/setup-node-pnpm.test.mjs' }];
  assert.ok(coldTestDependencies(steps).includes('yaml'));
  assert.deepEqual(
    coldTestDependencies([
      { run: 'node scripts/ci/prepare-pnpm-workspace.mjs --install' },
      ...steps,
    ]),
    [],
  );
  assert.ok(
    coldTestDependencies([
      { run: 'node scripts/ci/prepare-pnpm-workspace.mjs --install --filter @forgeax/engine' },
      ...steps,
    ]).includes('yaml'),
  );
});
