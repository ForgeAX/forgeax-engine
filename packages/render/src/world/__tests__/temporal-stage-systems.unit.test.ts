import type { World } from '@forgeax/engine-ecs';
import { describe, expect, it, vi } from 'vitest';
import type { RenderSystemInternals } from '../../record/render-context';
import { RENDER_CASCADE_FIT_SYSTEM } from '../light-systems';
import { ViewCascadeFit } from '../render-lights';
import { RenderViewFrameSource, RenderViewInput, ViewRecorder } from '../render-views';
import { beginRenderFrame, createRenderWorld, RenderExtract, RenderPrepare } from '../render-world';
import {
  RENDER_STANDARD_LIGHTING_SYSTEM,
  ViewStandardLighting,
  type ViewStandardLightingOutcome,
} from '../standard-lighting-systems';
import {
  consumeViewStandardOutput,
  RENDER_STANDARD_OUTPUT_STAGE_SYSTEM,
  RENDER_TEMPORAL_STAGE_SYSTEM,
  registerTemporalStageSystems,
  viewTemporalStageOf,
} from '../temporal-systems';
import {
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
  ViewFrame,
  type ViewFrameState,
} from '../view-frame-systems';
import { withInertTemporal } from './temporal-owner-fixture';

const standardOutput = vi.hoisted(() => ({
  prepare: vi.fn(),
  stage: vi.fn(),
}));
vi.mock('../../pipeline/standard-output/resources', () => ({
  commitStandardOutputSubmission: vi.fn(),
  discardStandardOutputStates: vi.fn(),
  retirePendingStandardOutputGpu: vi.fn(),
  prepareStandardOutputResources: standardOutput.prepare,
  stageStandardOutputStates: standardOutput.stage,
}));

const IDENTITY_CAMERA = {
  position: [1, 2, 3],
  world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]),
  fov: Math.PI / 4,
  aspect: 1,
  near: 0.1,
  far: 100,
  projection: 'perspective',
  output: { exposure: { kind: 'auto' } },
};

function setup(
  options: {
    lighting?: ViewStandardLightingOutcome['kind'];
    mode?: boolean | 'capture';
    cameras?: object[];
    stageThrows?: boolean;
  } = {},
) {
  const world = createRenderWorld();
  world.insertResource(
    RenderViewInput,
    new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
  );
  // Stand-ins for the systems the stage systems order after.
  for (const name of [RENDER_CASCADE_FIT_SYSTEM, RENDER_STANDARD_LIGHTING_SYSTEM])
    world.addSystem(RenderPrepare, { name, queries: [], fn: () => undefined }).unwrap();
  registerTemporalStageSystems(world);
  const stage = vi.fn(() => {
    if (options.stageThrows) throw new Error('stage exploded');
  });
  const fire = vi.fn();
  const frameState = {
    frameNumber: 7,
    temporalFrameTransaction: { inspect: () => ({ staged: false }), stage },
  };
  const owner = {
    frameState,
    internals: { canvas: { width: 8, height: 6 }, errorRegistry: { fire } },
  };
  const view = world.spawn().unwrap();
  world
    .addComponent(view, {
      component: ViewRecorder,
      data: {
        state: world.allocUniqueRef('ViewRecorder', withInertTemporal({}, owner)),
      },
    })
    .unwrap();
  world
    .addSystem(RenderExtract, {
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      queries: [],
      fn: (world: World) => {
        stageViewFrame(
          world,
          view,
          { cameraOwner: 0, resourceOwner: 0 } as never,
          options.mode ?? true,
        );
        const staged = world
          .resolveUniqueRef<ViewFrameState>(world.get(view, ViewFrame).unwrap().state)
          .unwrap();
        staged.result = {
          ok: true,
          value: { cameras: options.cameras ?? [IDENTITY_CAMERA] } as never,
        };
        staged.publication = { resources: { time: { delta: 0.016 } } } as never;
        if (world.hasComponent(view, ViewStandardLighting)) return;
        world
          .addComponent(view, {
            component: ViewStandardLighting,
            data: {
              state: world.allocUniqueRef('ViewStandardLighting', {
                frame: 1,
                outcome: { kind: options.lighting ?? 'prepared' },
              }),
            },
          })
          .unwrap();
        world
          .addComponent(view, {
            component: ViewCascadeFit,
            data: { fit: world.allocUniqueRef('ViewCascadeFit', { lights: {} }) },
          })
          .unwrap();
      },
    })
    .unwrap();
  const internals = { renderWorld: world, viewEntity: view } as unknown as RenderSystemInternals;
  const run = (frame: number) => {
    beginRenderFrame(world, frame);
    return { ok: true as const };
  };
  return { world, view, stage, fire, run, internals, frameState };
}

describe('render-temporal-stage system', () => {
  it('registers in RenderPrepare after standard lighting and lists its reads', () => {
    const { world } = setup();
    const prepare = world.scheduleData().find((schedule) => schedule.name === 'RenderPrepare');
    for (const name of [RENDER_TEMPORAL_STAGE_SYSTEM, RENDER_STANDARD_OUTPUT_STAGE_SYSTEM]) {
      const system = prepare?.systems.find((entry) => entry.name === name);
      expect(system?.queries[0]?.read).toEqual(['ViewRecorder', 'ViewFrame']);
      expect(prepare?.dependencies).toContainEqual([RENDER_STANDARD_LIGHTING_SYSTEM, name]);
    }
  });

  it('stages the display view frame transaction with its view projection', () => {
    const { view, world, stage, run } = setup();
    expect(run(1).ok).toBe(true);
    expect(stage).toHaveBeenCalledTimes(1);
    const input = (stage.mock.calls[0] as unknown[])[0] as {
      frameId: number;
      viewport: object;
      cameraPosition: number[];
      currentViewProjection: Float32Array;
    };
    expect(input.frameId).toBe(7);
    expect(input.viewport).toEqual({ width: 8, height: 6 });
    expect(input.cameraPosition).toEqual([1, 2, 3]);
    expect(input.currentViewProjection).toHaveLength(16);
    expect(viewTemporalStageOf(world, view)).toEqual({
      kind: 'staged',
      frameId: 7,
      currentViewProjection: input.currentViewProjection,
    });
    const outcome = viewTemporalStageOf(world, view);
    expect(outcome?.kind === 'staged' && outcome.currentViewProjection).toBe(
      input.currentViewProjection,
    );
  });

  it.each([
    ['a capture-only view', { mode: 'capture' as const }],
    ['a view whose lighting was not admitted', { lighting: 'not-admitted' as const }],
  ])('%s stages no temporal candidate', (_name, options) => {
    const { stage, run } = setup(options);
    run(1);
    expect(stage).not.toHaveBeenCalled();
  });

  it('records the zero camera fallback when the view has no camera', () => {
    const { stage, run } = setup({ cameras: [] });
    run(1);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it('stores a stage failure as data, reports it and never throws', () => {
    const { world, view, fire, run } = setup({ stageThrows: true });
    expect(run(1).ok).toBe(true);
    expect(viewTemporalStageOf(world, view)).toMatchObject({ kind: 'failed' });
    expect(fire).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { error: expect.objectContaining({ code: 'temporal-stage-failed' }) },
      }),
    );
  });

  it('is frame-stamped: a later frame without the system run has no stage', () => {
    const { world, view, run } = setup();
    run(1);
    beginRenderFrame(world, 2);
    expect(viewTemporalStageOf(world, view)).toBeUndefined();
  });

  it('stages nothing once the system is removed', () => {
    const { world, view, stage, run } = setup();
    expect(world.removeSystem(RenderPrepare, RENDER_TEMPORAL_STAGE_SYSTEM).ok).toBe(true);
    run(1);
    expect(stage).not.toHaveBeenCalled();
    expect(viewTemporalStageOf(world, view)).toBeUndefined();
  });
});

describe('render-standard-output-stage system', () => {
  it('prepares the output resources then stages the live candidates before recording', () => {
    standardOutput.prepare.mockReset().mockReturnValue({ ok: true, value: undefined });
    standardOutput.stage.mockReset();
    const { run, internals } = setup();
    run(1);
    expect(standardOutput.prepare).toHaveBeenCalledTimes(1);
    expect(standardOutput.stage).toHaveBeenCalledTimes(1);
    expect(standardOutput.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      standardOutput.stage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(consumeViewStandardOutput(internals)).toEqual({ kind: 'staged' });
  });

  it('hands a rejected preparation to the recording as data without staging', () => {
    const error = { code: 'webgpu-runtime-error' };
    standardOutput.prepare.mockReset().mockReturnValue({ ok: false, error });
    standardOutput.stage.mockReset();
    const { run, internals } = setup();
    expect(run(1).ok).toBe(true);
    expect(standardOutput.stage).not.toHaveBeenCalled();
    expect(consumeViewStandardOutput(internals)).toEqual({ kind: 'rejected', error });
  });

  it('rethrows an unexpected cause inside the recording, not in the system', () => {
    standardOutput.prepare.mockReset().mockImplementation(() => {
      throw new Error('prepare exploded');
    });
    const { run, internals } = setup();
    expect(run(1).ok).toBe(true);
    expect(() => consumeViewStandardOutput(internals)).toThrow('prepare exploded');
  });

  it('fails the recording naming the system once it is removed', () => {
    const { world, run, internals } = setup();
    expect(world.removeSystem(RenderPrepare, RENDER_STANDARD_OUTPUT_STAGE_SYSTEM).ok).toBe(true);
    run(1);
    expect(() => consumeViewStandardOutput(internals)).toThrow(RENDER_STANDARD_OUTPUT_STAGE_SYSTEM);
  });
});
