import { createApp } from '../../packages/app/dist/browser.mjs';
import {
  FORGEAX_FRAME_COMPLETED_EVENT,
  FORGEAX_FRAME_SUBMITTED_EVENT,
} from '../../packages/app/dist/index.mjs';
import { distribution } from './level-streaming-runtime.mjs';

const selectionTargets = ['active', 'prepared', 'active', 'prepared'];

/** Observe the ordinary Host, Engine Worker and Render Worker route with the frozen workload. */
export async function runSplitLevelBenchmark(
  canvas,
  fixture,
  { firstCycle, isolateCopies, progress, shadowWorkload, traceLogic },
) {
  const { profile, rootGuid, producer, catalogUrl, expectedScope, hostIdentity } = fixture;
  const diagnostic = firstCycle || isolateCopies !== undefined;
  const report = {
    backend: 'chromium-webgpu-split',
    identity: {
      ...hostIdentity,
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      clock: { timeOrigin: performance.timeOrigin, beginMs: performance.now() },
    },
    profile,
    producer,
    frames: [],
    cohorts: [],
    failures: [],
    qualified: false,
    instrumentation: { shadowWorkload, traceLogic },
    pendingEvidence: [
      'Match local and split runs under equivalent host load.',
      'Capture native resource custody and creation by owner, image and shadow readback, and GPU quality.',
    ],
  };
  const logicWindows = traceLogic
    ? [{ phase: 'initialization', at: performance.now() }]
    : undefined;
  let phase = 'initialization';
  progress({ phase, frames: 0 });
  let lastReady;
  const submittedPhases = new Map();
  const readyByPhase = new Map();
  const readyIn = (label) => readyByPhase.get(label) ?? 0;
  let failure;
  let app;
  const channel = new MessageChannel();
  const link = sourceRequests(channel.port1);
  const setPhase = (next) => {
    phase = next;
    logicWindows?.push({ phase, at: performance.now() });
    progress({ phase, frames: report.frames.length });
  };
  const recordSubmission = ({ detail }) => {
    const {
      frameId,
      presentation,
      engineUpdateMs,
      engineCreditWaitMs,
      renderDrawCpuMs,
      renderDrawIntervalMs,
      renderAwaitMs,
      renderQueuedMs,
      renderStallReason,
      renderGraphCompiles,
      renderPipelineCreations,
      rhiCommands,
      publicationBytes,
    } = detail;
    submittedPhases.set(frameId, phase);
    report.frames.push({
      phase,
      kind: 'submitted',
      at: performance.now(),
      frameId,
      presentation,
      engineUpdateMs,
      engineCreditWaitMs,
      renderDrawCpuMs,
      renderDrawIntervalMs,
      renderAwaitMs,
      renderQueuedMs,
      renderStallReason,
      renderGraphCompiles,
      renderPipelineCreations,
      rhiCommands,
      publicationBytes,
    });
  };
  const recordCompletion = ({ detail }) => {
    const at = performance.now();
    const { frameId, presentation, renderSubmitToCompleteMs, shadowWorkload: shadows } = detail;
    const submittedPhase = submittedPhases.get(frameId);
    submittedPhases.delete(frameId);
    const intervalMs = presentation === 'ready' && lastReady !== undefined ? at - lastReady : null;
    if (presentation === 'ready') {
      if (submittedPhase !== undefined)
        readyByPhase.set(submittedPhase, readyIn(submittedPhase) + 1);
      lastReady = at;
    }
    report.frames.push({
      phase,
      submittedPhase,
      kind: 'completed',
      at,
      frameId,
      presentation,
      intervalMs,
      renderSubmitToCompleteMs,
      ...(shadows === undefined ? {} : { shadows }),
    });
  };
  canvas.addEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, recordSubmission);
  canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, recordCompletion);
  const { call } = link;
  const readUntil = async (ids, label, timeoutMs, accept) => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (failure !== undefined) throw failure;
      const state = await call({ kind: 'read', ids });
      if (accept(state)) return state;
      if (performance.now() >= deadline)
        throw Error(`Deadline exceeded: ${label}`, { cause: state });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const steady = async (label) => {
    setPhase(label);
    const old = await call({ kind: 'read', ids: [] });
    return readUntil(
      [],
      label,
      30_000,
      (state) => readyIn(label) >= 60 && state.updates >= old.updates + 60,
    );
  };
  const prepare = (ids) =>
    readUntil(ids, phase, 180_000, (state) =>
      state.levels.every((level) => level.phase === 'prepared' && level.current),
    );
  const retire = async (ids, timeoutMs) => {
    for (const id of ids) await call({ kind: 'target', id, target: 'unloaded' });
    await readUntil(ids, phase, timeoutMs, (state) =>
      state.levels.every((level) => level.phase === 'retired'),
    );
    return call({ kind: 'retired', ids });
  };
  const transition = async (id, prefix, sample) => {
    for (const target of selectionTargets) {
      const label = `${prefix}/${target}-${sample.transitions.length}`;
      setPhase(label);
      const start = performance.now();
      const observation = report.frames.length;
      const active = target === 'active';
      const completedSelection = (frameId) =>
        report.frames
          .slice(observation)
          .find(
            (frame) =>
              frame.kind === 'completed' &&
              frame.presentation === 'ready' &&
              frame.frameId === frameId,
          );
      const accepts = (state) => {
        const level = state.levels[0];
        const selection = level.renderSelection;
        return (
          level.phase === target &&
          selection?.active === active &&
          completedSelection(selection.frameId) !== undefined
        );
      };
      await call({ kind: 'target', id, target });
      const state = await readUntil([id], label, 5000, accepts);
      if ((state.hit !== undefined) !== active)
        throw Error(`${label}: Rapier raycast disagrees with participation`);
      sample.transitions.push({
        target,
        elapsedMs: performance.now() - start,
        completedFrameMs: completedSelection(state.levels[0].renderSelection.frameId).at - start,
        ...state,
        renderSelection: state.levels[0].renderSelection,
      });
      if (target === 'active') await steady(`${label}/visible`);
    }
  };
  try {
    const [width, height] = profile.target.drawingBuffer;
    canvas.setAttribute('data-forgeax-render-width-limit', String(width));
    canvas.setAttribute('data-forgeax-render-height-limit', String(height));
    app = (
      await createApp(
        canvas,
        {
          execution: {
            workers: { engine: true, render: true, kernels: false },
            bootstrap: new URL('./level-streaming-split-bootstrap.mjs', import.meta.url),
            bootstrapPort: channel.port2,
            bootstrapData: { profile, rootGuid, producer, traceLogic },
            assetCatalog: { url: catalogUrl, expectedScope },
            startupTimeoutMs: 90_000,
            ...(shadowWorkload ? { diagnostics: { shadowWorkload: true } } : {}),
          },
        },
        { shaderManifestUrl: new URL('/__level/shaders', location.href).href },
      )
    ).unwrap();
    app.onError((cause) => {
      failure ??= cause;
    });
    app.execution.setFrameRateLimit(profile.target.frameRate);
    app.start().unwrap();
    await readUntil(
      [],
      phase,
      30_000,
      (state) => readyIn('initialization') >= 60 && state.updates >= 60,
    );
    report.execution = app.execution.report();
    setPhase('ordinary-cold-load');
    await call({ kind: 'load' });
    const collidersPerLevel = Object.values(profile.streetBlock.colliders).reduce(
      (sum, count) => sum + count,
      0,
    );
    for (const copies of profile.streetBlock.residentInactiveCopies) {
      if (isolateCopies !== undefined && copies !== isolateCopies) continue;
      setPhase(`copies-${copies}/prepare-inactive`);
      const inactive = [];
      for (let i = 0; i < copies; i++) inactive.push(await call({ kind: 'create' }));
      await prepare(inactive);
      const baseline = await steady(`copies-${copies}/baseline`);
      if (baseline.bodies !== copies * collidersPerLevel)
        throw Error(
          `copies-${copies}: prepared inactive Rapier body count differs from the profile`,
          {
            cause: { expected: copies * collidersPerLevel, actual: baseline.bodies },
          },
        );
      const cohort = { copies, baseline, cycles: [] };
      report.cohorts.push(cohort);
      for (let cycle = 0; cycle < profile.streetBlock.repeatCycles; cycle++) {
        const prefix = `copies-${copies}/cycle-${cycle}`;
        setPhase(`${prefix}/prepare`);
        const before = await call({ kind: 'read', ids: inactive });
        const begin = performance.now();
        const id = await call({ kind: 'create' });
        const prepared = await prepare([...inactive, id]);
        const facts = await call({ kind: 'facts', id });
        const sample = {
          cycle,
          preparationMs: performance.now() - begin,
          preparationEngineWork: levelWorkBetween(before, prepared),
          prepared,
          facts,
          transitions: [],
        };
        cohort.cycles.push(sample);
        await transition(id, prefix, sample);
        setPhase(`${prefix}/unload`);
        const unload = performance.now();
        sample.remainingBodies = await retire([id], 5000);
        if (sample.remainingBodies !== baseline.bodies)
          throw Error(`${prefix}: Rapier retains the wrong number of bodies after retirement`, {
            cause: { expected: baseline.bodies, actual: sample.remainingBodies },
          });
        sample.unloadMs = performance.now() - unload;
        if (diagnostic) break;
      }
      if (firstCycle) break;
      cohort.steady = await steady(`copies-${copies}/steady`);
      setPhase(`copies-${copies}/retire-inactive`);
      if ((await retire(inactive, 10000)) !== 0) throw Error('The cohort still owns Rapier bodies');
    }
    await call({ kind: 'release' });
    report.completedProfile = !diagnostic;
  } catch (cause) {
    report.failures.push({
      phase,
      message: cause.message,
      code: cause.code,
      detail: cause.detail,
      stack: cause.stack,
      cause: cause.cause,
    });
  } finally {
    setPhase('stopped-no-frame-close');
    if (logicWindows !== undefined && app !== undefined)
      await observeLogicTiming(report, call, logicWindows);
    try {
      if (app !== undefined) (await app.dispose()).unwrap();
    } catch (cause) {
      report.failures.push({ phase, message: cause.message, stack: cause.stack });
    } finally {
      link.close();
      channel.port2.close();
      canvas.removeEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, recordSubmission);
      canvas.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, recordCompletion);
    }
  }
  const intervals = report.frames.flatMap((frame) =>
    typeof frame.intervalMs === 'number' ? [frame.intervalMs] : [],
  );
  report.intervals = distribution(intervals);
  Object.assign(report, inspectSplitLifecycle(report, profile));
  return report;
}

async function observeLogicTiming(report, call, windows) {
  try {
    const engine = await call({ kind: 'logic-timing' });
    if (engine === undefined) throw Error('Engine Worker fixed timing unavailable');
    report.logicTiming = { hostClock: performance.timeOrigin, windows, engine };
  } catch (cause) {
    report.failures.push({ phase: 'logic-timing', message: cause.message });
  }
}

/** Interpret ordinary completed frames and the exact cuts that changed Level participation. */
export function inspectSplitLifecycle(report, profile) {
  const lifecycle = report.frames.filter((frame) => frame.phase !== 'initialization');
  const ready = lifecycle.filter((frame) => Number.isFinite(frame.intervalMs));
  const readyIntervals = distribution(ready.map((frame) => frame.intervalMs));
  const byFrame = new Map(
    lifecycle.filter((frame) => frame.kind === 'submitted').map((frame) => [frame.frameId, frame]),
  );
  const selections = report.cohorts.flatMap((cohort) =>
    cohort.cycles.flatMap((cycle) =>
      cycle.transitions.map((transition) => {
        const { frameId } = transition.renderSelection;
        const frame = byFrame.get(frameId);
        return {
          copies: cohort.copies,
          cycle: cycle.cycle,
          target: transition.target,
          frameId,
          engineUpdateMs: frame?.engineUpdateMs,
          renderDrawCpuMs: frame?.renderDrawCpuMs,
          renderDrawIntervalMs: frame?.renderDrawIntervalMs,
          renderAwaitMs: frame?.renderAwaitMs,
          renderQueuedMs: frame?.renderQueuedMs,
          renderStallReason: frame?.renderStallReason,
          graphCompiles: frame?.renderGraphCompiles,
          pipelineCreations: frame?.renderPipelineCreations,
          bindGroupCreates: frame?.rhiCommands?.bindGroupCreates,
          bufferCreates: frame?.rhiCommands?.bufferCreates,
          textureCreates: frame?.rhiCommands?.textureCreates,
        };
      }),
    ),
  );
  const creation = selections.filter(
    (value) =>
      ![
        value.graphCompiles,
        value.pipelineCreations,
        value.bindGroupCreates,
        value.bufferCreates,
        value.textureCreates,
      ].every((count) => count === 0),
  );
  const budget = profile.budgets;
  const expectedCopies = profile.streetBlock.residentInactiveCopies;
  const checks = [
    {
      name: 'completed-profile',
      pass:
        report.completedProfile === true &&
        report.cohorts.length === expectedCopies.length &&
        report.cohorts.every(
          (cohort, index) =>
            cohort.copies === expectedCopies[index] &&
            cohort.cycles.length === profile.streetBlock.repeatCycles &&
            cohort.cycles.every(
              (cycle) =>
                cycle.transitions.length === selectionTargets.length &&
                cycle.transitions.every(({ target }, step) => target === selectionTargets[step]),
            ),
        ),
      actual: report.cohorts.map(({ copies, cycles }) => ({ copies, cycles: cycles.length })),
    },
    {
      name: 'ready-interval-p95',
      pass: readyIntervals.p95 !== null && readyIntervals.p95 <= budget.presentationIntervalP95Ms,
      actual: readyIntervals.p95,
      limit: budget.presentationIntervalP95Ms,
    },
    {
      name: 'ready-interval-p99',
      pass: readyIntervals.p99 !== null && readyIntervals.p99 <= budget.presentationIntervalP99Ms,
      actual: readyIntervals.p99,
      limit: budget.presentationIntervalP99Ms,
    },
    {
      name: 'longest-ready-interval',
      pass:
        readyIntervals.max !== null &&
        readyIntervals.max <= budget.maximumLifecycleAttributedPauseMs,
      actual: readyIntervals.max,
      limit: budget.maximumLifecycleAttributedPauseMs,
    },
    {
      name: 'observed-selection-creation',
      pass: selections.length > 0 && creation.length === 0,
      actual: creation,
    },
  ];
  const steady = steadyFrameCosts(report.cohorts, ready, byFrame);
  checks.push(...steadyFrameChecks(steady, budget.maximumSteadyFrameRegressionPercent));
  return {
    readyIntervals,
    readyIntervalsByPhase: summarizeReadyWindows(ready),
    steadyFrameCosts: steady,
    selections,
    checks,
    qualified:
      report.failures.length === 0 &&
      report.pendingEvidence.length === 0 &&
      report.instrumentation?.traceLogic !== true &&
      checks.every((check) => check.pass),
  };
}

function steadyFrameCosts(cohorts, ready, submissions) {
  const frameCosts = new Map();
  for (const { submittedPhase, frameId } of ready) {
    if (submittedPhase === undefined) continue;
    const submitted = submissions.get(frameId);
    if (submitted === undefined) continue;
    let window = frameCosts.get(submittedPhase);
    if (window === undefined) {
      window = { engine: [], render: [] };
      frameCosts.set(submittedPhase, window);
    }
    if (Number.isFinite(submitted.engineUpdateMs)) window.engine.push(submitted.engineUpdateMs);
    if (Number.isFinite(submitted.renderDrawCpuMs)) window.render.push(submitted.renderDrawCpuMs);
  }
  return cohorts.map(({ copies }) => {
    const measure = (stage) => {
      const window = frameCosts.get(`copies-${copies}/${stage}`);
      return {
        engine: distribution(window?.engine ?? []),
        render: distribution(window?.render ?? []),
      };
    };
    return { copies, baseline: measure('baseline'), steady: measure('steady') };
  });
}

function steadyFrameChecks(cohorts, regressionPercent) {
  const reference = cohorts.find(({ copies }) => copies === 0)?.baseline;
  return cohorts.flatMap(({ copies, steady }) =>
    ['engine', 'render'].flatMap((domain) =>
      ['p50', 'p95'].map((tail) => {
        const baseline = reference?.[domain];
        const actual = steady[domain];
        const limit =
          baseline?.[tail] == null ? null : baseline[tail] * (1 + regressionPercent / 100);
        return {
          name: `steady-${copies}-copies-${domain}-${tail}`,
          pass:
            limit !== null &&
            baseline.count >= 60 &&
            actual.count >= 60 &&
            actual[tail] !== null &&
            actual[tail] <= limit,
          actual: actual[tail],
          limit,
        };
      }),
    ),
  );
}

function summarizeReadyWindows(ready) {
  const windows = new Map();
  for (const frame of ready) {
    const phase = frame.submittedPhase;
    if (phase === undefined) continue;
    let window = windows.get(phase);
    if (window === undefined) {
      window = [];
      windows.set(phase, window);
    }
    window.push(frame.intervalMs);
  }
  return Object.fromEntries(
    Array.from(windows, ([phase, intervals]) => [phase, distribution(intervals)]),
  );
}

function levelWorkBetween(before, after) {
  const { levelWork: start } = before;
  const { levelWork: end } = after;
  return {
    turns: end.turns - start.turns,
    turnMs: end.turnMs - start.turnMs,
    units: end.units - start.units,
    unitMs: end.totalMs - start.totalMs,
  };
}

function sourceRequests(port) {
  const pending = new Map();
  let serial = 0;
  port.onmessage = ({ data: { request, value, error } }) => {
    const operation = pending.get(request);
    if (operation === undefined) return;
    pending.delete(request);
    clearTimeout(operation.timer);
    if (error === undefined) operation.resolve(value);
    else operation.reject(new Error(error.message, { cause: error }));
  };
  return {
    call(operation) {
      const request = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(Error(`Engine Worker did not confirm ${operation.kind}`));
        }, 30_000);
        pending.set(request, { resolve, reject, timer });
        port.postMessage({ request, ...operation });
      });
    },
    close() {
      for (const { timer, reject } of pending.values()) {
        clearTimeout(timer);
        reject(Error('Engine Worker benchmark is closed'));
      }
      pending.clear();
      port.close();
    },
  };
}
