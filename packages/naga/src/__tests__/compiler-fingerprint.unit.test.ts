import { expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ fingerprint: vi.fn() }));
vi.mock('@forgeax/engine-wgpu-wasm', () => ({ getCompilerFingerprint: native.fingerprint }));

it('forwards the native owner fingerprint as a compiler fact', async () => {
  const { getCompilerFingerprint } = await import('../index.js');
  native.fingerprint.mockResolvedValue('sha256-native-a');
  expect((await getCompilerFingerprint()).unwrap()).toBe('sha256-native-a');
  native.fingerprint.mockResolvedValue('sha256-native-b');
  expect((await getCompilerFingerprint()).unwrap()).toBe('sha256-native-b');
});

it('retains an unavailable native identity as a structured failure', async () => {
  const { getCompilerFingerprint } = await import('../index.js');
  native.fingerprint.mockRejectedValue(new Error('invalid provenance'));
  const result = await getCompilerFingerprint();
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatchObject({ detail: { reason: 'invalid provenance' } });
});
