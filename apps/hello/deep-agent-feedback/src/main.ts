import { pointShadowPlugin } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { bootstrap } from './bootstrap';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
const status = document.querySelector<HTMLElement>('#status');
if (canvas === null || status === null) throw new Error('deep-agent-feedback: required host elements are missing');

const fixture = new URLSearchParams(globalThis.location.search).get('fixture') ?? 'baseline';
const appResult = await createApp(
  canvas,
  fixture === 'point-shadow-recipe' ? { plugins: [pointShadowPlugin()] } : {},
  forgeaxBundlerAdapter(),
);
if (!appResult.ok) {
  status.textContent = 'Engine unavailable';
  throw appResult.error;
}
if (fixture === 'point-shadow-recipe') {
  // Preflight the real renderer capability before bootstrap publishes the
  // PointLightShadow component. A failed Result is visible to the focused
  // consumer and cannot be mistaken for a silent fallback.
  const pointShadow = appResult.value.pluginContext.pointShadow;
  const admission = pointShadow?.admit(1);
  if (admission === undefined || !admission.ok) {
    const error = admission?.error ?? new Error('point-shadow capability was not installed');
    status.textContent = `Point shadow unavailable: ${error.message}`;
    await appResult.value.dispose();
    throw error;
  }
}
const uiRoot = document.querySelector<HTMLElement>('#game-ui');
const bootstrapOptions = { fixture, ...(uiRoot === null ? {} : { uiRoot }) };
bootstrap(appResult.value.world, bootstrapOptions);
appResult.value.start().unwrap();
status.textContent = `Ready: ${fixture}; Engine Skylight fixture mounted.`;
document.documentElement.dataset.forgeaxFixture = fixture;
globalThis.__forgeaxDeepAgentFeedback = { fixture, canvas, status };

declare global {
  var __forgeaxDeepAgentFeedback: {
    readonly fixture: string;
    readonly canvas: HTMLCanvasElement;
    readonly status: HTMLElement;
  };
}

export { canvas, fixture };
