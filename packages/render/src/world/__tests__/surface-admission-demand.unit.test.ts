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

const forward = 'forward';
const unused = captureUnusedSurfaceData({
  identity: 'unused',
  extract: () => ok(undefined),
  plan: () => ok({ work: [] }),
});
const host = (features: readonly object[]) => ({ features }) as Pick<RenderFeatureHost, 'features'>;

it('omits surface admission in Forward with declared nonconsumers', () => {
  expect(needsSceneSurfaceAdmission(forward, true, host([unused]))).toBe(false);
  expect(needsSceneSurfaceAdmission(forward, true, host([]))).toBe(false);
});

it('keeps unknown features, Deferred, custom pipelines and conformance diagnostics conservative', () => {
  expect(needsSceneSurfaceAdmission(forward, true, host([{}]))).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, true, undefined)).toBe(true);
  expect(needsSceneSurfaceAdmission('deferred', true, host([unused]))).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, false, host([unused]))).toBe(true);
  expect(needsSceneSurfaceAdmission(forward, true, host([unused]), true)).toBe(true);
});

it('observes feature demand changes on the next call without retaining a second roster', () => {
  const feature = captureUnusedSurfaceData({
    identity: 'changing',
    extract: () => ok(undefined),
    plan: () => ok({ work: [] }),
  });
  expect(needsSceneSurfaceAdmission(forward, true, host([feature]))).toBe(false);
  feature.plan = () => ok({ work: [] });
  expect(needsSceneSurfaceAdmission(forward, true, host([feature]))).toBe(true);
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
  expect(needsSceneSurfaceAdmission(forward, true, host(features))).toBe(false);
});
