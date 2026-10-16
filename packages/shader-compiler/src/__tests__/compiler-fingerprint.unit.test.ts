import * as naga from '@forgeax/engine-naga';
import { afterEach, expect, it, vi } from 'vitest';
import { getShaderCompilerFingerprint } from '../compiler-fingerprint.js';

afterEach(() => vi.restoreAllMocks());

it('changes public compiler identity when the verified native identity changes', async () => {
  const fingerprint = vi.spyOn(naga, 'getCompilerFingerprint');
  fingerprint.mockResolvedValue(naga.ok('native-a'));
  const first = await getShaderCompilerFingerprint();
  expect(first.ok).toBe(true);
  expect(await getShaderCompilerFingerprint()).toEqual(first);
  fingerprint.mockResolvedValue(naga.ok('native-b'));
  expect(await getShaderCompilerFingerprint()).not.toEqual(first);
});

it('preserves a native identity failure instead of issuing a reusable identity', async () => {
  const failure = naga.err(
    naga.initFailed({
      message: 'missing native payload',
      reason: 'missing',
      hint: 'repair payload',
    }),
  );
  vi.spyOn(naga, 'getCompilerFingerprint').mockResolvedValue(failure);
  expect(await getShaderCompilerFingerprint()).toBe(failure);
});
