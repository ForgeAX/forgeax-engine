import { afterAll, beforeAll } from 'vitest';
import * as wgpu from '../../../rhi-wgpu/src/index';
import { registerTsrFeedbackCases } from './tsr-feedback-cases.fixture';

const canvas = document.createElement('canvas');
canvas.width = canvas.height = 64;
let saved: PropertyDescriptor | undefined;
beforeAll(() => {
  saved = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  document.body.append(canvas);
});
afterAll(() => {
  if (saved) Object.defineProperty(navigator, 'gpu', saved);
  else Reflect.deleteProperty(navigator, 'gpu');
  canvas.remove();
});

// Every existing HDR, motion-sign falsifier, flicker and geometry assertion
// executes on the real no-compute backend with the production fragment shaders.
registerTsrFeedbackCases(
  {
    ...wgpu,
    rhi: { ...wgpu.rhi, requestAdapter: (options) => wgpu.rhi.requestAdapter(options, canvas) },
  },
  'raster',
);
