import { createProfiler, type Profiler } from '@forgeax/engine-profiler';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { registeredSystem } from '../../__tests__/registered-system.fixture';
import type { RenderSystemInternals } from '../../record/render-context';

import {
  captureGraphOutcome,
  captureGraphPassPhaseManifest,
  markCaptureGraphsEncoded,
  stageCaptureGraphCompile,
  ViewCaptureGraphs,
} from '../capture-graph-systems';
import { ViewRecorder } from '../render-views';
import {
  createRenderWorld,
  endRenderFrame,
  publishRenderSubmission,
  RenderRecord,
  renderSubmission,
  runRenderRecord,
} from '../render-world';
import { withInertTemporal } from './temporal-owner-fixture';

async function fixture(profiler?: Profiler) {
  const world = createRenderWorld();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  Object.assign(renderSubmission(world), { frame: 1, open: true });
  const internals = { device, renderWorld: world, profiler } as unknown as RenderSystemInternals;
  const deviceScope = { generation: 0 };
  const viewContext = { root: internals, camera: 11, deviceScope };
  Object.assign(internals, { viewContext });
  const view = world
    .spawn({
      component: ViewRecorder,
      data: { state: world.allocUniqueRef('ViewRecorder', withInertTemporal({}, { internals })) },
    })
    .unwrap();
  internals.viewEntity = view;
  expect(stageCaptureGraphCompile(internals)).toBe(true);
  const record = () => runRenderRecord(world, { device, frameId: 1 });
  return { world, device, internals, view, viewContext, deviceScope, record };
}

it('has no fallback compilation if the capture compiler is removed', async () => {
  const f = await fixture();
  f.world
    .removeSystem(
      RenderRecord,
      registeredSystem(f.world, RenderRecord, 'render-capture-graph-compile'),
    )
    .unwrap();
  expect(f.record().ok).toBe(true);
  expect(captureGraphOutcome(f.internals)).toMatchObject({
    ok: false,
    error: { code: 'graph-build-failed', detail: { cause: { code: 'capture-graph-unavailable' } } },
  });
  endRenderFrame(f.world);
  expect(f.world.execution.health).toBe('healthy');
});

it('stores missing component inputs as failure data without poisoning the World', async () => {
  const f = await fixture();
  const identityCapture = { entries: [], complete: true, instrumentationAccepted: false };
  f.internals.renderPassCpuIdentityCapture = identityCapture;
  expect(f.record().ok).toBe(true);
  expect(identityCapture.complete).toBe(false);
  const outcome = captureGraphOutcome(f.internals);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok)
    expect(outcome.error.detail.cause.detail).toMatchObject({ system: 'render-standard-lighting' });
  endRenderFrame(f.world);
  expect(f.world.execution.health).toBe('healthy');
});

it.each([
  false,
  true,
])('retirement uses actual encoding and physical completion: encoded=%s', async (encoded) => {
  const f = await fixture();
  const retired = vi.fn();
  const batch = { cube: [{ recording: { retire: retired } }], probes: [] };
  const state = f.world
    .resolveUniqueRef<{
      outcome: unknown;
    }>(f.world.get(f.view, ViewCaptureGraphs).unwrap().state)
    .unwrap();
  // Model a compiler product, then exercise the real Cleanup retirement owner.
  state.outcome = { ok: true, value: batch };
  if (encoded) markCaptureGraphsEncoded(f.internals);
  let complete: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  publishRenderSubmission(f.world, {
    accepted: true,
    generation: 0,
    completion,
    creditCompletion: completion,
  });
  endRenderFrame(f.world);
  expect(retired).toHaveBeenCalledTimes(encoded ? 0 : 1);
  complete?.();
  await Promise.resolve();
  expect(retired).toHaveBeenCalledTimes(1);
});

it('retains a frozen successful pass vocabulary only while its producer is unchanged', async () => {
  const f = await fixture(createProfiler());
  const state = f.world
    .resolveUniqueRef<{
      outcome: unknown;
      phaseManifest:
        | { producer: object; passes: readonly { name: string; kind: string }[] }
        | undefined;
    }>(f.world.get(f.view, ViewCaptureGraphs).unwrap().state)
    .unwrap();
  state.outcome = {
    ok: true,
    value: {
      cube: [
        {
          recording: {
            inspect: () => ({
              passes: [
                { name: 'capture-face.4', kind: 'raster', executionIndex: 0 },
                { name: 'capture-mip.2', kind: 'copy', executionIndex: 1 },
              ],
            }),
            retire: vi.fn(),
          },
        },
      ],
      probes: [],
    },
  };

  endRenderFrame(f.world);

  expect(captureGraphPassPhaseManifest(f.internals)?.passes).toEqual([
    { name: 'capture-face.4', kind: 'raster' },
    { name: 'capture-mip.2', kind: 'copy' },
  ]);
  expect(Object.isFrozen(state.phaseManifest)).toBe(true);
  expect(Object.isFrozen(state.phaseManifest?.producer)).toBe(true);
  expect(Object.isFrozen(state.phaseManifest?.passes)).toBe(true);

  // A failed next batch keeps the previous immutable vocabulary for the same
  // device/view producer, but that retained list is not a per-frame roster.
  renderSubmission(f.world).frame = 2;
  renderSubmission(f.world).open = true;
  expect(stageCaptureGraphCompile(f.internals)).toBe(true);
  state.outcome = { ok: false };
  endRenderFrame(f.world);
  expect(captureGraphPassPhaseManifest(f.internals)?.passes).toHaveLength(2);

  // A no-face/no-probe compile is a normal empty batch, not a new vocabulary.
  renderSubmission(f.world).frame = 3;
  renderSubmission(f.world).open = true;
  expect(stageCaptureGraphCompile(f.internals)).toBe(true);
  state.outcome = { ok: true, value: { cube: [], probes: [] } };
  endRenderFrame(f.world);
  expect(captureGraphPassPhaseManifest(f.internals)?.passes).toEqual([
    { name: 'capture-face.4', kind: 'raster' },
    { name: 'capture-mip.2', kind: 'copy' },
  ]);
});

it('does not retain capture declarations without a configured Profiler', async () => {
  const f = await fixture();
  const state = f.world
    .resolveUniqueRef<{ outcome: unknown }>(f.world.get(f.view, ViewCaptureGraphs).unwrap().state)
    .unwrap();
  state.outcome = {
    ok: true,
    value: {
      cube: [
        {
          recording: {
            inspect: () => ({ passes: [{ name: 'capture-face.4', kind: 'raster' }] }),
            retire: vi.fn(),
          },
        },
      ],
      probes: [],
    },
  };

  endRenderFrame(f.world);

  expect(captureGraphPassPhaseManifest(f.internals)).toBeUndefined();
});

it('drops retained capture vocabulary when the device or view identity changes', async () => {
  const f = await fixture(createProfiler());
  const state = f.world
    .resolveUniqueRef<{
      outcome: unknown;
      phaseManifest: unknown;
    }>(f.world.get(f.view, ViewCaptureGraphs).unwrap().state)
    .unwrap();
  state.outcome = {
    ok: true,
    value: {
      cube: [
        {
          recording: {
            inspect: () => ({ passes: [{ name: 'capture-face.4', kind: 'raster' }] }),
            retire: vi.fn(),
          },
        },
      ],
      probes: [],
    },
  };
  endRenderFrame(f.world);
  expect(captureGraphPassPhaseManifest(f.internals)?.passes).toHaveLength(1);

  Object.assign(f.internals, { viewOwner: {} });
  expect(captureGraphPassPhaseManifest(f.internals)).toBeUndefined();
  f.deviceScope.generation += 1;
  expect(captureGraphPassPhaseManifest(f.internals)).toBeUndefined();
  renderSubmission(f.world).frame = 2;
  renderSubmission(f.world).open = true;
  expect(stageCaptureGraphCompile(f.internals)).toBe(true);
  expect(state.phaseManifest).toBeUndefined();
  state.outcome = {
    ok: true,
    value: {
      cube: [
        {
          recording: {
            inspect: () => ({ passes: [{ name: 'capture-face.5', kind: 'raster' }] }),
            retire: vi.fn(),
          },
        },
      ],
      probes: [],
    },
  };
  endRenderFrame(f.world);
  expect(captureGraphPassPhaseManifest(f.internals)?.passes).toHaveLength(1);

  f.viewContext.camera += 1;
  expect(captureGraphPassPhaseManifest(f.internals)).toBeUndefined();
  renderSubmission(f.world).frame = 3;
  renderSubmission(f.world).open = true;
  expect(stageCaptureGraphCompile(f.internals)).toBe(true);
  expect(state.phaseManifest).toBeUndefined();
  endRenderFrame(f.world);
});
