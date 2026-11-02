import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import type { RenderSystemInternals } from '../../record/render-context';
import {
  captureGraphOutcome,
  markCaptureGraphsEncoded,
  RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM,
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

async function fixture() {
  const world = createRenderWorld();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  Object.assign(renderSubmission(world), { frame: 1, open: true });
  const internals = { device, renderWorld: world } as unknown as RenderSystemInternals;
  const view = world
    .spawn({
      component: ViewRecorder,
      data: { state: world.allocUniqueRef('ViewRecorder', withInertTemporal({}, { internals })) },
    })
    .unwrap();
  internals.viewEntity = view;
  expect(stageCaptureGraphCompile(internals)).toBe(true);
  const record = () => runRenderRecord(world, { device, frameId: 1 });
  return { world, device, internals, view, record };
}

it('has no fallback compilation if the capture compiler is removed', async () => {
  const f = await fixture();
  f.world.removeSystem(RenderRecord, RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM).unwrap();
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
  expect(f.record().ok).toBe(true);
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
  const batch = { cube: [{ graph: { retire: retired } }], probes: [] };
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
