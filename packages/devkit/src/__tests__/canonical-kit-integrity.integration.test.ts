import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

const kit = vi.hoisted(() => ({ packageJson: '' }));

// Resolve a real isolated Preview package; all source/receipt reads and the
// ordinary project configuration path remain the production implementations.
vi.mock('node:module', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:module')>();
  return {
    ...original,
    createRequire(filename: string | URL) {
      const require = original.createRequire(filename);
      const resolve = require.resolve;
      require.resolve = Object.assign(
        (id: string, options?: Parameters<typeof resolve>[1]) =>
          id === '@forgeax/engine-preview/package.json' && kit.packageJson !== ''
            ? kit.packageJson
            : resolve(id, options),
        { paths: resolve.paths },
      );
      return require;
    },
  };
});

describe('canonical kit admission', () => {
  let temporary: string;
  let project: string;
  let packageKit: string;

  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'forgeax-canonical-admission-'));
    const checkout = join(temporary, 'sdk');
    const preview = join(checkout, 'packages/preview');
    const script = join(preview, 'scripts/build-canonical-kit.mjs');
    packageKit = join(preview, 'assets/canonical-kit');
    await mkdir(join(preview, 'scripts'), { recursive: true });
    await mkdir(packageKit, { recursive: true });
    await copyFile(
      resolve(import.meta.dirname, '../../../preview/scripts/build-canonical-kit.mjs'),
      script,
    );
    await copyFile(
      resolve(import.meta.dirname, '../../../preview/assets/canonical-kit/sky.hdr.meta.json'),
      join(packageKit, 'sky.hdr.meta.json'),
    );
    await writeFile(join(checkout, '.forgeax-public-distribution'), 'public SDK\n');
    kit.packageJson = join(preview, 'package.json');
    await writeFile(kit.packageJson, '{"name":"@forgeax/engine-preview","type":"module"}\n');
    const launcher = join(preview, 'script-launcher');
    await symlink(dirname(script), launcher, process.platform === 'win32' ? 'junction' : 'dir');
    await promisify(execFile)(process.execPath, [join(launcher, 'build-canonical-kit.mjs')], {
      cwd: checkout,
      env: { ...process.env, FORGEAX_CANONICAL_KIT_OUTPUT: packageKit, FORGEAX_SDK_BUILD: '1' },
    });
    project = join(temporary, 'project');
    await mkdir(join(project, 'assets'), { recursive: true });
    await writeFile(join(project, 'package.json'), '{"name":"canonical-admission"}\n');
    await writeFile(
      join(project, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'canonical-admission',
        name: 'Canonical admission',
        roots: {},
      }),
    );
  });

  afterAll(async () => {
    kit.packageJson = '';
    await rm(temporary, { recursive: true, force: true });
  });

  it.each([
    'build',
    'serve',
  ] as const)('admits a coherent public fallback for %s', async (command) => {
    const facts = await readProjectFacts(project);
    if (!facts.ok) throw facts.error;
    const config = await createViteConfig(facts.value, command);
    expect(config.root).toBeDefined();
  });

  it.each([
    ['build', 'sky.hdr'],
    ['serve', 'sky.hdr'],
    ['build', 'sky.hdr.meta.json'],
    ['serve', 'sky.hdr.meta.json'],
  ] as const)('rejects %s with changed %s bytes under the same receipt', async (command, file) => {
    const path = join(packageKit, file);
    const bytes = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([bytes, Buffer.from('\n')]));
      const facts = await readProjectFacts(project);
      if (!facts.ok) throw facts.error;
      await expect(createViteConfig(facts.value, command)).rejects.toMatchObject({
        code: 'preview-kit-source-mismatch',
        detail: { file },
      });
    } finally {
      await writeFile(path, bytes);
    }
  });
});
