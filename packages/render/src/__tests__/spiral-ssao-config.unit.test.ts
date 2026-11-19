import { describe, expect, it } from 'vitest';
import { getSsaoParameters, resolveSsaoParameters, type SsaoParameterConfig } from '../ssao-config';

const spiral = 'spiral-ssao' as NonNullable<SsaoParameterConfig['algorithm']>;

describe('spiral SSAO sampling budget', () => {
  it.each([
    ['low', 8],
    ['medium', 12],
    ['high', 12],
  ] as const)('admits the original %s budget of %i depth candidates', (quality, sampleCount) => {
    expect(resolveSsaoParameters({ algorithm: spiral, quality })).toMatchObject({
      ok: true,
      value: { algorithm: spiral, sampleCount },
    });
  });

  it('permits an explicit 16-candidate ultra budget without changing other estimators', () => {
    expect(
      resolveSsaoParameters({ algorithm: spiral, sampleCount: 16 } as SsaoParameterConfig),
    ).toMatchObject({ ok: true, value: { sampleCount: 16 } });
    expect(getSsaoParameters({ algorithm: 'ssao', quality: 'high' })).toMatchObject({
      sampleCount: 64,
    });
    expect(getSsaoParameters({ algorithm: 'gtao', quality: 'high' })).toMatchObject({
      sampleCount: 16,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    65,
    NaN,
    Infinity,
  ])('rejects an invalid explicit budget %s', (sampleCount) => {
    expect(
      resolveSsaoParameters({ algorithm: spiral, sampleCount } as SsaoParameterConfig),
    ).toMatchObject({
      ok: false,
      error: { code: 'ssao-parameter-invalid', detail: { paramName: 'sampleCount' } },
    });
  });
});

it('keeps lighting AO as the default and admits explicit scene-color strength', () => {
  expect(getSsaoParameters(undefined)).toMatchObject({
    application: 'lighting',
    sceneColorStrength: 0.95,
  });
  expect(
    resolveSsaoParameters({
      algorithm: spiral,
      application: 'scene-color',
      sceneColorStrength: 0.8,
    } as SsaoParameterConfig),
  ).toMatchObject({ ok: true, value: { application: 'scene-color', sceneColorStrength: 0.8 } });
});
it.each([
  -0.1,
  1.1,
  NaN,
  Infinity,
])('rejects invalid scene-color strength %s', (sceneColorStrength) => {
  expect(
    resolveSsaoParameters({
      application: 'scene-color',
      sceneColorStrength,
    } as SsaoParameterConfig),
  ).toMatchObject({ ok: false, error: { detail: { paramName: 'sceneColorStrength' } } });
});
it('rejects an unknown application instead of silently changing lighting', () => {
  expect(
    resolveSsaoParameters({ application: 'unknown' } as unknown as SsaoParameterConfig),
  ).toMatchObject({ ok: false, error: { detail: { paramName: 'application' } } });
});
