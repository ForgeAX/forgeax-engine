import { createGameplayObserver } from './fixtures/gameplay-benchmark/observer.mjs';
import { createPhoneGameplaySocket } from './phone_gameplay_socket.mjs';
import { createPhoneGameplayTransport } from './phone_gameplay_transport.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Diagnostic only: no observer arm, timing window, App pause, or native input. */
export function createPhoneGameplayObserver(options, wx, observer = createGameplayObserver()) {
  if (
    !/^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(
      options.controlUrl,
    ) ||
    !/^[A-Za-z0-9_-]{16,96}$/.test(options.runId)
  )
    throw new Error('Explicit loopback run required');
  let platform,
    started = false;
  const report = {
    kind: 'forgeax-phone-gameplay',
    schemaVersion: 'forgeax-phone-gameplay/1',
    source: options.source,
    runId: options.runId,
    mode: 'transport-probe',
    status: 'partial',
    qualification: 'Stationary transport probe only; no performance capture or input.',
    debugReceipts: [],
    websocket: { events: [], bidirectionalAfterDebugFalse: false },
  };
  const now = () => platform.now().unwrap();
  const transport = createPhoneGameplayTransport(options, wx, report, { now, canShow: () => true });
  const connection = createPhoneGameplaySocket({ ...options, probeOnly: true }, wx, report, {
    now,
    failure: transport.failure,
  });
  async function ready() {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const state = observer.status(),
        owner = globalThis.__forgeaxGameInspection;
      const before = { observer: state, inspectionAvailable: !!owner };
      report.readiness = before;
      if (state.failure) throw new Error(`Observer failed: ${state.failure}`);
      if (!state.bound || state.readyCompletions < 60 || !owner) {
        await wait(250);
        continue;
      }
      const renderer = owner.renderer();
      before.renderer = renderer;
      if (renderer.phase !== 'ready' || renderer.startupError || renderer.lastError)
        throw new Error(`Ordinary renderer is not healthy: ${JSON.stringify(renderer)}`);
      const player = await owner.read('game-3d.player');
      before.player = player;
      if (
        !player?.grounded ||
        player.controls?.horizontal !== 0 ||
        player.controls?.vertical !== 0 ||
        player.controls?.run !== false ||
        !Array.isArray(player.position) ||
        player.position.length !== 3 ||
        !player.position.every(Number.isFinite) ||
        Math.abs(player.position[0]) > 10 ||
        Math.abs(player.position[2]) > 10
      )
        throw new Error('Neutral grounded player inside +/-10 required');
      const vase = await owner.read('game-3d.runtime-vase');
      before.vase = vase;
      if (!(vase?.vertexCount > 0) || vase.busy || vase.error)
        throw new Error('Runtime vase unavailable');
      const ui = owner.ui({ selector: '[data-ui-part]', limit: 512 });
      before.uiResult = ui;
      if (!ui.ok || ui.value.truncated !== false)
        throw new Error('Complete native controls unavailable');
      before.visible = platform.visible();
      before.atMs = now();
      report.before = before;
      return;
    }
    throw new Error('Ordinary readiness deadline');
  }
  async function collect() {
    try {
      await ready();
      await connection.debug(true);
      await connection.connect();
      await connection.exchange('ready', 'disable-debug');
      const disabled = await connection.debug(false);
      report.websocket.armProbe = await connection.exchange('debug-closed', 'arm', {
        debugReceipt: disabled,
      });
      report.websocket.bidirectionalAfterDebugFalse = true;
      await connection.exchange('probe-complete', 'close');
      await connection.close();
      report.status = 'complete';
    } catch (error) {
      report.failure = String(error?.stack ?? error);
      transport.failure(error, 'transport-probe');
      try {
        await connection.close();
      } catch (closeError) {
        report.closeError = String(closeError);
      }
    } finally {
      try {
        await connection.debug(true);
      } catch (error) {
        report.status = 'partial';
        report.exportDebugError = String(error);
        transport.failure(error, 'export-debug');
      }
      await wait(0);
      report.finishedAt = Date.now();
      globalThis.__forgeaxPhoneGameplayReport = report;
      await transport.finish();
    }
  }
  return {
    ...observer,
    observeOptions(value, host) {
      platform = value.platform;
      return observer.observeOptions(value, host);
    },
    bindApp(app) {
      if (started) throw new Error('Phone probe realm rebound');
      const result = observer.bindApp(app);
      started = true;
      void collect();
      return result;
    },
  };
}
