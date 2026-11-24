import { assert } from 'vitest';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { requireSceneProbeReadback } from './gi-scene-probe-readback.fixture';
import type { SceneHarness, SceneImage } from './gi-scenes.fixture';
import { requireConsecutiveVisibleFrame } from './gi-visible-temporal-metrics.fixture';

/** Unmeasured static setup, after the original World-advancing draw and before direct HDR. */
export async function prepareVisibleColdScene(
  h: Pick<SceneHarness, 'submit' | 'save'> & {
    readonly renderer: {
      inspect(): Pick<ReturnType<SceneHarness['renderer']['inspect']>, 'diffuseGi' | 'frame'>;
    };
  },
) {
  const before = h.renderer.inspect();
  const started = performance.now();
  let submissions = 0;
  let readyFrameId: number | undefined;
  let failure: string | undefined;
  const completed: { frameId: number; presentation: string; preparationSignal: boolean }[] = [];
  try {
    assert(before.diffuseGi === undefined, 'Cold setup must not update Field history');
    const receipt = await completeReadyFrame(
      () => {
        submissions++;
        const submitted = h.submit();
        if (!submitted.ok) throw submitted.error;
        return submitted.value;
      },
      {
        timeoutMs: 90_000,
        onCompleted: (receipt) => {
          completed.push({
            frameId: receipt.frameId,
            presentation: receipt.presentation,
            preparationSignal: receipt.preparationCompleted !== undefined,
          });
        },
      },
    );
    assert(receipt.presentation === 'ready' && receipt.frameId > before.frame.frameId);
    assert(h.renderer.inspect().diffuseGi === undefined, 'Cold setup must remain GI-off');
    readyFrameId = receipt.frameId;
    return receipt;
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    h.save('cold-preparation-setup.json', {
      scope: 'Unmeasured cold setup; not cold-start performance or steady-frame acceptance',
      timeoutMs: 90_000,
      wallMs: performance.now() - started,
      submissions,
      completed,
      beforeFrameId: before.frame.frameId,
      readyFrameId,
      failure,
      giBefore: before.diffuseGi,
      giAfter: h.renderer.inspect().diffuseGi,
    });
  }
}

/** Uses only the existing receipt-bound image observation; no tape or additional layer copies. */
export async function collectVisibleTemporalFrames(
  h: SceneHarness,
  options?: { readonly probeState: boolean },
): Promise<SceneImage[]> {
  const frames: SceneImage[] = [];
  const receipts: unknown[] = [];
  const initial = h.renderer.inspect().diffuseGi;
  assert(initial && 'gather' in initial && initial.gather === 'irradiance-field');
  assert(initial.state === 'ready' && initial.submittedFrames > 0);
  const generation = initial.generation;
  let submitted = initial.submittedFrames;
  let previousFrameId: number | undefined;
  for (let frame = 0; frame < 32; frame++) {
    const before = h.renderer.inspect().diffuseGi;
    const image = await h.image(`completed-${String(frame).padStart(2, '0')}`, options);
    const after = h.renderer.inspect().diffuseGi;
    // Persist the actual observation and both producer facts before checking progress.
    const receipt = {
      ordinal: frame,
      frameId: image.frameId,
      before,
      after,
      ...(image.probeState
        ? {
            probeState: {
              metaIdentity: image.probeState.metaIdentity,
              listIdentity: image.probeState.listIdentity,
              count: image.probeState.count,
              capacity: image.probeState.capacity,
              deltaFromOrdinal: frame === 0 ? null : frame - 1,
              meaning:
                'Trace update ordinal/classification, not radiance freshness or all-lit evidence',
            },
          }
        : {}),
    };
    receipts.push(receipt);
    h.save(`completed-${String(frame).padStart(2, '0')}-producer.json`, receipt);
    assert(after && 'gather' in after && after.gather === 'irradiance-field');
    assert(after.state === 'ready' && after.generation === generation);
    assert(
      after.submittedFrames === submitted + 1,
      'Every retained frame requires a new GI submission',
    );
    assert(image.frameId !== undefined);
    requireConsecutiveVisibleFrame(previousFrameId, image.frameId);
    if (options?.probeState) {
      assert(image.probeState, 'Required current probe metadata was not captured');
      requireSceneProbeReadback(frames.at(-1)?.probeState, image.probeState);
    }
    assert(
      image.transport && image.support && image.covered,
      'Same receipt production D/support required',
    );
    assert(image.transport.length === image.width * image.height * 4);
    for (const component of image.rgb) assert(Number.isFinite(component));
    for (const component of image.transport) assert(Number.isFinite(component));
    frames.push(image);
    submitted = after.submittedFrames;
    previousFrameId = image.frameId;
  }
  h.save('completed-receipts.json', { targetFrames: 32, collected: frames.length, receipts });
  return frames;
}
