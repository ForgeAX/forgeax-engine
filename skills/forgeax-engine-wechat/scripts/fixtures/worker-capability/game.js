import { persistPhoneReport, sendPhoneReport } from '../../phone_report_transport.js';
const options = require('./options.js');
const report = { kind: 'forgeax-worker-capabilities', schema: 1, runId: options.runId,
  source: options.source, startedAt: Date.now(), facts: {}, workers: [], errors: [] };
const live = [];
let canvas, timer, ended = false, shared;
const message = (error) => {
  try { return String(error && (error.message || error.errMsg) || error).slice(0, 1024); }
  catch { return 'unreadable error'; }
};
function recordError(error) { if (report.errors.length < 16) report.errors.push(message(error)); }
function finish(reason) {
  if (ended) return;
  ended = true;
  clearTimeout(timer);
  report.reason = reason;
  report.finishedAt = Date.now();
  for (const [off, handler] of [['offError', nativeError], ['offUnhandledRejection', unhandledRejection]]) {
    try { if (typeof wx[off] === 'function') wx[off](handler); } catch (error) { recordError(error); }
  }
  try { report.sharedValues = shared ? Array.from(new Int32Array(shared)) : null; }
  catch (error) { recordError(error); }
  report.termination = live.map((entry) => {
    try { entry.terminate(); return 'requested'; } catch (error) { return message(error); }
  });
  try {
    if (!report.canvasTransferred) {
      canvas ??= wx.createCanvas();
      canvas.width = 960; canvas.height = 440;
      const context = canvas.getContext('2d');
      if (context) {
        context.fillStyle = '#152433'; context.fillRect(0, 0, 960, 440);
        context.fillStyle = '#f5df85'; context.font = '26px sans-serif';
        ['ForgeAX Worker V2 capability probe', `WeChat ${report.facts.version} / SDK ${report.facts.SDKVersion}`,
          `V2 admission: ${report.facts.standardWorker}`, `Result: ${reason}`,
          `Worker replies: ${report.workers.filter((row) => row.reply).length} / ${report.workers.length}`,
          `Run: ${options.runId}`].forEach((line, index) => context.fillText(line, 28, 60 + index * 45));
      }
    }
  } catch (error) { recordError(error); }
  try { console.info('[forgeax.worker.capabilities]', JSON.stringify(report)); } catch { /* Native logging is optional. */ }
  const payload = persistPhoneReport(wx, report, 'worker-capabilities');
  sendPhoneReport(wx, options, report, payload, 'worker-capabilities');
}
function nativeError(error) { if (!ended) { recordError(error); finish('native-error'); } }
function unhandledRejection(event) { nativeError(event?.reason ?? event); }
try {
  if (typeof wx.onError === 'function') wx.onError(nativeError);
  if (typeof wx.onUnhandledRejection === 'function') wx.onUnhandledRejection(unhandledRejection);
  const info = wx.getSystemInfoSync();
  report.facts = { version: info.version, SDKVersion: info.SDKVersion, platform: info.platform, system: info.system,
    standardWorker: wx.env?.isSupportStandardWorker ?? null, flagType: typeof wx.env?.isSupportStandardWorker,
    createWorker: typeof wx.createWorker, SharedArrayBuffer: typeof SharedArrayBuffer,
    MessageChannel: typeof MessageChannel, Atomics: typeof Atomics,
    WebAssembly: typeof WebAssembly, WXWebAssembly: typeof WXWebAssembly };
  if (wx.env?.isSupportStandardWorker !== true) finish('v2-not-admitted');
  else {
    timer = setTimeout(() => finish('deadline'), options.timeoutMs);
    if (typeof SharedArrayBuffer === 'function') shared = new SharedArrayBuffer(8);
    report.workers = [{ id: 0 }, { id: 1 }];
    for (const row of report.workers) {
      if (ended) break;
      row.attempted = true;
      const target = wx.createWorker('workers/probe.js');
      live.push(target); row.created = true;
      target.onMessage((value) => {
        if (ended) return;
        if (!value || value.id !== row.id || value.runId !== options.runId || row.reply) {
          recordError('invalid or duplicate worker reply'); finish('worker-error'); return;
        }
        row.reply = value;
        if (Array.isArray(value.errors) && value.errors.length > 0) {
          for (const error of value.errors) recordError(error);
          finish('worker-error'); return;
        }
        if (report.workers.every((entry) => entry.reply)) finish('two-workers-replied');
      });
      if (typeof target.onError === 'function') target.onError((error) => {
        if (!ended) { row.error = message(error); recordError(error); finish('worker-error'); }
      });
      if (typeof target.onProcessKilled === 'function') target.onProcessKilled(() => {
        if (!ended) { row.killed = true; finish('worker-killed'); }
      });
      const buffer = new Uint8Array([17, 23, row.id, 41]).buffer;
      const data = { id: row.id, runId: options.runId, buffer, shared };
      const transfers = [buffer];
      if (row.id === 0) {
        canvas = wx.createCanvas(); canvas.width = 256; canvas.height = 256;
        row.canvasTransferMethod = typeof canvas.transferControlToOffscreen;
        if (typeof canvas.transferControlToOffscreen === 'function') {
          data.canvas = canvas.transferControlToOffscreen();
          transfers.push(data.canvas); report.canvasTransferred = true;
        }
      }
      target.postMessage(data, transfers);
      row.senderBufferBytesAfterTransfer = buffer.byteLength;
    }
  }
} catch (error) { recordError(error); finish('main-failed'); }
