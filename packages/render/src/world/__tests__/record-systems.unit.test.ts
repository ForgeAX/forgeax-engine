import type { RhiDevice } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM } from '../capture-graph-systems';
import { RENDER_FEATURE_GRAPH_COMPILE_SYSTEM } from '../feature-graph-systems';
import { RENDER_GRAPH_SEAL_SYSTEM } from '../graph-seal-systems';
import { RENDER_GRAPH_COMPILE_SYSTEM } from '../graph-systems';
import {
  closeFrameEncoder,
  RENDER_ENCODER_OPEN_SYSTEM,
  RenderFrameEncoder,
  renderFrameEncoder,
} from '../record-systems';
import { createRenderWorld, RenderRecord, runRenderRecord } from '../render-world';

const device = async (): Promise<RhiDevice> =>
  (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();

describe('RenderRecord', () => {
  it('owns the encoder open and graph compile; RenderQueue holds no encoder system', () => {
    const world = createRenderWorld();
    const schedules = world.scheduleData();
    const record = schedules.find((schedule) => schedule.name === 'RenderRecord');
    expect(record?.systems.map((system) => system.name)).toEqual([
      RENDER_ENCODER_OPEN_SYSTEM,
      RENDER_GRAPH_COMPILE_SYSTEM,
      RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM,
      RENDER_GRAPH_SEAL_SYSTEM,
      'render-capture-graph-encode',
      'render-feature-graph-encode',
      'render-view-graph-encode',
      RENDER_FEATURE_GRAPH_COMPILE_SYSTEM,
      'render-view-record-settle',
      'render-composite-encode',
      'render-surface-ui-encode',
      'render-frame-submit',
      'render-frame-submit-report',
      'render-surface-ui-present-prepare',
    ]);
    expect(record?.dependencies).toContainEqual([
      'render-surface-ui-present-prepare',
      RENDER_ENCODER_OPEN_SYSTEM,
    ]);
    // scheduleData inventories registration; these edges establish execution order.
    expect(record?.dependencies).toContainEqual([
      'render-feature-graph-compile',
      'render-feature-graph-encode',
    ]);
    expect(record?.dependencies).toContainEqual([
      'render-view-graph-encode',
      'render-composite-encode',
    ]);
    expect(record?.dependencies).toContainEqual([
      'render-surface-ui-encode',
      'render-frame-submit',
    ]);
    expect(record?.dependencies).toContainEqual([
      'render-frame-submit',
      'render-view-record-settle',
    ]);
    const queue = schedules.find((schedule) => schedule.name === 'RenderQueue');
    expect(queue?.systems.map((system) => system.name) ?? []).not.toContain(
      RENDER_ENCODER_OPEN_SYSTEM,
    );
  });

  it('opens one labelled frame encoder and closes it once finished', async () => {
    const world = createRenderWorld();
    const rhiDevice = await device();
    const created = vi.spyOn(rhiDevice, 'createCommandEncoder');
    expect(renderFrameEncoder(world)).toEqual({ kind: 'closed' });
    expect(runRenderRecord(world, { device: rhiDevice, frameId: 7 }).ok).toBe(true);
    expect(created).toHaveBeenCalledExactlyOnceWith({ label: 'render-frame' });
    const state = renderFrameEncoder(world);
    expect(state.kind).toBe('open');
    if (state.kind === 'open') expect(state.device).toBe(rhiDevice);
    closeFrameEncoder(world);
    expect(renderFrameEncoder(world)).toEqual({ kind: 'closed' });
  });

  it('keeps the encoder owner label stable across frames for repeated submit errors', async () => {
    const world = createRenderWorld();
    const rhiDevice = await device();
    const created = vi.spyOn(rhiDevice, 'createCommandEncoder');
    for (const frameId of [7, 8]) {
      expect(runRenderRecord(world, { device: rhiDevice, frameId }).ok).toBe(true);
      closeFrameEncoder(world);
    }
    expect(created.mock.calls.map(([descriptor]) => descriptor?.label)).toEqual([
      'render-frame',
      'render-frame',
    ]);
  });

  it.each([
    'result',
    'throw',
  ] as const)('stores a %s encoder failure as closed data without poisoning the World', async (mode) => {
    const world = createRenderWorld();
    const rhiDevice = await device();
    const failure = new RhiError({
      code: 'webgpu-runtime-error',
      expected: 'the device creates a command encoder',
      hint: 'recover the device',
    });
    vi.spyOn(rhiDevice, 'createCommandEncoder').mockImplementation(() => {
      if (mode === 'throw') throw new Error('encoder exploded');
      return err(failure);
    });
    expect(runRenderRecord(world, { device: rhiDevice, frameId: 1 }).ok).toBe(true);
    const state = renderFrameEncoder(world);
    expect(state.kind).toBe('failed');
    if (state.kind !== 'failed') return;
    expect(state.error.code).toBe('device-operation-failed');
    expect(state.error.detail).toMatchObject({
      operation: 'draw',
      cause: { code: mode === 'throw' ? 'command-encoder-unavailable' : 'webgpu-runtime-error' },
    });
    expect(world.run(RenderRecord).ok).toBe(true);
  });

  it('fails as data when RenderRecord runs without its frame input', () => {
    const world = createRenderWorld();
    expect(world.run(RenderRecord).ok).toBe(true);
    expect(world.getResource<{ kind: string }>(RenderFrameEncoder).kind).toBe('failed');
  });
});
