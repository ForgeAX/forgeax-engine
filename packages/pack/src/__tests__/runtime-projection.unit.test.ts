import { describe, expect, it } from 'vitest';

import { projectRuntimePack } from '../runtime-projection.js';

const artifact = {
  path: 'mesh.bin',
  mediaType: 'application/octet-stream',
  contentEncoding: 'identity' as const,
  byteLength: 3,
  integrity: { algorithm: 'sha256' as const, digest: 'sha256:mesh' },
};

const asset = {
  guid: '019e2cc6-0c86-79da-aa76-b0984c86d45a',
  kind: 'mesh',
  payload: { kind: 'mesh' },
  refs: [],
  artifacts: { mesh: artifact },
};

describe('runtime Pack projection', () => {
  it('preserves the material payload and artifact tuple without a runtime adapter', () => {
    const material = {
      guid: '019e2cc6-0c86-79da-aa76-b0984c86d45b',
      kind: 'material',
      payload: {
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'forgeax::standard' } }],
        values: { baseColor: [1, 1, 1, 1] },
      },
      refs: [],
      artifacts: {},
    };
    const result = projectRuntimePack({
      scopeId: 'material-session',
      generation: 1,
      digest: 'sha256:material-pack',
      outputSetDigest: 'sha256:material-outputs',
      assets: [material],
    });

    expect(result).toMatchObject({ ok: true, value: { assets: [material] } });
  });

  it('publishes one atomic tuple and one Pack v2 envelope', () => {
    const result = projectRuntimePack({
      scopeId: 'play-session',
      generation: 7,
      digest: 'sha256:pack',
      outputSetDigest: 'sha256:outputs',
      assets: [asset],
    });

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        scopeId: 'play-session',
        generation: 7,
        digest: 'sha256:pack',
        outputSetDigest: 'sha256:outputs',
        assets: [asset],
      },
    });
  });

  it('rejects legacy and duplicate-row input before publication', () => {
    const legacy = projectRuntimePack({ schemaVersion: '1.0.0', assets: [asset] });
    expect(legacy).toMatchObject({
      ok: false,
      error: { code: 'pack-v2-envelope-invalid', detail: { expected: 'runtime Pack v2' } },
    });

    const duplicate = projectRuntimePack({
      scopeId: 'play-session',
      generation: 7,
      digest: 'sha256:pack',
      outputSetDigest: 'sha256:outputs',
      assets: [asset, asset],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: 'pack-v2-duplicate-guid', detail: { guid: asset.guid } },
    });
  });
});
