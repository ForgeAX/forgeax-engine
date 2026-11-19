import { expect, it } from 'vitest';
import { portableBrowserAddons } from './portable-browser-addons.fixture';

it('uses real DOM, transferable Web Workers, KMZ parsing and six-face HDR loading', {
  timeout: 30000,
}, async () => {
  const result = await portableBrowserAddons();
  // The queued buffer is transferred only when its worker is admitted.
  expect(result.detached).toEqual([0, 2]);
  expect(result.queued).toBe(1);
  expect(result.workerValues).toEqual([
    { id: 0, bytes: [4, 2] },
    { id: 1, bytes: [13, 20] },
  ]);
  expect(result.workerCount).toBe(1);
  expect(result.afterDispose).toEqual({ workers: 0, queue: 0, status: 0 });
  expect(result.canvasSize).toEqual([128, 128]);
  expect(result.darkPixels).toBeGreaterThan(100);
  expect(result.sceneIdentity).toBe(true);
  expect(result.vertices).toBe(3);
  expect(result.cubeIdentity).toBe(true);
  expect(result.faces).toHaveLength(6);
  result.faces.forEach((face, i) => {
    expect(face).toMatchObject({ native: true, width: 1, height: 1 });
    expect(face.red).toBeCloseTo(((128 + i * 16) * 2) / 255, 6);
  });
});
