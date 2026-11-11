import { describe, expect, it } from 'vitest';
import { createPlayClock, type PlayClockApp } from '../play-clock.js';

const STEP = 1 / 60;

/** An App stand-in that integrates a held input on every stepped frame. */
function fakeApp(refuse: (call: number) => 'credit' | 'fail' | undefined = () => undefined) {
  const log: string[] = [];
  const world = { frames: 0, seconds: 0, rendered: [] as number[] };
  let calls = 0;
  let paused = false;
  const app: PlayClockApp = {
    pause() {
      if (paused) return { ok: false };
      paused = true;
      log.push('pause');
      return { ok: true };
    },
    resume() {
      paused = false;
      log.push('resume');
      return { ok: true };
    },
    stepFrame(delta, options) {
      calls += 1;
      const refusal = refuse(calls);
      if (refusal !== undefined)
        return {
          ok: false,
          error: {
            code: 'app-dispatch-refused',
            detail: { reason: refusal === 'credit' ? 'credit' : 'state' },
          },
        };
      world.frames += 1;
      world.seconds += delta;
      if (options.render) world.rendered.push(world.frames);
      return { ok: true };
    },
  };
  return { app, log, world, isPaused: () => paused };
}

/** A manual wall clock: time moves only when the test or a clock delay moves it. */
function fakeEnvironment() {
  let now = 1000;
  let idles = 0;
  const delays: number[] = [];
  return {
    environment: {
      now: () => now,
      async delay(ms: number) {
        delays.push(ms);
        now += ms;
      },
      async idle() {
        idles += 1;
      },
    },
    pass(ms: number) {
      now += ms;
    },
    now: () => now,
    delays,
    idles: () => idles,
  };
}

describe('play clock', () => {
  it('stands still until asked, then steps exactly the requested fixed frames', async () => {
    const { app, world, log } = fakeApp();
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 4, STEP, wall.environment);
    expect(log).toEqual(['pause']);
    // Wall time alone never moves game time.
    wall.pass(5000);
    expect(world.frames).toBe(0);
    const status = await clock.step(3);
    expect(world.frames).toBe(3);
    expect(world.seconds).toBeCloseTo(3 * STEP, 12);
    // Only the last frame of a request renders.
    expect(world.rendered).toEqual([3]);
    expect(status).toMatchObject({ running: true, frames: 3, checks: 1, heldSeconds: 0 });
    expect(status.gameSeconds).toBeCloseTo(0.05, 12);
    expect(clock.stop()).toMatchObject({ running: false, frames: 3 });
    expect(log).toEqual(['pause', 'resume']);
  });

  it('caps game time at scale times wall time and renders the frames it held back', async () => {
    const { app, world } = fakeApp();
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 4, STEP, wall.environment, 3);
    const startWall = wall.now();
    // 240 frames are 4 game seconds; at 4x they need one wall second (less the burst).
    await clock.step(240);
    const wallMs = wall.now() - startWall;
    expect(world.frames).toBe(240);
    expect(wallMs).toBeGreaterThanOrEqual(1000 - (3 * 1000) / 60 / 4 - 1e-6);
    expect(wallMs).toBeLessThan(1000 + 240);
    const status = clock.status();
    expect(status.heldSeconds).toBeGreaterThan(0.9);
    expect(world.rendered.length).toBeGreaterThan(200);
  });

  it('does not bank speed-cap credit beyond its burst while the script is busy', async () => {
    const { app } = fakeApp();
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 2, STEP, wall.environment, 3);
    wall.pass(10_000);
    await clock.step(30);
    // Ten idle wall seconds bank 3 frames, so 27 frames still wait at 2x: 27/120 s.
    expect(clock.status().heldSeconds).toBeGreaterThanOrEqual(27 / 120 - 0.03);
  });

  it('banks the slack of slow checks for later waits, up to one game second', async () => {
    const { app } = fakeApp();
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 4, STEP, wall.environment);
    // Drain the initial bank, then 20 checks of 3 frames, each 40 ms of wall time:
    // 160 ms bank 0.64 s at 4x, so a 30-frame wait after them is not held back.
    await clock.step(60);
    const held = clock.status().heldSeconds;
    for (let check = 0; check < 20; check += 1) {
      wall.pass(40);
      await clock.step(3);
    }
    await clock.step(30);
    expect(clock.status().heldSeconds).toBeCloseTo(held, 9);
    // Ten idle wall seconds still bank only one second: 120 frames then wait 0.25 s.
    wall.pass(10_000);
    await clock.step(120);
    expect(clock.status().heldSeconds - held).toBeGreaterThanOrEqual(0.25 - 0.02);
    expect(clock.status().heldSeconds - held).toBeLessThan(0.25 + 0.05);
  });

  it('serves fast scales without holding back while the caller is slower than the cap', async () => {
    const { app } = fakeApp();
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 16, STEP, wall.environment);
    for (let check = 0; check < 20; check += 1) {
      wall.pass(20);
      await clock.step(3);
    }
    expect(clock.status()).toMatchObject({ frames: 60, checks: 20, heldSeconds: 0 });
  });

  it('retries a step refused for an in-flight frame once the page is idle', async () => {
    const { app, world } = fakeApp((call) => (call === 2 ? 'credit' : undefined));
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 16, STEP, wall.environment);
    const status = await clock.step(3);
    expect(world.frames).toBe(3);
    expect(wall.idles()).toBe(1);
    expect(status).toMatchObject({ running: true, frames: 3 });
  });

  it('stops and resumes the App when a step fails for another reason', async () => {
    const { app, log, isPaused } = fakeApp((call) => (call === 3 ? 'fail' : undefined));
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 16, STEP, wall.environment);
    const status = await clock.step(6);
    expect(status).toMatchObject({
      running: false,
      frames: 2,
      error: expect.stringContaining('app-dispatch-refused'),
    });
    expect(log).toEqual(['pause', 'resume']);
    expect(isPaused()).toBe(false);
    // A stopped clock steps nothing more.
    expect(await clock.step(3)).toMatchObject({ running: false, frames: 2 });
  });

  it('runs concurrent requests one after another', async () => {
    const { app, world } = fakeApp();
    const wall = fakeEnvironment();
    // At 2x the cap holds frames back, so an unqueued second request would interleave.
    const clock = createPlayClock(app, 2, STEP, wall.environment, 3);
    const [first, second] = await Promise.all([clock.step(6), clock.step(6)]);
    expect(first.frames).toBe(6);
    expect(second.frames).toBe(12);
    expect(world.rendered).toEqual(expect.arrayContaining([6, 12]));
  });

  it('counts time another caller stepped as game time without banking credit', async () => {
    const { app, world } = fakeApp();
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 2, STEP, wall.environment, 3);
    await clock.step(30);
    const release = clock.suspend();
    wall.pass(2000);
    release(3);
    release(3);
    await clock.step(30);
    expect(world.frames).toBe(60);
    expect(clock.status().gameSeconds).toBeCloseTo(4, 9);
  });

  it('reports a clock that cannot pause the App instead of stepping a running loop', async () => {
    const { app, world } = fakeApp();
    app.pause();
    const wall = fakeEnvironment();
    const clock = createPlayClock(app, 4, STEP, wall.environment);
    expect(clock.status()).toMatchObject({ running: false, error: expect.any(String) });
    await clock.step(3);
    expect(world.frames).toBe(0);
  });

  it('is self-contained source the development page can embed', async () => {
    const source = createPlayClock.toString();
    const embedded = new Function(`return (${source});`)() as typeof createPlayClock;
    const { app, world } = fakeApp();
    const wall = fakeEnvironment();
    const clock = embedded(app, 3, STEP, wall.environment, 3);
    await clock.step(180);
    expect(world.frames).toBe(180);
    expect(wall.now() - 1000).toBeGreaterThanOrEqual(1000 - 20);
  });
});
