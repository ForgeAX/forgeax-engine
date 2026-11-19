import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createBarrelDistortionRenderFeature } from '../../features/barrel-distortion';
import { createEditorAssistanceFeature } from '../../features/editor-assistance/feature';
import { createFullscreenRenderFeature } from '../../features/fullscreen';
import type { RenderFeatureHost } from '../../features/host';
import { createMotionBlurFeature } from '../../features/motion-blur/motion-blur-feature';
import {
  captureUnusedSurfaceData,
  featureUsesSurfaceData,
} from '../../features/surface-data-usage';
import { needsSceneSurfaceAdmission } from '../feature-view-systems';

const forward = { renderPath: 'forward' as const, ssao: false };
const unused = captureUnusedSurfaceData({
  identity: 'unused',
  extract: () => ok(undefined),
  plan: () => ok({ work: [] }),
});
const host = (features: readonly object[]) => ({ features }) as Pick<RenderFeatureHost, 'features'>;

it('omits surface admission only for explicitly disabled stock consumers and declared nonconsumers', () => {
  expect(needsSceneSurfaceAdmission(forward, true, undefined, host([unused]))).toBe(false);
  expect(needsSceneSurfaceAdmission(forward, true, false, host([]))).toBe(false);
});

it('keeps unknown features, SSAO, Deferred, custom pipelines and conformance diagnostics conservative', () => {
  expect(needsSceneSurfaceAdmission(forward, true, undefined, host([{}]))).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, true, undefined, undefined)).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, true, true, host([unused]))).toBe(true);
  expect(needsSceneSurfaceAdmission({ ...forward, ssao: true }, true, false, host([unused]))).toBe(
    true,
  );
  expect(
    needsSceneSurfaceAdmission({ ...forward, renderPath: 'deferred' }, true, false, host([unused])),
  ).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, false, false, host([unused]))).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, true, false, host([unused]), true)).toBe(true);
});

it('observes feature demand changes on the next call without retaining a second roster', () => {
  const feature = captureUnusedSurfaceData({
    identity: 'changing',
    extract: () => ok(undefined),
    plan: () => ok({ work: [] }),
  });
  expect(needsSceneSurfaceAdmission(forward, true, false, host([feature]))).toBe(false);
  feature.plan = () => ok({ work: [] });
  expect(needsSceneSurfaceAdmission(forward, true, false, host([feature]))).toBe(true);
});

it('uses declarations from the real built-in feature producers rather than their identities', () => {
  const fullscreen = createFullscreenRenderFeature({ identity: 'test', source: 'synthetic' });
  const features = [
    createBarrelDistortionRenderFeature(),
    createEditorAssistanceFeature(),
    createMotionBlurFeature(),
    fullscreen,
  ];
  expect(features.every((feature) => !featureUsesSurfaceData(feature))).toBe(true);
  expect(featureUsesSurfaceData(Object.freeze({ ...fullscreen }))).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, true, false, host(features))).toBe(false);
});
