import { describe, expect, it } from 'vitest';
import { TransmissionCapabilityMissingError } from '../../errors/render';
import type { ExtractedFrame } from '../../render-system-extract';
import { RenderViewFrameSource, RenderViewInput, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
} from '../render-world';
import {
  consumeViewTransmission,
  registerTransmissionSystem,
  VIEW_TRANSMISSION_ADMIT_SYSTEM,
  viewTransmissionInspection,
} from '../transmission-systems';
import { RENDER_VIEW_RECORDERS_SYSTEM, stageViewFrame } from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const opts = { cameraOwner: 0, resourceOwner: 0 } as const;

function setup({ activeCount = 0, renderable = true, register = true } = {}) {
  const world = createRenderWorld();
  world.insertResource(
    RenderViewInput,
    new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
  );
  if (register) registerTransmissionSystem(world);
  const fired: unknown[] = [];
  const recorder = {
    prepareViewFrame: () => ({
      ok: true as const,
      value: { renderables: [], cameras: [{ antialias: 'none' }] } as unknown as ExtractedFrame,
    }),
  };
  registerViewFrameStub(world, recorder.prepareViewFrame);
  const internals = {
    canvas: { width: 8, height: 8 },
    device: { caps: { rgba16floatRenderable: renderable } },
    deviceScope: { generation: 1 },
    errorRegistry: { fire: (error: unknown) => fired.push(error) },
  };
  const scene = { transmissionTopologyDemand: () => ({ activeCount, needsRoughMips: false }) };
  const view = world.spawn().unwrap();
  const state = world.allocUniqueRef('ViewRecorder', withInertTemporal({}, { internals, scene }));
  world.addComponent(view, { component: ViewRecorder, data: { state } }).unwrap();
  world
    .addSystem(RenderExtract, {
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      queries: [],
      fn: (world) => stageViewFrame(world, view, opts),
    })
    .unwrap();
  return { world, view, fired };
}

describe('render-transmission-admit', () => {
  it('admits a view without transmission demand', () => {
    const { world, view, fired } = setup();
    beginRenderFrame(world, 1);
    expect(consumeViewTransmission(world, view)).toBe('admitted');
    expect(viewTransmissionInspection(world, view)).toBeUndefined();
    expect(fired).toEqual([]);
    endRenderFrame(world);
  });

  it('rejects demand the device cannot back and fires the structured error once per frame', () => {
    const { world, view, fired } = setup({ activeCount: 2, renderable: false });
    beginRenderFrame(world, 1);
    expect(consumeViewTransmission(world, view)).toBe('capability-missing');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeInstanceOf(TransmissionCapabilityMissingError);
    endRenderFrame(world);
  });

  it('falsifier: without the system the recording has no admission to take', () => {
    const { world, view } = setup({ register: false });
    beginRenderFrame(world, 1);
    expect(() => consumeViewTransmission(world, view)).toThrow(VIEW_TRANSMISSION_ADMIT_SYSTEM);
    endRenderFrame(world);
  });

  it('declares RenderPrepare ordering after the view frame', () => {
    const { world } = setup();
    const prepare = world
      .scheduleData()
      .find((schedule) => schedule.name === 'RenderPrepare')
      ?.systems.find((system) => system.name === VIEW_TRANSMISSION_ADMIT_SYSTEM);
    expect(prepare?.after).toEqual(['render-view-frame']);
  });
});
