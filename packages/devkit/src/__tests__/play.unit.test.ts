import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ToolExecutionContext } from '@forgeax/engine-tool-runtime';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCaptureRecord, BrowserCaptureSession } from '../browser-capture.js';
import { captureRenderFailure } from '../capture-render-failure.js';
import {
  clearPreviousRun,
  createPlayContext,
  finalCaptureCheck,
  PLAY_COMPACT_BYTES,
  type PlayRecorder,
  type PlayReport,
  playCommand,
  playExpectationLine,
  playFailureError,
  playLockWaitMs,
  playOutputDir,
  playResultValue,
  startPlayProgress,
  summarizeValue,
} from '../play.js';
import { acquirePlayLock } from '../play-lock.js';
import { createUnifiedCommandContributions } from '../tools/unified-contributions.js';

function recorder(): PlayRecorder {
  return {
    steps: [],
    screenshots: [],
    log: [],
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
) {
  const events: string[] = [];
  let frame = 0;
  const page = {
    async evaluate(fn: unknown, arg?: unknown) {
      const source = String(fn);
      if (source.includes('frame?.completed')) {
        frame += framesPerPoll;
        return frame;
      }
      if (source.includes('.advance?.(')) {
        events.push(`advance ${JSON.stringify(arg)}`);
        return { ok: true, frames: 1 };
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
    },
    keyboard: {
      down: async (key: string) => events.push(`down ${key}`),
      up: async (key: string) => events.push(`up ${key}`),
    },
    mouse: {
      move: async (x: number, y: number) => events.push(`move ${x},${y}`),
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
    schemaVersion: '1.0.0',
    passed: true,
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
    layout: [],
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
      'down mouse',
      ...held,
      'up mouse',
      'move 210,120',
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

  it('reports layout warnings compactly and keeps them when the byte budget is tight', () => {
    const layout = Array.from({ length: 5 }, (_unused, index) => ({
      viewport: '1280x600',
      kind: 'text-over-panel' as const,
      a: `#intro "Night ${index} falls over the lighthouse"`,
      b: '#bottom-bar',
    }));
    const value = playResultValue(
      report({ layout, state: { blob: 'x'.repeat(2_000) }, returned: { more: 'y'.repeat(2_000) } }),
      false,
    ) as Record<string, unknown>;
    expect(value.layout).toEqual([
      '1280x600 text-over-panel #intro "Night 0 falls over the lighthouse" vs #bottom-bar',
      '1280x600 text-over-panel #intro "Night 1 falls over the lighthouse" vs #bottom-bar',
      '1280x600 text-over-panel #intro "Night 2 falls over the lighthouse" vs #bottom-bar',
      '+2 more',
    ]);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
    expect('layout' in (playResultValue(report(), false) as object)).toBe(false);
  });

  it('keeps a CJK, long-path worst case within the byte budget, shrinking layout to one line', () => {
    // Four CJK ideographs (three UTF-8 bytes each), escaped for the English-only source rule.
    const cjk = '\u706f\u5854\u5b88\u591c'.repeat(60);
    const layout = Array.from({ length: 20 }, () => ({
      viewport: '1280x600',
      kind: 'text-over-panel' as const,
      a: `#intro "${cjk}"`,
      b: `#${cjk}`,
    }));
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
        layout,
        state: { [cjk]: cjk },
        returned: { [cjk]: cjk },
      }),
      false,
    ) as Record<string, unknown>;
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(PLAY_COMPACT_BYTES);
    expect(value.layout).toEqual([expect.stringMatching(/^1280x600 text-over-panel/), '+19 more']);
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
