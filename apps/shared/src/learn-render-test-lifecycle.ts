export interface LearnRenderTestApp {
  renderer: {
    dispose(): void;
  };
  dispose(): Promise<unknown>;
}

interface LearnRenderTestLifecycle {
  owner?: object | undefined;
  app?: LearnRenderTestApp | undefined;
  bootstraps: Map<object, Promise<unknown>>;
  bootstrapStages: Map<object, BootstrapStage>;
  closedOwners: WeakSet<object>;
  pendingDisposal?: Promise<void> | undefined;
  disposalErrors: unknown[];
}

interface BootstrapStage {
  readonly name: string;
  readonly startedAt: number;
}

const LIFECYCLE_KEY = '__forgeaxLearnRenderTestLifecycle';

function lifecycle(): LearnRenderTestLifecycle {
  const scope = globalThis as typeof globalThis & {
    [LIFECYCLE_KEY]?: LearnRenderTestLifecycle;
  };
  const existing = scope[LIFECYCLE_KEY];
  if (existing !== undefined) return existing;
  const created: LearnRenderTestLifecycle = {
    bootstraps: new Map(),
    bootstrapStages: new Map(),
    closedOwners: new WeakSet(),
    disposalErrors: [],
  };
  scope[LIFECYCLE_KEY] = created;
  return created;
}

async function disposeApp(app: LearnRenderTestApp): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    const result = await app.dispose();
    if (
      typeof result === 'object' &&
      result !== null &&
      (result as { ok?: unknown }).ok === false
    ) {
      failed = true;
      failure =
        (result as { error?: unknown }).error ??
        new Error('learn-render App disposal returned err');
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    app.renderer.dispose();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

function enqueueDisposal(state: LearnRenderTestLifecycle, app: LearnRenderTestApp): void {
  const previous = state.pendingDisposal;
  const disposal = previous === undefined ? disposeApp(app) : previous.then(() => disposeApp(app));
  const next = disposal.catch((error: unknown) => {
    state.disposalErrors.push(error);
  });
  state.pendingDisposal = next;
}

async function drainDisposals(state: LearnRenderTestLifecycle): Promise<void> {
  while (state.pendingDisposal !== undefined) {
    const pending = state.pendingDisposal;
    await pending;
    if (state.pendingDisposal === pending) state.pendingDisposal = undefined;
  }
  const failures = state.disposalErrors.splice(0);
  if (failures.length > 0) throw failures[0];
}

async function drainBootstraps(state: LearnRenderTestLifecycle): Promise<void> {
  let failure: unknown;
  let failed = false;
  while (state.bootstraps.size > 0) {
    const entries = [...state.bootstraps.entries()];
    for (const [owner, bootstrap] of entries) {
      try {
        await bootstrap;
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      } finally {
        if (state.bootstraps.get(owner) === bootstrap) state.bootstraps.delete(owner);
      }
    }
  }
  if (failed) throw failure;
}

async function waitForBootstrap(
  state: LearnRenderTestLifecycle,
  owner: object,
  timeoutMs = 0,
): Promise<void> {
  const bootstrap = state.bootstraps.get(owner);
  if (bootstrap === undefined) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout =
    timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const stage = state.bootstrapStages.get(owner);
            const elapsedMs = stage === undefined ? 0 : Date.now() - stage.startedAt;
            reject(
              new Error(
                `[learn-render bootstrap] timed out after ${timeoutMs}ms; stage=${stage?.name ?? 'unknown'}; stageElapsedMs=${elapsedMs}`,
              ),
            );
          }, timeoutMs);
        })
      : undefined;
  try {
    await (timeout === undefined ? bootstrap : Promise.race([bootstrap, timeout]));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (state.bootstraps.get(owner) === bootstrap) state.bootstraps.delete(owner);
  }
}

/** Record the current async bootstrap stage for bounded browser failures. */
export function markLearnRenderTestBootstrapStage(owner: object, name: string): void {
  const state = lifecycle();
  state.bootstrapStages.set(owner, { name, startedAt: Date.now() });
}

/** Read the existing owner stage before failure cleanup removes it. */
export function learnRenderTestBootstrapStage(owner: object): Readonly<BootstrapStage> | undefined {
  return lifecycle().bootstrapStages.get(owner);
}

/** Track the asynchronous SUT bootstrap so teardown cannot race its App creation. */
export function trackLearnRenderTestBootstrap(bootstrap: Promise<unknown>, owner: object): void {
  const state = lifecycle();
  // A real browser smoke starts the app from the page entry, so there is no
  // Vitest owner to call beginLearnRenderTestLifecycle first. Claim that owner
  // before exposing the App; test callers already set the same owner explicitly.
  if (state.owner === undefined) state.owner = owner;
  const tracked = Promise.resolve(bootstrap);
  state.bootstraps.set(owner, tracked);
  // Keep rejection observed until the browser gate drains it, while preserving
  // the rejection for the gate's fail-closed await.
  void tracked.catch(() => undefined);
}

/** Wait for the current SUT bootstrap without changing ownership or disposal state. */
export async function waitForLearnRenderTestBootstrap(owner: object, timeoutMs = 0): Promise<void> {
  await waitForBootstrap(lifecycle(), owner, timeoutMs);
}

/** Mark the canvas/test scope that is allowed to own the next App. */
export async function beginLearnRenderTestLifecycle(owner: object): Promise<void> {
  const state = lifecycle();
  const staleApp = state.app;
  state.owner = owner;
  state.app = undefined;
  if (staleApp !== undefined) enqueueDisposal(state, staleApp);
  let failure: unknown;
  let failed = false;
  try {
    await drainBootstraps(state);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await drainDisposals(state);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}

/** Register the current demo App so a browser error-gate can close its GPU owner. */
export function exposeLearnRenderTestApp(app: LearnRenderTestApp, owner: object): void {
  const state = lifecycle();
  // Standalone browser smoke harnesses do not run the Vitest onerror-gate
  // setup, so there is no pre-admitted owner. Let the first SUT register its
  // own canvas; an explicitly admitted owner still retains the stale-App
  // protection below.
  if (state.owner === undefined) state.owner = owner;
  if (state.closedOwners.has(owner) || state.owner !== owner) {
    enqueueDisposal(state, app);
    return;
  }
  state.app = app;
}

/** Dispose and clear the current demo App; safe to call when bootstrap failed. */
export async function disposeLearnRenderTestApp(owner: object, timeoutMs = 0): Promise<void> {
  const state = lifecycle();
  // Close the owner before awaiting a pending bootstrap so a late App cannot
  // be retained in the test scope while teardown is already in flight.
  state.closedOwners.add(owner);
  let failure: unknown;
  let failed = false;
  try {
    await waitForBootstrap(state, owner, timeoutMs);
  } catch (error) {
    failed = true;
    failure = error;
    if (state.bootstraps.has(owner)) state.bootstraps.delete(owner);
  }
  if (state.owner === owner) {
    state.bootstrapStages.delete(owner);
    const app = state.app;
    state.owner = undefined;
    state.app = undefined;
    if (app !== undefined) {
      // App.dispose() owns the loop and plugin context; the browser test owns
      // the renderer returned by createApp and must release its GPU device too.
      enqueueDisposal(state, app);
    }
  }
  try {
    await drainBootstraps(state);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  try {
    await drainDisposals(state);
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (failed) throw failure;
}
