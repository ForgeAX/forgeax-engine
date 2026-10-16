import { createGameplayObserver } from './fixtures/gameplay-benchmark/observer.mjs';
import { installPhoneCompletionTiming } from './phone_completion_timing.mjs';
import { createPhoneGameplaySocket } from './phone_gameplay_socket.mjs';
import { createPhoneGameplayTransport } from './phone_gameplay_transport.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const neutral = (player) =>
  player?.grounded === true &&
  player.controls?.horizontal === 0 &&
  player.controls?.vertical === 0 &&
  player.controls?.run === false;

/** Four fixed messages for one capture; no eval, input injection or timed inspection. */
export function createPhoneGameplayObserver(
  options,
  wx,
  observer = createGameplayObserver(),
  diagnostics = {},
) {
  if (
    !/^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(
      options.controlUrl,
    ) ||
    Number(options.controlUrl.split(':')[2].split('/')[0]) < 1 ||
    Number(options.controlUrl.split(':')[2].split('/')[0]) > 65535 ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(options.runId)
  )
    throw new Error('Explicit loopback run required');
  const mode = options.mode ?? 'timed';
  if (
    !['timed', 'cpu', 'gpu', 'qualification'].includes(mode) ||
    (mode === 'cpu') !== !!diagnostics.cpu ||
    (mode === 'gpu') !== !!diagnostics.gpu ||
    (mode === 'qualification') !== !!diagnostics.qualify
  )
    throw new Error('Phone diagnostic mode and capability must agree');
  let platform,
    started = false,
    armed = false;
  const report = {
    kind: 'forgeax-phone-gameplay',
    schemaVersion: 'forgeax-phone-gameplay/1',
    source: options.source,
    runId: options.runId,
    mode,
    diagnostic: mode === 'timed' ? 'debug-state-unchanged' : mode,
    diagnosticOnly: true,
    cleanFpsEvidence: false,
    debug: { policy: 'unchanged', before: null, after: null },
    status: 'partial',
    qualification:
      'App completion callbacks; socket dispatch and external thermal/image evidence remain separate.',
  };
  const now = () => platform.now().unwrap();
  if (options.completionTiming === true) {
    if (globalThis.__forgeaxCompletionTiming)
      throw new Error('Completion timing realm already owned');
    globalThis.__forgeaxCompletionTiming = installPhoneCompletionTiming(observer, { now });
  }
  const transport = createPhoneGameplayTransport(options, wx, report, {
    now,
    canShow: () => !armed,
  });
  let connection = createPhoneGameplaySocket(options, wx, report, {
    now,
    failure: transport.failure,
  });
  const request = (stage, value, timeout) =>
    connection.exchange(
      stage,
      {
        ready: ['arm', 'observe-only'],
        armed: 'accepted',
        release: ['released', 'release-unknown'],
      }[stage],
      value,
      timeout,
    );
  async function readReady() {
    const status = observer.status(),
      owner = globalThis.__forgeaxGameInspection;
    const observation = { observer: status, inspectionAvailable: !!owner };
    report.readiness = observation;
    if (status.failure) throw new Error(`Observer failed: ${status.failure}`);
    if (!status.bound || status.readyCompletions < 60 || !owner) return null;
    const renderer = owner.renderer();
    observation.renderer = renderer;
    if (renderer.startupError || renderer.lastError || renderer.phase !== 'ready')
      throw new Error(`Ordinary renderer is not healthy: ${JSON.stringify(renderer)}`);
    const player = await owner.read('game-3d.player');
    observation.player = player;
    if (
      !neutral(player) ||
      !Array.isArray(player.position) ||
      player.position.length !== 3 ||
      !player.position.every(Number.isFinite) ||
      Math.abs(player.position[0]) > 10 ||
      Math.abs(player.position[2]) > 10
    )
      throw new Error('Player must be neutral and grounded inside +/-10');
    const vase = await owner.read('game-3d.runtime-vase');
    observation.vase = vase;
    if (!(vase?.vertexCount > 0) || vase.busy || vase.error)
      throw new Error('Ordinary runtime vase unavailable');
    const ui = owner.ui({ selector: '[data-ui-part]', limit: 512 });
    observation.uiResult = ui;
    if (!ui.ok || ui.value.truncated !== false)
      throw new Error('Complete native controls unavailable');
    return {
      observer: status,
      renderer,
      player,
      vase,
      ui: ui.value,
      display: platform.display().unwrap(),
      nativeWindow: wx.getWindowInfo(),
      visible: platform.visible(),
      atMs: now(),
    };
  }
  async function collect() {
    const deadline = Date.now() + 300000;
    try {
      report.debug.before = { atMs: now(), appBaseInfo: wx.getAppBaseInfo() };
      let command;
      while (Date.now() < deadline) {
        const before = await readReady();
        if (!before) {
          await wait(250);
          continue;
        }
        report.before = before;
        let connected = false;
        for (let attempt = 0; attempt < 60 && Date.now() < deadline; attempt++) {
          try {
            await connection.connect();
            connected = true;
            break;
          } catch (error) {
            transport.failure(error, 'socket-connect');
            await connection.close();
            await wait(1000);
            connection = createPhoneGameplaySocket(options, wx, report, {
              now,
              failure: transport.failure,
            });
          }
        }
        if (!connected) throw new Error('Receiver connection deadline before readiness');
        command = await request('ready', { observation: before, debug: report.debug });
        break;
      }
      if (command?.action === 'observe-only') {
        report.failure = 'transport-observation-only';
        return;
      }
      if (!command || command.action !== 'arm') throw new Error('Readiness/receiver deadline');
      if (command.delayMs < 1000 || command.delayMs > 10000 || command.maxEvents > 65536)
        throw new Error('Invalid phone capture limits');
      report.arm = observer.arm({
        phases: command.phases,
        durationMs: command.durationMs,
        delayMs: command.delayMs,
        maxEvents: command.maxEvents,
      });
      armed = true;
      const receipt = await request('armed', { arm: report.arm }, Math.min(command.delayMs, 5000));
      if (receipt.action !== 'accepted' || now() >= report.arm.startMs)
        throw new Error('Capture could not synchronize before its start');
      report.synchronization = receipt.synchronization;
      if (mode === 'qualification') {
        report.inputQualification = await diagnostics.qualify({
          read: () => globalThis.__forgeaxGameInspection.read('game-3d.player'),
          now,
          wait,
          startMs: report.arm.startMs,
          endMs: report.arm.endMs,
          phases: command.phases,
          baselineHeight: report.before.player.position[1],
        });
      }
      if (mode === 'cpu' || mode === 'gpu') {
        await wait(report.arm.startMs - now());
        report.diagnosticWindow = {
          startedAtMs: now(),
          relativeStartMs: now() - report.arm.startMs,
        };
        if (diagnostics.cpu) {
          const started = diagnostics.cpu.start({ frameLimit: options.cpuFrames ?? 120 });
          if (!started.ok)
            throw new Error(`CPU capture start failed: ${JSON.stringify(started.error)}`);
          report.diagnosticWindow.frameLimit = options.cpuFrames ?? 120;
        }
        if (diagnostics.gpu) {
          diagnostics.gpu.start();
          await wait(Math.min(4000, report.arm.endMs - now()));
          diagnostics.gpu.stop();
          report.diagnosticWindow.stoppedAtMs = now();
          report.diagnosticWindow.relativeStopMs = now() - report.arm.startMs;
        }
      }
      // The clean timed mode has no control request, inspection or serialization here.
      await wait(report.arm.endMs - now() + 10);
      const released = await request('release', {});
      report.inputRelease = released.input;
      if (released.action !== 'released') throw new Error('Native input release was not confirmed');
      await connection.close();
      const landingDeadline = Date.now() + 20000;
      do {
        report.afterPlayer = await globalThis.__forgeaxGameInspection.read('game-3d.player');
        if (neutral(report.afterPlayer)) break;
        await wait(100);
      } while (Date.now() < landingDeadline);
      if (!neutral(report.afterPlayer))
        throw new Error('Player did not become neutral and grounded');
      report.capture = await observer.drain();
      report.status = report.capture.status === 'complete' ? 'complete' : 'partial';
      report.failure = report.capture.failure;
      if (report.inputQualification?.success === false) {
        report.status = 'partial';
        report.failure = 'input-qualification-failed';
      }
    } catch (error) {
      report.failure = String(error?.stack ?? error);
      if (!armed) transport.failure(error, 'readiness');
      if (armed) {
        observer.abort();
        if (!report.inputRelease) {
          try {
            report.inputRelease = (await request('release', {})).input;
          } catch (releaseError) {
            report.releaseError = String(releaseError);
          }
        }
        try {
          report.capture = await observer.drain();
        } catch (drainError) {
          report.drainError = String(drainError);
        }
      }
    } finally {
      if (diagnostics.cpu) {
        try {
          if (report.diagnosticWindow) diagnostics.cpu.stop();
          report.cpu = diagnostics.cpu.read();
          const frames =
            report.cpu.capture?.records.filter(
              (row) => row.kind === 'phase' && row.source === 'app' && row.phase === 'frame-total',
            ) ?? [];
          if (report.arm && report.diagnosticWindow) {
            report.diagnosticWindow.completedCpuFrames = frames.length;
            report.diagnosticWindow.relativeStopMs = frames.length
              ? Math.max(...frames.map((row) => row.endMicros / 1000)) - report.arm.startMs
              : null;
            report.diagnosticWindow.phases =
              report.capture?.phases.map((phase) => ({
                name: phase.name,
                framesStarted: frames.filter(
                  (row) =>
                    row.startMicros / 1000 >= report.arm.startMs + phase.startMs &&
                    row.startMicros / 1000 < report.arm.startMs + phase.endMs,
                ).length,
              })) ?? [];
          }
        } catch (error) {
          report.cpuError = String(error);
        }
      }
      if (diagnostics.gpu) {
        try {
          diagnostics.gpu.stop();
          if (report.capture) await diagnostics.gpu.collect();
        } catch (error) {
          report.gpuError = String(error);
        } finally {
          try {
            report.gpu = diagnostics.gpu.dispose();
          } catch (error) {
            report.gpuCleanupError = String(error);
          }
        }
      }
      try {
        await connection.close();
      } catch (error) {
        report.closeError = String(error);
        report.status = 'partial';
      }
      try {
        report.debug.after = { atMs: now(), appBaseInfo: wx.getAppBaseInfo() };
      } catch (error) {
        report.status = 'partial';
        report.failure ??= String(error);
      }
      await wait(0);
      report.finishedAt = Date.now();
      globalThis.__forgeaxPhoneGameplayReport = report;
      await transport.finish();
    }
  }
  return {
    ...observer,
    now,
    rendererOptions(value) {
      return { ...value, profiler: diagnostics.cpu.profiler };
    },
    gpuHost(value) {
      return diagnostics.gpu.wrapHost(value);
    },
    observeOptions(value, host) {
      platform = value.platform;
      return observer.observeOptions(
        diagnostics.cpu ? { ...value, profiler: diagnostics.cpu.profiler } : value,
        host,
      );
    },
    bindApp(app) {
      const result = observer.bindApp(app);
      if (started) throw new Error('Phone capture realm rebound');
      started = true;
      void collect();
      return result;
    },
  };
}
