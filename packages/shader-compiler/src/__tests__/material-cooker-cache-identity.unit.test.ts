import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMaterialPackCooker } from '../material/pack-cooker.js';

const { resolvedPackages } = vi.hoisted(() => ({ resolvedPackages: new Map<string, string>() }));

// Relocate only package discovery. The cooker, source collector and native
// compiler fingerprint still execute their ordinary implementations.
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>();
  return {
    ...actual,
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      const require = actual.createRequire(...args);
      const resolve = require.resolve;
      require.resolve = Object.assign(
        (...resolveArgs: Parameters<typeof resolve>) =>
          resolvedPackages.get(resolveArgs[0]) ?? resolve(...resolveArgs),
        { paths: resolve.paths },
      );
      return require;
    },
  };
});

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'forgeax-material-cooker-identity-'));
});

afterEach(async () => {
  resolvedPackages.clear();
  await rm(directory, { recursive: true, force: true });
});

const shaderSource = '#define_import_path forgeax_material::fixture\nconst value = 1.0;\n';
const projectSource = '#define_import_path game::surface\n#import game::helper\n';

async function source(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function checkout(name: string): Promise<readonly [string, string]> {
  const root = join(directory, name);
  const shader = join(root, 'packages/shader');
  const vfx = join(root, 'packages/vfx-render');
  const project = join(root, 'project/shaders');
  const extra = join(root, 'shared/shaders');
  await source(join(shader, 'src/nested/material.wgsl'), shaderSource);
  await source(
    join(vfx, 'src/shaders/particle.wgsl'),
    '#define_import_path vfx-render.fixture\nconst value = 2.0;\n',
  );
  await source(join(project, 'surface.wgsl'), projectSource);
  await source(join(extra, 'nested/helper.wgsl'), '#define_import_path game::helper\n');
  resolvedPackages.set('@forgeax/engine-shader/package.json', join(shader, 'package.json'));
  resolvedPackages.set('@forgeax/engine-vfx-render/package.json', join(vfx, 'package.json'));
  return [project, extra];
}

async function identity(roots: readonly string[]): Promise<string> {
  const cooker = createMaterialPackCooker(roots);
  if (cooker.cacheIdentity === undefined) throw new Error('material cooker must identify inputs');
  return await cooker.cacheIdentity();
}

it('reuses identical packaged and project sources after relocating the checkout', async () => {
  const firstRoots = await checkout('first');
  const first = await identity(firstRoots);
  const relocatedRoots = await checkout('relocated');
  // Engine-only relocation is the normal consumer/worktree cache reuse path.
  expect(await identity(firstRoots)).toBe(first);
  expect(await identity(relocatedRoots)).toBe(first);
});

it('reuses a relocated individual source root and invalidates its filename mapping', async () => {
  const [first] = await checkout('first');
  const before = await identity([join(first, 'surface.wgsl')]);
  const [relocated] = await checkout('relocated');
  expect(await identity([join(relocated, 'surface.wgsl')])).toBe(before);
  await rename(join(relocated, 'surface.wgsl'), join(relocated, 'renamed.wgsl'));
  expect(await identity([join(relocated, 'renamed.wgsl')])).not.toBe(before);
});

it.each([
  ['source bytes', `${projectSource}const value = 3.0;\n`],
  ['module identity', projectSource.replace('game::surface', 'game::renamed')],
  ['import mapping', projectSource.replace('game::helper', 'game::different')],
])('invalidates changed %s', async (_label, changedSource) => {
  const roots = await checkout('first');
  const before = await identity(roots);
  await source(join(roots[0], 'surface.wgsl'), changedSource);
  expect(await identity(roots)).not.toBe(before);
});

it('invalidates changed packaged source bytes', async () => {
  const roots = await checkout('first');
  const before = await identity(roots);
  await source(
    join(directory, 'first/packages/shader/src/nested/material.wgsl'),
    shaderSource.replace('1.0', '4.0'),
  );
  expect(await identity(roots)).not.toBe(before);
});

it('retains each extra root without depending on discovery order', async () => {
  const roots = await checkout('first');
  await source(join(roots[0], 'shared.wgsl'), '#define_import_path game::first\n');
  await source(join(roots[1], 'shared.wgsl'), '#define_import_path game::second\n');
  const before = await identity(roots);
  expect(await identity([roots[1], roots[0]])).toBe(before);
  await source(join(roots[0], 'shared.wgsl'), '#define_import_path game::second\n');
  await source(join(roots[1], 'shared.wgsl'), '#define_import_path game::first\n');
  expect(await identity(roots)).not.toBe(before);
});

it('retains source paths relative to their root', async () => {
  const roots = await checkout('first');
  const before = await identity(roots);
  await rename(join(roots[1], 'nested/helper.wgsl'), join(roots[1], 'helper.wgsl'));
  expect(await identity(roots)).not.toBe(before);
});

it('does not renumber shader roots when an empty SDK asset root moves across the project', async () => {
  const roots = await checkout('middle-project');
  const beforeRoot = join(directory, 'a-sdk', 'canonical-kit');
  const afterRoot = join(directory, 'z-sdk', 'canonical-kit');
  await mkdir(beforeRoot, { recursive: true });
  await source(join(beforeRoot, 'sky.hdr'), 'unchanged HDR bytes');
  const before = await identity([...roots, beforeRoot]);
  await mkdir(dirname(afterRoot), { recursive: true });
  await rename(beforeRoot, afterRoot);
  expect(await identity([...roots, afterRoot])).toBe(before);
  expect(await identity(roots)).toBe(before);
  await source(join(afterRoot, 'surface.wgsl'), '#define_import_path sdk::surface\n');
  expect(await identity([...roots, afterRoot])).not.toBe(before);
});
