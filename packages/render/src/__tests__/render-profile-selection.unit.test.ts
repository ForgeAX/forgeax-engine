import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { validateRenderProfile } from '../assembly/renderer-facade';
import { deriveCameraStandardConfiguration } from '../pipeline/camera-standard-profile';
import { createRenderProfileSelection } from '../pipeline/render-profile-selection';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type { RenderProfile } from '../render-contract';
import { DEFERRED_ATTACHMENT_BYTES } from '../standard-attachments';

const profile: RenderProfile = Object.freeze({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'auto' });
const device = (storageBuffer = true, attachments = 8, bytes = 64) =>
  ({
    caps: { storageBuffer, maxColorAttachments: attachments },
    limits: { maxColorAttachmentBytesPerSample: bytes },
  }) as Pick<RhiDevice, 'caps' | 'limits'>;

describe('device-owned automatic Standard path', () => {
  it.each([
    [true, 8, 64, 'deferred'],
    [true, 6, DEFERRED_ATTACHMENT_BYTES.surface, 'deferred'],
    [false, 8, 64, 'forward'],
    [true, 5, 64, 'forward'],
    [true, 8, DEFERRED_ATTACHMENT_BYTES.surface - 1, 'forward'],
  ] as const)('admits storage=%s MRTs=%s bytes=%s as %s', (storage, targets, bytes, path) => {
    expect(
      createRenderProfileSelection().select(profile, device(storage, targets, bytes)).renderPath,
    ).toBe(path);
    expect(profile.renderPath).toBe('auto');
  });
  it('reuses one immutable projection across every camera and effect transition', () => {
    const select = createRenderProfileSelection().select,
      current = device(),
      first = select(profile, current);
    for (let i = 0; i < 1000; i++) expect(select(profile, current)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it('reselects for recovered capabilities without replacing the author request', () => {
    const select = createRenderProfileSelection().select;
    expect(select(profile, device()).renderPath).toBe('deferred');
    expect(select(profile, device(false)).renderPath).toBe('forward');
    expect(select(profile, device()).renderPath).toBe('deferred');
    expect(profile.renderPath).toBe('auto');
  });
  it.each([
    'forward',
    'deferred',
  ] as const)('preserves an explicit %s request on either device', (path) => {
    const explicit = Object.freeze({ ...DEFAULT_STANDARD_PROFILE, renderPath: path }),
      select = createRenderProfileSelection().select;
    expect(select(explicit, device())).toBe(explicit);
    expect(select(explicit, device(false))).toBe(explicit);
  });
  it('validates automatic profile fields and still rejects malformed author intent', () => {
    expect(validateRenderProfile(profile)).toBeUndefined();
    expect(
      validateRenderProfile({ ...profile, lightCount: 17 } as unknown as RenderProfile),
    ).toContain('lightCount');
    expect(
      validateRenderProfile({ ...profile, extra: true } as unknown as RenderProfile),
    ).toContain('extra');
    expect(
      validateRenderProfile({ ...profile, renderPath: 'unknown' } as unknown as RenderProfile),
    ).toContain('renderPath');
  });
  it.each([32, 35, 36])('does not let SSR change the %i-byte device default', (bytes) => {
    const d = device(true, 8, bytes);
    const resolved = createRenderProfileSelection().select(profile, d);
    const result = deriveCameraStandardConfiguration(
      resolved,
      {},
      { screenSpaceReflection: {} },
      { ...d.caps, maxColorAttachmentBytesPerSample: bytes },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profile?.renderPath).toBe(resolved.renderPath);
  });
});
