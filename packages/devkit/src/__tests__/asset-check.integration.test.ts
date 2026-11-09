import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProjectAssets } from '../asset-check.js';

const fixture = resolve(import.meta.dirname, 'fixtures/asset-check');
const temporary: string[] = [];

async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-asset-check-'));
  temporary.push(root);
  await cp(fixture, root, { recursive: true });
  // The sidecar is stored under a neutral name so repo-wide material inventories do not scan the fixture.
  await rename(
    resolve(root, 'punk-smoke.wgsl.meta.fixture'),
    resolve(root, 'punk-smoke.wgsl.meta.json'),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('checkProjectAssets', () => {
  it('cooks a textured custom particle-billboard material and its vfx programs', async () => {
    const root = await project();
    expect(await checkProjectAssets(root, ['.'])).toEqual({
      checked: 3,
      skipped: [],
      failures: [],
    });
  });

  it('names the parameter, expected and actual type of a texture2d mistake', async () => {
    const root = await project();
    const path = resolve(root, 'punk-smoke.pack.json');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(
        '"name": "smokeTexture", "type": "texture"',
        '"name": "smokeTexture", "type": "texture2d"',
      ),
    );
    const report = await checkProjectAssets(root, ['.']);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      kind: 'material',
      key: 'material/punk-smoke',
    });
    expect(report.failures[0]?.message).toContain('material-value-type-mismatch');
    expect(report.failures[0]?.message).toContain('parameter=smokeTexture');
    expect(report.failures[0]?.message).toContain('expectedType=texture2d');
  });

  it('reports the WGSL line of an invalid vfx program', async () => {
    const root = await project();
    const path = resolve(root, 'punk-smoke-exhaust.vfx.wgsl');
    await writeFile(path, `${await readFile(path, 'utf8')}\nfn vfx_update(`);
    const report = await checkProjectAssets(root, ['.']);
    const failure = report.failures.find((entry) => entry.kind === 'particle-effect');
    expect(failure?.key).toBe('vfx/punk-smoke-exhaust');
    expect(failure?.message).toContain('vfx-shader-invalid');
    expect(failure?.message).toMatch(/lineNum=\d+/);
  });
});
