import type { ToolExecutionContext } from '@forgeax/engine-tool-runtime';
import { expect, it, vi } from 'vitest';

const loadShaderProducer = vi.hoisted(() => vi.fn());
const runCapture = vi.hoisted(() => vi.fn());
vi.mock('@forgeax/engine-modeling/tools', async (original) => ({
  ...(await original<typeof import('@forgeax/engine-modeling/tools')>()),
  runCapture,
}));
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

it.each([
  createModelRenderTool,
  createModelReplayTool,
])('retires a cancelled model operation before processing its captured result', async (createTool) => {
  const controller = new AbortController();
  const cancellation = new Error('workspace request retired');
  runCapture.mockImplementationOnce(async () => {
    controller.abort(cancellation);
    return { ok: true, value: {} };
  });
  const execution = createTool(process.cwd()).execute({ source: 'asset.pack.ts' }, {
    signal: controller.signal,
  } as ToolExecutionContext);
  await expect(execution).rejects.toBe(cancellation);
});
