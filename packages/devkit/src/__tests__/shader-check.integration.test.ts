import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shaderCheckCommand } from '../shader-check.js';

const namespace = '01900000-0000-7000-8000-000000008301';
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(definePackageId(namespace), key));

let root = '';

beforeAll(async () => {
  root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-shader-check-')));
  const repositoryRoot = resolve(import.meta.dirname, '../../../..');
  await mkdir(resolve(root, 'assets'));
  await mkdir(resolve(root, 'node_modules/@forgeax'), { recursive: true });
  await symlink(
    resolve(repositoryRoot, 'packages/engine'),
    resolve(root, 'node_modules/@forgeax/engine'),
    'junction',
  );
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'shader-check',
        name: 'Shader Check',
        schemaVersion: '3.0.0',
        roots: { engine: guid('game') },
      }),
    ),
    writeFile(
      resolve(root, 'assets/programs.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId: namespace,
        assets: { game: { kind: 'plugin', payload: { module: { specifier: './game.ts' } } } },
      }),
    ),
    writeFile(
      resolve(root, 'package.json'),
      '{"name":"shader-check","type":"module","dependencies":{"@forgeax/engine":"workspace:*"}}',
    ),
    writeFile(resolve(root, 'assets/game.ts'), `export default { name: 'game', apply() {} };\n`),
    writeFile(
      resolve(root, 'assets/valid.wgsl'),
      '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n',
    ),
    writeFile(resolve(root, 'assets/broken.wgsl'), 'fn broken( {\n'),
  ]);
}, 60_000);

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

describe('asset shader check', () => {
  it('compiles a named WGSL file that no project module imports', async () => {
    const result = await shaderCheckCommand({ root, path: 'assets/broken.wgsl' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-check-failed');
    expect(JSON.stringify(result.error.detail)).toContain('broken.wgsl');
  }, 120_000);

  it('accepts a valid named WGSL file', async () => {
    const result = await shaderCheckCommand({ root, path: 'assets/valid.wgsl' });
    expect(result).toMatchObject({
      ok: true,
      value: { root, path: resolve(root, 'assets/valid.wgsl') },
    });
  }, 120_000);
});
