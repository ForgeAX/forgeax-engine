import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { afterEach, describe, expect, it } from 'vitest';
import { projectLintCommand } from '../commands.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const packageId = '01900000-0000-7000-8000-000000000140';
const parsedNamespace = PackageId.parse(packageId);
if (!parsedNamespace.ok) throw parsedNamespace.error;
const namespace = parsedNamespace.value;
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(namespace, key));
async function fixture(roots: object = { engine: guid('plugin/root') }) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-lint-'));
  temporary.push(root);
  await mkdir(resolve(root, 'assets'));
  await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '3.0.0', roots }),
  );
  await writeFile(
    resolve(root, 'assets/game.ts'),
    'throw new Error("lint must not execute plugin modules");',
  );
  await writeFile(
    resolve(root, 'assets/game.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: {
        'plugin/root': {
          kind: 'plugin',
          payload: {
            module: { specifier: './game.ts' },
            config: { child: { $asset: guid('plugin/child') } },
          },
        },
        'plugin/child': { kind: 'plugin', payload: { module: { specifier: './game.ts' } } },
        'plugin/unused': { kind: 'plugin', payload: { module: { specifier: './missing.ts' } } },
      },
    }),
  );
  return root;
}
describe('project root lint', () => {
  it('follows plugin asset references without executing modules or guessing services', async () => {
    const root = await fixture();
    const result = await projectLintCommand({ root });
    expect(result).toMatchObject({
      ok: true,
      value: {
        diagnostics: [],
        ownership: [
          {
            source: 'plugin-asset',
            realm: 'engine',
            ownerPath: `forge.json#roots.engine > ${guid('plugin/root')}`,
          },
          {
            source: 'plugin-asset',
            realm: 'engine',
            ownerPath: `forge.json#roots.engine > ${guid('plugin/child')}`,
          },
        ],
      },
    });
  });
  it('allows the same implementation and asset in distinct realms', async () => {
    const result = await projectLintCommand({
      root: await fixture({ host: guid('plugin/root'), engine: guid('plugin/root') }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ownership).toHaveLength(4);
  });
  it('does not activate unreferenced files or require their code in the player', async () => {
    const result = await projectLintCommand({ root: await fixture({}) });
    expect(result).toMatchObject({ ok: true, value: { ownership: [] } });
  });
  it('reports unresolved root and source module paths', async () => {
    expect(
      await projectLintCommand({ root: await fixture({ engine: guid('missing') }) }),
    ).toMatchObject({ ok: false });
    expect(
      await projectLintCommand({ root: await fixture({ engine: guid('plugin/unused') }) }),
    ).toMatchObject({
      ok: false,
      error: {
        detail: {
          diagnostics: [
            {
              ruleId: 'project-ownership-orphan',
              detail: { module: expect.stringContaining('missing.ts') },
            },
          ],
        },
      },
    });
  });
  it('rejects the removed manifest authoring contract', async () => {
    const root = await fixture();
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '2.0.0', plugins: [] }),
    );
    expect(await projectLintCommand({ root })).toMatchObject({
      ok: false,
      error: { detail: { diagnostics: [{ ruleId: 'project-legacy-field' }] } },
    });
  });
});
