import { setTimeout as delay } from 'node:timers/promises';

const leasesByRenderer = new WeakMap();

/** Resolve the Result returned by the public runtime renderer factory. */
export async function createSmokeRenderer(createRenderer, ...args) {
  const created = await createRenderer(...args);
  if (!created.ok) throw created.error;
  return created.value;
}

/** Read backend capability data without reaching into Renderer internals. */
export function rendererBackend(renderer) {
  return renderer.inspect().capabilities.backendKind;
}

/** Subscribe to the single structured renderer event stream used by smokes. */
export function subscribeSmokeErrors(renderer, listener) {
  return renderer.subscribe((event) => {
    if (event.kind === 'error') listener(event.error);
  });
}

/**
 * Drive the lease-bound public frame contract for a single-world smoke.
 * The cache keeps the helper from allocating a new lease on every frame while
 * allowing legacy fixtures to pass their World only at this test boundary.
 */
export function drawSmokeFrame(renderer, world) {
  let leasesByWorld = leasesByRenderer.get(renderer);
  if (leasesByWorld === undefined) {
    leasesByWorld = new WeakMap();
    leasesByRenderer.set(renderer, leasesByWorld);
  }
  let lease = leasesByWorld.get(world);
  if (lease === undefined) {
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    lease = attached.value;
    leasesByWorld.set(world, lease);
  }
  return renderer.draw({
    leases: [lease],
    camera: { lease },
    environment: { lease },
  });
}

/** Count real ready GPU completions while pumping the smoke's original RAF queue. */
export async function runSmokeAppFrames(app, pumpFrame, count) {
  const deadline = Date.now() + 30_000;
  let creditDeadline = Math.min(deadline, Date.now() + 5_000);
  let receipt;
  let failure;
  let ready = 0;
  const unsubscribe = app.renderer.subscribe((event) => {
    if (event.kind !== 'frame-submitted') return;
    // Retain the original rejecting promise for the awaited result, while
    // owning its rejection immediately during the RAF-to-receipt handoff.
    event.receipt.completed.catch(() => {});
    if (receipt !== undefined) {
      failure ??= new Error('Smoke received overlapping unconsumed frame receipts');
      return;
    }
    receipt = event.receipt;
  });
  try {
    const started = app.start();
    if (!started.ok) throw started.error;
    while (ready < count) {
      if (failure !== undefined) throw failure;
      if (Date.now() >= deadline) throw new Error(`Smoke did not complete ${count} ready frames within 30000ms (ready=${ready})`);
      if (receipt === undefined) {
        if (Date.now() >= creditDeadline) throw new Error('Smoke App did not submit a frame within 5000ms');
        if (!pumpFrame()) throw new Error('Smoke App exhausted its RAF queue before ready frames completed');
        await delay(1);
        continue;
      }
      const current = receipt;
      receipt = undefined;
      let timer;
      const completed = await Promise.race([
        current.completed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Smoke GPU frame completion exceeded its credit budget')), Math.min(5_000, Math.max(1, deadline - Date.now())));
        }),
      ]).finally(() => clearTimeout(timer));
      if (!completed.ok) throw completed.error;
      if (failure !== undefined) throw failure;
      if (Date.now() >= deadline) throw new Error(`Smoke completed outside its 30000ms ready budget (ready=${ready})`);
      if (current.presentation === 'ready') ready++;
      creditDeadline = Math.min(deadline, Date.now() + 5_000);
    }
    return ready;
  } finally {
    unsubscribe();
    app.stop();
  }
}
