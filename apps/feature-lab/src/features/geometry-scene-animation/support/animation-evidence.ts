import type { App } from '@forgeax/engine/app';

/** Development measurements reuse submitted receipts and Renderer timing observations. */
export function animationEvidence(app: App, cpu: () => number, enabled: () => boolean): void {
  if (!new URLSearchParams(location.search).has('animationEvidence')) return;
  const samples: unknown[] = [];
  Object.assign(window, { __animationEvidence: samples });
  app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted' || samples.length >= 2048) return;
    const cpuMs = cpu();
    const on = enabled();
    void app.renderer.observe(event.receipt, { include: ['timings'] }).then((observed) => {
      samples.push({
        on,
        cpuMs,
        observation: observed.ok ? observed.value.timings : { error: observed.error },
      });
    });
  });
}
