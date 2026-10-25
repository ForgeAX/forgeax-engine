import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { UI_AUTHORING_PROFILE } from '@forgeax/engine-ui/authoring';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { doctorCommand, initCommand, newCommand } from '../bootstrap-commands.js';
import { MINIMUM_SUPPORTED_PNPM, pnpmVersionAtLeast } from '../sdk-bootstrap.js';

describe('pnpm support range', () => {
  it('accepts current pnpm 12 releases while rejecting older, other-major, and prerelease versions', () => {
    expect(pnpmVersionAtLeast('12.15.0', MINIMUM_SUPPORTED_PNPM)).toBe(true);
    expect(pnpmVersionAtLeast('12.15.1', MINIMUM_SUPPORTED_PNPM)).toBe(true);
    expect(pnpmVersionAtLeast('12.14.0', MINIMUM_SUPPORTED_PNPM)).toBe(false);
    expect(pnpmVersionAtLeast('11.28.2', MINIMUM_SUPPORTED_PNPM)).toBe(false);
    expect(pnpmVersionAtLeast('13.0.0', MINIMUM_SUPPORTED_PNPM)).toBe(false);
    expect(pnpmVersionAtLeast('12.15.1-rc.1', MINIMUM_SUPPORTED_PNPM)).toBe(false);
  });
});

const originalPath = process.env.PATH;
const originalPnpmEntry = process.env.npm_execpath;
const originalSdkRoot = process.env.FORGEAX_SDK_ROOT;
const originalInstallState = process.env.FORGEAX_TEST_INSTALL_STATE;
const originalFailFirstInstall = process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL;
const originalNpmConfigOffline = process.env.npm_config_offline;
const temporaryRoots: string[] = [];

interface SdkFixture {
  readonly root: string;
  readonly template: string;
  readonly installState: string;
  readonly bin: string;
}

async function sdkFixture(failFirstInstall = true, withStore = true): Promise<SdkFixture> {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-new-'));
  temporaryRoots.push(temporaryRoot);
  const root = resolve(temporaryRoot, 'sdk');
  await mkdir(root);
  const template = resolve(root, 'templates', 'empty');
  const fullTemplate = resolve(root, 'templates', 'game-3d');
  const bin = resolve(root, 'bin');
  const installState = resolve(root, 'install-state');
  await mkdir(template, { recursive: true });
  await mkdir(resolve(template, 'src', '__tests__'), { recursive: true });
  await mkdir(fullTemplate, { recursive: true });
  if (withStore) await mkdir(resolve(root, 'store', 'pnpm'), { recursive: true });
  await mkdir(bin, { recursive: true });
  const skillText = '# Test skill\n\nUse the ForgeaX test skill.\n';
  await mkdir(resolve(root, 'skills', 'forgeax-engine-test'), { recursive: true });
  await writeFile(resolve(root, 'skills', 'forgeax-engine-test', 'SKILL.md'), skillText);
  await writeFile(
    resolve(root, 'sdk-manifest.json'),
    `${JSON.stringify({
      schemaVersion: '1.11.0',
      viewCommit: 'view-test',
      sdkVersion: '0.0.0-test',
      engineCommit: 'test',
      requirements: { node: '>=22.13.0', pnpm: '12.15.0', pnpmStoreFormat: 'v11' },
      capabilities: [],
      packages: [],
      templates: [
        { id: 'empty', root: 'templates/empty' },
        { id: 'game-3d', root: 'templates/game-3d' },
      ],
      skills: [
        {
          id: 'forgeax-engine-test',
          root: 'skills/forgeax-engine-test',
          fileCount: 1,
          byteCount: Buffer.byteLength(skillText),
        },
      ],
    })}\n`,
  );
  await mkdir(resolve(root, '.forgeax'), { recursive: true });
  await writeFile(
    resolve(root, '.forgeax', 'sdk-init.json'),
    `${JSON.stringify({
      schemaVersion: '2.0.0',
      sdkVersion: '0.0.0-test',
      engineCommit: 'test',
      pnpm: '12.15.0',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    })}\n`,
  );
  await writeFile(
    resolve(template, 'forge.json'),
    '{"id":"game","name":"Game","schemaVersion":"3.0.0","roots":{}}\n',
  );
  await writeFile(resolve(template, 'package.json'), '{"name":"game","version":"0.0.0"}\n');
  await writeFile(
    resolve(template, 'template.json'),
    `${JSON.stringify({
      id: 'empty',
      purpose: 'minimal project',
      defaultIdentity: { name: 'empty-game', packageName: '@local/empty-game' },
      journeys: ['typecheck', 'unit'],
    })}\n`,
  );
  await writeFile(resolve(template, 'src', 'main.ts'), 'export async function bootstrap() {}\n');
  await writeFile(
    resolve(template, 'src', '__tests__', 'starter.test.ts'),
    'export const starter = true;\n',
  );
  await writeFile(resolve(template, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(
    resolve(template, 'pnpm-workspace.yaml'),
    "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: install\nfrozenLockfile: true\nenableGlobalVirtualStore: false\n",
  );
  await writeFile(resolve(template, '.npmrc'), 'public-hoist-pattern[]=@forgeax/engine-*\n');
  await writeFile(
    resolve(fullTemplate, 'forge.json'),
    '{"id":"full-game","name":"Full Game","schemaVersion":"3.0.0","roots":{}}\n',
  );
  await writeFile(resolve(fullTemplate, 'package.json'), '{"name":"full","version":"0.0.0"}\n');
  await writeFile(
    resolve(fullTemplate, 'template.json'),
    `${JSON.stringify({
      id: 'game-3d',
      purpose: 'three-dimensional game project',
      defaultIdentity: { name: 'game-3d', packageName: '@local/game-3d' },
      journeys: ['typecheck', 'unit', 'browser'],
    })}\n`,
  );
  await writeFile(resolve(fullTemplate, 'main.ts'), 'export default {}\n');
  await writeFile(resolve(fullTemplate, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(
    resolve(fullTemplate, 'pnpm-workspace.yaml'),
    "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: install\nfrozenLockfile: true\nenableGlobalVirtualStore: false\n",
  );
  const pnpm = resolve(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  const pnpmScript = resolve(bin, 'pnpm.mjs');
  process.env.npm_execpath = pnpmScript;
  await writeFile(
    pnpmScript,
    `${[
      "import { access, mkdir, realpath, writeFile } from 'node:fs/promises';",
      "import { resolve } from 'node:path';",
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { process.stdout.write('12.15.0\\n'); process.exit(0); }",
      'const state = process.env.FORGEAX_TEST_INSTALL_STATE;',
      "if (!state) throw new Error('missing FORGEAX_TEST_INSTALL_STATE');",
      "await writeFile(state + '.args', args.join('\\n') + '\\n');",
      "await writeFile(state + '.cwd', (await realpath(process.cwd())) + '\\n');",
      "await writeFile(state + '.ci', (process.env.CI ?? '') + '\\n');",
      'let alreadyInstalled = true;',
      'try { await access(state); } catch { alreadyInstalled = false; }',
      'if (!alreadyInstalled) {',
      "  await writeFile(state, '');",
      "  if (process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL === '1') {",
      "    process.stderr.write('deterministic offline install fault\\n');",
      '    process.exit(23);',
      '  }',
      '}',
      "await mkdir(resolve(process.cwd(), 'node_modules'), { recursive: true });",
    ].join('\n')}\n`,
  );
  if (process.platform === 'win32') {
    await writeFile(pnpm, `@echo off\r\n"${process.execPath}" "${pnpmScript}" %*\r\n`);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(pnpm, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(pnpmScript)} "$@"\n`);
    await chmod(pnpm, 0o755);
  }
  const toolchain = resolve(root, 'toolchain/cli-runtime');
  const runtime = resolve(root, '.forgeax/cli-runtime');
  await mkdir(toolchain, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const hash = createHash('sha256');
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(resolve(template, name), resolve(toolchain, name));
    await cp(resolve(template, name), resolve(runtime, name));
    hash.update(await readFile(resolve(toolchain, name)));
  }
  await mkdir(resolve(runtime, 'node_modules/@forgeax/engine/dist/bin'), { recursive: true });
  await writeFile(
    resolve(runtime, 'node_modules/@forgeax/engine/dist/bin/forgeax.mjs'),
    'export {};',
  );
  const view = resolve(runtime, 'node_modules/@forgeax/view');
  await mkdir(view, { recursive: true });
  await writeFile(
    resolve(view, 'package.json'),
    JSON.stringify({ name: '@forgeax/view', exports: { './host.pack.json': './host.pack.json' } }),
  );
  await writeFile(resolve(view, 'host.pack.json'), '{}');
  const state = JSON.parse(await readFile(resolve(root, '.forgeax/sdk-init.json'), 'utf8'));
  state.toolInputsDigest = hash.digest('hex');
  await writeFile(resolve(root, '.forgeax/sdk-init.json'), JSON.stringify(state));
  process.env.FORGEAX_SDK_ROOT = root;
  process.env.FORGEAX_TEST_INSTALL_STATE = installState;
  process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL = failFirstInstall ? '1' : '0';
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
  process.env.npm_config_offline = 'true';
  return { root, template, installState, bin };
}

async function writeLocalEngine(root: string, version = '1.0.0'): Promise<string> {
  const workspace = resolve(root, 'local-engine');
  const packageRoot = resolve(workspace, 'packages', 'engine');
  await mkdir(resolve(packageRoot, 'dist'), { recursive: true });
  await writeFile(resolve(workspace, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
  await writeFile(
    resolve(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@forgeax/engine',
      version,
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs' } },
    }),
  );
  await writeFile(resolve(packageRoot, 'dist/index.d.ts'), 'export declare const engine: true;\n');
  await writeFile(resolve(packageRoot, 'dist/index.mjs'), 'export const engine = true;\n');
  return workspace;
}

async function writeWorkspaceInstallState(
  root: string,
  projectRoots: readonly string[],
  patterns: readonly string[],
): Promise<void> {
  const projects: Record<string, { name: string; version?: string }> = {};
  for (const projectRoot of projectRoots) {
    const packageRoot = await realpath(projectRoot);
    const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8')) as {
      readonly name: string;
      readonly version?: string;
    };
    projects[packageRoot] = {
      name: manifest.name,
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
    };
  }
  const nodeModules = resolve(root, 'node_modules');
  const virtualStore = resolve(nodeModules, '.pnpm');
  await mkdir(virtualStore, { recursive: true });
  await writeFile(
    resolve(nodeModules, '.modules.yaml'),
    `packageManager: pnpm@12.15.0\nvirtualStoreDir: ${JSON.stringify(virtualStore)}\nvirtualStoreDirMaxLength: 60\n`,
  );
  await writeFile(
    resolve(virtualStore, 'lock.yaml'),
    await readFile(resolve(root, 'pnpm-lock.yaml')),
  );
  await writeFile(
    resolve(nodeModules, '.pnpm-workspace-state-v1.json'),
    JSON.stringify({ projects, settings: { workspacePackagePatterns: patterns } }),
  );
}

async function localDoctorFixture(engineVersion = '1.0.0'): Promise<{
  readonly sdk: SdkFixture;
  readonly engine: string;
  readonly workspacePackage: string;
}> {
  const sdk = await sdkFixture(false);
  const engine = await writeLocalEngine(sdk.root, engineVersion);
  const workspacePackage = resolve(sdk.root, 'packages', 'shared-runtime');
  await mkdir(workspacePackage, { recursive: true });
  await mkdir(resolve(sdk.template, '.forgeax'), { recursive: true });
  await mkdir(resolve(sdk.template, 'node_modules'), { recursive: true });
  await writeFile(
    resolve(sdk.template, 'package.json'),
    JSON.stringify({
      name: 'game',
      version: '0.0.0',
      dependencies: { 'shared-runtime': 'workspace:*' },
    }),
  );
  await writeFile(
    resolve(sdk.template, '.forgeax', 'engine-binding.json'),
    JSON.stringify({ schemaVersion: '1.0.0', path: engine }),
  );
  await writeFile(
    resolve(workspacePackage, 'package.json'),
    '{"name":"shared-runtime","version":"1.2.3"}\n',
  );
  await writeFile(resolve(workspacePackage, 'index.js'), 'export const shared = true;\n');
  await rm(resolve(sdk.template, 'pnpm-workspace.yaml'));
  await rm(resolve(sdk.template, 'pnpm-lock.yaml'));
  await writeFile(
    resolve(sdk.root, 'pnpm-workspace.yaml'),
    'packages:\n  - templates/*\n  - packages/*\n',
  );
  await writeFile(
    resolve(sdk.root, 'package.json'),
    '{"name":"doctor-test-workspace","private":true,"packageManager":"pnpm@12.15.0"}\n',
  );
  await writeFile(
    resolve(sdk.root, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .: {}',
      '  templates/empty:',
      '    dependencies:',
      '      shared-runtime:',
      '        specifier: workspace:*',
      '        version: link:../../packages/shared-runtime',
      '  packages/shared-runtime: {}',
      '',
    ].join('\n'),
  );
  await symlink(
    workspacePackage,
    resolve(sdk.template, 'node_modules', 'shared-runtime'),
    'junction',
  );
  await writeWorkspaceInstallState(
    sdk.root,
    [sdk.root, sdk.template, workspacePackage],
    ['templates/*', 'packages/*'],
  );
  return { sdk, engine, workspacePackage };
}

async function addFileDirectoryDependency(sdk: SdkFixture): Promise<string> {
  const source = resolve(sdk.root, 'file-only', 'file-runtime');
  const installed = resolve(
    sdk.root,
    'node_modules',
    '.pnpm',
    'file-runtime@file+file-only+file-runtime',
    'node_modules',
    'file-runtime',
  );
  await mkdir(source, { recursive: true });
  await writeFile(
    resolve(source, 'package.json'),
    '{"name":"file-runtime","version":"2.3.4","main":"index.js"}\n',
  );
  await writeFile(resolve(source, 'index.js'), 'export const fileRuntime = true;\n');
  await mkdir(dirname(installed), { recursive: true });
  await cp(source, installed, { recursive: true });
  await symlink(installed, resolve(sdk.template, 'node_modules', 'file-runtime'), 'junction');
  const manifest = JSON.parse(await readFile(resolve(sdk.template, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies['file-runtime'] = 'file:../../file-only/file-runtime';
  await writeFile(resolve(sdk.template, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    resolve(sdk.root, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .: {}',
      '  templates/empty:',
      '    dependencies:',
      '      file-runtime:',
      '        specifier: file:../../file-only/file-runtime',
      '        version: file:file-only/file-runtime',
      '      shared-runtime:',
      '        specifier: workspace:*',
      '        version: link:../../packages/shared-runtime',
      '  packages/shared-runtime: {}',
      'packages:',
      '  file-runtime@file:file-only/file-runtime:',
      '    resolution: {directory: file-only/file-runtime, type: directory}',
      'snapshots:',
      '  file-runtime@file:file-only/file-runtime: {}',
      '',
    ].join('\n'),
  );
  await writeWorkspaceInstallState(
    sdk.root,
    [sdk.root, sdk.template, resolve(sdk.root, 'packages', 'shared-runtime')],
    ['templates/*', 'packages/*'],
  );
  return installed;
}

async function addRegistryEngineDependency(
  sdk: SdkFixture,
  installedVersion: string,
): Promise<void> {
  const installedEngine = resolve(sdk.root, 'registry-engine');
  await mkdir(resolve(installedEngine, 'dist'), { recursive: true });
  await writeFile(
    resolve(installedEngine, 'package.json'),
    `${JSON.stringify({
      name: '@forgeax/engine',
      version: installedVersion,
      main: './dist/index.mjs',
    })}\n`,
  );
  await writeFile(resolve(installedEngine, 'dist/index.mjs'), 'export const engine = true;\n');
  await mkdir(resolve(sdk.template, 'node_modules', '@forgeax'), { recursive: true });
  await symlink(
    installedEngine,
    resolve(sdk.template, 'node_modules', '@forgeax', 'engine'),
    'junction',
  );
  const manifest = JSON.parse(await readFile(resolve(sdk.template, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  manifest.dependencies['@forgeax/engine'] = '1.0.0';
  await writeFile(resolve(sdk.template, 'package.json'), JSON.stringify(manifest));
  await writeFile(
    resolve(sdk.root, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .: {}',
      '  templates/empty:',
      '    dependencies:',
      '      shared-runtime:',
      '        specifier: workspace:*',
      '        version: link:../../packages/shared-runtime',
      "      '@forgeax/engine':",
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '  packages/shared-runtime: {}',
      '',
    ].join('\n'),
  );
  await writeWorkspaceInstallState(
    sdk.root,
    [sdk.root, sdk.template, resolve(sdk.root, 'packages', 'shared-runtime')],
    ['templates/*', 'packages/*'],
  );
}

async function stagingEntries(parent: string, target: string): Promise<string[]> {
  return (await readdir(parent)).filter((entry) =>
    entry.startsWith(`.${basename(target)}.forgeax-staging-`),
  );
}

afterEach(async () => {
  process.env.PATH = originalPath;
  process.env.npm_execpath = originalPnpmEntry;
  process.env.FORGEAX_SDK_ROOT = originalSdkRoot;
  process.env.FORGEAX_TEST_INSTALL_STATE = originalInstallState;
  process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL = originalFailFirstInstall;
  process.env.npm_config_offline = originalNpmConfigOffline;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('newCommand', () => {
  it('gives an installed Engine CLI an executable SDK recovery route before creating files', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-missing-sdk-'));
    temporaryRoots.push(root);
    process.env.FORGEAX_SDK_ROOT = resolve(root, 'missing-sdk');
    const target = resolve(root, 'game');

    const result = await newCommand({ root: target, template: 'game-3d' });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'sdk-context-missing',
        hint: expect.stringContaining('forgeax sdk install --root <sdk-root>'),
      },
    });
    if (result.ok) throw new Error('missing SDK unexpectedly created a game');
    expect(result.error.hint).toContain(
      'node <sdk-root>/bin/forgeax.mjs project init --root <sdk-root>',
    );
    expect(result.error.hint).toContain(
      'node <sdk-root>/bin/forgeax.mjs project new <game-root> --template game-3d',
    );
    expect(result.error.hint).toContain('FORGEAX_SDK_ROOT');
    expect(await readdir(root)).toEqual([]);
  });

  it('pins the supported package manager in shipped templates', async () => {
    for (const template of ['empty', 'game-3d']) {
      const packageJson = JSON.parse(
        await readFile(
          resolve(import.meta.dirname, '../../../../templates', template, 'package.json'),
          'utf8',
        ),
      ) as { readonly packageManager?: unknown };
      expect(packageJson.packageManager).toBe('pnpm@12.15.0');
    }
  });

  it('requires one SDK-root init before creating a game', async () => {
    const sdk = await sdkFixture(false);
    await rm(resolve(sdk.root, '.forgeax', 'sdk-init.json'));

    const result = await newCommand({
      root: resolve(sdk.root, '..', 'uninitialized-game'),
      template: 'empty',
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-not-initialized' }),
    });
    await expect(readdir(resolve(sdk.root, '..', 'uninitialized-game'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a partial tool runtime even when installation exits successfully', async () => {
    const sdk = await sdkFixture(false);
    await rm(resolve(sdk.root, '.forgeax/sdk-init.json'));
    await rm(resolve(sdk.root, '.forgeax/cli-runtime/node_modules/@forgeax/view'), {
      recursive: true,
    });
    const result = await initCommand({ root: sdk.root });
    expect(result).toMatchObject({ ok: false, error: { code: 'sdk-init-failed' } });
    await expect(readFile(resolve(sdk.root, '.forgeax/sdk-init.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('initializes the SDK closure once at the SDK root', async () => {
    const sdk = await sdkFixture(false);
    await rm(resolve(sdk.root, '.forgeax', 'sdk-init.json'));

    const result = await initCommand({ root: sdk.root });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        root: sdk.root,
        sdkVersion: '0.0.0-test',
        store: 'offline',
        onboarding: {
          read: [
            resolve(sdk.root, 'AGENTS.md'),
            resolve(sdk.root, 'skills/forgeax-engine-sdk/SKILL.md'),
          ],
          templateSelection: {
            required: true,
            available: ['empty', 'game-3d'],
          },
        },
      }),
    });
    expect(
      JSON.parse(await readFile(resolve(sdk.root, '.forgeax', 'sdk-init.json'), 'utf8')),
    ).toEqual(
      expect.objectContaining({
        schemaVersion: '2.0.0',
        sdkVersion: '0.0.0-test',
        engineCommit: 'test',
        pnpm: '12.15.0',
      }),
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--side-effects-cache=true\n',
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).not.toContain(
      '--config.pm-on-fail=ignore\n',
    );
  });

  it.each(['root', 'nested'] as const)('refuses an SDK-owned %s target', async (scope) => {
    const sdk = await sdkFixture(false);
    const targetRoot = scope === 'root' ? sdk.root : resolve(sdk.root, 'games', 'game');

    const result = await newCommand({ root: targetRoot, template: 'empty' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'project-target-inside-sdk',
        expected: 'forgeax project new target to be outside the unpacked SDK root',
        hint: 'Choose a sibling directory or an absolute path outside the SDK.',
        detail: { root: targetRoot, sdkRoot: sdk.root },
      },
    });
    if (scope === 'nested') {
      await expect(readdir(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readFile(sdk.installState, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { label: 'absent', target: 'absent-game' },
    { label: 'empty', target: 'empty-game' },
  ])('rolls back a failed install for an $label target and retries in-process', async ({
    target,
  }) => {
    const sdk = await sdkFixture();
    const targetRoot = resolve(sdk.root, '..', target);
    if (target === 'empty-game') await mkdir(targetRoot);
    const originalEntries = target === 'empty-game' ? await readdir(targetRoot) : undefined;

    const failed = await newCommand({ root: targetRoot, template: 'empty' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('project-create-failed');
      expect(JSON.stringify(failed.error.detail)).toContain('deterministic offline install fault');
    }
    if (originalEntries === undefined) {
      await expect(readdir(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readdir(targetRoot)).toEqual(originalEntries);
    }
    expect(await stagingEntries(dirname(targetRoot), targetRoot)).toEqual([]);

    const retried = await newCommand({ root: targetRoot, template: 'empty' });
    expect(retried.ok).toBe(true);
    expect(await readFile(resolve(targetRoot, 'pnpm-lock.yaml'), 'utf8')).toBe(
      'lockfileVersion: 9.0\n',
    );
    expect(parse(await readFile(resolve(targetRoot, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({
      allowBuilds: { esbuild: true },
      minimumReleaseAgeExclude: ['@forgeax/*'],
      trustLockfile: true,
      verifyDepsBeforeRun: 'install',
      frozenLockfile: true,
      enableGlobalVirtualStore: false,
      storeDir: await realpath(resolve(sdk.root, 'store', 'pnpm')),
    });
    expect(JSON.parse(await readFile(resolve(targetRoot, 'forge.json'), 'utf8'))).toEqual({
      id: target,
      name: target,
      schemaVersion: '3.0.0',
      roots: {},
    });
    expect(JSON.parse(await readFile(resolve(targetRoot, 'package.json'), 'utf8')).name).toBe(
      `@local/${target}`,
    );
    expect(await readFile(resolve(targetRoot, 'src', '__tests__', 'starter.test.ts'), 'utf8')).toBe(
      'export const starter = true;\n',
    );
    expect(await readdir(resolve(targetRoot, 'node_modules'))).toEqual([]);
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--side-effects-cache=true\n',
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).not.toContain(
      '--config.pm-on-fail=ignore\n',
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--config.trust-lockfile=true\n',
    );
    expect(await readFile(`${sdk.installState}.ci`, 'utf8')).toBe('true\n');
    expect(await readFile(`${sdk.installState}.cwd`, 'utf8')).toBe(
      `${await realpath(targetRoot)}\n`,
    );
    expect(await readFile(resolve(targetRoot, '.npmrc'), 'utf8')).toBe(
      'public-hoist-pattern[]=@forgeax/engine-*\n',
    );
    expect(await readFile(resolve(targetRoot, 'skills/forgeax-engine-test/SKILL.md'), 'utf8')).toBe(
      '# Test skill\n\nUse the ForgeaX test skill.\n',
    );
    const mounted = resolve(targetRoot, '.agents/skills/forgeax-engine-test');
    expect((await lstat(mounted)).isSymbolicLink()).toBe(true);
    expect(resolve(targetRoot, '.agents/skills', await readlink(mounted))).toBe(
      resolve(targetRoot, 'skills/forgeax-engine-test'),
    );
    expect(
      JSON.parse(
        await readFile(resolve(targetRoot, '.forgeax/skill-install-manifest.json'), 'utf8'),
      ).skills,
    ).toEqual([
      expect.objectContaining({ id: 'forgeax-engine-test', root: 'skills/forgeax-engine-test' }),
    ]);
    expect(await stagingEntries(dirname(targetRoot), targetRoot)).toEqual([]);
  });

  it('contains malformed SDK manifest JSON and retries new and init in-process', async () => {
    const sdk = await sdkFixture(false);
    const manifestPath = resolve(sdk.root, 'sdk-manifest.json');
    const validManifest = await readFile(manifestPath, 'utf8');
    const newRoot = resolve(sdk.root, '..', 'malformed-new-game');
    const initRoot = resolve(sdk.root, '..', 'malformed-init-game');
    await mkdir(initRoot);
    const initFiles = {
      forge: resolve(initRoot, 'forge.json'),
      package: resolve(initRoot, 'package.json'),
      entry: resolve(initRoot, 'main.ts'),
    };
    await writeFile(
      initFiles.forge,
      `${JSON.stringify({
        id: 'game',
        name: 'Game',
        schemaVersion: '3.0.0',
        roots: {},
      })}\n`,
    );
    await writeFile(initFiles.package, '{"name":"game","version":"0.0.0"}\n');
    await writeFile(initFiles.entry, 'export default {}\n');
    const beforeInit = await Promise.all(
      Object.values(initFiles).map(async (path) => [path, await readFile(path, 'utf8')] as const),
    );
    await writeFile(manifestPath, '{"schemaVersion":\n');

    const failedNew = await newCommand({ root: newRoot, template: 'empty' });
    expect(failedNew.ok).toBe(false);
    if (!failedNew.ok) {
      expect(failedNew.error.code).toBe('project-create-failed');
      expect(failedNew.error.detail.reason).toMatch(/JSON|Expected/);
    }
    await expect(readdir(newRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stagingEntries(dirname(newRoot), newRoot)).toEqual([]);

    const failedInit = await initCommand({ root: initRoot });
    expect(failedInit.ok).toBe(false);
    if (!failedInit.ok) {
      expect(failedInit.error.code).toBe('project-init-failed');
      expect(failedInit.error.detail.reason).toMatch(/JSON|Expected/);
    }
    await expect(readFile(sdk.installState, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await Promise.all(
        Object.values(initFiles).map(async (path) => [path, await readFile(path, 'utf8')] as const),
      ),
    ).toEqual(beforeInit);

    await writeFile(manifestPath, validManifest);
    const retriedNew = await newCommand({ root: newRoot, template: 'empty' });
    expect(retriedNew.ok).toBe(true);
    const retriedInit = await initCommand({ root: initRoot });
    expect(retriedInit.ok).toBe(true);
    expect(await readFile(sdk.installState, 'utf8')).toBe('');
    expect(await readFile(`${sdk.installState}.ci`, 'utf8')).toBe('true\n');
    expect(JSON.parse(await readFile(initFiles.package, 'utf8')).packageManager).toBe(
      'pnpm@12.15.0',
    );
    expect(parse(await readFile(resolve(initRoot, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({
      allowBuilds: { esbuild: true },
      minimumReleaseAgeExclude: ['@forgeax/*'],
      trustLockfile: true,
      verifyDepsBeforeRun: 'install',
      frozenLockfile: true,
      enableGlobalVirtualStore: false,
      storeDir: await realpath(resolve(sdk.root, 'store', 'pnpm')),
    });
    expect(await stagingEntries(dirname(newRoot), newRoot)).toEqual([]);
  });

  it('preserves genuinely pre-existing content and refuses a non-empty target', async () => {
    const sdk = await sdkFixture();
    const targetRoot = resolve(sdk.root, '..', 'existing-game');
    await mkdir(targetRoot);
    const sentinel = resolve(targetRoot, 'keep.txt');
    await writeFile(sentinel, 'do not overwrite\n');

    const result = await newCommand({ root: targetRoot, template: 'empty' });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'project-target-not-empty' }),
    });
    expect(await readFile(sentinel, 'utf8')).toBe('do not overwrite\n');
    await expect(readFile(resolve(sdk.installState), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('requires an explicit template and selects each named SDK template', async () => {
    const sdk = await sdkFixture(false);
    const defaultRoot = resolve(sdk.root, '..', 'default-game');
    const fullRoot = resolve(sdk.root, '..', 'full-game');

    const requiredResult = await newCommand({ root: resolve(sdk.root, '..', 'required-game') });
    const defaultResult = await newCommand({ root: defaultRoot, template: 'empty' });
    const fullResult = await newCommand({ root: fullRoot, template: 'game-3d' });
    const missingResult = await newCommand({
      root: resolve(sdk.root, '..', 'missing-game'),
      template: 'missing',
    });

    expect(requiredResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-template-required' }),
    });
    expect(defaultResult).toEqual({
      ok: true,
      value: expect.objectContaining({
        template: 'empty',
        onboarding: {
          read: [
            resolve(defaultRoot, 'AGENTS.md'),
            resolve(defaultRoot, 'skills/forgeax-engine-sdk/SKILL.md'),
          ],
          next: {
            cwd: defaultRoot,
            argv: ['pnpm', 'exec', 'forgeax', 'help', '--tree', '--json'],
          },
        },
        sdkUpdate: { status: 'skipped', currentVersion: '0.0.0-test', reason: 'offline' },
      }),
    });
    expect(JSON.parse(await readFile(resolve(defaultRoot, 'forge.json'), 'utf8'))).toEqual(
      expect.objectContaining({ id: 'default-game', name: 'default-game' }),
    );
    expect(JSON.parse(await readFile(resolve(defaultRoot, 'package.json'), 'utf8')).name).toBe(
      '@local/default-game',
    );
    expect(fullResult).toEqual({
      ok: true,
      value: expect.objectContaining({ template: 'game-3d' }),
    });
    expect(JSON.parse(await readFile(resolve(fullRoot, 'forge.json'), 'utf8'))).toEqual(
      expect.objectContaining({ id: 'full-game', name: 'full-game' }),
    );
    expect(JSON.parse(await readFile(resolve(fullRoot, 'package.json'), 'utf8')).name).toBe(
      '@local/full-game',
    );
    expect(missingResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-template-not-found' }),
    });
  });

  it('uses the registry when the npm carrier omits its offline store', async () => {
    const sdk = await sdkFixture(false, false);
    const targetRoot = resolve(sdk.root, '..', 'online-game');

    const result = await newCommand({ root: targetRoot, template: 'empty' });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ template: 'empty' }),
    });
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      'install\n--frozen-lockfile\n--ignore-scripts\n',
    );
  });

  it('accepts explicit identity in arbitrary directory names and validates default identity before side effects', async () => {
    const sdk = await sdkFixture(false);
    const targetRoot = resolve(sdk.root, '..', 'cap-perf-01@forgeax-test');
    const explicit = await newCommand({
      root: targetRoot,
      template: 'empty',
      id: 'stable-game',
      name: 'Stable Game',
      packageName: '@studio/stable-game',
    });

    expect(explicit.ok).toBe(true);
    expect(JSON.parse(await readFile(resolve(targetRoot, 'forge.json'), 'utf8'))).toEqual(
      expect.objectContaining({ id: 'stable-game', name: 'Stable Game' }),
    );
    expect(JSON.parse(await readFile(resolve(targetRoot, 'package.json'), 'utf8')).name).toBe(
      '@studio/stable-game',
    );

    const unsafeRoot = resolve(sdk.root, '..', 'Unsafe Game');
    const unsafe = await newCommand({ root: unsafeRoot, template: 'empty' });
    expect(unsafe).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'project-identity-invalid' }),
    });
    await expect(readdir(unsafeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('doctorCommand', () => {
  it('keeps exact-version dependencies on the registry path without a local binding', async () => {
    const sdk = await sdkFixture(false);
    await writeFile(
      resolve(sdk.template, 'package.json'),
      JSON.stringify({
        name: 'game',
        version: '0.0.0',
        dependencies: { '@forgeax/example': '1.2.3' },
      }),
    );

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: true,
      value: { workspaceDependencies: [], uiAuthoringProfile: UI_AUTHORING_PROFILE },
    });
  });

  it('accepts a lock-proven third-party workspace without a local Engine binding', async () => {
    const { sdk } = await localDoctorFixture();
    await rm(resolve(sdk.template, '.forgeax', 'engine-binding.json'));

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: true,
      value: { workspaceDependencies: ['shared-runtime'] },
    });
  });

  it.each([
    'absolute',
    'relative',
  ])('accepts a matching third-party file directory without a local Engine binding (%s store)', async (store) => {
    const { sdk } = await localDoctorFixture();
    await addFileDirectoryDependency(sdk);
    await rm(resolve(sdk.template, '.forgeax', 'engine-binding.json'));
    if (store === 'relative') {
      const modulesPath = resolve(sdk.root, 'node_modules', '.modules.yaml');
      const modules = await readFile(modulesPath, 'utf8');
      await writeFile(
        modulesPath,
        modules.replace(/virtualStoreDir:.*\n/, 'virtualStoreDir: .pnpm\n'),
      );
    }

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: true,
      value: { workspaceDependencies: ['file-runtime', 'shared-runtime'] },
    });
  });

  it('rejects an uninstalled third-party workspace without a local Engine binding', async () => {
    const { sdk } = await localDoctorFixture();
    await rm(resolve(sdk.template, '.forgeax', 'engine-binding.json'));
    await rm(resolve(sdk.template, 'node_modules', 'shared-runtime'));

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: false,
      error: { code: 'project-dependency-not-installed' },
    });
  });

  it('rejects a stale copied file package without a local Engine binding', async () => {
    const { sdk } = await localDoctorFixture();
    const installed = await addFileDirectoryDependency(sdk);
    await rm(resolve(sdk.template, '.forgeax', 'engine-binding.json'));
    await writeFile(resolve(installed, 'index.js'), 'export const stale = true;\n');

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: false,
      error: { code: 'project-file-dependency-unverified' },
    });
  });

  it.each([
    'workspace:*',
    'file:../../engine',
  ])('still requires an explicit Engine binding for %s', async (specifier) => {
    const { sdk } = await localDoctorFixture();
    await rm(resolve(sdk.template, '.forgeax', 'engine-binding.json'));
    const path = resolve(sdk.template, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.dependencies['@forgeax/engine'] = specifier;
    await writeFile(path, JSON.stringify(manifest));

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: false,
      error: { code: 'project-local-dependency', detail: { dependencies: ['@forgeax/engine'] } },
    });
  });

  it.each([
    '1.0.0',
    '1.0.1',
  ])('verifies the registry Engine version while allowing a third-party workspace (%s)', async (version) => {
    const { sdk } = await localDoctorFixture();
    await addRegistryEngineDependency(sdk, version);
    await rm(resolve(sdk.template, '.forgeax', 'engine-binding.json'));

    expect(await doctorCommand({ root: sdk.template })).toMatchObject(
      version === '1.0.0'
        ? { ok: true }
        : { ok: false, error: { code: 'project-engine-version-mismatch' } },
    );
  });

  it('keeps a registry bundle npm alias under its published package instead of requiring a workspace importer', async () => {
    const { sdk } = await localDoctorFixture();
    await addRegistryEngineDependency(sdk, '1.0.0');
    await rm(resolve(sdk.template, '.forgeax', 'engine-binding.json'));
    const registryEngine = resolve(sdk.root, 'registry-engine');
    const manifestPath = resolve(registryEngine, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dependencies = { 'runtime-alias': 'npm:bundled-runtime@1.0.0' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const bundled = resolve(registryEngine, 'node_modules', 'runtime-alias');
    await mkdir(bundled, { recursive: true });
    await writeFile(
      resolve(bundled, 'package.json'),
      JSON.stringify({ name: 'bundled-runtime', version: '1.0.0' }),
    );
    await writeFile(resolve(bundled, 'index.js'), 'export const bundled = true;\n');

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({ ok: true });
  });

  it('accepts a healthy local Engine binding with a lock-proven workspace package', async () => {
    const { sdk } = await localDoctorFixture();

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ workspaceDependencies: ['shared-runtime'] }),
    });
  });

  it('accepts pnpm 12 workspace state without the optional recorded patterns', async () => {
    const { sdk } = await localDoctorFixture();
    const statePath = resolve(sdk.root, 'node_modules', '.pnpm-workspace-state-v1.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.settings = { nodeLinker: 'isolated' };
    await writeFile(statePath, JSON.stringify(state));

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: true,
      value: { workspaceDependencies: ['shared-runtime'] },
    });
  });

  it.each([
    null,
    ['other/*'],
  ])('rejects invalid or stale recorded workspace patterns (%j)', async (patterns) => {
    const { sdk } = await localDoctorFixture();
    const statePath = resolve(sdk.root, 'node_modules', '.pnpm-workspace-state-v1.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.settings.workspacePackagePatterns = patterns;
    await writeFile(statePath, JSON.stringify(state));

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: false,
      error: { code: 'project-pnpm-workspace-state-stale' },
    });
  });

  it.each([
    'missing',
    'name',
    'version',
  ])('rejects a workspace identity mismatch without recorded patterns (%s)', async (mismatch) => {
    const { sdk, workspacePackage } = await localDoctorFixture();
    const statePath = resolve(sdk.root, 'node_modules', '.pnpm-workspace-state-v1.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    delete state.settings.workspacePackagePatterns;
    const key = await realpath(workspacePackage);
    if (mismatch === 'missing') delete state.projects[key];
    else state.projects[key][mismatch] = 'different';
    await writeFile(statePath, JSON.stringify(state));

    expect(await doctorCommand({ root: sdk.template })).toMatchObject({
      ok: false,
      error: { code: 'project-workspace-package-mismatch' },
    });
  });

  it('rejects a local dependency when the selected Engine binding is stale', async () => {
    const { sdk } = await localDoctorFixture();
    await writeFile(
      resolve(sdk.template, '.forgeax', 'engine-binding.json'),
      JSON.stringify({ schemaVersion: '1.0.0', path: resolve(sdk.root, 'missing-engine') }),
    );

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'engine-workspace-missing' },
    });
  });

  it('rejects local dependencies until the bound Engine runtime is built', async () => {
    const { sdk, engine } = await localDoctorFixture();
    await rm(resolve(engine, 'packages', 'engine', 'dist', 'index.mjs'));

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'engine-local-build-missing' },
    });
  });

  it('includes root development dependencies in the local installed closure', async () => {
    const { sdk } = await localDoctorFixture();
    const manifestPath = resolve(sdk.template, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    manifest.devDependencies = { 'shared-runtime': manifest.dependencies['shared-runtime'] ?? '' };
    delete manifest.dependencies['shared-runtime'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const lockPath = resolve(sdk.root, 'pnpm-lock.yaml');
    const lock = await readFile(lockPath, 'utf8');
    await writeFile(
      lockPath,
      lock.replace(
        '    dependencies:\n      shared-runtime:',
        '    devDependencies:\n      shared-runtime:',
      ),
    );

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: true,
      value: { workspaceDependencies: ['shared-runtime'] },
    });
  });

  it('keeps a missing transitive required peer fatal while omitting a missing optional dependency', async () => {
    const { sdk, workspacePackage } = await localDoctorFixture();
    const packageManifestPath = resolve(workspacePackage, 'package.json');
    const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8')) as {
      name: string;
      version: string;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    packageManifest.peerDependencies = { 'missing-peer': 'workspace:*' };
    packageManifest.optionalDependencies = { 'missing-optional': 'workspace:*' };
    await writeFile(packageManifestPath, JSON.stringify(packageManifest));

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'project-dependency-not-installed',
        detail: { dependency: 'missing-peer', from: await realpath(workspacePackage) },
      },
    });
  });

  it('rejects a workspace lock locator that points at a different package directory', async () => {
    const { sdk, workspacePackage } = await localDoctorFixture();
    const otherPackage = resolve(sdk.root, 'packages', 'different-runtime');
    await mkdir(otherPackage, { recursive: true });
    await writeFile(
      resolve(otherPackage, 'package.json'),
      '{"name":"different-runtime","version":"1.2.3"}\n',
    );
    await writeFile(resolve(otherPackage, 'index.js'), 'export const other = true;\n');
    const lockPath = resolve(sdk.root, 'pnpm-lock.yaml');
    const lock = await readFile(lockPath, 'utf8');
    await writeFile(
      lockPath,
      lock.replace('link:../../packages/shared-runtime', 'link:../../packages/different-runtime'),
    );
    await writeWorkspaceInstallState(
      sdk.root,
      [sdk.root, sdk.template, workspacePackage, otherPackage],
      ['templates/*', 'packages/*'],
    );

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'project-workspace-locator-mismatch' },
    });
  });

  it.each([
    'single',
    'project',
    'virtual-store',
    'both',
  ])('accepts a file directory copied by pnpm only while its published payload matches the source (environment document: %s)', async (environmentDocument) => {
    const { sdk } = await localDoctorFixture();
    const installed = await addFileDirectoryDependency(sdk);
    const modules = await readFile(resolve(sdk.root, 'node_modules', '.modules.yaml'), 'utf8');
    const lock = await readFile(resolve(sdk.root, 'pnpm-lock.yaml'), 'utf8');

    expect(modules).toContain('virtualStoreDirMaxLength: 60');
    expect(await readFile(resolve(sdk.root, 'node_modules', '.pnpm', 'lock.yaml'), 'utf8')).toBe(
      lock,
    );

    if (environmentDocument !== 'single') {
      const environment =
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies: {}\n    packageManagerDependencies:\n      pnpm: {specifier: 12.15.0, version: 12.15.0}\n";
      const combined = `---\r\n${environment.replace(/\n/g, '\r\n')}---\r\n${lock}`;
      if (environmentDocument !== 'virtual-store')
        await writeFile(resolve(sdk.root, 'pnpm-lock.yaml'), combined);
      if (environmentDocument !== 'project')
        await writeFile(resolve(sdk.root, 'node_modules', '.pnpm', 'lock.yaml'), combined);
    }

    const accepted = await doctorCommand({ root: sdk.template });

    expect(accepted).toMatchObject({ ok: true });
    await writeFile(resolve(installed, 'index.js'), 'export const fileRuntime = false;\n');
    const staleCopy = await doctorCommand({ root: sdk.template });

    expect(staleCopy).toMatchObject({
      ok: false,
      error: { code: 'project-file-dependency-unverified' },
    });
  });

  it('rejects a copied file package when pnpm metadata omits the bounded virtual-store limit', async () => {
    const { sdk } = await localDoctorFixture();
    await addFileDirectoryDependency(sdk);
    const modulesPath = resolve(sdk.root, 'node_modules', '.modules.yaml');
    const modules = await readFile(modulesPath, 'utf8');
    await writeFile(modulesPath, modules.replace('virtualStoreDirMaxLength: 60\n', ''));

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'project-file-dependency-unverified',
        detail: {
          reason: 'Installed pnpm metadata does not identify a bounded virtual-store layout.',
        },
      },
    });
  });

  it('rejects an archive-based file dependency whose payload is not proven by this local-path check', async () => {
    const { sdk } = await localDoctorFixture();
    await addFileDirectoryDependency(sdk);
    const archive = resolve(sdk.root, 'file-only', 'file-runtime.tgz');
    await writeFile(archive, 'archive payload is not expanded or verified');
    const manifestPath = resolve(sdk.template, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['file-runtime'] = 'file:../../file-only/file-runtime.tgz';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(
      resolve(sdk.root, 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .: {}',
        '  templates/empty:',
        '    dependencies:',
        '      file-runtime:',
        '        specifier: file:../../file-only/file-runtime.tgz',
        '        version: file:file-only/file-runtime.tgz',
        '      shared-runtime:',
        '        specifier: workspace:*',
        '        version: link:../../packages/shared-runtime',
        '  packages/shared-runtime: {}',
        '',
      ].join('\n'),
    );
    await writeWorkspaceInstallState(
      sdk.root,
      [sdk.root, sdk.template, resolve(sdk.root, 'packages', 'shared-runtime')],
      ['templates/*', 'packages/*'],
    );

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'project-file-dependency-unsupported' },
    });
  });

  it('rejects a local Engine with a missing declared public type export', async () => {
    const { sdk, engine } = await localDoctorFixture();
    await rm(resolve(engine, 'packages', 'engine', 'dist', 'index.d.ts'));

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'project-engine-export-missing' },
    });
  });

  it('accepts a bound Engine version independently of the installed registry package version', async () => {
    const { sdk } = await localDoctorFixture('2.0.0');
    await addRegistryEngineDependency(sdk, '1.0.0');

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({ ok: true });
  });

  it('rejects an installed registry Engine version that differs from the pnpm locator', async () => {
    const { sdk } = await localDoctorFixture('2.0.0');
    await addRegistryEngineDependency(sdk, '1.0.1');

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'project-engine-version-mismatch' },
    });
  });

  it('resolves the project package manager through Corepack before plain pnpm', async () => {
    const sdk = await sdkFixture(false);
    await writeFile(
      resolve(sdk.template, 'package.json'),
      '{"name":"game","version":"0.0.0","packageManager":"pnpm@12.15.0"}\n',
    );
    const argsPath = `${sdk.installState}.corepack-args`;
    const corepack = resolve(sdk.bin, process.platform === 'win32' ? 'corepack.cmd' : 'corepack');
    const corepackScript = resolve(sdk.bin, 'corepack-fixture.mjs');
    await writeFile(
      corepackScript,
      `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(argsPath)}, process.argv.slice(2).join('\\n') + '\\n');\nprocess.stdout.write('12.15.0\\n');\n`,
    );
    if (process.platform === 'win32') {
      await writeFile(corepack, `@echo off\r\n"${process.execPath}" "${corepackScript}" %*\r\n`);
    } else {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(
        corepack,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(corepackScript)} "$@"\n`,
      );
      await chmod(corepack, 0o755);
    }

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({ ok: true, value: { pnpm: '12.15.0' } });
    expect(await readFile(argsPath, 'utf8')).toBe('pnpm\n--version\n');
  });
});
