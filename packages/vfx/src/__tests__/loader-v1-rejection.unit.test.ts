import type { LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { vfxGpuEffectPackLoader } from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
function context(): LoadContext {
  return {
    fetchBinary: async () => {
      throw new Error('asset-local loaders must not fetch legacy global artifacts');
    },
    resolveRef: async () => ({ ok: true, value: 0 }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

function input(
  payload: Record<string, unknown>,
  artifacts: Record<
    string,
    { descriptor: { path: string; mediaType: string }; bytes: Uint8Array }
  > = {},
) {
  return {
    guid: EFFECT_GUID,
    kind: 'particle-effect',
    payload,
    refs: [],
    artifacts,
  };
}

const invalidPayload = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [{ id: 'spark', capacity: 32 }],
};

describe('vfxGpuEffectPackLoader version boundary', () => {
  it('rejects older payloads before reading an artifact', async () => {
    const result = await vfxGpuEffectPackLoader.load(
      input(invalidPayload, {
        'effect/program.json': {
          descriptor: { path: 'program.json', mediaType: 'application/json' },
          bytes: new TextEncoder().encode('{}'),
        },
      }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'vfx-asset-version-unsupported',
        detail: { path: 'schemaVersion' },
      });
    }
  });

  it('rejects a summary-only older payload before reading a program artifact', async () => {
    const result = await vfxGpuEffectPackLoader.load(
      input({
        kind: 'particle-effect',
        schemaVersion: 2,
        emitters: [],
        programFingerprint: 'sha256:x',
      }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.detail.path).toBe('schemaVersion');
  });

  it('rejects a v1 package-global artifact shape', async () => {
    const result = await vfxGpuEffectPackLoader.load(
      input(invalidPayload, {
        'effect/program.json': {
          descriptor: { path: 'program.json', mediaType: 'application/json' },
          bytes: new TextEncoder().encode('{}'),
        },
      }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-asset-version-unsupported');
      expect(result.error.detail.path).toBe('schemaVersion');
    }
  });

  it('rejects raw source fallback when the cooked program is absent', async () => {
    const result = await vfxGpuEffectPackLoader.load(
      input({ ...invalidPayload, source: { emitters: [] }, sourcePath: 'effect.vfx.json' }),
      context(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-asset-version-unsupported');
      expect(result.error.detail.path).toBe('schemaVersion');
    }
  });
});

it('rejects the previous sorting uniform ABI with a re-cook hint', async () => {
  const program = { format: 'forgeax-vfx-program-3', emitters: [] };
  const result = await vfxGpuEffectPackLoader.load(
    input(
      {
        kind: 'particle-effect',
        schemaVersion: 3,
        emitters: [],
        programFingerprint: 'sha256:old',
        program: { ...program, fingerprint: 'sha256:old' },
      },
      {
        'particle-effect/program.json': {
          descriptor: {
            path: 'program.json',
            mediaType: 'application/vnd.forgeax.vfx-program+json',
          },
          bytes: new TextEncoder().encode(JSON.stringify(program)),
        },
      },
    ),
    context(),
  );
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error).toMatchObject({
      code: 'vfx-asset-v3-invalid',
      expected: 'a forgeax-vfx-program-4 managed GPU program',
      hint: 'recook with the current VFX compiler ABI',
    });
});
