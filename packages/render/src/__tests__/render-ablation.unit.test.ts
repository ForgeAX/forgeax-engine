import { afterEach, describe, expect, it } from 'vitest';
import {
  ablateLocalLights,
  installRenderAblationDevtools,
  parseRenderAblation,
  RenderAblationInvalidError,
  renderAblation,
  setRenderAblation,
} from '../diagnostics/render-ablation';

const point = (id: number, shadowed = false) => ({
  kind: 'point',
  shadowed,
  source: { kind: 'point', id, shadowAtlasLayer: shadowed ? id : -1 },
});
const spot = (id: number, shadowed = false) => ({
  kind: 'spot',
  shadowed,
  source: { kind: 'spot', id, shadowAtlasTile: shadowed ? id : -1 },
});
const rect = (id: number) => ({
  kind: 'rect-area',
  shadowed: false,
  source: { kind: 'rect-area', id },
});

afterEach(() => {
  setRenderAblation(undefined);
  delete (globalThis as { __forgeaxRenderAblation?: unknown }).__forgeaxRenderAblation;
});

describe('render ablation defaults', () => {
  it('is off unless explicitly set', () => {
    expect(renderAblation()).toBeUndefined();
  });

  it('returns the identical light corpus when nothing is ablated', () => {
    const local = [point(0, true), spot(1, true), rect(2)];
    expect(ablateLocalLights(local)).toBe(local);
    setRenderAblation({ bloom: false });
    expect(ablateLocalLights(local)).toBe(local);
  });

  it('treats all-true settings and full scale as no ablation', () => {
    const set = setRenderAblation({
      shadowRaster: true,
      shadowSampling: true,
      bloom: true,
      fxaa: true,
      punctualLights: 1,
      renderScale: 1,
    });
    expect(set.ok && set.value).toBeUndefined();
    expect(renderAblation()).toBeUndefined();
    expect(parseRenderAblation('').ok).toBe(true);
  });
});

describe('parseRenderAblation', () => {
  it('parses every switch', () => {
    const parsed = parseRenderAblation(
      'shadow-raster=0, shadow-sampling=off,lights=0.25,bloom=0,fxaa=false,scale=0.5',
    );
    expect(parsed.ok && parsed.value).toEqual({
      shadowRaster: false,
      shadowSampling: false,
      punctualLights: 0.25,
      bloom: false,
      fxaa: false,
      renderScale: 0.5,
    });
  });

  it('expands post=0 to bloom and FXAA', () => {
    const parsed = parseRenderAblation('post=0');
    expect(parsed.ok && parsed.value).toEqual({ bloom: false, fxaa: false });
  });

  it.each([
    'shadows=0',
    'bloom=maybe',
    'lights=1.5',
    'lights=',
    'scale=0.1',
    'scale=abc',
  ])('rejects %s with a structured error', (text) => {
    const parsed = parseRenderAblation(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBeInstanceOf(RenderAblationInvalidError);
    expect(parsed.error.code).toBe('render-ablation-invalid');
    expect(parsed.error.hint).toContain('shadow-raster=0');
  });
});

describe('setRenderAblation', () => {
  it('rejects out-of-range values without changing the active state', () => {
    setRenderAblation({ fxaa: false });
    const rejected = setRenderAblation({ renderScale: 0 });
    expect(rejected.ok).toBe(false);
    expect(renderAblation()).toEqual({ fxaa: false });
  });

  it('freezes the installed state and clears with undefined', () => {
    setRenderAblation({ shadowRaster: false });
    expect(Object.isFrozen(renderAblation())).toBe(true);
    setRenderAblation(undefined);
    expect(renderAblation()).toBeUndefined();
  });
});

describe('ablateLocalLights', () => {
  it('keeps the rounded fraction of point and spot lights per kind in roster order', () => {
    const local = [point(0), point(1), point(2), point(3), spot(4), spot(5), rect(6)];
    const kept = ablateLocalLights(local, { punctualLights: 0.5 });
    expect(kept.map((light) => (light.source as { id: number }).id)).toEqual([0, 1, 4, 6]);
    expect(ablateLocalLights(local, { punctualLights: 0 }).map((l) => l.kind)).toEqual([
      'rect-area',
    ]);
  });

  it('drops shadow sampling with stable per-source copies and leaves the input intact', () => {
    const local = [point(0, true), spot(1, true), point(2)];
    const first = ablateLocalLights(local, { shadowSampling: false });
    const second = ablateLocalLights(local, { shadowSampling: false });
    expect(first.every((light) => !light.shadowed)).toBe(true);
    expect(first[0]?.source).toMatchObject({ shadowAtlasLayer: -1, shadowAtlasTile: -1 });
    expect(first[1]?.source).toMatchObject({ shadowAtlasLayer: -1, shadowAtlasTile: -1 });
    expect(first[0]?.source).toBe(second[0]?.source);
    expect(first[2]).toBe(local[2]);
    expect(local[0]?.shadowed).toBe(true);
    expect(local[0]?.source).toMatchObject({ shadowAtlasLayer: 0 });
  });
});

describe('devtools accessor', () => {
  it('sets from the query form and reads back', () => {
    const devtools = installRenderAblationDevtools();
    expect((globalThis as { __forgeaxRenderAblation?: unknown }).__forgeaxRenderAblation).toBe(
      devtools,
    );
    expect(devtools.set('lights=0.5').ok).toBe(true);
    expect(devtools.get()).toEqual({ punctualLights: 0.5 });
    expect(devtools.set('nope=1').ok).toBe(false);
    expect(devtools.set(undefined).ok).toBe(true);
    expect(devtools.get()).toBeUndefined();
  });
});
