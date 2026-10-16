import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { publicEngineFacades, publicEngineMembers } from '../public-facades.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('public engine facades', () => {
  it('forwards default only for physical targets that declare one', async () => {
    const members = await publicEngineMembers(repositoryRoot, ['ddc', 'physics', 'types']);
    const facades = publicEngineFacades(members);
    const rapier3d = facades.find(({ source }) => source === '@forgeax/engine-physics/rapier3d');
    const types = facades.find(({ source }) => source === '@forgeax/engine-types');

    expect(rapier3d?.hasDefault).toBe(true);
    expect(types?.hasDefault).toBe(false);
    expect(facades.find(({ source }) => source === '@forgeax/engine-ddc')?.hasDefault).toBe(false);
  });

  it('emits declarations for nested user-facing facade imports', async () => {
    const declaration = await readFile(
      resolve(repositoryRoot, 'packages/engine/dist/facades/pack/guid.d.ts'),
      'utf8',
    );

    expect(declaration).toContain("export * from '@forgeax/engine-pack/guid';");
  });

  it('resolves the built Rapier3D default through the user-facing umbrella', async () => {
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./fixtures/rapier-facade.mjs', import.meta.url)), 'descriptor',
    ], { cwd: repositoryRoot, timeout: 5000 });
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ name: 'physics', provide: 'physics' });
  });

  it('keeps the Rapier3D preset on the root physics component-token instance', async () => {
    const artifact = await readFile(resolve(repositoryRoot, 'packages/physics/dist/rapier3d.mjs'), 'utf8');
    expect(artifact).not.toContain('CharacterController');
    expect(artifact).not.toContain('defineComponent');

    // Built native consumers share Node's ESM identity, not Vitest's transformed cache.
    // Keep the original five-second test bound, including child startup and disposal.
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('./fixtures/rapier-facade.mjs', import.meta.url)),
    ], { cwd: repositoryRoot, timeout: 5000 });
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ sameToken: true, installed: true, released: true });
  });
});
