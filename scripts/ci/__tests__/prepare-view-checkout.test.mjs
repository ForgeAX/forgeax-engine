import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { isGlobalWorkspaceInstall } from '../workspace-install-scope.mjs';

const action = readFileSync('.github/actions/prepare-view-checkout/action.yml', 'utf8');
const scalar = (source, name) =>
  source
    .match(new RegExp(`^\\s*(?:- )?${name}:\\s*(.*?)\\s*$`, 'm'))?.[1]
    ?.replace(/^['"]|['"]$/g, '');
const rootDirectory = (directory) =>
  directory === undefined || ['.', './', '${{ github.workspace }}'].includes(directory);

function missingViewSources(workflow) {
  const jobs = workflow
    .slice(workflow.indexOf('\njobs:'))
    .split(/\n(?= {2}[\w-]+:\r?\n)/)
    .slice(1);
  const failures = [];
  for (const job of jobs) {
    const [header, ...steps] = job.split(/^ {6}- /m);
    const name = header.match(/^ {2}([\w-]+):/)?.[1];
    let ready = false;
    const pins = new Set();
    for (const step of steps) {
      const uses = scalar(step, 'uses') ?? step.match(/^uses: (.*)/)?.[1];
      const unconditional = scalar(step, 'if') === undefined;
      if (uses?.startsWith('actions/checkout@')) {
        const repository = scalar(step, 'repository');
        if (
          (repository === undefined || repository === 'ForgeaX-Games/forgeax-engine') &&
          rootDirectory(scalar(step, 'path'))
        ) {
          ready = unconditional && ['true', 'recursive'].includes(scalar(step, 'submodules'));
          pins.clear();
        } else if (repository === 'ForgeaX-Games/forgeax-view' && unconditional) {
          const pin = scalar(step, 'ref')?.match(
            /^\$\{\{ steps\.([\w-]+)\.outputs\.sha \}\}$/,
          )?.[1];
          ready =
            scalar(step, 'path') === 'tools/view' &&
            pins.has(pin) &&
            scalar(step, 'token') !== undefined &&
            scalar(step, 'persist-credentials') === 'false';
        }
      }
      if (
        unconditional &&
        (/echo ["']sha=\$\(git rev-parse HEAD:tools\/view\)/.test(step) ||
          /sha=\$\(git rev-parse HEAD:tools\/view\)[\s\S]*?echo ["']sha=\$sha["']/.test(step))
      )
        pins.add(scalar(step, 'id'));
      if (uses === './.github/actions/prepare-view-checkout') {
        ready = unconditional && scalar(step, 'token') !== undefined;
      }
      if (!rootDirectory(scalar(step, 'working-directory') ?? scalar(header, 'working-directory')))
        continue;
      let cwd = '.';
      for (const line of step.split('\n')) {
        const command = line.trim().replace(/^run:\s*/, '');
        if (/^cd\s+/.test(command))
          cwd = command
            .slice(3)
            .trim()
            .replace(/^['"]|['"]$/g, '');
        if (rootDirectory(cwd) && isGlobalWorkspaceInstall(command) && !ready) failures.push(name);
      }
    }
  }
  return [...new Set(failures)];
}

test('every global workspace installer materializes View from its current Engine checkout first', () => {
  assert.equal(existsSync('.github/actions/checkout-pinned-view/action.yml'), false);
  const failures = readdirSync('.github/workflows')
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      missingViewSources(readFileSync(join('.github/workflows', file), 'utf8')).map(
        (job) => `${file}:${job}`,
      ),
    );
  assert.deepEqual(
    failures,
    [],
    `missing fixed View before workspace install: ${failures.join(', ')}`,
  );
});

const workflow = (steps) => `name: fixture\njobs:\n  consumer:\n    steps:\n${steps}`;
const checkout = '      - uses: actions/checkout@v5\n        with:\n          submodules: false\n';
const prepare =
  '      - uses: ./.github/actions/prepare-view-checkout\n        with:\n          token: ${{ secrets.GHA }}\n';
const install = '      - run: pnpm install --frozen-lockfile\n';
const literal =
  '      - name: Resolve View\n        id: view-pin\n        run: echo "sha=$(git rev-parse HEAD:tools/view)" >> "$GITHUB_OUTPUT"\n      - uses: actions/checkout@v5\n        with:\n          repository: ForgeaX-Games/forgeax-view\n          ref: ${{ steps.view-pin.outputs.sha }}\n          path: tools/view\n          token: ${{ secrets.GHA }}\n          persist-credentials: false\n';

test('source admission rejects missing, late, conditional, unauthenticated and stale View preparation', () => {
  for (const steps of [
    checkout + install,
    checkout + install + prepare,
    checkout +
      prepare.replace('        with:', '        if: matrix.ubuntu\n        with:') +
      install,
    checkout + prepare.replace('          token: ${{ secrets.GHA }}\n', '') + install,
    checkout + literal.replace('steps.view-pin.outputs.sha', 'github.sha') + install,
    checkout + literal.replace('HEAD:tools/view', '-C tools/view rev-parse HEAD') + install,
    checkout + literal.replace('          token: ${{ secrets.GHA }}\n', '') + install,
    checkout + prepare + checkout + install,
    checkout.replace(
      'submodules: false',
      "submodules: ${{ matrix.ubuntu && 'recursive' || false }}",
    ) + install,
  ])
    assert.deepEqual(missingViewSources(workflow(steps)), ['consumer']);
  for (const steps of [
    checkout + prepare + install,
    checkout + literal + install,
    checkout +
      literal.replace(
        'run: echo "sha=$(git rev-parse HEAD:tools/view)" >> "$GITHUB_OUTPUT"',
        'run: |\n          sha=$(git rev-parse HEAD:tools/view)\n          echo "sha=$sha" >> "$GITHUB_OUTPUT"',
      ) +
      install,
    checkout.replace('submodules: false', 'submodules: recursive') + install,
  ])
    assert.deepEqual(missingViewSources(workflow(steps)), []);
  assert.deepEqual(
    missingViewSources(
      workflow(checkout + prepare + install.replace('pnpm install', 'bun install')),
    ),
    [],
  );
  assert.deepEqual(
    missingViewSources(
      workflow(
        `${checkout}      - run: pnpm install\n        working-directory: /external/project\n`,
      ),
    ),
    [],
  );
  assert.deepEqual(
    missingViewSources(
      workflow(
        `${checkout}      - run: |\n          cd /external/project\n          pnpm install\n`,
      ),
    ),
    [],
  );
});

test('a secondary Engine checkout neither retires nor supplies root View preparation', () => {
  const controller = checkout.replace(
    '          submodules:',
    '          path: release-controller\n          submodules:',
  );
  assert.deepEqual(missingViewSources(workflow(checkout + prepare + controller + install)), []);
  assert.deepEqual(missingViewSources(workflow(checkout + controller + install)), ['consumer']);
  assert.deepEqual(
    missingViewSources(
      workflow(
        checkout + controller.replace('submodules: false', 'submodules: recursive') + install,
      ),
    ),
    ['consumer'],
  );
  assert.deepEqual(
    missingViewSources(
      workflow(
        checkout + prepare + controller.replace('path: release-controller', 'path: .') + install,
      ),
    ),
    ['consumer'],
  );
});

test('the shared action resolves the parent gitlink, authenticates the exact child and preserves ancestry', () => {
  assert.match(action, /token:[\s\S]*?required: true/);
  assert.match(action, /using: composite/);
  assert.match(action, /value: \$\{\{ steps.view-pin.outputs.sha \}\}/);
  const [resolveStep, child, verification] = action.split('    - name: ').slice(1);
  assert.match(resolveStep, /id: view-pin[\s\S]*?shell: bash/);
  assert.match(child, /uses: actions\/checkout@v5/);
  assert.equal(scalar(child, 'repository'), 'ForgeaX-Games/forgeax-view');
  assert.equal(scalar(child, 'ref'), '${{ steps.view-pin.outputs.sha }}');
  assert.equal(scalar(child, 'path'), 'tools/view');
  assert.equal(scalar(child, 'token'), '${{ inputs.token }}');
  assert.equal(scalar(child, 'fetch-depth'), '0');
  assert.equal(scalar(child, 'persist-credentials'), 'false');
  assert.match(verification, /actual=\$\(git -C tools\/view rev-parse HEAD\)/);
  assert.match(verification, /test "\$actual" = "\$\{\{ steps.view-pin.outputs.sha \}\}"/);
  const temporary = mkdtempSync(join(tmpdir(), 'forgeax-view-checkout-'));
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    const childRoot = join(temporary, 'tools/view');
    mkdirSync(childRoot, { recursive: true });
    for (const cwd of [temporary, childRoot]) {
      git(cwd, 'init', '-q');
      git(cwd, 'config', 'user.name', 'CI fixture');
      git(cwd, 'config', 'user.email', 'ci@example.invalid');
    }
    git(childRoot, 'commit', '--allow-empty', '-qm', 'pinned');
    const pinned = git(childRoot, 'rev-parse', 'HEAD');
    git(temporary, 'update-index', '--add', '--cacheinfo', `160000,${pinned},tools/view`);
    git(temporary, 'commit', '-qm', 'pin');
    git(childRoot, 'commit', '--allow-empty', '-qm', 'foreign child head');
    assert.notEqual(git(childRoot, 'rev-parse', 'HEAD'), pinned);
    const output = join(temporary, 'outputs');
    writeFileSync(output, '');
    const gitBash = join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe');
    const shell = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash';
    const script = resolveStep
      .split('      run: |\n')[1]
      .split('\n')
      .map((line) => line.replace(/^ {8}/, ''))
      .join('\n');
    const result = spawnSync(shell, ['-c', script], {
      cwd: temporary,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8').trim(), `sha=${pinned}`);
    const verifyScript = verification
      .split('      run: |\n')[1]
      .split('\n')
      .map((line) => line.replace(/^ {8}/, ''))
      .join('\n')
      .replace('${{ steps.view-pin.outputs.sha }}', pinned);
    const verify = () =>
      spawnSync(shell, ['-c', verifyScript], { cwd: temporary, encoding: 'utf8' });
    assert.notEqual(verify().status, 0, 'a foreign child head must fail exact-pin admission');
    git(childRoot, 'checkout', '--detach', pinned);
    assert.equal(verify().status, 0, 'the actual pinned child must pass admission');
    git(temporary, 'update-index', '--force-remove', 'tools/view');
    git(temporary, 'commit', '-qm', 'remove View pin');
    writeFileSync(output, '');
    const missing = spawnSync(shell, ['-c', script], {
      cwd: temporary,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    assert.notEqual(
      missing.status,
      0,
      'a missing gitlink must stop before child checkout can fall back',
    );
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally {
    assert.ok(
      resolve(temporary).startsWith(`${resolve(tmpdir())}\\`) ||
        resolve(temporary).startsWith(`${resolve(tmpdir())}/`),
    );
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('only frozen root-only installs without lifecycle scripts avoid View preparation', () => {
  const rootInstall = 'pnpm install --frozen-lockfile --ignore-scripts --filter forgeax-engine';
  assert.deepEqual(missingViewSources(workflow(`${checkout}      - run: ${rootInstall}\n`)), []);
  for (const command of [
    rootInstall.replace('--ignore-scripts ', ''),
    rootInstall.replace('forgeax-engine', 'forgeax-engine...'),
    `${rootInstall} && pnpm install --frozen-lockfile`,
  ]) {
    assert.deepEqual(missingViewSources(workflow(`${checkout}      - run: ${command}\n`)), [
      'consumer',
    ]);
  }
});
