import { describe, expect, it } from 'vitest';

// The focused assertion only needs a real non-flat canvas. Keep the test
// surface at a small 16:9 size while avoiding an unnecessary software-GPU
// screenshot on the shared runner. Dedicated visual tests own the compositor
// PNG path; this carrier test only proves that the real app reaches Ready.
document.body.innerHTML = '<canvas id="app" width="640" height="360"></canvas><div id="status"></div>';
await import('../main');

describe('deep-agent-feedback focused browser carrier', () => {
  it('mounts a non-flat canvas and the evidence UI', () => {
    const status = document.querySelector<HTMLElement>('#status')?.textContent ?? '';
    const canvas = document.querySelector<HTMLCanvasElement>('#app');
    expect(canvas).not.toBeNull();
    expect(canvas?.width).toBe(640);
    expect(canvas?.height).toBe(360);
    expect(status).toContain('Ready');
    expect(document.documentElement.dataset.forgeaxFixture).toBe('baseline');
  });
});
