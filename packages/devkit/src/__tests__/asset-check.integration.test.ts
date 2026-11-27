import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { scanInventory } from '@forgeax/engine-pack/scanner';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProjectAssets } from '../assets.js';

const fixture = resolve(import.meta.dirname, 'fixtures/asset-check');
const temporary: string[] = [];

async function check(root: string, paths: readonly string[]) {
  const roots = paths.map((path) => resolve(root, path));
  const inventory = await scanInventory(roots);
  if (!inventory.ok) throw inventory.error;
  return checkProjectAssets(root, roots, inventory.value);
}

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
  it('checks cloud materials and instances without a project build plugin', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-cloud-check-'));
    temporary.push(root);
    await mkdir(resolve(root, 'assets'));
    const packageId = '019a50a5-0000-7000-8000-000000000001';
    const parsed = PackageId.parse(packageId);
    if (!parsed.ok) throw parsed.error;
    const material = AssetGuid.format(AssetGuid.derive(parsed.value, 'cloud'));
    await writeFile(
      resolve(root, 'assets/cloud.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: {
          cloud: {
            kind: 'cloud-material',
            refs: [],
            payload: {
              version: 1,
              model: {
                kind: 'uniform',
                sample: {
                  extinctionPerMeter: 0.00012,
                  albedo: [1, 1, 1],
                  emissivePerMeter: [0, 0, 0],
                  materialAO: 1,
                },
              },
              parameters: {},
            },
          },
          instance: {
            kind: 'cloud-material-instance',
            refs: [material],
            payload: {
              version: 1,
              material,
              parameters: {},
              overrides: {},
            },
          },
        },
      }),
    );
    expect(await check(root, ['assets'])).toEqual({
      checked: 2,
      skipped: [],
      failures: [],
    });
    const path = resolve(root, 'assets/cloud.pack.json');
    await writeFile(path, (await readFile(path, 'utf8')).replace('0.00012', '-2'));
    const invalid = await check(root, ['assets']);
    expect(invalid.checked).toBe(1);
    expect(invalid.failures).toMatchObject([{ key: 'cloud', kind: 'cloud-material' }]);
    expect(invalid.failures[0]?.message).toContain('extinctionPerMeter');
  });

  it('cooks a textured custom particle-billboard material and its vfx programs', async () => {
    const root = await project();
    expect(await check(root, ['.'])).toEqual({
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
    const report = await check(root, ['.']);
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
    const report = await check(root, ['.']);
    const failure = report.failures.find((entry) => entry.kind === 'particle-effect');
    expect(failure?.key).toBe('vfx/punk-smoke-exhaust');
    expect(failure?.message).toContain('vfx-shader-invalid');
    expect(failure?.message).toMatch(/lineNum=\d+/);
  });
});
