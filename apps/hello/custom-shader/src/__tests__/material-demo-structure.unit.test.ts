import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appRoot = new URL('../..', import.meta.url);
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const shader = readFileSync(new URL('../pulse-material.wgsl', import.meta.url), 'utf8');
const browserSmoke = readFileSync(new URL('../../scripts/smoke-browser.mjs', import.meta.url), 'utf8');
const fixture = JSON.parse(
  readFileSync(new URL('../../assets/pulse-material.pack.json', import.meta.url), 'utf8'),
);
const ROOT_MATERIAL_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd02';
const DERIVED_MATERIAL_GUID = '01935b00-7d8c-7c4e-9f12-345678abcd03';

describe('material-inheritance-demo structure', () => {
  it('loads root and derived MaterialAsset records through the runtime', () => {
    expect(source).toContain('loadByGuid<MaterialAsset>');
    expect(source).toContain('createMaterialLoader');
    expect(source).toContain('loadCookedMaterial');
    expect(source).toContain('materialFromCookedRecord');
    expect(source).toContain('rootMaterialHandle');
    expect(source).toContain('derivedMaterialHandle');
    expect(source).toContain('rebindMaterialTextures');
    expect(source).toContain('world.set(derivedEntity, MeshRenderer');
    expect(source).toContain('liveMutation');
    expect(source).toContain("materials: [rootMaterialHandle]");
    expect(source).toContain("materials: [derivedMaterialHandle]");
    expect(source).toContain('sharesCookedSpecialization');
    expect(source).not.toContain('JSON.stringify(rootReady.record.resolved.values)');
    expect(source).not.toContain('const materialHandle');
    expect(source).not.toContain(['install', 'MaterialArtifact'].join(''));
  });

  it('uses an owned ephemeral browser server and never borrows a foreign listener', () => {
    expect(browserSmoke).toContain('startOwnedServer');
    expect(browserSmoke).toContain('stopOwnedServer');
    expect(browserSmoke).toContain('requestedPort: 0');
    expect(browserSmoke).toContain("'--host', '127.0.0.1'");
    expect(browserSmoke).toContain("'--port', '__PORT__'");
    expect(browserSmoke).toContain("'--strictPort'");
    expect(browserSmoke).toContain('const url = ownedServer.url;');
    expect(browserSmoke).toContain('page.goto(targetUrl');
    expect(browserSmoke).toContain('timeout: 90_000');
    expect(browserSmoke).toContain("throw new Error('browser close timed out after 15000ms')");
  });

  it('retains bounded server evidence when browser setup or cleanup fails', () => {
    expect(browserSmoke).toContain('const retainServerEvidence =');
    expect(browserSmoke).toMatch(/if \(!retainServerEvidence\) \{\s+await rm\(serverStateRoot/);
    expect(browserSmoke).toContain('stateFile: serverStateFile');
    expect(browserSmoke).toContain('logFile: ownedServer?.logFile');
    expect(browserSmoke).toContain('requestedPortOccupied:');
    expect(browserSmoke).toContain('remainingTreePids');
    expect(browserSmoke).toContain('remainingListenerPids');
    expect(browserSmoke).toContain('custom-shader browser server evidence:');
    expect(browserSmoke).toContain('cleanupError ??= error');
    expect(browserSmoke).toContain('browser inherited values lost shared runtime parameters');
    expect(browserSmoke).toContain('browser inherited values lost the derived baseColor override');
    expect(browserSmoke.lastIndexOf('await closeBrowserBounded()')).toBeLessThan(
      browserSmoke.lastIndexOf('cleanup = await stopOwnedServer'),
    );
  });

  it('keeps the derived values limited to color while sharing a dynamic shader', () => {
    const rows = fixture.assets.filter((asset: { kind?: string }) => asset.kind === 'material');
    expect(rows).toHaveLength(2);
    expect(rows.some((asset: { guid?: string }) => asset.guid === ROOT_MATERIAL_GUID)).toBe(true);
    expect(rows.some((asset: { guid?: string }) => asset.guid === DERIVED_MATERIAL_GUID)).toBe(true);
    expect(rows.every((asset: { payload?: { cooked?: { schemaVersion?: string } } }) => asset.payload?.cooked?.schemaVersion === 'material-cook/4')).toBe(true);
    expect(shader).toMatch(/sin\(/);
    expect(shader).toMatch(/time/);
  });

  it('publishes strict authored root and child rows with one inherited cook table', () => {
    const root = fixture.assets.find((asset: { guid?: string }) => asset.guid === ROOT_MATERIAL_GUID);
    const derived = fixture.assets.find((asset: { guid?: string }) => asset.guid === DERIVED_MATERIAL_GUID);
    expect(root?.payload).toBeDefined();
    expect(derived?.payload).toBeDefined();
    expect(Object.keys(root?.payload ?? {}).sort()).toEqual([
      'cooked',
      'kind',
      'parameters',
      'passes',
      'values',
    ]);
    expect(Object.keys(derived?.payload ?? {}).sort()).toEqual([
      'cooked',
      'kind',
      'parent',
      'values',
    ]);
    expect(derived?.payload).not.toHaveProperty('role');
    expect(derived?.payload).not.toHaveProperty('passes');
    expect(derived?.payload).not.toHaveProperty('parameters');
    expect(derived?.payload).not.toHaveProperty('colorSpace');
    expect(derived?.payload?.parent).toBe(ROOT_MATERIAL_GUID);
    expect(Object.keys(derived?.payload?.cooked?.authored ?? {}).sort()).toEqual([
      'kind',
      'parent',
      'values',
    ]);
    expect(derived?.payload?.cooked?.authored).toMatchObject({
      kind: 'material',
      parent: ROOT_MATERIAL_GUID,
      values: { baseColor: [0.2, 0.55, 0.95, 1] },
    });
    expect(derived?.payload?.cooked?.authored).not.toHaveProperty('passes');
    expect(derived?.payload?.cooked?.authored).not.toHaveProperty('parameters');
    expect(derived?.payload?.cooked?.resolved?.passes).toEqual(root?.payload?.cooked?.resolved?.passes);
    expect(derived?.payload?.cooked?.resolved?.parameters).toEqual(root?.payload?.cooked?.resolved?.parameters);
    expect(derived?.payload?.cooked?.refs?.parent).toEqual([ROOT_MATERIAL_GUID]);
    for (const row of [root, derived]) {
      expect(row?.payload?.cooked?.guid).toBe(row?.guid);
      expect(row?.payload?.cooked?.resolved?.passes?.[0]?.program?.module).toBe('my-game::pulse-material');
      expect(row?.payload?.cooked?.programs?.[0]?.artifact?.digest).toMatch(/^sha256:/);
      expect(row?.payload?.cooked?.receipt?.identity?.materialPublicationIdentity).toMatch(/^sha256:/);
    }
    expect(root?.payload?.cooked?.artifactDigest).toBe(derived?.payload?.cooked?.artifactDigest);
    expect(root?.payload?.cooked?.specializationKey).toBe(
      derived?.payload?.cooked?.specializationKey,
    );
    expect(root?.payload?.cooked?.receipt?.identity?.cookIdentity).toBe(
      derived?.payload?.cooked?.receipt?.identity?.cookIdentity,
    );
    expect(root?.payload?.cooked?.resolved?.values).not.toEqual(
      derived?.payload?.cooked?.resolved?.values,
    );
    expect(derived?.payload?.cooked?.resolved?.values).toMatchObject({
      baseColor: [0.2, 0.55, 0.95, 1],
      time: 0,
      speed: 2,
    });
  });

  it('makes per-slot coordinates and transforms observable', () => {
    expect(source).toContain('toMaterialAsset');
    expect(source).toContain('satisfies GltfMaterialIr');
    expect(source).toContain('texCoord: 0');
    expect(source).toContain('texCoord: 1');
    expect(JSON.stringify(fixture)).toContain('coordinates');
    expect(JSON.stringify(fixture)).toContain('transform');
    expect(JSON.stringify(fixture)).toContain('baseColorTexture');
    expect(JSON.stringify(fixture)).toContain('normalTexture');
    expect(appRoot.pathname).toContain('custom-shader');
  });

  it('keeps identity texture coordinates implicit and preserves cooked refs', () => {
    const root = fixture.assets.find(
      (asset: { guid?: string }) => asset.guid === ROOT_MATERIAL_GUID,
    );
    expect(root?.payload?.values?.baseColorTexture).toBe(
      '01935b00-7d8c-7c4e-9f12-345678abcd11',
    );
    expect(root?.payload?.values?.baseColorTexture).not.toEqual(
      expect.objectContaining({ coordinates: expect.anything() }),
    );
    expect(root?.payload?.cooked?.refs?.textures).toEqual([
      '01935b00-7d8c-7c4e-9f12-345678abcd11',
      '01935b00-7d8c-7c4e-9f12-345678abcd12',
    ]);
    expect(root?.payload?.cooked?.resolved?.values?.baseColorTexture).toBe(
      '01935b00-7d8c-7c4e-9f12-345678abcd11',
    );
    const derived = fixture.assets.find(
      (asset: { guid?: string }) => asset.guid === DERIVED_MATERIAL_GUID,
    );
    expect(derived?.payload?.cooked?.authored?.values).toEqual({
      baseColor: [0.2, 0.55, 0.95, 1],
    });
  });
});
