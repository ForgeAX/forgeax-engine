import { describe, expect, it } from 'vitest';
import { deriveCameraStandardConfiguration } from '../pipeline/camera-standard-profile';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';

const lane = { storageBuffer: true, maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 72 };
const deferred = { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' as const };
const forward = { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' as const };

describe('Standard view AA and path admission', () => {
  it.each([
    'msaa',
    'msaa-fxaa',
  ] as const)('rejects explicit Deferred with %s before effects', (antialias) => {
    for (const water of [false, true]) {
      for (const screenSpaceReflection of [undefined, {}]) {
        expect(
          deriveCameraStandardConfiguration(
            deferred,
            {},
            { antialias, screenSpaceReflection },
            lane,
            water,
          ),
        ).toMatchObject({
          ok: false,
          error: {
            code: 'resource-descriptor-invalid',
            detail: {
              resourceLabel: 'forgeax::standard',
              field: 'camera.antialias',
              actual: antialias,
            },
          },
        });
      }
    }
  });

  it.each([
    'msaa',
    'msaa-fxaa',
  ] as const)('keeps Forward with %s when SSR and Water are requested', (antialias) => {
    for (const water of [false, true]) {
      expect(
        deriveCameraStandardConfiguration(
          forward,
          {},
          { antialias, screenSpaceReflection: {} },
          lane,
          water,
        ),
      ).toMatchObject({
        ok: true,
        value: { profile: { renderPath: 'forward' } },
      });
    }
  });

  it.each([
    'none',
    'fxaa',
    'taa',
    'tsr',
    'smaa',
  ] as const)('retains ordinary single-sample Deferred with %s', (antialias) => {
    expect(deriveCameraStandardConfiguration(deferred, {}, { antialias }, lane)).toMatchObject({
      ok: true,
      value: { profile: { renderPath: 'deferred' } },
    });
  });

  it.each([
    'msaa',
    'msaa-fxaa',
  ] as const)('selects real Forward for automatic %s and restores Deferred', (antialias) => {
    const selected = deriveCameraStandardConfiguration(
      deferred,
      {},
      { antialias, screenSpaceReflection: {} },
      lane,
      false,
      'auto',
    );
    expect(selected).toMatchObject({ ok: true, value: { profile: { renderPath: 'forward' } } });
    const restored = deriveCameraStandardConfiguration(
      deferred,
      {},
      { antialias: 'taa' },
      lane,
      false,
      'auto',
    );
    expect(restored).toMatchObject({ ok: true, value: { profile: { renderPath: 'deferred' } } });
    expect(deferred.renderPath).toBe('deferred');
  });

  it.each([
    'visibleSurface',
    'diffuseGi',
    'probePlacement',
  ] as const)('does not drop Deferred-only %s when auto requests MSAA', (feature) => {
    const profile = { ...deferred, [feature]: feature === 'visibleSurface' ? true : {} };
    expect(
      deriveCameraStandardConfiguration(profile, {}, { antialias: 'msaa' }, lane, false, 'auto'),
    ).toMatchObject({
      ok: false,
      error: { code: 'resource-descriptor-invalid', detail: { field: 'camera.antialias' } },
    });
  });
});
