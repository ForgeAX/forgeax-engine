// audio-webaudio.browser.test.ts — M5 browser tests for real Web Audio behavior
//
// Covers:
//   - w20 (AC-05): natural onended self-cleanup for non-loop sources
//   - w21 (AC-08/AC-15): long-session sources bounded after repeated serial SFX
//   - w22 (AC-16): repeated backend create/destroy, AudioContext count non-monotonic
//
// Anchors:
//   - requirements AC-05 (F24 natural onended self-cleanup)
//   - requirements AC-08 (F24 long-session bounded) + AC-15 (total criterion 1)
//   - requirements AC-16 (total criterion 2: AudioContext non-monotonic)
//   - plan-strategy §5.2 (browser test tier, real Web Audio; mock cannot trigger
//     natural onended — Finding 7)
//   - research Finding 7 (no existing audio browser test)
//   - plan-decisions leftovers (file must match **/*.browser.test.ts —
//     vitest.config.ts:141 browser project include glob)
//
// Testing approach:
//   - Real WebAudioEngine instances (no mocks) in browser playwright chromium.
//   - Autoplay policy: AudioContext starts suspended; dispatch a synthetic
//     click event to trigger the engine's one-shot gesture-resume listener,
//     then wait for contextState to transition to 'running'.
//   - Short silent AudioBuffers played via engine.play() with opts.loop=false.
//   - Poll engine.getActiveSourceCount() to observe onended-driven source cleanup.
//   - engine.destroy() calls ctx.close() — verify via engine.getState().contextState.
//
// charter awareness:
//   - P3 explicit failure: assertions are concrete numeric (getActiveSourceCount() === 0,
//     contextState === 'closed'), not silent or assume-based.
//   - F2 image-untrustworthy: no pixel or visual assertions; purely numeric.
//   - P5 producer/consumer split: this file is consumed by vitest browser runner
//     which reports pass/fail to the orchestrator — no self-reported image claims.

import { afterEach, describe, expect, it } from 'vitest';
import { WebAudioEngine } from '../web-audio-engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a short silent mono AudioBuffer using a temporary AudioContext.
 * The returned buffer is context-independent (Web Audio spec: AudioBuffer
 * is not tied to a specific BaseAudioContext) and can be passed to
 * any WebAudioEngine.play().
 */
function createShortSilentBuffer(durationSec: number): AudioBuffer {
  const tmpCtx = new AudioContext();
  const sampleRate = tmpCtx.sampleRate;
  const length = Math.max(1, Math.ceil(sampleRate * durationSec));
  const buffer = tmpCtx.createBuffer(1, length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    channel[i] = 1e-6;
  }
  void tmpCtx.close();
  return buffer;
}

/**
 * Resume a WebAudioEngine's AudioContext via the one-shot gesture listener.
 *
 * The engine lazily creates its AudioContext on first play()/listener access
 * and registers click/keydown/touchstart listeners to call ctx.resume()
 * when the context is in 'suspended' state (autoplay policy gate).
 *
 * This helper triggers the gesture path in the test environment by:
 *   1. Accessing engine.listener to force context creation.
 *   2. Dispatching a synthetic 'click' event, which the engine's one-shot
 *      gesture listener picks up and calls ctx.resume().
 *   3. Polling getState().contextState until 'running'.
 */
async function resumeEngineContext(engine: WebAudioEngine, timeoutMs: number): Promise<void> {
  // Force lazy AudioContext creation via the listener getter.
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  engine.listener;

  // Dispatch a synthetic click to trigger the engine's one-shot gesture-resume
  // listener (registered in ensureContext when ctx.state === 'suspended').
  document.dispatchEvent(new Event('click'));

  // Poll until the context is running.
  const start = Date.now();
  while (true) {
    if (engine.getState().contextState === 'running') return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout after ${timeoutMs}ms: expected contextState === 'running', got ${engine.getState().contextState}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Poll engine.getActiveSourceCount() until it reaches `target` or times out.
 */
async function waitForSourceCount(
  engine: WebAudioEngine,
  target: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (true) {
    if (engine.getActiveSourceCount() === target) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timeout after ${timeoutMs}ms: expected getActiveSourceCount() === ${target}, got ${engine.getActiveSourceCount()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// w20 — AC-05: natural onended self-cleanup for non-loop sources
// ---------------------------------------------------------------------------

describe('M5 browser — F24 natural onended self-cleanup (AC-05)', () => {
  let engine: WebAudioEngine;

  afterEach(() => {
    engine.destroy();
  });

  it('non-loop play triggers onended -> source removed from sources Map [w20]', async () => {
    engine = new WebAudioEngine();
    await resumeEngineContext(engine, 5000);

    const buffer = createShortSilentBuffer(0.1);

    engine.play(1, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

    expect(engine.getActiveSourceCount()).toBe(1);

    // Wait for onended to fire naturally (the clip is 0.1s, generous timeout).
    await waitForSourceCount(engine, 0, 5000);

    expect(engine.getActiveSourceCount()).toBe(0);
  });

  it('loop source does NOT self-remove on natural end (AC-06 cross-check) [w20]', async () => {
    engine = new WebAudioEngine();
    await resumeEngineContext(engine, 5000);

    const buffer = createShortSilentBuffer(0.05);

    engine.play(2, buffer, { loop: true, volume: 1, spatialBlend: 0, bus: 'sfx' });

    // After a short wait, the loop source must still be tracked
    // (looping sources never fire onended and thus never self-clean).
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(engine.getActiveSourceCount()).toBe(1);

    engine.stop(2);
    expect(engine.getActiveSourceCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// w21 — AC-08/AC-15: long-session sources bounded (total criterion 1)
// ---------------------------------------------------------------------------

describe('M5 browser — long-session sources bounded (AC-08/AC-15)', () => {
  let engine: WebAudioEngine;

  afterEach(() => {
    engine.destroy();
  });

  it('N serial non-loop SFX plays -> sources.size returns to 0 after all finish [w21]', async () => {
    engine = new WebAudioEngine();
    await resumeEngineContext(engine, 5000);

    const buffer = createShortSilentBuffer(0.05);
    const N = 10;

    for (let i = 0; i < N; i++) {
      engine.play(i + 10, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      // Wait for this clip to finish (onended -> self-cleanup) before next.
      await waitForSourceCount(engine, 0, 5000);
    }

    // After all N clips have played and onended has cleaned each one,
    // sources.size must return to 0 -- it must NOT grow monotonically with N.
    expect(engine.getActiveSourceCount()).toBe(0);
  });

  it('serial non-loop SFX bounds sources at <= 1 per iteration [w21]', async () => {
    engine = new WebAudioEngine();
    await resumeEngineContext(engine, 5000);

    const buffer = createShortSilentBuffer(0.03);
    const N = 20;

    for (let i = 0; i < N; i++) {
      engine.play(i + 30, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      expect(engine.getActiveSourceCount()).toBe(1);

      await waitForSourceCount(engine, 0, 3000);

      expect(engine.getActiveSourceCount()).toBe(0);
    }

    expect(engine.getActiveSourceCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// w22 — AC-16: repeated backend create/destroy, AudioContext non-monotonic
// ---------------------------------------------------------------------------

describe('M5 browser — multi-backend AudioContext non-monotonic (AC-16)', () => {
  it('N serial create/destroy cycles -> each destroy closes its AudioContext [w22]', async () => {
    const N = 5;
    const buffer = createShortSilentBuffer(0.05);

    for (let i = 0; i < N; i++) {
      const engine = new WebAudioEngine();
      await resumeEngineContext(engine, 5000);

      // Trigger lazy AudioContext creation + play a short clip.
      engine.play(i + 50, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });

      // After play, the context must be active (running).
      expect(engine.getState().contextState).toBe('running');

      // Wait for onended to fire so destroy doesn't race with playback.
      await waitForSourceCount(engine, 0, 3000);

      engine.destroy();

      const stateAfter = engine.getState();
      expect(stateAfter.contextState).toBe('closed');
      expect(stateAfter.activeSourceCount).toBe(0);
    }

    // All N individual checks passed: the number of active (non-closed)
    // AudioContexts does NOT grow monotonically with N.
  });

  it('N concurrent engines + bulk destroy -> all contexts closed [w22]', async () => {
    const N = 3;
    const buffer = createShortSilentBuffer(0.05);
    const engines: WebAudioEngine[] = [];

    // Create N engines concurrently -- each gets its own AudioContext.
    for (let i = 0; i < N; i++) {
      const engine = new WebAudioEngine();
      await resumeEngineContext(engine, 5000);
      engine.play(i + 60, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'sfx' });
      engines.push(engine);
    }

    for (const engine of engines) {
      expect(engine.getState().contextState).toBe('running');
    }

    for (const engine of engines) {
      await waitForSourceCount(engine, 0, 3000);
      engine.destroy();
    }

    for (const engine of engines) {
      const state = engine.getState();
      expect(state.contextState).toBe('closed');
      expect(state.activeSourceCount).toBe(0);
    }
  });
});
