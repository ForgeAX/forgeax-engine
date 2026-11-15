import { expect, it } from 'vitest';
import { receiptRow } from '../../__tests__/gpu-draw-selection-fixture';
import { makeZeroCameraFallbackSnapshot } from '../../record/frame-snapshot';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract';
import { MaterialFrame } from '../material-dispatch';
import { cullPersistentFrame } from '../persistent-cull';

it('keeps visible native draws when a sibling of the same entity is outside the camera', () => {
  const source = receiptRow().source;
  const visible: RenderableSnapshot = {
    ...source,
    nativeDraw: { key: 'water-near' },
    localAabb: Float32Array.of(-1, -1, -10, 1, 1, -8),
  };
  const outside: RenderableSnapshot = {
    ...source,
    nativeDraw: { key: 'water-far' },
    localAabb: Float32Array.of(100, -1, -10, 102, 1, -8),
  };
  const frame = {
    cameras: [makeZeroCameraFallbackSnapshot()],
    renderables: [visible, outside],
    dispatch: [],
  } as unknown as ExtractedFrame;

  const result = cullPersistentFrame(
    frame,
    new MaterialFrame(undefined).with(source.material),
  ).frame;

  expect(result.renderables).toEqual([visible]);
  expect(result.frustumStats).toMatchObject({ culled: 1, total: 2 });
  expect(result.cameraVisible?.(visible)).toBe(true);
  expect(result.cameraVisible?.(outside)).toBe(false);
});
