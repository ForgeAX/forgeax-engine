import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ToolExecutionContext } from '@forgeax/engine-tool-runtime';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowserCaptureRecord,
  type BrowserCaptureSession,
  isExternalUrl,
} from '../browser-capture.js';
import { captureRenderFailure } from '../capture-render-failure.js';
import {
  admitRelease,
  clearPreviousRun,
  clickBlockedWarning,
  createPlayContext,
  externalRequestFailure,
  externalRequestsField,
  finalCaptureCheck,
  finalFields,
  PLAY_COMPACT_BYTES,
  PLAY_WARNING_BYTES,
  PLAY_WARNING_KINDS,
  type PlayRangeTracker,
  type PlayRecorder,
  type PlayReport,
  type PlayStepRange,
  POINTER_LOCK_MOVE_WARNING,
  parsePlayStepRange,
  playCommand,
  playExpectationLine,
  playFailureError,
  playLockWaitMs,
  playOutputDir,
  playRerunFields,
  playResultValue,
  releaseArgsError,
  rerunCommand,
  SCENE_PREVIEW_HINT,
  startPlayProgress,
  summarizeValue,
  warningsField,
} from '../play.js';
import { PLAY_CONTEXT_REFERENCE } from '../play-context-reference.js';
import { acquirePlayLock } from '../play-lock.js';
import { groupPlayWarnings } from '../play-warnings.js';
import { createUnifiedCommandContributions } from '../tools/unified-contributions.js';

function recorder(): PlayRecorder {
  return {
    steps: [],
    screenshots: [],
    log: [],
    warnings: [],
    step: undefined,
    action: undefined,
    failedStep: new WeakMap(),
  };
}

/** A Page stand-in recording real-input calls and serving one read projection. */
function fakeSession(
  read: () => unknown,
  reads: readonly string[] = ['game.state'],
  framesPerPoll = 1,
  readLatencyMs = 0,
  pointerLocked = false,
  clickTarget: string | null = null,
  /** Frames complete every 16.7 ms of wall time and waits really sleep. */
  realTime = false,
) {
  const events: string[] = [];
  let frame = 0;
  const started = Date.now();
  const page = {
    async evaluate(fn: unknown, arg?: unknown) {
      const source = String(fn);
      if (source.includes('frame?.completed')) {
        if (realTime) return Math.floor((Date.now() - started) / (1000 / 60)) + 1;
        frame += framesPerPoll;
        return frame;
      }
      if (source.includes('.advance?.(')) {
        events.push(`advance ${JSON.stringify(arg)}`);
        return { ok: true, frames: 1 };
      }
      if (source.includes('pointerLockElement')) {
        if (source.includes('movementX')) events.push(`look ${JSON.stringify(arg)}`);
        return pointerLocked;
      }
      if (source.includes('elementFromPoint')) {
        events.push(`hit-test ${JSON.stringify(arg)}`);
        return clickTarget;
      }
      if (source.includes('.list()')) return [...reads];
      if (source.includes('.read(')) {
        events.push(`read ${String(arg)}`);
        if (readLatencyMs > 0) await new Promise((done) => setTimeout(done, readLatencyMs));
        return read();
      }
      throw new Error(`unexpected evaluate ${source}`);
    },
    async waitForTimeout(ms: number) {
      events.push(`wait ${ms}`);
      if (realTime) await new Promise((done) => setTimeout(done, ms));
    },
    keyboard: {
      down: async (key: string) => events.push(`down ${key}`),
      up: async (key: string) => events.push(`up ${key}`),
    },
    mouse: {
      move: async (x: number, y: number, options?: { steps?: number }) =>
        events.push(`move ${x},${y}${options?.steps === undefined ? '' : ` in ${options.steps}`}`),
      down: async () => events.push('down mouse'),
      up: async () => events.push('up mouse'),
    },
    locator: () => ({
      first: () => ({ boundingBox: async () => ({ x: 10, y: 20, width: 200, height: 100 }) }),
    }),
  };
  const session = { page: page as unknown as Page } as BrowserCaptureSession;
  return { session, events };
}

function report(overrides: Partial<PlayReport> = {}): PlayReport {
  return {
    schemaVersion: '1.1.0',
    passed: true,
    mode: 'private',
    root: '/game',
    script: 'scripts/playthrough.mjs',
    outputDir: '/game/artifacts/play/playthrough',
    report: '/game/artifacts/play/playthrough/play.json',
    timings: { totalMs: 4200 },
    steps: [
      { name: 'start', ok: true, ms: 10 },
      { name: 'collect', ok: true, ms: 20 },
    ],
    screenshots: [
      {
        name: 'start',
        path: '/game/artifacts/play/playthrough/01-start.png',
        rendered: true,
        digest: 'sha256:a',
      },
      {
        name: 'final',
        path: '/game/artifacts/play/playthrough/02-final.png',
        rendered: true,
        digest: 'sha256:b',
      },
    ],
    viewports: ['1280x720', '1280x600'],
    errors: { console: [], page: [], inputWarnings: 0 },
    log: [],
    ...overrides,
  };
}

describe('play helper', () => {
  it('maps canvas-normalized points and holds input until three Engine frames complete', async () => {
    let score = 0;
    const { session, events } = fakeSession(() => ({ score: score++ }));
    const play = createPlayContext(session, recorder(), '/tmp/out', 1000);
    await play.mouse.click([0.5, 0.25]);
    await play.mouse.move({ x: 1, y: 1 });
    await play.keyboard.press('Shift+KeyA');
    const state = await play.keyboard.hold(
      ['KeyW', 'KeyD'],
      (s: { score: number }) => s.score >= 2,
    );
    expect(state).toEqual({ score: 2 });
    // Frame counter starts at 1 and advances one per poll: released at frame >= 4.
    const held = ['wait 50', 'wait 16', 'wait 16'];
    expect(events).toEqual([
      'move 110,45',
      'hit-test {"x":110,"y":45}',
      'down mouse',
      ...held,
      'up mouse',
      'move 210,120 in 4',
      'down Shift',
      'down KeyA',
      'wait 50',
      'wait 16',
      'wait 16',
      'up KeyA',
      'up Shift',
      'down KeyW',
      'down KeyD',
      'read game.state',
      'wait 50',
      'read game.state',
      'wait 50',
      'read game.state',
      'up KeyD',
      'up KeyW',
    ]);
  });

  it('drags in three steps with frame-observed press, motion and release', async () => {
    const { session, events } = fakeSession(() => ({}));
    await createPlayContext(session, recorder(), '/tmp/out', 1000).mouse.drag(
      [0.5, 0.5],
      [0.65, 0.5],
      { button: 'right' },
    );
    // No timed 50 ms hold: each phase waits two completed frames (one poll here).
    expect(events).toEqual([
      'move 110,70',
      'down mouse',
      'wait 16',
      'move 140,70 in 3',
      'wait 16',
      'up mouse',
    ]);
    const timed = fakeSession(() => ({}), ['game.state'], 1, 0, false, null, true);
    const play = createPlayContext(timed.session, recorder(), '/tmp/out', 5000);
    const start = performance.now();
    await play.mouse.drag([0.5, 0.5], [0.65, 0.5], { button: 'right' });
    // At 60 frames per second one drag takes about four frames.
    expect(performance.now() - start).toBeLessThan(150);
  });

  it('looks by a relative delta, directly under pointer lock', async () => {
    const locked = fakeSession(() => ({}), ['game.state'], 1, 0, true);
    await createPlayContext(locked.session, recorder(), '/tmp/out', 1000).mouse.look(100, 0);
    expect(locked.events).toEqual(['look {"dx":100,"dy":0}', 'wait 16']);
    const free = fakeSession(() => ({}));
    const play = createPlayContext(free.session, recorder(), '/tmp/out', 1000);
    await play.mouse.look(100, 0);
    await play.mouse.look(0, -20);
    // Without the lock the cursor moves by the delta from the canvas centre, then onward.
    expect(free.events.filter((event) => event.startsWith('move'))).toEqual([
      'move 110,70',
      'move 210,70',
      'move 210,70',
      'move 210,50',
    ]);
    await expect(play.mouse.look(Number.NaN, 0)).rejects.toThrow(/finite pixel deltas/);
  });

  it('warns when mouse.click lands on page content instead of the canvas', async () => {
    const clear = recorder();
    await createPlayContext(fakeSession(() => ({})).session, clear, '/tmp/out', 1000).mouse.click([
      0.5, 0.5,
    ]);
    expect(clear.warnings).toEqual([]);
    const covered = recorder();
    const { session, events } = fakeSession(
      () => ({}),
      ['game.state'],
      1,
      0,
      false,
      '<div.hud> in UI hud.ui.html',
    );
    const play = createPlayContext(session, covered, '/tmp/out', 1000);
    await play.mouse.click([0.5, 0.5]);
    await play.mouse.click([0.5, 0.5]);
    // The click is still delivered; the warning only names what received it.
    expect(events.filter((event) => event === 'down mouse')).toHaveLength(2);
    expect(covered.warnings).toEqual([
      clickBlockedWarning([0.5, 0.5], '<div.hud> in UI hud.ui.html'),
    ]);
    const value = playResultValue(
      report({ warnings: groupPlayWarnings(covered.warnings) }),
      false,
    ) as { warnings?: { kind: string; message: string }[] };
    expect(value.warnings?.[0]?.kind).toBe('mouse.click off canvas');
    expect(value.warnings?.[0]?.message).toContain(
      'mouse.click [0.5,0.5] hit <div.hud> in UI hud.ui.html',
    );
  });

  it('warns once when mouse.move runs while the page holds pointer lock', async () => {
    const unlocked = recorder();
    await createPlayContext(fakeSession(() => ({})).session, unlocked, '/tmp/out', 1000).mouse.move(
      [0.5, 0.5],
    );
    expect(unlocked.warnings).toEqual([]);
    const locked = recorder();
    const play = createPlayContext(
      fakeSession(() => ({}), ['game.state'], 1, 0, true).session,
      locked,
      '/tmp/out',
      1000,
    );
    await play.mouse.move([0.5, 0.5]);
    await play.mouse.move([0.6, 0.5]);
    expect(locked.warnings).toEqual([POINTER_LOCK_MOVE_WARNING]);
    const value = playResultValue(
      report({ warnings: groupPlayWarnings(locked.warnings) }),
      false,
    ) as { warnings?: { message: string }[] };
    expect(value.warnings?.[0]?.message).toContain('setPointerLockAllowed(false)');
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
  });

  it('merges warnings by kind in the order first seen and keeps cause and fix whole', () => {
    const fix = ' Fix: '.padEnd(300, 'x');
    const lines = [
      `screenshot mid: renamed asset: "Crate" was renamed.${fix}`,
      `screenshot start: stale asset: "Crate" 1 was reloaded.${fix}`,
      `screenshot mid: stale asset: "Crate" 2 was reloaded.${fix}`,
      `screenshot end: stale asset: "Crate" 3 was reloaded.${fix}`,
      `screenshot end: missing texture: "Crate" has no base colour.${fix}`,
      `screenshot start: unbaked mesh: "Crate" is not baked.${fix}`,
      `screenshot end: unbaked mesh: "Crate" still is not baked.${fix}`,
      POINTER_LOCK_MOVE_WARNING,
    ];
    const warnings = groupPlayWarnings(lines);
    expect(warnings.map((warning) => [warning.kind, warning.count, warning.screenshots])).toEqual([
      ['renamed asset', 1, ['mid']],
      ['stale asset', 3, ['start', 'mid', 'end']],
      ['missing texture', 1, ['end']],
      ['unbaked mesh', 2, ['start', 'end']],
      ['mouse.move under pointer lock', 1, []],
    ]);
    expect(warnings[1]?.message).toMatch(/^stale asset: "Crate" 1/);
    expect(warnings[1]?.others).toHaveLength(2);
    expect(warnings[3]?.others).toEqual([lines[6]]);
    const { warnings: field = [], moreWarningKinds } = warningsField({ warnings });
    expect(field.map((warning) => warning.kind)).toEqual([
      'renamed asset',
      'stale asset',
      'missing texture',
      'unbaked mesh',
    ]);
    expect(moreWarningKinds).toBe(1);
    for (const warning of field) {
      expect(warning.message.endsWith(fix)).toBe(true);
      expect(warning.others).toBeUndefined();
    }
    expect(Buffer.byteLength(JSON.stringify(field))).toBeLessThanOrEqual(PLAY_WARNING_BYTES);
    // Success value and failure detail carry the report's shape, the report path last.
    const value = playResultValue(report({ warnings }), false) as Record<string, unknown>;
    const { warnings: listed, moreWarningKinds: more, ...rest } = value;
    expect(listed).toEqual(field);
    expect(more).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(rest))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
    expect(Object.keys(value).at(-1)).toBe('report');
    const failed = playFailureError(
      report({
        passed: false,
        warnings,
        failure: { code: 'play-step-failed', reason: 'script-error', message: 'boom' },
      }),
    );
    expect((failed?.detail as Record<string, unknown>).warnings).toEqual(field);
  });

  it('caps the warnings by kind count, bytes and screenshot names and counts the rest', () => {
    const many = Array.from(
      { length: PLAY_WARNING_KINDS + 3 },
      (_unused, index) => `screenshot s: ${'abcdefg'[index]} finding: ${'y'.repeat(900)}`,
    );
    const { warnings: field = [], moreWarningKinds } = warningsField({
      warnings: groupPlayWarnings(many),
    });
    expect(Buffer.byteLength(JSON.stringify(field))).toBeLessThanOrEqual(PLAY_WARNING_BYTES);
    expect(field.length).toBeLessThanOrEqual(PLAY_WARNING_KINDS);
    expect(moreWarningKinds).toBe(PLAY_WARNING_KINDS + 3 - field.length);
    // One very long warning still shows, clipped; long screenshot lists end with a count.
    const shots = Array.from({ length: 9 }, (_unused, index) => `screenshot s${index}: dark: x`);
    const [only] =
      warningsField({ warnings: groupPlayWarnings([`dark: ${'z'.repeat(5000)}`, ...shots]) })
        .warnings ?? [];
    expect(only?.message.length).toBeLessThan(PLAY_WARNING_BYTES);
    expect(only?.count).toBe(10);
    expect(only?.screenshots).toEqual(['s0', 's1', 's2', 's3', 's4', '+4 more']);
    expect(warningsField({ warnings: [] })).toEqual({});
  });

  it('points step and startup failures at the scene preview', () => {
    expect(SCENE_PREVIEW_HINT).toContain('forgeax asset preview --kind scene --guid');
    const value = playResultValue(
      report({ warnings: groupPlayWarnings([POINTER_LOCK_MOVE_WARNING]) }),
      false,
    ) as Record<string, unknown>;
    expect(value.scenePreview).toBeUndefined();
    const failed = playFailureError(
      report({
        passed: false,
        failure: { code: 'play-step-failed', reason: 'wait-timeout', message: 'never' },
      }),
    );
    expect(failed?.hint).toContain(SCENE_PREVIEW_HINT);
    const startup = playFailureError(
      report({
        passed: false,
        failure: { code: 'play-not-ready', reason: 'startup-failed', message: 'fatal' },
      }),
    );
    expect(startup?.hint).toContain(SCENE_PREVIEW_HINT);
  });

  it('rejects every helper after abort and never lets a key release mask the hold error', async () => {
    const abort = new AbortController();
    const { session, events } = fakeSession(() => ({ phase: 'menu' }));
    const page = session.page as unknown as { keyboard: { up(key: string): Promise<void> } };
    page.keyboard.up = async () => {
      throw new Error('Target page, context or browser has been closed');
    };
    const play = createPlayContext(session, recorder(), '/tmp/out', 1000, abort.signal);
    expect(play.signal).toBe(abort.signal);
    await expect(
      play.keyboard.hold('KeyW', (s: { phase: string }) => s.phase === 'won', { timeoutMs: 1 }),
    ).rejects.toMatchObject({ reason: 'wait-timeout' });
    abort.abort();
    const before = events.length;
    for (const call of [
      () => play.keyboard.press('KeyD'),
      () => play.mouse.click([0.5, 0.5]),
      () => play.state(),
      () => play.wait(10),
      () => play.step('late', () => undefined),
    ])
      await expect(call()).rejects.toMatchObject({ name: 'PlayAbortedError' });
    expect(events.length).toBe(before);
  });

  it('reports the innermost failing step and a bounded wait timeout with the last state', async () => {
    const rec = recorder();
    const { session } = fakeSession(() => ({ phase: 'menu' }));
    const play = createPlayContext(session, rec, '/tmp/out', 1000);
    const failure = await play
      .step('level', () =>
        play.step('reach exit', () =>
          play.waitFor((s: { phase: string }) => s.phase === 'won', { timeoutMs: 1 }),
        ),
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'wait-timeout', state: { phase: 'menu' } });
    expect(rec.failedStep.get(failure as object)).toBe('level > reach exit');
    expect(rec.action).toBe('level > reach exit: waitFor');
    expect(rec.steps.map((step) => [step.name, step.ok])).toEqual([
      ['level > reach exit', false],
      ['level', false],
    ]);
  });

  it('reports a wait timeout with the last state when reads are slower than the wait', async () => {
    const { session } = fakeSession(() => ({ presses: 1 }), ['game.state'], 1, 20);
    const play = createPlayContext(session, recorder(), '/tmp/out', 1000);
    await expect(
      play.waitFor((s: { presses: number }) => s.presses === 99, { timeoutMs: 5 }),
    ).rejects.toMatchObject({ reason: 'wait-timeout', state: { presses: 1 } });
  });

  it('advances in one page evaluation as a recorded step and rejects out-of-range time at once', async () => {
    const rec = recorder();
    const { session, events } = fakeSession(() => ({ phase: 'lost' }));
    const play = createPlayContext(session, rec, '/tmp/out', 1000);
    await expect(play.advance(180)).resolves.toEqual({ phase: 'lost' });
    await expect(play.advance(1, { render: true })).resolves.toEqual({ phase: 'lost' });
    // Update-only stepping is the default; render: true keeps every picture.
    const request = (seconds: number, render: boolean) =>
      `advance ${JSON.stringify({ seconds, stepSeconds: 1 / 60, render, timeoutMs: 120_000 })}`;
    expect(events).toEqual([
      request(180, false),
      'read game.state',
      request(1, true),
      'read game.state',
    ]);
    for (const [seconds, stepSeconds] of [
      [0, 1 / 60],
      [-1, 1 / 60],
      [601, 1 / 60],
      [Number.POSITIVE_INFINITY, 1 / 60],
      [10, 0],
      [10, 0.2],
      [600, 0.01],
    ] as const)
      await expect(play.advance(seconds, { stepSeconds })).rejects.toMatchObject({
        reason: 'advance-invalid',
      });
    expect(events).toHaveLength(4);
    expect(rec.steps.map((step) => [step.name, step.ok])[0]).toEqual(['advance 180 s', true]);
    expect(rec.steps).toHaveLength(9);
  });

  it('requires an explicit read id when the game registers zero or several projections', async () => {
    for (const reads of [[], ['a', 'b']]) {
      const { session } = fakeSession(() => ({}), reads);
      const play = createPlayContext(session, recorder(), '/tmp/out', 1000);
      await expect(play.state()).rejects.toMatchObject({ reason: 'state-unavailable' });
    }
    const { session, events } = fakeSession(() => ({ ok: true }), ['a', 'b']);
    const play = createPlayContext(session, recorder(), '/tmp/out', 1000);
    await expect(play.state('b')).resolves.toEqual({ ok: true });
    expect(events).toEqual(['read b']);
  });
});

describe('play result shaping', () => {
  it('keeps scalars and collapses large nested state within the byte budget', () => {
    const state = {
      phase: 'won',
      coins: 125,
      pots: Array.from({ length: 16 }, (_, index) => ({
        index,
        stage: 3,
        screen: { x: 0.1, y: 0.2 },
      })),
      message: 'x'.repeat(200),
      position: [1, 2, 3],
    };
    const summary = summarizeValue(state) as Record<string, unknown>;
    expect(summary).toEqual({
      phase: 'won',
      coins: 125,
      pots: '[16 items]',
      message: `${'x'.repeat(57)}…`,
      position: [1, 2, 3],
    });
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(320);
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`key${i}`, i]));
    const bounded = summarizeValue(wide) as Record<string, unknown>;
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(320);
    expect(String(bounded['…'])).toMatch(/^\+\d+$/);
    expect(summarizeValue({ small: true })).toEqual({ small: true });
  });

  it('returns a compact passing value under about 1 KB and the full report with detail', () => {
    const passing = report({ state: { phase: 'won', coins: 125 }, returned: { checks: 3 } });
    const value = playResultValue(passing, false);
    expect(value).toEqual({
      passed: true,
      script: 'scripts/playthrough.mjs',
      ms: 4200,
      steps: 2,
      returned: { checks: 3 },
      state: { phase: 'won', coins: 125 },
      screenshots: [
        'artifacts/play/playthrough/01-start.png',
        'artifacts/play/playthrough/02-final.png',
      ],
      rendered: true,
      errors: { console: 0, page: 0 },
      report: 'artifacts/play/playthrough/play.json',
    });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
    expect(playResultValue(passing, true)).toBe(passing);
    expect(playFailureError(passing)).toBeUndefined();
  });

  it('shapes a step failure with its step, action, screenshot, state and first browser error', () => {
    const failed = report({
      passed: false,
      state: { phase: 'menu' },
      errors: { console: ['TypeError: boom'], page: [], inputWarnings: 0 },
      log: ['one', 'two', 'three', 'four'],
      failure: {
        code: 'play-step-failed',
        reason: 'script-error',
        message: 'Expected values to be strictly equal',
        step: 'collect coin',
        action: 'collect coin: keyboard.press KeyE',
        screenshot: '/game/artifacts/play/playthrough/03-failure.png',
      },
    });
    const error = playFailureError(failed);
    expect(error).toMatchObject({
      code: 'play-step-failed',
      detail: {
        reason: 'script-error',
        step: 'collect coin',
        action: 'collect coin: keyboard.press KeyE',
        screenshot: 'artifacts/play/playthrough/03-failure.png',
        state: { phase: 'menu' },
        errors: { console: 1, page: 0 },
        firstError: 'TypeError: boom',
        log: ['three', 'four'],
        report: 'artifacts/play/playthrough/play.json',
      },
    });
    expect(Buffer.byteLength(JSON.stringify(error))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
  });

  it('keeps a worst-case failure and pass inside the compact byte budget', () => {
    const wide = '\u00e9'.repeat(2_000);
    const huge = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, wide]));
    const worst = report({
      passed: false,
      state: huge,
      returned: huge,
      errors: { console: [wide], page: [wide], inputWarnings: 0 },
      log: [wide, wide, wide],
      failure: {
        code: 'play-not-ready',
        reason: 'session-failed',
        message: wide,
        step: wide,
        action: wide,
        screenshot: `/game/${wide}.png`,
        cause: { code: wide, hint: wide, detail: huge },
      },
    });
    const error = playFailureError(worst);
    expect(Buffer.byteLength(JSON.stringify(error))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
    expect(error).toMatchObject({ code: 'play-not-ready', detail: { reason: 'session-failed' } });
    const many = report({
      state: huge,
      returned: huge,
      screenshots: Array.from({ length: 30 }, (_, i) => ({
        name: `s${i}`,
        path: `/game/artifacts/play/${wide}/${i}.png`,
        rendered: true,
        digest: 'sha256:x',
      })),
    });
    const value = playResultValue(many, false);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
    expect(value).toMatchObject({ passed: true, report: 'artifacts/play/playthrough/play.json' });
  });

  it('keys the output directory by script path under artifacts/play', () => {
    expect(playOutputDir('/game', '/game/scripts/playthrough.mjs')).toBe(
      '/game/artifacts/play/scripts/playthrough',
    );
    expect(playOutputDir('/game', '/game/tests/playthrough.ts')).toBe(
      '/game/artifacts/play/tests/playthrough',
    );
    expect(playOutputDir('/game', '/elsewhere/playthrough.mjs')).toMatch(
      /^\/game\/artifacts\/play\/external\/playthrough-[0-9a-f]{8}$/,
    );
  });

  it('names the first failing final-frame check from the strict capture record', () => {
    const record = (runtime: Partial<BrowserCaptureRecord['runtime']>, rendered: boolean) =>
      ({
        pixels: { rendered },
        runtime: { fatalError: null, domUi: { rootChildren: 1 }, ...runtime },
      }) as unknown as BrowserCaptureRecord;
    const failed = { code: 'browser-capture-runtime-failed' };
    expect(finalCaptureCheck(failed, record({ fatalError: 'boom' }, true), 0, false)).toBe('fatal');
    expect(finalCaptureCheck(failed, record({}, true), 2, false)).toBe('browser-errors');
    expect(finalCaptureCheck(failed, record({}, false), 0, false)).toBe('flat-canvas');
    expect(
      finalCaptureCheck(
        failed,
        record({ domUi: { rootChildren: 0, openShadowRoots: 0, textWitness: '' } }, true),
        0,
        true,
      ),
    ).toBe('ui-missing');
    // A canvas-only game under --require-ui fails fast with its own code.
    expect(finalCaptureCheck({ code: 'browser-capture-ui-missing' }, undefined, 0, true)).toBe(
      'ui-missing',
    );
    expect(finalCaptureCheck({ code: 'browser-capture-timeout' }, undefined, 0, false)).toBe(
      'final-frame-timeout',
    );
  });

  it('names a recent renderer error before the browser error it logs and the flat canvas it leaves', () => {
    const submitFailed = {
      code: 'queue-submit-failed',
      message: 'GPU validation: [Buffer "gpu-scene-material-table"] used in submit while destroyed',
      frame: 1490,
      framesAgo: 0,
      count: 1490,
    };
    const record = (rendererError: typeof submitFailed | null, rendered: boolean) =>
      ({
        pixels: { rendered },
        runtime: { fatalError: null, domUi: { rootChildren: 1 }, rendererError },
      }) as unknown as BrowserCaptureRecord;
    const failed = { code: 'browser-capture-runtime-failed' };
    // A stale canvas witness may still look rendered; the renderer error decides.
    expect(finalCaptureCheck(failed, record(submitFailed, true), 1, false)).toBe('renderer-error');
    expect(finalCaptureCheck(failed, record(submitFailed, false), 1, false)).toBe('renderer-error');
    const recovered = { ...submitFailed, framesAgo: 61 };
    expect(captureRenderFailure(record(recovered, true))).toBeUndefined();
    expect(finalCaptureCheck(failed, record(recovered, false), 0, false)).toBe('flat-canvas');
    expect(captureRenderFailure(record(submitFailed, true))).toEqual({
      reason: 'renderer-error',
      hint: 'GPU submit failed; the canvas is not presented (queue-submit-failed at frame 1490, 1490 since start): GPU validation: [Buffer "gpu-scene-material-table"] used in submit while destroyed See skills/forgeax-engine-rhi-debug.',
    });

    const failing = report({
      passed: false,
      rendererError: submitFailed,
      failure: {
        code: 'play-runtime-failed',
        reason: 'renderer-error',
        message: captureRenderFailure(record(submitFailed, false))?.hint ?? '',
      },
    });
    const error = playFailureError(failing);
    expect(error).toMatchObject({
      code: 'play-runtime-failed',
      detail: { reason: 'renderer-error' },
    });
    expect(String(error?.detail?.message)).toContain(
      'GPU submit failed; the canvas is not presented',
    );
    expect(playResultValue(failing, false)).toMatchObject({
      rendererError:
        'queue-submit-failed x1490, last frame 1490: GPU validation: [Buffer "gpu-scene-material-table"] used in submit while destroyed',
    });
  });
});

describe('playCommand script admission', () => {
  it('rejects a missing module or one without a default function before starting a browser', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-admission-'));
    try {
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({ id: 'play-admission', name: 'Play', schemaVersion: '3.0.0', roots: {} }),
      );
      await writeFile(resolve(root, 'package.json'), '{"name":"play-admission"}\n');
      await writeFile(resolve(root, 'named.mjs'), 'export const play = 1;\n');
      await writeFile(resolve(root, 'broken.mjs'), 'export default async function (\n');
      const missing = await playCommand({ root, script: 'absent.mjs' });
      expect(missing).toMatchObject({
        ok: false,
        error: { code: 'play-script-invalid', detail: { reason: 'missing' } },
      });
      const named = await playCommand({ root, script: 'named.mjs' });
      expect(named).toMatchObject({
        ok: false,
        error: { code: 'play-script-invalid', detail: { reason: 'no-default-export' } },
      });
      const broken = await playCommand({ root, script: 'broken.mjs' });
      expect(broken).toMatchObject({
        ok: false,
        error: { code: 'play-script-invalid', detail: { reason: 'import-failed' } },
      });
      // A rerun replaces only files the previous run recorded; other files survive.
      const output = resolve(root, 'artifacts/play/broken');
      const stale = resolve(output, '01-stale.png');
      const keep = resolve(output, 'notes.txt');
      await writeFile(stale, 'png');
      await writeFile(keep, 'mine');
      const previous = JSON.parse(await readFile(resolve(output, 'play.json'), 'utf8'));
      previous.screenshots = [{ name: 'stale', path: stale, rendered: true, digest: 'x' }];
      await writeFile(resolve(output, 'play.json'), JSON.stringify(previous));
      await mkdir(resolve(root, 'artifacts/other'), { recursive: true });
      await playCommand({ root, script: 'broken.mjs' });
      await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(keep, 'utf8')).toBe('mine');
      expect((await stat(resolve(root, 'artifacts/other'))).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('play output ownership and cancellation', () => {
  it('ignores untrusted play.json paths outside its own file names and never throws', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-clear-'));
    try {
      const output = resolve(root, 'artifacts/play/scripts/x');
      await mkdir(resolve(root, 'src'), { recursive: true });
      await mkdir(resolve(output, '02-dir.png'), { recursive: true });
      const victim = resolve(root, 'src/main.ts');
      const notes = resolve(output, 'notes.txt');
      const shot = resolve(output, '01-a.png');
      const outside = resolve(root, '03-outside.png');
      for (const path of [victim, notes, shot, outside]) await writeFile(path, 'x');
      await writeFile(
        resolve(output, 'play.json'),
        JSON.stringify({
          screenshots: [
            { path: `${output}/../../../../src/main.ts` },
            { path: '../../../../src/main.ts' },
            { path: resolve(output, '02-dir.png') },
            { path: notes },
            { path: outside },
            { path: shot },
            null,
            { path: 7 },
          ],
          captureReport: victim,
        }),
      );
      await clearPreviousRun(output, resolve(output, 'play.json'));
      for (const kept of [victim, notes, outside]) expect(await readFile(kept, 'utf8')).toBe('x');
      expect((await stat(resolve(output, '02-dir.png'))).isDirectory()).toBe(true);
      await expect(stat(shot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(resolve(output, 'play.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      // Malformed JSON is ignored.
      await writeFile(resolve(output, 'play.json'), '{');
      await expect(clearPreviousRun(output, resolve(output, 'play.json'))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the tool runtime cancellation code before starting a browser', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-cancel-'));
    try {
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({ id: 'play-cancel', name: 'Play', schemaVersion: '3.0.0', roots: {} }),
      );
      await writeFile(resolve(root, 'package.json'), '{"name":"play-cancel"}\n');
      await writeFile(
        resolve(root, 'ok.mjs'),
        "console.log('import output');\nexport default async () => {};\n",
      );
      const abort = new AbortController();
      abort.abort();
      const contribution = createUnifiedCommandContributions(root).find(
        ({ descriptor }) => descriptor.id === 'project.play',
      );
      expect(contribution).toBeDefined();
      const result = await contribution?.execute({ script: 'ok.mjs' }, {
        signal: abort.signal,
      } as ToolExecutionContext);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'tool-run-cancelled',
          detail: { reason: 'cancelled', log: ['import output'] },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('play in a dev owner session', () => {
  async function project(name: string): Promise<string> {
    const root = await mkdtemp(resolve(tmpdir(), `forgeax-play-${name}-`));
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({ id: name, name: 'Play', schemaVersion: '3.0.0', roots: {} }),
    );
    await writeFile(
      resolve(root, 'package.json'),
      `{"name":"${name}","forgeax":{"startupTimeoutMs":300}}\n`,
    );
    await writeFile(resolve(root, 'ok.mjs'), 'export default async () => {};\n');
    return root;
  }

  it('runs in the borrowed page, never closes it and restores its size', async () => {
    const root = await project('play-session-host');
    try {
      const events: string[] = [];
      let size = { width: 800, height: 450 };
      const page = {
        viewportSize: () => size,
        setViewportSize: async (next: { width: number; height: number }) => {
          size = next;
          events.push(`viewport ${next.width}x${next.height}`);
        },
        // Input never opens, so the run ends at the input gate.
        waitForFunction: async () => {
          throw new Error('timeout');
        },
        evaluate: async () => null,
      };
      const session = {
        page: page as unknown as Page,
        url: 'http://127.0.0.1:5173/',
        capture: async () => {
          throw new Error('no frame');
        },
        report: () => ({ captures: [], consoleErrors: [], pageErrors: [], inputWarnings: [] }),
        close: async () => void events.push('close'),
      } as unknown as BrowserCaptureSession;
      let opened = 0;
      const result = await playCommand(
        { root, script: 'ok.mjs', progress: false, detail: true, session: true },
        {
          sessionHost: {
            open: async () => {
              opened += 1;
              return session;
            },
          },
        },
      );
      expect(opened).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'play-not-ready',
          detail: { reason: 'input-closed', play: { mode: 'session' } },
        },
      });
      // The script viewport, then the owner's own size again; the page stays open.
      expect(events).toEqual(['viewport 1280x720', 'viewport 800x450']);
      const written = JSON.parse(
        await readFile(resolve(root, 'artifacts/play/ok/play.json'), 'utf8'),
      ) as PlayReport;
      expect(written.mode).toBe('session');
      expect(written.timings.openMs).toBeTypeOf('number');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a missing dev owner as session-unavailable and starts nothing', async () => {
    const root = await project('play-session-absent');
    try {
      const result = await playCommand({ root, script: 'ok.mjs', progress: false, session: true });
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: 'play-not-ready',
          hint: expect.stringContaining('forgeax dev start'),
          detail: { reason: 'session-unavailable', cause: { code: 'live-not-running' } },
        },
      });
      await expect(stat(resolve(root, '.forgeax/dev-session.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps --session in the rerun command of a session play', () => {
    expect(rerunCommand({ script: 'p.mjs', timeScale: 1, mode: 'session' }, 'walk')).toBe(
      'forgeax project play p.mjs --from walk --session --json',
    );
    expect(rerunCommand({ script: 'p.mjs', timeScale: 1 }, 'walk')).toBe(
      'forgeax project play p.mjs --from walk --json',
    );
  });
});

describe('play help', () => {
  it('lists every PlayContext member in the project play input schema', () => {
    const contribution = createUnifiedCommandContributions(tmpdir()).find(
      ({ descriptor }) => descriptor.id === 'project.play',
    );
    const description = (contribution?.descriptor.inputSchema as { description?: string })
      ?.description;
    expect(description).toContain("import('@forgeax/engine/devkit').PlayContext");
    for (const [key, line] of Object.entries(PLAY_CONTEXT_REFERENCE)) {
      expect(line.startsWith(key)).toBe(true);
      expect(description).toContain(`play.${line}`);
    }
  });
});

describe('play agent loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes progress at most once per interval and stops with the run', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let step = 'boot';
    const stop = startPlayProgress(
      (line) => lines.push(line),
      () => `step ${step}`,
    );
    vi.advanceTimersByTime(29_999);
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(1);
    step = 'collect coin';
    vi.advanceTimersByTime(30_000);
    vi.advanceTimersByTime(15_000);
    expect(lines).toEqual(['30 s, step boot', '60 s, step collect coin']);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(lines).toHaveLength(2);
  });

  it('opens with the expected duration from the previous run, or the usual range', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-expect-'));
    try {
      const reportPath = resolve(root, 'play.json');
      const wait =
        "wait for this command in one call (your shell tool's longest wait) instead of re-checking it";
      expect(await playExpectationLine(reportPath)).toBe(
        `a play usually takes 1-3 minutes; ${wait}`,
      );
      await writeFile(
        reportPath,
        JSON.stringify({ timings: { totalMs: 142_706 }, steps: [{}, {}, {}] }),
      );
      expect(await playExpectationLine(reportPath)).toBe(
        `the previous run of this script took 143 s over 3 steps; ${wait}`,
      );
      await writeFile(reportPath, '{"timings":{}}');
      expect(await playExpectationLine(reportPath)).toBe(
        `a play usually takes 1-3 minutes; ${wait}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('suggests a faster iteration run on a real-time private play, naming --session only with a live owner', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-faster-'));
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({ id: 'play-faster', name: 'Play', schemaVersion: '3.0.0', roots: {} }),
      );
      await writeFile(
        resolve(root, 'package.json'),
        '{"name":"play-faster","forgeax":{"startupTimeoutMs":500}}\n',
      );
      await playCommand({ root, script: 'absent.mjs' });
      await mkdir(resolve(root, '.forgeax'), { recursive: true });
      await writeFile(
        resolve(root, '.forgeax/dev-session.json'),
        JSON.stringify({ endpoint: 'http://127.0.0.1:1', pid: process.pid }),
      );
      await playCommand({ root, script: 'absent.mjs' });
      await playCommand({ root, script: 'absent.mjs', timeScale: 4 });
    } finally {
      spy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
    const expectations = lines.filter((line) => line.includes('wait for this command'));
    expect(expectations).toHaveLength(3);
    for (const line of expectations) expect(line.trimEnd().includes('\n')).toBe(false);
    const [plain, owned, scaled] = expectations;
    expect(plain).toContain('iteration runs can pass --time-scale 4;');
    expect(plain).toContain('final acceptance stays real-time');
    expect(plain).not.toContain('--session');
    expect(owned).toContain('iteration runs can pass --time-scale 4 --session');
    // A run already using the flags gets no suggestion.
    expect(scaled).not.toContain('--time-scale');
  }, 15_000);

  it('adds one next hint to a long passing real-time private run only', () => {
    const long = { timings: { totalMs: 120_000 } };
    const value = playResultValue(report(long), false) as Record<string, unknown>;
    expect(value.next).toBe(
      'iteration runs can pass --time-scale 4 (and --from <step> once steps have setups); final acceptance stays real-time',
    );
    for (const quiet of [
      report(),
      report({ ...long, timeScale: 4, final: false, nonFinal: ['time scale 4'] }),
      report({ ...long, mode: 'session' }),
      report({ ...long, range: { from: 'walk' }, final: false, nonFinal: ['step range walk..'] }),
    ])
      expect('next' in (playResultValue(quiet, false) as object)).toBe(false);
    // The hint goes first when the budget is tight.
    const tight = playResultValue(
      report({ ...long, state: { blob: 'x'.repeat(2_000) }, script: `scripts/${'p'.repeat(119)}` }),
      false,
    ) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(tight))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
  });

  it('keeps a CJK, long-path worst case within the byte budget', () => {
    // Four CJK ideographs (three UTF-8 bytes each), escaped for the English-only source rule.
    const cjk = '\u706f\u5854\u5b88\u591c'.repeat(60);
    const value = playResultValue(
      report({
        root: '/g',
        script: `scripts/${cjk}.mjs`,
        report: `/g/artifacts/play/${cjk}/play.json`,
        screenshots: Array.from({ length: 6 }, (_unused, index) => ({
          name: cjk,
          path: `/g/artifacts/play/${cjk}/${index}.png`,
          rendered: true,
          digest: 'sha256:a',
        })),
        state: { [cjk]: cjk },
        returned: { [cjk]: cjk },
      }),
      false,
    ) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
    const failed = playFailureError(
      report({
        passed: false,
        root: '/g',
        report: `/g/artifacts/play/${cjk}/play.json`,
        failure: {
          code: 'play-step-failed',
          reason: 'script-error',
          message: cjk,
          step: cjk,
          action: cjk,
          screenshot: `/g/${cjk}.png`,
        },
        errors: { console: [cjk], page: [cjk], inputWarnings: 0 },
        log: [cjk, cjk],
        state: { [cjk]: cjk },
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(failed))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
  });

  it('fails an invalid script at once while another play holds the lock, and names a busy lock', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-queue-'));
    try {
      await writeFile(
        resolve(root, 'forge.json'),
        JSON.stringify({ id: 'play-queue', name: 'Play', schemaVersion: '3.0.0', roots: {} }),
      );
      await writeFile(
        resolve(root, 'package.json'),
        '{"name":"play-queue","forgeax":{"startupTimeoutMs":500}}\n',
      );
      await writeFile(resolve(root, 'ok.mjs'), 'export default async () => {};\n');
      const lockPath = resolve(root, '.forgeax/play/lock.json');
      const held = await acquirePlayLock(lockPath, { script: 'other.mjs', timeoutMs: 0 });
      const started = Date.now();
      const invalid = await playCommand({ root, script: 'absent.mjs', progress: false });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(invalid).toMatchObject({
        ok: false,
        error: { code: 'play-script-invalid', detail: { reason: 'missing' } },
      });
      // A valid script waits one ordinary play budget: here 1 ms script + 500 ms startup.
      expect(playLockWaitMs(300_000, 120_000)).toBe(420_000);
      const busy = await playCommand({ root, script: 'ok.mjs', progress: false, timeoutMs: 1 });
      expect(busy).toMatchObject({
        ok: false,
        error: {
          code: 'play-not-ready',
          hint: expect.stringContaining(lockPath),
          detail: { reason: 'busy', lock: lockPath, holder: { script: 'other.mjs' } },
        },
      });
      if (held.ok) await held.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects malformed viewports before starting anything', async () => {
    const result = await playCommand({
      root: tmpdir(),
      script: 'x.mjs',
      viewports: '1280x720,10x10',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'tool-invalid-args', expected: '--viewports WxH[,WxH...]' },
    });
  });
});

describe('step ranges', () => {
  const ranged = (range: PlayStepRange): PlayRecorder & { range: PlayRangeTracker } => ({
    ...recorder(),
    range: { range, phase: 'before', index: 0, seen: [] },
  });
  /** Four top-level steps with input inside and between them; `withSetup` gives each a setup. */
  const journey = (play: ReturnType<typeof createPlayContext>, ran: string[], withSetup = true) =>
    (async () => {
      for (const name of ['spawn', 'walk', 'jump', 'land']) {
        await play.step(
          name,
          async () => {
            ran.push(name);
            await play.keyboard.press(`Key${name[0]?.toUpperCase()}`);
          },
          withSetup ? { setup: async () => void ran.push(`${name} setup`) } : {},
        );
        await play.keyboard.press('KeyX');
        await play.wait(5);
      }
    })();

  it('parses --from and --steps into a range of names or 1-based positions', () => {
    expect(parsePlayStepRange({})).toEqual({ ok: true });
    expect(parsePlayStepRange({ from: 'walk' })).toEqual({ ok: true, value: { from: 'walk' } });
    expect(parsePlayStepRange({ steps: '2..3' })).toEqual({
      ok: true,
      value: { from: '2', to: '3' },
    });
    expect(parsePlayStepRange({ steps: 'walk..' })).toEqual({ ok: true, value: { from: 'walk' } });
    expect(parsePlayStepRange({ steps: '..jump' })).toEqual({
      ok: true,
      value: { from: '1', to: 'jump' },
    });
    expect(parsePlayStepRange({ steps: 'jump' })).toEqual({
      ok: true,
      value: { from: 'jump', to: 'jump' },
    });
    for (const bad of [
      { steps: '3..2' },
      { steps: '..' },
      { from: ' ' },
      { from: 'a', steps: 'b' },
    ])
      expect(parsePlayStepRange(bad).ok).toBe(false);
  });

  it('skips steps before the range without input, runs the first one after its setup and ends after the last', async () => {
    const rec = ranged({ from: 'walk', to: '3' });
    const { session, events } = fakeSession(() => ({ phase: 'playing' }));
    const play = createPlayContext(session, rec, '/tmp/out', 1000);
    const ran: string[] = [];
    await expect(journey(play, ran)).rejects.toMatchObject({ name: 'PlayRangeEnd' });
    // Only the setup of the range's first step runs; spawn and land never run.
    expect(ran).toEqual(['walk setup', 'walk', 'jump']);
    const keys = events.filter((event) => event.startsWith('down '));
    // No spawn input and none between skipped steps; input between range steps still runs,
    // and the first helper after the last range step ends the script.
    expect(keys).toEqual(['down KeyW', 'down KeyX', 'down KeyJ']);
    expect(rec.steps).toEqual([
      { name: 'spawn', ok: true, ms: 0, skipped: true },
      expect.objectContaining({ name: 'walk > setup', ok: true }),
      expect.objectContaining({ name: 'walk', ok: true }),
      expect.objectContaining({ name: 'jump', ok: true }),
    ]);
    expect(rec.range.phase).toBe('after');
  });

  it('fails fast naming the step and the setup option when the range starts at a step without setup', async () => {
    const rec = ranged({ from: '3' });
    const { session, events } = fakeSession(() => ({ phase: 'playing' }));
    const play = createPlayContext(session, rec, '/tmp/out', 1000);
    const ran: string[] = [];
    const error = await journey(play, ran, false).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'setup-missing' });
    expect((error as Error).message).toContain('Step "jump" (#3) has no setup');
    expect((error as Error).message).toContain('play.step("jump", run, { setup:');
    expect(ran).toEqual([]);
    expect(events.filter((event) => event.startsWith('down '))).toEqual([]);
    // Starting at the first step needs no setup: it is the complete journey.
    const full = ranged({ from: 'spawn' });
    const fresh: string[] = [];
    await journey(createPlayContext(session, full, '/tmp/out', 1000), fresh, false);
    expect(fresh).toEqual(['spawn', 'walk', 'jump', 'land']);
  });

  it('remembers the failed top-level step and prints the --from rerun command', async () => {
    const rec = recorder();
    const { session } = fakeSession(() => ({ phase: 'menu' }));
    const play = createPlayContext(session, rec, '/tmp/out', 1000);
    await play.step('spawn', async () => undefined);
    await play
      .step('walk', () =>
        play.step('reach door', () =>
          play.waitFor((s: { phase: string }) => s.phase === 'won', { timeoutMs: 1 }),
        ),
      )
      .catch(() => undefined);
    expect(rec.failedTop).toBe('walk');
    const failed = playFailureError(
      report({
        passed: false,
        failure: {
          code: 'play-step-failed',
          reason: 'wait-timeout',
          message: 'State predicate stayed false for 1 ms',
          step: 'walk > reach door',
          rerunFrom: 'walk',
        },
      }),
    );
    expect((failed?.detail as Record<string, unknown>).rerun).toBe(
      'forgeax project play scripts/playthrough.mjs --from walk --json',
    );
    expect(failed?.hint).toContain('detail.rerun');
    // The rerun command and the longer hint still leave room for the step's state and action.
    const located = playFailureError(
      report({
        passed: false,
        state: { presses: 1, phase: 'playing' },
        failure: {
          code: 'play-step-failed',
          reason: 'wait-timeout',
          message: 'State predicate stayed false for 500 ms',
          step: 'collect coin',
          action: 'collect coin: waitFor',
          screenshot: '/game/.forgeax/diag/artifacts/play/scripts/playthrough/01-failure.png',
          rerunFrom: 'collect coin',
        },
      }),
    );
    expect(located?.detail).toMatchObject({
      state: { presses: 1 },
      action: 'collect coin: waitFor',
      rerun: "forgeax project play scripts/playthrough.mjs --from 'collect coin' --json",
    });
    expect(Buffer.byteLength(JSON.stringify(located))).toBeLessThan(1024);
    expect(rerunCommand({ script: 'scripts/my play.mjs' }, "boss's room")).toBe(
      "forgeax project play 'scripts/my play.mjs' --from 'boss'\\''s room' --json",
    );
    // "walk" is a later step without setup, so the run reruns from the start.
    expect(playRerunFields(rec)).toEqual({ stepWithoutSetup: 'walk' });
    // A range run is reported as not final acceptance.
    const partial = playResultValue(
      report({ range: { from: 'walk' }, final: false, nonFinal: ['step range walk..'] }),
      false,
    );
    expect(partial).toMatchObject({ final: false, nonFinal: ['step range walk..'] });
  });

  it('runs the game-3d template playthrough from its later step with a setup', async () => {
    const path = resolve(
      import.meta.dirname,
      '../../../../templates/game-3d/scripts/playthrough.mjs',
    );
    const script = ((await import(path)) as { default: (play: unknown) => Promise<unknown> })
      .default;
    let reads = 0;
    const { session, events } = fakeSession(() => {
      reads += 1;
      return { position: [reads * 0.2, reads * 0.3, 0], camera: { yaw: 0 }, grounded: true };
    }, ['game-3d.player']);
    const rec = ranged({ from: 'jump', to: 'jump' });
    await expect(script(createPlayContext(session, rec, tmpdir(), 1000))).rejects.toMatchObject({
      name: 'PlayRangeEnd',
    });
    expect(rec.steps.map((step) => step.name)).toEqual([
      'spawn',
      'look',
      'walk',
      'jump > setup',
      'jump',
    ]);
    expect(events).toContain('down Space');
    // The header names the iteration rerun and keeps final acceptance real-time.
    const source = await readFile(path, 'utf8');
    expect(source).toContain('--from <step>');
    expect(source).toContain('real time');
  });

  it('never prints a --from rerun that must fail: a later step without setup reruns from the start', async () => {
    const { session } = fakeSession(() => ({ phase: 'menu' }));
    const stuck = async () => {
      throw new Error('stuck');
    };
    const setup = { setup: async () => undefined };
    const fields = async (
      rec: PlayRecorder,
      run: (play: ReturnType<typeof createPlayContext>) => Promise<unknown>,
    ) => {
      await run(createPlayContext(session, rec, '/tmp/out', 1000)).catch(() => undefined);
      return playRerunFields(rec);
    };
    expect(
      await fields(recorder(), async (play) => {
        await play.step('spawn', async () => undefined);
        await play.step('walk', stuck);
      }),
    ).toEqual({ stepWithoutSetup: 'walk' });
    expect(
      await fields(recorder(), async (play) => {
        await play.step('spawn', async () => undefined);
        await play.step('walk', stuck, setup);
      }),
    ).toEqual({ rerunFrom: 'walk' });
    expect(await fields(recorder(), (play) => play.step('spawn', stuck))).toEqual({
      rerunFrom: 'spawn',
    });
    // A range run that started at a step with setup reruns from that start.
    expect(
      await fields(ranged({ from: 'walk' }), async (play) => {
        await play.step('spawn', async () => undefined);
        await play.step('walk', async () => undefined, setup);
        await play.step('jump', stuck);
      }),
    ).toEqual({ rerunFrom: 'walk', stepWithoutSetup: 'jump' });
    const failed = (overrides: Partial<PlayReport>) =>
      playFailureError(
        report({
          passed: false,
          failure: {
            code: 'play-step-failed',
            reason: 'script-error',
            message: 'stuck',
            step: 'walk',
            stepWithoutSetup: 'walk',
          },
          ...overrides,
        }),
      )?.detail as Record<string, unknown>;
    const realTime = failed({});
    expect(realTime.rerun).toBe('forgeax project play scripts/playthrough.mjs --json');
    expect(realTime.setupHint).toContain('play.step("walk", run, { setup:');
    expect(realTime.setupHint).toContain('--from walk');
    expect(realTime.setupHint).toContain('--time-scale 4');
    const scaled = failed({ mode: 'session', timeScale: 2, final: false, nonFinal: ['x'] });
    expect(scaled.rerun).toBe(
      'forgeax project play scripts/playthrough.mjs --time-scale 2 --session --json',
    );
    expect(scaled.setupHint).not.toContain('--time-scale 4');
    // Real-project sizes: a deep root, a scaled iteration run and long warnings. The
    // error message, the setup hint and the scene preview pointer all survive.
    const real = playFailureError(
      report({
        passed: false,
        root: '/private/tmp/workspace/game',
        script: 'scripts/fail-late.mjs',
        report: '/private/tmp/workspace/game/artifacts/play/scripts/fail-late/play.json',
        timeScale: 4,
        final: false,
        nonFinal: ['time scale 4'],
        warnings: [
          {
            kind: 'mouse.click off canvas',
            count: 2,
            screenshots: [],
            message: 'mouse.click at 10,10 hit #menu, not the game canvas: '.padEnd(600, 'x'),
          },
        ],
        failure: {
          code: 'play-step-failed',
          reason: 'script-error',
          message: 'injected smoke failure after look',
          step: 'look',
          action: 'look: screenshot look-around',
          stepWithoutSetup: 'look',
          screenshot:
            '/private/tmp/workspace/game/.forgeax/diag/artifacts/play/scripts/fail-late/03-failure.png',
        },
      }),
    );
    const realDetail = real?.detail as Record<string, unknown>;
    expect(realDetail.message).toBe('injected smoke failure after look');
    expect(realDetail.setupHint).toContain('play.step("look", run, { setup:');
    expect(real?.hint).toContain(SCENE_PREVIEW_HINT);
    // Without warnings the hint carries the pointer too.
    const plain = playFailureError(
      report({
        passed: false,
        failure: {
          code: 'play-step-failed',
          reason: 'script-error',
          message: 'stuck',
          step: 'walk',
        },
      }),
    );
    expect(plain?.hint).toContain(SCENE_PREVIEW_HINT);
    // The same real-size failure without warnings keeps the full hint and still fits
    // both the message and the setup hint.
    const unwarned = playFailureError(
      report({
        passed: false,
        root: '/private/tmp/workspace/game',
        script: 'scripts/fail-late.mjs',
        report: '/private/tmp/workspace/game/artifacts/play/scripts/fail-late/play.json',
        failure: {
          code: 'play-step-failed',
          reason: 'script-error',
          message: 'injected smoke failure after look',
          step: 'look',
          action: 'look: screenshot look-around',
          stepWithoutSetup: 'look',
          screenshot:
            '/private/tmp/workspace/game/.forgeax/diag/artifacts/play/scripts/fail-late/03-failure.png',
        },
      }),
    );
    expect(unwarned?.hint).toContain(SCENE_PREVIEW_HINT);
    expect(unwarned?.detail).toMatchObject({
      message: 'injected smoke failure after look',
      setupHint: expect.stringContaining('play.step("look", run, { setup:'),
    });
  });
});

describe('time scale', () => {
  /**
   * A page whose lockstep clock moves game time only by stepped frames; a step request
   * takes `latencyMs` of real time, like a slow page evaluation.
   */
  function lockstep(
    scale: number,
    options: { latencyMs?: number; edgeFrame?: number; running?: () => boolean } = {},
  ) {
    const { latencyMs = 0, edgeFrame = 10, running = () => true } = options;
    let frames = 0;
    const checks: number[] = [];
    const state = () => ({ frames, edge: frames >= edgeFrame, ready: false });
    const { session, events } = fakeSession(state);
    const page = session.page as unknown as {
      evaluate(fn: unknown, arg?: unknown): Promise<unknown>;
    };
    const evaluate = page.evaluate.bind(page);
    const status = () => ({
      running: true,
      scale,
      stepSeconds: 1 / 60,
      frames,
      gameSeconds: frames / 60,
      wallSeconds: 0,
      checks: checks.length,
      heldSeconds: 0,
    });
    page.evaluate = async (fn, arg) => {
      if (!String(fn).includes('clock?.(')) return await evaluate(fn, arg);
      const request = arg as { action?: string; frames?: number; read?: string };
      if (request.frames === undefined) {
        events.push(`clock ${request.action}`);
        return status();
      }
      if (latencyMs > 0) await new Promise((done) => setTimeout(done, latencyMs));
      if (!running()) return { status: { running: false, error: 'app-dispatch-refused {}' } };
      frames += request.frames;
      events.push(`step ${request.frames}`);
      if (request.read === undefined) return { status: status() };
      checks.push(frames);
      return { status: status(), state: state() };
    };
    const rec: PlayRecorder = { ...recorder(), timeScale: scale };
    const play = createPlayContext(session, rec, tmpdir(), 1000);
    return { play, rec, events, checks, frames: () => frames };
  }

  it('checks a predicate every 3 frames of game time whatever the evaluation latency', async () => {
    const runs = [];
    for (const latencyMs of [0, 40]) {
      const run = lockstep(4, { latencyMs, edgeFrame: 10 });
      const started = Date.now();
      const reached = await run.play.keyboard.hold('KeyW', (s: { edge: boolean }) => s.edge);
      runs.push({
        reached,
        checks: run.checks,
        events: run.events.filter((event) => !event.startsWith('read')),
        ms: Date.now() - started,
      });
    }
    const [fast, slow] = runs;
    // The key goes down before frame 1 and up right after the first check that holds.
    expect(fast?.events).toEqual(['down KeyW', 'step 3', 'step 3', 'step 3', 'step 3', 'up KeyW']);
    expect(fast?.checks).toEqual([3, 6, 9, 12]);
    expect(fast?.reached).toEqual({ frames: 12, edge: true, ready: false });
    // A slow page changes how long the run takes, never which frames it checks.
    expect(slow?.events).toEqual(fast?.events);
    expect(slow?.checks).toEqual(fast?.checks);
    expect(slow?.reached).toEqual(fast?.reached);
    expect(slow?.ms ?? 0).toBeGreaterThanOrEqual(4 * 40 - 5);
  });

  it('steps waits and timed holds as game time and never sleeps on the wall clock', async () => {
    const run = lockstep(4);
    await run.play.wait(1000);
    expect(run.frames()).toBe(60);
    await run.play.wait(2500);
    expect(run.frames()).toBe(210);
    await run.play.keyboard.hold('KeyW', 500);
    expect(run.frames()).toBe(240);
    expect(run.events).toEqual([
      'step 60',
      'step 60',
      'step 60',
      'step 30',
      'down KeyW',
      'step 30',
      'up KeyW',
    ]);
    expect(run.rec.clock).toMatchObject({ running: true, scale: 4, frames: 240 });
  });

  it('times a wait out after its game time in frames, not wall time', async () => {
    const run = lockstep(4, { latencyMs: 30 });
    const timedOut = await run.play
      .waitFor((state: { ready: boolean }) => state.ready, { timeoutMs: 100 })
      .catch((error: unknown) => error);
    expect(timedOut).toMatchObject({
      reason: 'wait-timeout',
      message: 'State predicate stayed false for 100 ms of game time',
      state: { frames: 6 },
    });
    expect(run.checks).toEqual([3, 6]);
  });

  it('holds presses and clicks for whole stepped frames', async () => {
    const run = lockstep(2);
    await run.play.keyboard.press('Shift+KeyA');
    await run.play.mouse.click([0.5, 0.5]);
    await run.play.mouse.look(5, 0);
    expect(run.events.filter((event) => !event.startsWith('hit-test'))).toEqual([
      'down Shift',
      'down KeyA',
      'step 3',
      'up KeyA',
      'up Shift',
      'move 110,70',
      'down mouse',
      'step 3',
      'up mouse',
      'look {"dx":5,"dy":0}',
      'move 110,70',
      'move 115,70',
      'step 2',
    ]);
  });

  it('fails a wait with clock-failed once the page clock stopped', async () => {
    let stopped = false;
    const halted = lockstep(4, { running: () => !stopped });
    stopped = true;
    await expect(halted.play.wait(100)).rejects.toMatchObject({
      reason: 'clock-failed',
      message: expect.stringContaining('app-dispatch-refused'),
    });
  });

  it('keeps real-time waits on the wall clock without touching the page clock', async () => {
    const { session, events } = fakeSession(() => ({}));
    const play = createPlayContext(session, recorder(), tmpdir(), 1000);
    await play.wait(300);
    expect(events).toEqual(['wait 300']);
  });

  it('records the scale, marks a scaled run non-final and keeps the scale in the rerun', () => {
    expect(finalFields({})).toEqual({ timeScale: 1 });
    const fields = finalFields({
      timeScale: 4,
      clock: {
        running: false,
        scale: 4,
        stepSeconds: 1 / 60,
        frames: 240,
        gameSeconds: 4,
        wallSeconds: 1,
        checks: 80,
        heldSeconds: 0.25,
      },
    });
    expect(fields).toEqual({
      timeScale: 4,
      clock: {
        stepSeconds: 1 / 60,
        frames: 240,
        gameSeconds: 4,
        wallSeconds: 1,
        checks: 80,
        heldSeconds: 0.25,
      },
      final: false,
      nonFinal: ['time scale 4'],
    });
    expect(rerunCommand({ script: 'scripts/p.mjs', timeScale: 4 }, 'walk')).toBe(
      'forgeax project play scripts/p.mjs --from walk --time-scale 4 --json',
    );
    expect(rerunCommand({ script: 'scripts/p.mjs', timeScale: 1 }, 'walk')).toBe(
      'forgeax project play scripts/p.mjs --from walk --json',
    );
    const value = playResultValue(report({ ...fields }), false);
    expect(value).toMatchObject({ final: false, nonFinal: ['time scale 4'] });
  });

  it('rejects a time scale outside its bounds before starting anything', async () => {
    for (const timeScale of [0, -1, 17, Number.NaN]) {
      const result = await playCommand({ root: tmpdir(), script: 'x.mjs', timeScale });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'tool-invalid-args', expected: expect.stringContaining('--time-scale') },
      });
    }
  });
});

describe('release play', () => {
  it('refuses development-only flags and a missing build before starting anything', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-play-release-'));
    try {
      const scaled = await playCommand({ root, script: 'x.mjs', release: true, timeScale: 4 });
      expect(scaled).toMatchObject({
        ok: false,
        error: {
          code: 'tool-invalid-args',
          detail: { reason: 'release-unsupported-flag', flags: ['--time-scale'] },
        },
      });
      expect(releaseArgsError({ release: true, session: true }, 1)?.detail).toMatchObject({
        flags: ['--session'],
      });
      expect(releaseArgsError({ release: false, session: true }, 4)).toBeUndefined();
      expect(releaseArgsError({ release: true, headers: 'none' }, 1)).toBeUndefined();
      expect(releaseArgsError({ release: false, headers: 'none' }, 1)?.detail).toMatchObject({
        reason: 'release-headers-without-release',
      });
      expect(
        releaseArgsError({ release: true, headers: 'open' as 'none' }, 1)?.detail,
      ).toMatchObject({ reason: 'release-headers-invalid', headers: 'open' });
      const missing = await playCommand({ root, script: 'x.mjs', release: true });
      expect(missing).toMatchObject({
        ok: false,
        error: {
          code: 'play-not-ready',
          hint: expect.stringContaining('forgeax project build'),
          detail: { reason: 'release-missing', dist: 'dist' },
        },
      });
      // No play output and no lock: the refusal came before the run.
      await expect(stat(resolve(root, '.forgeax/play/lock.json'))).rejects.toThrow();
      await mkdir(resolve(root, 'out'), { recursive: true });
      await writeFile(resolve(root, 'out/forgeax-dist.json'), '{"schemaVersion":"0"}');
      const invalid = await admitRelease(root, 'out');
      expect(invalid).toMatchObject({
        ok: false,
        error: {
          code: 'play-not-ready',
          detail: {
            reason: 'release-invalid',
            dist: 'out',
            cause: { code: 'dist-manifest-invalid' },
          },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies only other hosts as external', () => {
    for (const url of [
      'http://127.0.0.1:4173/assets/a.js',
      'http://localhost:5173/',
      'ws://[::1]:9000/',
      'http://game.localhost/x',
      'data:text/plain,hi',
      'blob:http://127.0.0.1/abc',
    ])
      expect(isExternalUrl(new URL(url)), url).toBe(false);
    for (const url of ['https://example.com/x', 'wss://cdn.example.org/s', 'http://10.0.0.2/'])
      expect(isExternalUrl(new URL(url)), url).toBe(true);
  });

  it('fails an otherwise passing run on external requests and names them', () => {
    expect(externalRequestFailure([])).toBeUndefined();
    const failure = externalRequestFailure(['https://example.com/font.woff2']);
    expect(failure).toMatchObject({ code: 'play-runtime-failed', reason: 'external-request' });
    const urls = Array.from(
      { length: 12 },
      (_, i) => `https://example.com/${'x'.repeat(200)}/${i}`,
    );
    const field = externalRequestsField(urls);
    expect(field).toHaveLength(11);
    expect(field.at(-1)).toBe('+2 more');
    expect(field.every((url) => url.length <= 160)).toBe(true);
    const failed = report({
      passed: false,
      mode: 'release',
      dist: 'dist',
      externalRequests: field,
      ...(failure === undefined ? {} : { failure }),
    });
    const error = playFailureError(failed);
    expect(error).toMatchObject({
      code: 'play-runtime-failed',
      hint: expect.stringContaining('externalRequests'),
      detail: { reason: 'external-request', externalRequests: expect.any(Array) },
    });
    expect(JSON.stringify(error).length).toBeLessThanOrEqual(PLAY_COMPACT_BYTES + 100);
    expect(playResultValue(report({ mode: 'release', dist: 'dist' }), false)).toMatchObject({
      mode: 'release',
    });
    expect(
      rerunCommand({ script: 'p.mjs', timeScale: 1, mode: 'release', dist: 'dist' }, 'b'),
    ).toBe('forgeax project play p.mjs --from b --release --json');
    expect(rerunCommand({ script: 'p.mjs', timeScale: 1, mode: 'release', dist: 'out' })).toBe(
      'forgeax project play p.mjs --release --dist out --json',
    );
    expect(
      playResultValue(report({ mode: 'release', dist: 'dist', headers: 'none' }), false),
    ).toMatchObject({ mode: 'release', headers: 'none' });
    expect(
      rerunCommand({
        script: 'p.mjs',
        timeScale: 1,
        mode: 'release',
        dist: 'dist',
        headers: 'none',
      }),
    ).toBe('forgeax project play p.mjs --release --headers none --json');
  });

  it('reads the registered projection on a release page and refuses development-only stepping', async () => {
    const calls: unknown[] = [];
    const page = {
      evaluate: async (_fn: unknown, arg?: unknown) => {
        calls.push(arg);
        return arg === undefined ? ['game.round'] : { phase: 'playing' };
      },
    } as unknown as Page;
    const rec = { ...recorder(), release: true };
    const play = createPlayContext({ page } as BrowserCaptureSession, rec, '/tmp/out', 1000);
    // One script serves both runs: the read projection is on every build.
    expect(play.release).toBe(true);
    expect(
      createPlayContext({ page } as BrowserCaptureSession, recorder(), '/tmp/out', 1000).release,
    ).toBe(false);
    await expect(play.state()).resolves.toEqual({ phase: 'playing' });
    await expect(play.state('game.round')).resolves.toEqual({ phase: 'playing' });
    await expect(
      play.waitFor((s: unknown) => (s as { phase: string }).phase === 'playing', {
        timeoutMs: 200,
      }),
    ).resolves.toBeDefined();
    await expect(play.advance(1)).rejects.toMatchObject({
      reason: 'advance-failed',
      message: expect.stringContaining('release build'),
    });
    // A release page whose game registers no read says so instead of blaming the build.
    const none = createPlayContext(
      { page: { evaluate: async () => [] } as unknown as Page } as BrowserCaptureSession,
      { ...recorder(), release: true },
      '/tmp/out',
      1000,
    );
    await expect(none.state()).rejects.toMatchObject({
      reason: 'state-unavailable',
      message: expect.stringContaining('registerRead'),
    });
  });
});
