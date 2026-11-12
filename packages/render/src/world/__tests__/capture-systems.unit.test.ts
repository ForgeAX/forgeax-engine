import type { EntityHandle } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { createRendererCaptureOwner } from '../../capture/renderer-captures';
import type { CubeCaptureWork } from '../../capture/scheduler';
import { createRenderFeatureHost } from '../../features/host';
import type { CubeCameraSnapshot, RendererError } from '../../render-contract';
import type { RenderTarget } from '../../targets/contracts';
import {
  CUBE_CAPTURE_COMMIT_SYSTEM,
  RENDER_CAPTURE_SCHEDULE_SYSTEM,
  RENDER_VIEW_CAPTURE_COMMIT_SYSTEM,
  recordsViewWork,
  registerCaptureSystems,
  registerViewCaptureSystems,
  type ViewCaptureFrame,
  viewCaptureWorkOf,
} from '../capture-systems';
import { RENDER_DISPLAY_COMMIT_SYSTEM } from '../display-submission-systems';
import { ViewFeatureInput, type ViewFeatureInputState } from '../feature-systems';
import { beginFrameSubmission, frameSubmitOutcome } from '../frame-submit-systems';
import { RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM } from '../graph-submission-systems';
import { RENDER_GRAPH_SETTLE_SYSTEM } from '../graph-systems';
import { RENDER_POST_COMMIT_SYSTEM } from '../post-systems';
import { RenderViewInput, ViewRecorder } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
  RenderCommit,
  RenderPrepare,
  renderSubmission,
} from '../render-world';
import { RENDER_RECORD_COMMIT_SYSTEM } from '../submission-systems';
import { RENDER_TEMPORAL_COMMIT_SYSTEMS } from '../temporal-systems';
import { ViewFrame, type ViewFrameState, type ViewRecordMode } from '../view-frame-systems';
import { RENDER_SETTLEMENT_COMMIT_SYSTEMS } from '../view-settlement';
import { withInertTemporal } from './temporal-owner-fixture';

const camera: CubeCameraSnapshot = {
  entityKey: 1,
  target: {} as RenderTarget,
  position: [0, 0, 0],
  near: 0.1,
  far: 10,
  updateIntent: 'on-demand',
  requestVersion: 1,
  faceBudget: 1,
};

function setup() {
  const world = createRenderWorld();
  const owner = createRendererCaptureOwner((target) => target);
  const errors: RendererError[] = [];
  registerCaptureSystems(world, owner, (error) => errors.push(error));
  /** One Renderer frame: record the next face, publish the submission outcome, commit. */
  const frame = (frameNumber: number, accepted: boolean): string | undefined => {
    beginRenderFrame(world, frameNumber);
    const face = owner.prepare([camera])[0]?.face;
    renderSubmission(world).accepted = accepted;
    endRenderFrame(world);
    return face;
  };
  return { world, owner, errors, frame };
}

describe('cube capture commit system', () => {
  it('advances faces only for accepted submissions', () => {
    const { owner, errors, frame } = setup();
    expect(frame(1, true)).toBe('+X');
    expect(frame(2, false)).toBe('-X');
    // The rejected frame aborted the candidate; its face is recorded again.
    expect(frame(3, true)).toBe('+X');
    const faces = [frame(4, true), frame(5, true), frame(6, true), frame(7, true), frame(8, true)];
    expect(faces).toEqual(['-X', '+Y', '-Y', '+Z', '-Z']);
    expect(owner.isPending(camera.target)).toBe(false);
    expect(errors).toEqual([]);
  });

  it.each([
    false,
    true,
  ])('commits a cube face only for a rendered picture, pending=%s', (pending) => {
    const { world, owner } = setup();
    beginRenderFrame(world, 1);
    beginFrameSubmission(world);
    expect(owner.prepare([camera])[0]?.face).toBe('+X');
    frameSubmitOutcome(world).captureReady = !pending;
    renderSubmission(world).accepted = true;
    endRenderFrame(world);
    beginRenderFrame(world, 2);
    expect(owner.prepare([camera])[0]?.face).toBe(pending ? '+X' : '-X');
    endRenderFrame(world);
  });

  it('settles the recorded face at the submission GPU completion', async () => {
    const { world, owner } = setup();
    let complete!: () => void;
    const completion = new Promise<void>((resolve) => {
      complete = resolve;
    });
    beginRenderFrame(world, 1);
    expect(owner.prepare([camera])[0]?.face).toBe('+X');
    Object.assign(renderSubmission(world), { accepted: true, completion });
    endRenderFrame(world);
    // A submitted, uncompleted face yields no new work.
    expect(owner.prepare([camera])).toEqual([]);
    complete();
    await completion;
    expect(owner.prepare([camera])[0]?.face).toBe('-X');
  });

  it('never advances the capture once the commit system is removed', () => {
    const { world, frame } = setup();
    world.removeSystem(RenderCommit, CUBE_CAPTURE_COMMIT_SYSTEM).unwrap();
    expect(frame(1, true)).toBe('+X');
    // Without the commit the face stays in flight and is re-recorded.
    expect(frame(2, true)).toBe('+X');
  });

  it('declares the commit system in RenderCommit', () => {
    const { world } = setup();
    const commit = world.scheduleData().find((data) => data.name === 'RenderCommit');
    expect(commit?.systems.map((system) => system.name)).toEqual([
      RENDER_RECORD_COMMIT_SYSTEM,
      RENDER_POST_COMMIT_SYSTEM,
      ...RENDER_TEMPORAL_COMMIT_SYSTEMS,
      ...RENDER_SETTLEMENT_COMMIT_SYSTEMS,
      RENDER_GRAPH_SETTLE_SYSTEM,
      RENDER_GRAPH_SUBMISSION_COMMIT_SYSTEM,
      RENDER_DISPLAY_COMMIT_SYSTEM,
      CUBE_CAPTURE_COMMIT_SYSTEM,
    ]);
  });
});

const cubeWork = { face: '+X' } as unknown as CubeCaptureWork;

interface ViewSpec {
  readonly name: string;
  readonly mode: ViewRecordMode;
  /** The Renderer's capture schedule throws when this view owns the shared recorder's frame. */
  readonly fail?: boolean;
}

/** An owner-only view recorder: the capture systems read its owner bag, never a RenderSystem. */
function ownedRecorder({ name, fail }: ViewSpec, calls: string[]) {
  const settle = (accepted: boolean) => calls.push(`commit:${name}:${accepted}`);
  return withInertTemporal(
    {},
    {
      internals: {
        rendererCaptureOwner: {
          prepare: () => {
            calls.push(`schedule:${name}`);
            if (fail === true) throw new Error('schedule failure');
            return [cubeWork];
          },
        },
        featureSceneInputs: undefined,
        getRenderTargetPhysical: undefined,
      },
      captures: {
        work: [],
        planar: { prepare: () => void calls.push(`prepare:${name}`), settle },
      },
      frameState: { frameNumber: 1 },
    },
  );
}

function viewSetup(views: readonly ViewSpec[]) {
  const host = createRenderFeatureHost([]).unwrap();
  const world = host.world;
  world.insertResource(RenderViewInput, { worlds: [], leases: undefined });
  registerViewCaptureSystems(world);
  // The owner-only recorders carry the capture side alone; RenderCommit runs the capture commit alone.
  const commitSystems = world.scheduleData().find((data) => data.name === 'RenderCommit');
  for (const { name } of commitSystems?.systems ?? [])
    if (name !== RENDER_VIEW_CAPTURE_COMMIT_SYSTEM) world.removeSystem(RenderCommit, name).unwrap();
  const calls: string[] = [];
  const frames: ViewFrameState[] = [];
  const inputs: ViewFeatureInputState[] = [];
  const entities: EntityHandle[] = views.map((spec) => {
    const { name, mode } = spec;
    const frame = {
      frame: 0,
      mode,
      opts: { cameraOwner: 0, resourceOwner: 0 },
      result: { ok: true, value: { cubeCameras: [], cameras: [], auxiliaryCameras: [] } },
    } as unknown as ViewFrameState;
    const input: ViewFeatureInputState = {
      frame: 0,
      outcome: {
        kind: 'prepared',
        value: {
          input: {
            identity: name,
            render: mode === true,
            worlds: [],
            owner: 0,
            frameNumber: 0,
            caps: {} as never,
          },
          skylight: undefined,
        },
      },
      motionBlur: undefined,
    };
    frames.push(frame);
    inputs.push(input);
    return world
      .spawn(
        {
          component: ViewRecorder,
          data: { state: world.allocUniqueRef('ViewRecorder', ownedRecorder(spec, calls)) },
        },
        { component: ViewFrame, data: { state: world.allocUniqueRef('ViewFrame', frame) } },
        {
          component: ViewFeatureInput,
          data: { state: world.allocUniqueRef('ViewFeatureInput', input) },
        },
      )
      .unwrap();
  });
  /** One Renderer frame: every view staged, RenderPrepare, then the submission outcome. */
  const prepare = (frameNumber: number) => {
    for (const state of [...frames, ...inputs]) state.frame = frameNumber;
    beginRenderFrame(world, frameNumber);
  };
  const commit = (accepted: boolean) => {
    publishRenderSubmission(world, {
      accepted,
      completion: undefined,
      creditCompletion: undefined,
      generation: renderSubmission(world).generation,
    });
    const ran = world.run(RenderCommit);
    if (!ran.ok) throw ran.error;
  };
  return { world, calls, entities, prepare, commit, host };
}

describe('view capture systems', () => {
  it('schedules the shared captures once and routes them to the display recorder', () => {
    const f = viewSetup([
      { name: 'held', mode: false },
      { name: 'display', mode: true },
    ]);
    f.prepare(1);
    // Only the first shared view schedules; the display view, a recorder with picture, selects its planar mirror.
    expect(f.calls).toEqual(['schedule:held', 'prepare:display']);
    const held = viewCaptureWorkOf(f.world, f.entities[0]);
    expect(held?.kind === 'prepared' && held.value.cube).toEqual([]);
    const display = viewCaptureWorkOf(f.world, f.entities[1]);
    expect(display?.kind === 'prepared' && display.value.cube).toEqual([cubeWork]);
    expect(display?.kind === 'prepared' && display.value.faces).toEqual([]);
    f.commit(true);
    expect(f.calls.slice(2)).toEqual(['commit:held:true', 'commit:display:true']);
    f.host.dispose();
  });

  it('routes the shared captures to the exclusive capture view first', () => {
    const f = viewSetup([
      { name: 'display', mode: true },
      { name: 'capture', mode: 'capture' },
    ]);
    f.prepare(1);
    expect(f.calls).toEqual(['schedule:display', 'prepare:display', 'prepare:capture']);
    const capture = viewCaptureWorkOf(f.world, f.entities[1]);
    expect(capture?.kind === 'prepared' && capture.value.cube).toEqual([cubeWork]);
    f.host.dispose();
  });

  it('hands a schedule failure to the recorder view without throwing', () => {
    const f = viewSetup([{ name: 'display', mode: true, fail: true }]);
    expect(() => f.prepare(1)).not.toThrow();
    const outcome = viewCaptureWorkOf(f.world, f.entities[0]);
    expect(outcome?.kind).toBe('failed');
    expect(f.calls).toEqual(['schedule:display']);
    f.commit(false);
    // The failed view's planar selection still settles, as a rejected frame.
    expect(f.calls).toEqual(['schedule:display', 'commit:display:false']);
    f.host.dispose();
  });

  it('settles only the views prepared in the current frame', () => {
    const f = viewSetup([{ name: 'display', mode: true }]);
    f.prepare(1);
    f.commit(false);
    beginRenderFrame(f.world, 2);
    f.commit(true);
    expect(f.calls).toEqual(['schedule:display', 'prepare:display', 'commit:display:false']);
    f.host.dispose();
  });

  it('leaves the recording no capture work once the schedule system is removed', () => {
    const f = viewSetup([{ name: 'display', mode: true }]);
    f.world.removeSystem(RenderPrepare, RENDER_CAPTURE_SCHEDULE_SYSTEM).unwrap();
    f.prepare(1);
    // Recording reads the component only: no scheduler run, no capture work, no commit.
    expect(viewCaptureWorkOf(f.world, f.entities[0])).toBeUndefined();
    f.commit(true);
    expect(f.calls).toEqual([]);
    f.host.dispose();
  });
});

describe('recording admission before Queue', () => {
  it.each([
    true,
    false,
    'capture',
  ] as const)('admits %s only for display or actual capture work', (mode) => {
    const empty = { cube: [], sceneInputs: [], auxiliaryCameras: [] };
    expect(recordsViewWork(mode, empty)).toBe(mode === true);
    expect(recordsViewWork(mode, { ...empty, cube: [{} as CubeCaptureWork] })).toBe(true);
    expect(
      recordsViewWork(mode, {
        ...empty,
        sceneInputs: [{} as ViewCaptureFrame['sceneInputs'][number]],
      }),
    ).toBe(true);
    expect(
      recordsViewWork(mode, {
        ...empty,
        auxiliaryCameras: [{} as ViewCaptureFrame['auxiliaryCameras'][number]],
      }),
    ).toBe(true);
  });
});
