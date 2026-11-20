// Real App/Renderer/Rapier lifecycle measurement shared by native and browser hosts.
import { createApp } from '../../packages/app/dist/index.mjs';
import { appLevelOwner } from '../../packages/app/dist/internal.mjs';
import { createCatalogSource } from '../../packages/assets-runtime/dist/index.mjs';
import { runtimeAssets } from '../../packages/assets-runtime/dist/internal.mjs';
import { World } from '../../packages/ecs/dist/index.mjs';
import { vec3 } from '../../packages/math/dist/index.mjs';
import physics3d, { RapierPhysicsWorld3D } from '../../packages/physics-rapier3d/dist/index.mjs';
import {
  constructRendererHost,
  loadRhiPack,
} from '../../packages/render/dist/construct-renderer.mjs';
import * as webgpu from '../../packages/rhi-webgpu/dist/index.mjs';
import { ok, textureFormatBlock } from '../../packages/types/dist/index.mjs';
import {
  installBenchmarkWorld,
  registerBenchmarkVocabulary,
  sourceFacts,
} from './level-streaming-world.mjs';

function unwrapResult(result) {
  if (!result.ok) throw result.error;
  return result.value;
}
function observeFailure(cause, phase, depth = 0) {
  const detail = Object.fromEntries(
    Object.entries(cause?.detail ?? {}).filter(
      ([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value),
    ),
  );
  return {
    name: cause?.name,
    message: cause?.message,
    code: cause?.code,
    detail,
    stack: cause?.stack,
    phase,
    ...(depth < 8 && cause?.cause !== undefined
      ? { cause: observeFailure(cause.cause, phase, depth + 1) }
      : {}),
    ...(depth < 8 && cause instanceof AggregateError
      ? { errors: cause.errors.map((error) => observeFailure(error, phase, depth + 1)) }
      : {}),
  };
}
function requireFact(condition, message) {
  if (!condition) throw Error(message);
}
function percentile(values, p) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
export function distribution(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max:
      values.length === 0 ? null : values.reduce((max, value) => Math.max(max, value), -Infinity),
  };
}

export function sourceOwnedMemoryBytes(world, assets) {
  // Pool bookkeeping uses JS objects after ECS ownership consolidation.
  // Explicit heap sampling accounts for this population.
  const bytes =
    world.arena.committedBytes +
    world.buffers.committedBytes +
    world.arrays.committedBytes +
    world.tableBytes +
    world.entityRecordBytes +
    world.archetypeBytes +
    assets.bytes +
    assets.snapshotBytes +
    assets.adoptionBytes;
  requireFact(Number.isSafeInteger(bytes) && bytes >= 0, 'Source memory ownership is unconfirmed');
  return bytes;
}

function textureBytes(descriptor) {
  const extent = descriptor.size;
  let [width, height, depth] = Array.isArray(extent)
    ? [extent[0], extent[1] ?? 1, extent[2] ?? 1]
    : [extent.width, extent.height ?? 1, extent.depthOrArrayLayers ?? 1];
  const block = textureFormatBlock(descriptor.format);
  let bytes = 0;
  for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) {
    bytes +=
      Math.ceil(width / block.blockWidth) *
      Math.ceil(height / block.blockHeight) *
      depth *
      block.bytesPerBlock *
      (descriptor.sampleCount ?? 1);
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
    if (descriptor.dimension === '3d') depth = Math.max(1, depth >> 1);
  }
  return bytes;
}
/** Diagnostic observations only; no alternate native resource authority. */
function observeDevice(device, events, phase, surfaceTextures) {
  const live = new Map(),
    restore = [];
  let bytes = 0;
  const createNames = [
    'createBuffer',
    'createTexture',
    'createTextureView',
    'createSampler',
    'createBindGroup',
    'createRenderBundleEncoder',
    'createRenderPipeline',
    'createRenderPipelineAsync',
    'createComputePipeline',
    'createComputePipelineAsync',
    'createBindGroupLayout',
    'createPipelineLayout',
    'createShaderModule',
  ];
  for (const name of createNames) {
    const original = device[name];
    if (typeof original !== 'function') continue;
    device[name] = function (...args) {
      const begin = performance.now();
      const result = original.apply(this, args);
      const event = {
        phase: phase(),
        kind: name,
        label: args[0]?.label,
        ...(name === 'createTextureView' && surfaceTextures?.has(args[0])
          ? { presentationSurface: true }
          : {}),
        beginMs: begin,
        ms: performance.now() - begin,
      };
      events.push(event);
      if (result?.ok && (name === 'createBuffer' || name === 'createTexture')) {
        const size = name === 'createBuffer' ? args[0].size : textureBytes(args[0]);
        live.set(result.value, size);
        bytes += size;
      }
      return result;
    };
    restore.push(() => {
      device[name] = original;
    });
  }
  const raw = webgpu._internal_getRawDevice(device);
  const shader = raw.createShaderModule;
  raw.createShaderModule = function (...args) {
    const begin = performance.now(),
      result = shader.apply(this, args);
    events.push({
      phase: phase(),
      kind: 'nativeShaderModule',
      label: args[0]?.label,
      beginMs: begin,
      ms: performance.now() - begin,
    });
    return result;
  };
  restore.push(() => {
    raw.createShaderModule = shader;
  });
  const upload = device.queue.writeTexture;
  device.queue.writeTexture = function (...args) {
    const begin = performance.now(),
      result = upload.apply(this, args);
    events.push({
      phase: phase(),
      kind: 'textureUpload',
      beginMs: begin,
      ms: performance.now() - begin,
    });
    return result;
  };
  restore.push(() => {
    device.queue.writeTexture = upload;
  });
  for (const name of ['destroyBuffer', 'destroyTexture']) {
    const original = device[name];
    device[name] = function (resource) {
      const result = original.call(this, resource);
      if (result.ok && live.has(resource)) {
        bytes -= live.get(resource);
        live.delete(resource);
      }
      return result;
    };
    restore.push(() => {
      device[name] = original;
    });
  }
  return {
    snapshot: () => ({ logicalBytes: bytes, resources: live.size }),
    close: () => {
      for (const reset of restore.toReversed()) reset();
      live.clear();
    },
  };
}

function qualifyRetiredMemory(cohort, gate) {
  for (const sample of cohort.cycles) {
    gate(
      `owned-memory-${cohort.copies}-${sample.cycle}`,
      sample.memory?.logicalBytes <= sample.memory?.logicalLimit,
      sample.memory?.logicalBytes,
      sample.memory?.logicalLimit,
    );
    for (const [name, population] of Object.entries(sample.memory?.populations ?? {}))
      gate(
        `memory-${name}-${cohort.copies}-${sample.cycle}`,
        Number.isFinite(population.bytes) && population.bytes <= population.limit,
        population.bytes,
        population.limit,
      );
    gate(
      `heap-${cohort.copies}-${sample.cycle}`,
      Number.isFinite(sample.memory?.heap) && sample.memory.heap <= sample.memory.heapLimit,
      sample.memory?.heap,
      sample.memory?.heapLimit,
    );
  }
}

/** The host supplies an actual 60 Hz scheduler, surface, catalog and heap observation. */
export async function runLevelStreamingRuntime(host) {
  const { profile, canvas, platform, catalog, fetcher, rootGuid, shaderManifestUrl } = host;
  const report = {
    backend: host.backend,
    identity: host.identity,
    profile,
    producer: host.producer,
    frames: [],
    native: [],
    transitions: [],
    memory: [],
    cohorts: [],
    failures: [],
    qualified: false,
    instrumentation: { traceLogic: host.traceLogic === true },
  };
  const logicWindows = host.traceLogic
    ? [{ phase: 'initialization', at: performance.now() }]
    : undefined;
  let worldProbe;
  let phase = 'initialization',
    device,
    observation,
    app,
    world,
    renderer;
  let failure,
    lastStart,
    lastReadyAt,
    stopped = false;
  const receipts = new Set(),
    waiters = new Set();
  const pulse = () => {
    for (const notify of [...waiters]) notify();
  };
  const setPhase = (next) => {
    phase = next;
    logicWindows?.push({ phase, at: performance.now() });
    host.progress?.({ phase, frames: report.frames.length });
  };
  const observedPlatform = {
    ...platform,
    requestFrame(callback) {
      return platform.requestFrame(() => {
        const begin = performance.now();
        const entry = {
          phase,
          begin,
          intervalMs: lastStart === undefined ? null : begin - lastStart,
        };
        lastStart = begin;
        try {
          callback();
        } catch (cause) {
          failure ??= cause;
        }
        entry.cpuMs = performance.now() - begin;
        report.frames.push(entry);
        if (report.frames.length % 600 === 0)
          host.progress?.({ phase, frames: report.frames.length, cpuMs: entry.cpuMs });
        pulse();
      });
    },
  };
  const when = async (predicate, timeoutMs, label) => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (host.signal?.aborted) throw host.signal.reason;
      if (failure !== undefined) throw failure;
      if (predicate()) return;
      if (performance.now() >= deadline) throw Error(`deadline exceeded: ${label}`);
      await new Promise((resolve) => {
        const timer = setTimeout(
          () => {
            waiters.delete(wake);
            resolve();
          },
          Math.min(250, deadline - performance.now()),
        );
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        waiters.add(wake);
      });
    }
  };
  try {
    const assembly = unwrapResult(
      await constructRendererHost(
        canvas,
        {},
        { shaderManifestUrl },
        loadRhiPack(webgpu, {
          resolveSurfaceDevice(actual) {
            requireFact(
              device === undefined || device === actual,
              'unexpected device replacement during qualification',
            );
            device = actual;
            observation ??= observeDevice(actual, report.native, () => phase, host.surfaceTextures);
            return ok(actual);
          },
        }),
      ),
    );
    renderer = assembly.renderer;
    const readyFrames = new Map();
    const draw = renderer.draw.bind(renderer);
    renderer.draw = (request) => {
      const result = draw(request);
      if (result.ok) {
        const begun = performance.now(),
          submittedPhase = phase;
        const completion = result.value.completed
          .then((done) => {
            done.unwrap();
            const completedAt = performance.now();
            let completionIntervalMs = null;
            if (result.value.presentation === 'ready') {
              if (lastReadyAt !== undefined) completionIntervalMs = completedAt - lastReadyAt;
              lastReadyAt = completedAt;
              readyFrames.set(submittedPhase, (readyFrames.get(submittedPhase) ?? 0) + 1);
            }
            report.frames.push({
              phase: submittedPhase,
              receipt: result.value.frameId,
              presentation: result.value.presentation,
              presentationPendingReason: result.value.presentationPendingReason,
              completedAt,
              completionMs: completedAt - begun,
              completionIntervalMs,
            });
          })
          .catch((cause) => {
            failure ??= cause;
          })
          .finally(() => {
            receipts.delete(completion);
            pulse();
          });
        receipts.add(completion);
      }
      return result;
    };
    const assets = assembly.assets;
    world = new World({ assets });
    registerBenchmarkVocabulary(world);
    app = (
      await createApp({
        world,
        renderer,
        assets,
        platform: observedPlatform,
        plugins: [physics3d],
        assetCatalog:
          catalog ??
          createCatalogSource({
            entries: host.entries,
            fetch: fetcher,
            expectedScope: host.expectedScope,
          }),
      })
    ).unwrap();
    app.onError((cause) => {
      failure ??= cause;
      pulse();
    });
    app.execution.setFrameRateLimit(profile.target.frameRate);
    app.start().unwrap();
    worldProbe = installBenchmarkWorld(world, profile, host.traceLogic);
    await when(
      () => worldProbe.updates() >= 60 && (readyFrames.get('initialization') ?? 0) >= 60,
      30000,
      'baseline completed frames',
    );
    setPhase('ordinary-cold-load');
    const loaded = await assets.load(rootGuid, 'scene');
    const root = loaded.unwrap();
    const owner = appLevelOwner(app);
    report.preparationCosts = owner.costs;
    requireFact(app.physics instanceof RapierPhysicsWorld3D, 'actual static Physics owner missing');
    const physics = app.physics;
    const observedStages = new WeakMap();
    const observeLevelStage = (level, index) => {
      const status = level.inspect();
      const render = status.render?.phase;
      const resources = status.render?.resources?.phase;
      const pending = status.pending !== undefined;
      const observed = observedStages.get(level);
      if (
        observed?.source !== status.phase ||
        observed.render !== render ||
        observed.resources !== resources ||
        observed.pending !== pending ||
        observed.current !== status.current
      ) {
        const stage = { source: status.phase, render, resources, pending, current: status.current };
        observedStages.set(level, stage);
        host.progress?.({ phase, frames: report.frames.length, level: index, stage });
      }
      return status;
    };
    const prepare = async (levels) =>
      when(
        () =>
          levels.every((level, index) => {
            const status = observeLevelStage(level, index);
            if (status.failure !== undefined) throw status.failure;
            return status.phase === 'prepared' && status.current;
          }),
        180000,
        'all actual native Source and Physics preparations',
      );
    const steady = async (label, count = 60) => {
      setPhase(label);
      const start = worldProbe.updates();
      await when(
        () => worldProbe.updates() >= start + count && (readyFrames.get(label) ?? 0) >= count,
        30000,
        label,
      );
      const samples = report.frames.filter(
        (frame) => frame.phase === label && frame.cpuMs !== undefined,
      );
      return {
        cpu: distribution(samples.map((frame) => frame.cpuMs)),
        interval: distribution(
          samples.map((frame) => frame.intervalMs).filter((value) => value !== null),
        ),
      };
    };
    const memory = async (label) => {
      await Promise.all([...receipts]);
      app.pause().unwrap();
      const sampleBegin = performance.now();
      const populations = await host.heap();
      const heap = populations.jsHeapBytes;
      const ecs = world.memoryStats(),
        records = runtimeAssets(assets).inspect();
      const native = observation.snapshot();
      const gpu = renderer.inspect({ fields: ['renderScene'] }).renderScene.gpu;
      requireFact(
        gpu.status === 'resident' || gpu.status === 'inactive',
        'Scene CPU table ownership is unconfirmed',
      );
      const sceneTableBytes =
        gpu.status === 'resident'
          ? Object.values(gpu.tables).reduce((sum, table) => sum + table.bytes, 0)
          : 0;
      const logicalBytes =
        sourceOwnedMemoryBytes(ecs, records) + native.logicalBytes + sceneTableBytes;
      const row = {
        phase: label,
        logicalBytes,
        heap,
        populations,
        sceneTableBytes,
        ecs,
        records,
        native,
        bodies: physics.getBodyCount(),
      };
      report.memory.push(row);
      report.frames.push({
        phase: 'measurement-pause',
        reason: 'explicit heap collection and cold memory inspection',
        durationMs: performance.now() - sampleBegin,
      });
      lastStart = undefined;
      lastReadyAt = undefined;
      app.resume().unwrap();
      return row;
    };
    const transitionLevel = async (level, prefix, sample) => {
      for (const target of ['active', 'prepared', 'active', 'prepared']) {
        const label = `${prefix}/${target}-${sample.transitions.length}`;
        setPhase(label);
        const before = report.native.length,
          begin = performance.now();
        level.target(target).unwrap();
        await when(() => level.inspect().phase === target, 5000, label);
        await Promise.all([...receipts]);
        const nativeCalls = report.native.slice(before);
        const cold = nativeCalls.filter((call) => call.presentationSurface !== true);
        const frames = report.frames.filter(
          (frame) => frame.phase === label && frame.cpuMs !== undefined,
        );
        const transition = {
          target,
          elapsedMs: performance.now() - begin,
          cold,
          surfaceViews: nativeCalls.length - cold.length,
          frames,
        };
        sample.transitions.push(transition);
        report.transitions.push(transition);
        requireFact(cold.length === 0, `${label}: first consumption created native resources`);
        requireFact(
          (readyFrames.get(label) ?? 0) > 0,
          `${label}: transition did not complete a ready picture`,
        );
        const hit = physics.raycast(vec3.create(0, 10, 0), vec3.create(0, -1, 0), 20);
        requireFact(
          target === 'active' ? hit !== undefined : hit === undefined,
          `${label}: native participation disagrees with the fixed-boundary target`,
        );
        if (target === 'active') {
          const gpu = renderer.inspect({ fields: ['renderScene'] }).renderScene.gpuDriven;
          requireFact(
            gpu.cpuFallbackDrawItems === 0 && gpu.indirectDrawCount > 0 && !gpu.overflow,
            `${label}: original GPU quality or submission changed`,
          );
          await steady(`${label}/visible`, 60);
        }
      }
    };
    for (const copies of profile.streetBlock.residentInactiveCopies) {
      setPhase(`copies-${copies}/prepare-inactive`);
      const inactive = Array.from({ length: copies }, () => owner.create(root).unwrap());
      await prepare(inactive);
      const baseline = await steady(`copies-${copies}/baseline`);
      let warm;
      const cohort = { copies, baseline, cycles: [], budgets: profile.budgets };
      report.cohorts.push(cohort);
      for (let cycle = 0; cycle < profile.streetBlock.repeatCycles; cycle++) {
        const prefix = `copies-${copies}/cycle-${cycle}`;
        setPhase(`${prefix}/prepare`);
        const level = owner.create(root).unwrap();
        await prepare([...inactive, level]);
        const facts = sourceFacts(world, level, profile, host.producer);
        const sample = { cycle, facts, preparation: { ...owner.inspect().costs }, transitions: [] };
        cohort.cycles.push(sample);
        await transitionLevel(level, prefix, sample);
        setPhase(`${prefix}/unload`);
        const begin = performance.now();
        level.target('unloaded').unwrap();
        await when(
          () => {
            const status = observeLevelStage(level, copies);
            if (status.cleanupFailure !== undefined) throw status.cleanupFailure;
            return status.phase === 'retired';
          },
          5000,
          `${prefix}/unload`,
        );
        sample.unloadMs = performance.now() - begin;
        const retained = await memory(`${prefix}/memory`);
        warm ??= retained;
        sample.memory = {
          logicalLimit:
            warm.logicalBytes * (1 + profile.budgets.maximumWarmOwnedMemoryGrowthPercent / 100) +
            profile.budgets.ownedMemoryAllowanceBytes,
          heapLimit:
            warm.heap * (1 + profile.budgets.maximumWarmOwnedMemoryGrowthPercent / 100) +
            profile.budgets.ownedMemoryAllowanceBytes,
          populations: Object.fromEntries(
            Object.entries(retained.populations).map(([name, bytes]) => [
              name,
              {
                bytes,
                limit:
                  warm.populations[name] *
                    (1 + profile.budgets.maximumWarmOwnedMemoryGrowthPercent / 100) +
                  profile.budgets.ownedMemoryAllowanceBytes,
              },
            ]),
          ),
          logicalBytes: retained.logicalBytes,
          heap: retained.heap,
        };
      }
      cohort.steady = await steady(`copies-${copies}/steady`);
      for (const level of inactive) level.target('unloaded').unwrap();
      await when(
        () => inactive.every((level) => level.inspect().phase === 'retired'),
        10000,
        'inactive cleanup',
      );
    }
    report.finalCosts = owner.inspect().costs;
    assets.release(root).unwrap();
    setPhase('stopped-no-frame-close');
    app.stop().unwrap();
    stopped = true;
    (await app.dispose()).unwrap();
    requireFact(
      owner.inspect().live === 0 && physics.getBodyCount() === 0,
      'stopped owners remain live',
    );
    requireFact(runtimeAssets(assets).inspect().snapshots === 0, 'Source snapshot custody remains');
    report.closed = true;
  } catch (cause) {
    report.failures.push(observeFailure(cause, phase));
  } finally {
    if (logicWindows !== undefined && worldProbe !== undefined)
      report.logicTiming = {
        hostClock: performance.timeOrigin,
        windows: logicWindows,
        engine: worldProbe.logicTiming(),
      };
    if (!stopped && app !== undefined) app.stop().unwrap();
    if (app !== undefined) {
      const result = await app.dispose();
      if (!result.ok) report.failures.push({ phase: 'app-dispose', message: result.error.message });
    }
    if (renderer !== undefined) {
      const result = await renderer.dispose();
      if (!result.ok)
        report.failures.push({ phase: 'renderer-dispose', message: result.error.message });
    }
    observation?.close();
  }
  return qualifyRuntimeReport(report, profile);
}

function qualifyRuntimeReport(report, profile) {
  const windows = report.frames.filter(
    (frame) => frame.cpuMs !== undefined && frame.phase !== 'initialization',
  );
  const completions = report.frames.filter(
    (frame) => frame.phase !== 'initialization' && Number.isFinite(frame.completionIntervalMs),
  );
  const readyCompletionIntervals = distribution(
    completions.map((frame) => frame.completionIntervalMs),
  );
  const completionOver33Ms = completions.filter(
    (frame) => frame.completionIntervalMs > profile.budgets.presentationIntervalP99Ms,
  );
  const completionOver50Ms = completions.filter(
    (frame) => frame.completionIntervalMs > profile.budgets.maximumLifecycleAttributedPauseMs,
  );
  report.summary = {
    frames: distribution(windows.map((frame) => frame.cpuMs)),
    intervals: distribution(
      windows.map((frame) => frame.intervalMs).filter((value) => value !== null),
    ),
    readyCompletionIntervals,
    completionOver33Ms,
    completionOver50Ms,
    over33Ms: windows.filter((frame) => frame.intervalMs > 33.34),
    over50Ms: windows.filter((frame) => frame.cpuMs > 50 || frame.intervalMs > 50),
  };
  const b = profile.budgets;
  const checks = [];
  const gate = (name, pass, actual, limit) => checks.push({ name, pass, actual, limit });
  gate(
    'complete-original-profile',
    report.closed === true &&
      report.cohorts.length === 3 &&
      report.cohorts.every((cohort) => cohort.cycles.length === profile.streetBlock.repeatCycles),
    report.cohorts.map((cohort) => cohort.cycles.length),
    profile.streetBlock.repeatCycles,
  );
  const nativeUnits = report.native
    .filter((event) => event.phase !== 'initialization')
    .map((event) => event.ms);
  const acceptance = report.transitions.flatMap((entry) =>
    entry.frames.map((frame) => frame.cpuMs),
  );
  report.summary.preparation = {
    longestSourceUnitMs: (report.finalCosts ?? report.preparationCosts)?.maxUnitMs ?? null,
    nativeInvocations: distribution(nativeUnits),
    acceptanceAndFirstUpdate: distribution(acceptance),
  };
  gate(
    'lifecycle-frame-interval-p95',
    report.summary.intervals.p95 !== null &&
      report.summary.intervals.p95 <= b.presentationIntervalP95Ms,
    report.summary.intervals,
    b.presentationIntervalP95Ms,
  );
  gate(
    'lifecycle-frame-interval-p99',
    report.summary.intervals.p99 !== null &&
      report.summary.intervals.p99 <= b.presentationIntervalP99Ms,
    report.summary.intervals,
    b.presentationIntervalP99Ms,
  );
  gate(
    'maximum-lifecycle-pause',
    report.summary.over50Ms.length === 0,
    report.summary.over50Ms,
    b.maximumLifecycleAttributedPauseMs,
  );
  gate(
    'ready-completion-interval-p95',
    readyCompletionIntervals.p95 !== null &&
      readyCompletionIntervals.p95 <= b.presentationIntervalP95Ms,
    readyCompletionIntervals.p95,
    b.presentationIntervalP95Ms,
  );
  gate(
    'ready-completion-interval-p99',
    readyCompletionIntervals.p99 !== null &&
      readyCompletionIntervals.p99 <= b.presentationIntervalP99Ms,
    readyCompletionIntervals.p99,
    b.presentationIntervalP99Ms,
  );
  gate(
    'maximum-ready-completion-pause',
    readyCompletionIntervals.max !== null && completionOver50Ms.length === 0,
    completionOver50Ms,
    b.maximumLifecycleAttributedPauseMs,
  );
  const reference = report.cohorts[0]?.baseline.cpu;
  for (const cohort of report.cohorts) {
    gate(
      `steady-${cohort.copies}-copies-p50`,
      cohort.steady?.cpu.p50 <= reference?.p50 * 1.1,
      cohort.steady?.cpu,
      reference?.p50 * 1.1,
    );
    gate(
      `steady-${cohort.copies}-copies-p95`,
      cohort.steady?.cpu.p95 <= reference?.p95 * 1.1,
      cohort.steady?.cpu,
      reference?.p95 * 1.1,
    );
    qualifyRetiredMemory(cohort, gate);
  }
  report.checks = checks;
  report.qualified =
    !report.instrumentation.traceLogic &&
    report.failures.length === 0 &&
    checks.every((check) => check.pass);
  return report;
}
