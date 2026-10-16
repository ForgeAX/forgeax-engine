import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishShaderManifest } from '../manifest-publication.js';
import { loadSharedEngineShaderManifest } from '../shared-engine-inputs.js';

let root: string;
let manifestPath: string;
const wgsl = '// source \u00e9\r\nfn main() {}\n// final bytes  ';
const entries = [{ hash: 'primary', wgsl, bindings: '[]' }];
const materialShaders = [{ identifier: 'material', composedWgsl: wgsl, variants: [] }];

function writePayload(value: unknown): void {
  writeFileSync(join(root, 'shared/shaders.json'), JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shared-publication-loader-'));
  mkdirSync(join(root, 'shared'));
  manifestPath = join(root, 'shared/manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 2,
      producer: 'repo-build-inputs',
      inputFingerprint: 'test-source',
      inventory: ['shared/shaders.json'],
      payload: { engineShaderManifest: 'shared/shaders.json' },
    }),
  );
  writePayload(publishShaderManifest(entries, materialShaders));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('serializes admitted shared blocks without expanding and splitting every material again', async () => {
  const materials = [
    'forgeax::default-standard-pbr',
    'forgeax::pbr-skin',
    'forgeax::default-shadow-caster',
  ].map((identifier) => ({ identifier, composedWgsl: wgsl, variants: [] }));
  const publication = publishShaderManifest(entries, materials);
  writePayload(publication);
  vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', manifestPath);
  const { buildEngineShaderManifest } = await import('../index.js');
  const split = String.prototype.split;
  let repeatedSplits = 0;
  const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
    this: string,
    separator: unknown,
    limit?: number,
  ) {
    if (separator === '\n\n' && String(this) === wgsl) repeatedSplits++;
    return Reflect.apply(split, this, [separator, limit]) as string[];
  });
  try {
    const manifest = await buildEngineShaderManifest();
    const wire = JSON.parse(JSON.stringify(manifest));
    expect(wire).toEqual({
      ...publication,
      entries: publication.entries.map((entry) => ({ ...entry, glsl: '' })),
    });
    expect(repeatedSplits).toBe(0);
    // Reusing admitted blocks must not turn an in-place replacement into a
    // stale cache hit or bypass the source digest check.
    publication.fragments[0] += 'corrupt';
    writePayload(publication);
    await expect(buildEngineShaderManifest()).rejects.toThrow('digest mismatch');
  } finally {
    spy.mockRestore();
  }
});

it('loads exact shared shader bytes in Node without a browser Crypto global', async () => {
  vi.stubGlobal('crypto', undefined);
  const join = Array.prototype.join;
  const composed: string[] = [];
  const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
    this: unknown[],
    separator?: string,
  ) {
    const result = Reflect.apply(join, this, [separator]) as string;
    if (separator === '' && result === wgsl) composed.push(result);
    return result;
  });
  const loaded = await loadSharedEngineShaderManifest(manifestPath);
  expect(composed).toEqual([]);
  spy.mockRestore();
  expect({ entries: loaded.entries, materialShaders: loaded.materialShaders }).toEqual({
    entries,
    materialShaders,
  });
  expect(loaded.publication).toEqual(publishShaderManifest(entries, materialShaders));
});

it('rejects changed source bytes under an unchanged source digest', async () => {
  const publication = publishShaderManifest(entries, materialShaders);
  publication.fragments[0] += ' ';
  writePayload(publication);
  await expect(loadSharedEngineShaderManifest(manifestPath)).rejects.toThrow('digest mismatch');
});

it('rejects unused source digests before accepting the shared publication', async () => {
  const publication = publishShaderManifest(entries, materialShaders);
  publication.sources['0'.repeat(64)] = [0];
  writePayload(publication);
  await expect(loadSharedEngineShaderManifest(manifestPath)).rejects.toThrow('missing or unused');
});

it('retains the producer inventory gate before loading shader rows', async () => {
  rmSync(join(root, 'shared/shaders.json'));
  await expect(loadSharedEngineShaderManifest(manifestPath)).rejects.toThrow(
    'inventory is missing',
  );
});
