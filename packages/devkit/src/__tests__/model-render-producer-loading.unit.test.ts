import { expect, it, vi } from 'vitest';

const loadShaderProducer = vi.hoisted(() => vi.fn());
vi.mock('@forgeax/engine-vite-plugin-shader', () => {
  loadShaderProducer();
  throw new Error('the shader producer belongs to model render execution');
});

import { createModelRenderTool, createModelReplayTool } from '../tools/model-render.js';

it('declares model commands without loading the shader build producer', () => {
  expect(createModelRenderTool('/explicit/project').descriptor.id).toBe('model.render');
  expect(createModelReplayTool('/explicit/project').descriptor.id).toBe('model.replay');
  expect(loadShaderProducer).not.toHaveBeenCalled();
});
