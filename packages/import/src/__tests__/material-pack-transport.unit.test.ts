import { createMaterialArtifactDigest } from '@forgeax/engine-pack';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type { ImportedAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectImportedAssetPayload } from '../import-product.js';
import { runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';
import { projectMaterialPackTransport } from '../material-pack-transport.js';
import { projectImportProductForBuild } from '../pack-projection.js';

const GUID = '019f0000-0000-7000-8000-000000000072';
const PATH = 'materials/program.wgsl';
const bytes = new TextEncoder().encode('@compute @workgroup_size(1) fn main() {}');

function asset(inline = bytes): ImportedAsset<unknown> {
  return {
    guid: GUID,
    kind: 'material',
    refs: [],
    payload: {
      kind: 'material',
      cooked: {
        schemaVersion: 'material-cook/4',
        programs: [
          {
            artifact: {
              mediaType: 'text/wgsl',
              path: PATH,
              digest: createMaterialArtifactDigest(bytes),
              bytes: inline,
            },
          },
        ],
      },
    },
    artifacts: { [PATH]: { mediaType: 'text/wgsl', bytes } },
  };
}

function program(payload: unknown): { artifact: { bytes?: unknown } } {
  const value = (payload as { cooked: { programs: { artifact: { bytes?: unknown } }[] } }).cooked
    .programs[0];
  if (value === undefined) throw new Error('missing fixture material program');
  return value;
}

describe('material payload transport', () => {
  it.each([
    'identity',
    'copy',
  ] as const)('externalizes verified %s bodies before Pack normalization without mutating the native record', (mode) => {
    const input = asset(mode === 'identity' ? bytes : new Uint8Array(bytes));
    expect(program(projectImportedAssetPayload(input)).artifact).not.toHaveProperty('bytes');
    expect(
      program(projectImportProductForBuild({ assets: [input] }).assets[0]?.payload).artifact,
    ).not.toHaveProperty('bytes');
    expect(program(input.payload).artifact.bytes).toBeInstanceOf(Uint8Array);
    expect(input.artifacts[PATH]?.bytes).toBe(bytes);
  });

  it('retains inconsistent inline bytes for the existing full material equality check', () => {
    const input = asset(new Uint8Array(bytes.length));
    expect(program(projectImportedAssetPayload(input)).artifact.bytes).toEqual(
      new Uint8Array(bytes.length),
    );
  });

  it('retains inline bytes when no external artifact exists', () => {
    const input = { ...asset(), artifacts: {} };
    expect(projectImportedAssetPayload(input)).toBe(input.payload);
  });

  it('compares the exact view rather than accepting a shared backing buffer', () => {
    const storage = new Uint8Array(bytes.length * 2);
    storage.set(bytes);
    const input = {
      ...asset(storage.subarray(bytes.length)),
      artifacts: { [PATH]: { mediaType: 'text/wgsl', bytes: storage.subarray(0, bytes.length) } },
    };
    expect(program(projectImportedAssetPayload(input)).artifact.bytes).toEqual(
      new Uint8Array(bytes.length),
    );
  });

  it.each([
    false,
    true,
  ])('preserves the verified descriptor route and rejects inconsistent inline elision: %s', (tampered) => {
    const input = asset();
    const payload = JSON.parse(
      JSON.stringify(projectImportProductForBuild({ assets: [input] }).assets[0]?.payload),
    );
    program(payload).artifact.bytes = tampered ? [...new Uint8Array(bytes.length)] : [...bytes];
    const pack = {
      assets: [
        {
          ...input,
          payload,
          artifacts: {
            [PATH]: {
              mediaType: 'text/wgsl',
              path: 'program.bin',
              byteLength: bytes.length,
              contentEncoding: 'identity',
              integrity: { algorithm: 'sha256', digest: createMaterialArtifactDigest(bytes) },
            },
          },
        },
      ],
    };
    const output = projectMaterialPackTransport(pack) as typeof pack;
    if (tampered)
      expect(program(output.assets[0]?.payload).artifact.bytes).toEqual([
        ...new Uint8Array(bytes.length),
      ]);
    else expect(program(output.assets[0]?.payload).artifact).not.toHaveProperty('bytes');
    expect(program(pack.assets[0]?.payload).artifact).toHaveProperty('bytes');
  });

  it('still rejects an invalid source record before publication or another cooker call', async () => {
    const input = asset();
    const registry = new ImporterRegistry();
    registry.register({
      key: 'material-fixture',
      async import() {
        return { ok: true, value: { assets: [input], sourceDependencies: [] } };
      },
    });
    const cookers = new NativeCookerRegistry();
    cookers.register({
      key: 'material',
      cook() {
        throw new Error('invalid existing record must not be cooked');
      },
    });
    const result = await runImport(
      {
        importer: 'material-fixture',
        source: 'fixture.bin',
        buildPack: false,
        subAssets: [
          { guid: GUID, kind: 'material', sourceIndex: 0, sourceKey: 'fixture:material' },
        ],
      },
      registry,
      {
        async readSource() {
          return { ok: true, value: new Uint8Array([1]) };
        },
      },
      cookers,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'import-internal-error',
        detail: { reason: 'invalid existing material cook record' },
      },
    });
  });
});
