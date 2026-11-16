import type { BrowserFrameCompleted } from '../src/browser-frame-signal';
import { expect, it } from 'vitest';
import { SubsurfacePictures } from './subsurface-picture.fixture';

function frame(frameId: number, presentation: 'pending' | 'ready'): BrowserFrameCompleted {
  return { frameId, deviceGeneration: 0, presentation };
}

it('rejects queue-only progress and the previous revision, then requires all 60 new ready pictures', () => {
  const pictures = new SubsurfacePictures();
  pictures.begin();
  for (let i = 0; i < 60; i++) pictures.completed(frame(i, 'pending'));
  expect(pictures.sinceAcknowledgment(0, 1)).toBe(0);
  expect(pictures.sinceAcknowledgment(2, 1)).toBe(0);
  pictures.completed(frame(61, 'ready'));
  expect(pictures.sinceAcknowledgment(0, 1)).toBe(0);
  expect(pictures.sinceAcknowledgment(1, 1)).toBe(0);
  for (let i = 0; i < 59; i++) pictures.completed(frame(62 + i, 'ready'));
  expect(pictures.sinceAcknowledgment(1, 1)).toBe(59);
  pictures.completed(frame(121, 'ready'));
  expect(pictures.sinceAcknowledgment(1, 1)).toBe(60);
  pictures.begin();
  expect(pictures.sinceAcknowledgment(1, 2)).toBe(0);
  expect(pictures.sinceAcknowledgment(2, 2)).toBe(0);
});
