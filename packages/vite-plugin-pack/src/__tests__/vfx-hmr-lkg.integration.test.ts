import { type NativeCookDraft, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { describe, expect, it } from 'vitest';

function draft(version: string): NativeCookDraft<{ version: string }> {
  return {
    guid: 'vfx-showcase',
    payload: { version },
    refs: [],
    artifacts: {
      'particle-effect/program.json': {
        mediaType: 'application/json',
        bytes: new Uint8Array([version.length]),
      },
    },
    inputFingerprint: `sha256:${version}`,
  };
}

describe('generation-scoped VFX HMR LKG', () => {
  it('keeps the committed generation through an invalid candidate and recovers once', async () => {
    const registry = new NativeCookerRegistry();
    let version = 'one';
    registry.register({ key: 'particle-effect', cook: () => draft(version) });
    const first = await registry.runTransaction<{ version: string }, Record<string, never>>({
      key: 'particle-effect',
      input: {},
    });
    expect(first).toMatchObject({ ok: true, value: { generation: 1, status: 'committed' } });
    if (!first.ok) return;

    version = 'invalid';
    const rejected = await registry.runTransaction<{ version: string }, Record<string, never>>({
      key: 'particle-effect',
      input: {},
      previous: first.value,
      validate: (candidate) =>
        candidate.payload.version === 'invalid' ? 'ABI fingerprint mismatch' : undefined,
    });
    expect(rejected).toMatchObject({
      ok: true,
      value: {
        status: 'recovered',
        generation: 1,
        candidateGeneration: 2,
        lastKnownGoodGeneration: 1,
        recoveryHint: expect.stringContaining('repair'),
      },
    });

    version = 'two';
    if (!rejected.ok) return;
    const recovered = await registry.runTransaction<{ version: string }, Record<string, never>>({
      key: 'particle-effect',
      input: {},
      previous: rejected.value,
    });
    expect(recovered).toMatchObject({ ok: true, value: { status: 'committed', generation: 2 } });
  });
});
