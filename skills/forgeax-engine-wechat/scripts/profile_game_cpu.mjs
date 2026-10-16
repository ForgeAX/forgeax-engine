#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const codeOf = error => /^[a-z][a-z0-9-]+$/.test(error?.code ?? '') ? error.code : 'operation-failed';
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'loopback' : host;

function configuration(options) {
  if (!/^s\d+$/.test(options.window ?? '')) fail('invalid-window');
  if (!/^[a-f0-9]{64}$/.test(options.manifestSha ?? '')) fail('invalid-manifest-sha');
  if (!options.project || !options.out) fail('project-and-output-required');
  const durationMs = Number(options.durationMs ?? 10000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 10000 || durationMs > 20000)
    fail('duration-must-be-10000-to-20000-ms');
  let endpoint;
  try { endpoint = new URL(options.endpoint ?? 'http://127.0.0.1:9422'); }
  catch { fail('invalid-endpoint'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['/', '/json/list'].includes(endpoint.pathname)) fail('invalid-endpoint');
  endpoint.pathname = '/json/list';
  const targetPath = options.targetPath ?? `/game/${options.window}/_sessionId/simulator-app-session-${options.window}/gamePage.html`;
  if (!targetPath.startsWith(`/game/${options.window}/`) || targetPath.includes('?') || targetPath.includes('#') || new URL(targetPath, endpoint).pathname !== targetPath) fail('invalid-target-path');
  return { ...options, endpoint, targetPath, durationMs, project: resolve(options.project), out: resolve(options.out) };
}

/** Inspect only metadata; never attach to an unrelated target to identify it. */
export function selectTarget(targets, { endpoint, targetPath }) {
  if (!Array.isArray(targets)) fail('invalid-target-list');
  const matches = targets.filter(target => {
    try { return new URL(target.url).pathname === targetPath; } catch { return false; }
  });
  if (matches.length !== 1) fail(matches.length ? 'target-ambiguous' : 'target-not-found');
  let socketUrl;
  try { socketUrl = new URL(matches[0].webSocketDebuggerUrl); }
  catch { fail('target-websocket-unavailable'); }
  const origin = new URL(endpoint);
  if (!['ws:', 'wss:'].includes(socketUrl.protocol) || socketUrl.username || socketUrl.password || loopback(socketUrl.hostname) !== loopback(origin.hostname) || socketUrl.port !== origin.port) fail('target-websocket-origin-mismatch');
  return socketUrl.href;
}

export async function verifyPublication(project, manifestSha) {
  let manifestBytes, manifest, game;
  try {
    manifestBytes = await readFile(join(project, 'forgeax-dist.json'));
    manifest = JSON.parse(manifestBytes);
    game = await readFile(join(project, 'game.js'));
  } catch { fail('publication-unreadable'); }
  if (sha256(manifestBytes) !== manifestSha) fail('publication-manifest-mismatch');
  const rows = Array.isArray(manifest.artifacts) ? manifest.artifacts.filter(row => row.path === 'game.js') : [];
  if (manifest.target !== 'wechat' || rows?.length !== 1 || rows[0].bytes !== game.length || rows[0].sha256 !== sha256(game)) fail('publication-bootstrap-mismatch');
  return { manifestSha256: manifestSha, gameJsSha256: rows[0].sha256, gameJsBytes: game.length };
}

class Cdp {
  pending = new Map();
  nextId = 0;
  lifetime = new AbortController();

  constructor(url) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', event => {
      let response;
      try { response = JSON.parse(String(event.data)); } catch { this.retire('cdp-invalid-response'); return; }
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      request.finish();
      if (response.error) request.reject(Object.assign(new Error('cdp-command-rejected'), { code: 'cdp-command-rejected' }));
      else request.resolve(response.result);
    });
    this.socket.addEventListener('error', () => this.retire('cdp-socket-error'));
    this.socket.addEventListener('close', () => this.retire('cdp-socket-closed'));
  }

  retire(code) {
    this.lifetime.abort(code);
    for (const request of this.pending.values()) {
      request.finish();
      request.reject(Object.assign(new Error(code), { code }));
    }
    this.pending.clear();
  }

  async open(signal) {
    if (signal.aborted) fail('interrupted');
    if (this.socket.readyState === WebSocket.OPEN) return;
    if (this.lifetime.signal.aborted) fail('cdp-socket-closed');
    await new Promise((resolveOpen, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.socket.removeEventListener('open', opened);
        this.lifetime.signal.removeEventListener('abort', failed);
        signal.removeEventListener('abort', interrupted);
      };
      const opened = () => { finish(); resolveOpen(); };
      const error = code => { finish(); reject(Object.assign(new Error(code), { code })); };
      const failed = () => error('cdp-connect-failed');
      const interrupted = () => error('interrupted');
      const timer = setTimeout(() => error('cdp-connect-timeout'), 10000);
      this.socket.addEventListener('open', opened, { once: true });
      this.lifetime.signal.addEventListener('abort', failed, { once: true });
      signal.addEventListener('abort', interrupted, { once: true });
    });
  }

  call(method, params = {}, signal) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('interrupted'), { code: 'interrupted' }));
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('cdp-socket-closed'), { code: 'cdp-socket-closed' }));
    return new Promise((resolveCall, reject) => {
      const id = ++this.nextId;
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', interrupted); };
      const failed = code => {
        this.pending.delete(id); finish(); reject(Object.assign(new Error(code), { code }));
      };
      const interrupted = () => failed('interrupted');
      const timer = setTimeout(() => failed('cdp-command-timeout'), 10000);
      this.pending.set(id, { resolve: resolveCall, reject, finish });
      signal?.addEventListener('abort', interrupted, { once: true });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { failed('cdp-send-failed'); }
    });
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return true;
    const closed = new Promise(resolveClose => {
      const done = () => { clearTimeout(timer); this.socket.removeEventListener('close', done); resolveClose(true); };
      const timer = setTimeout(() => { this.socket.removeEventListener('close', done); resolveClose(false); }, 2000);
      this.socket.addEventListener('close', done, { once: true });
    });
    this.socket.close();
    this.retire('cdp-socket-closed');
    return closed;
  }
}

const snapshotExpression = `(() => {
  const g = globalThis.GameGlobal?.__gameContextWindow;
  const inspection = g?.__forgeaxGameInspection;
  const r = inspection?.renderer?.();
  return { targetPath: new URL(globalThis.location.href).pathname, game: !!inspection,
    inspectionKeys: inspection ? Object.keys(inspection).sort() : [],
    renderer: r && { generation: r.generation, completed: r.completed, presented: r.presented,
      phase: r.phase, failed: !!r.startupError || !!r.lastError },
    clockMs: g?.performance?.now(), clockOriginMs: g?.performance?.timeOrigin };
})()`;

async function snapshot(cdp, config, signal) {
  const value = await cdp.call('Runtime.evaluate', { expression: snapshotExpression, returnByValue: true }, signal);
  if (value?.exceptionDetails) fail('game-inspection-failed');
  const state = value?.result?.value;
  const r = state?.renderer;
  if (state?.targetPath !== config.targetPath || !state.game) fail('game-target-mismatch');
  if (!r || r.phase !== 'ready' || r.failed || ![r.generation, r.completed, r.presented].every(Number.isSafeInteger) || !Number.isFinite(state.clockMs) || !Number.isFinite(state.clockOriginMs)) fail('game-not-ready');
  return state;
}

function scrubProfile(profile, window) {
  if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples) || !Number.isFinite(profile.startTime) || !Number.isFinite(profile.endTime) || profile.endTime <= profile.startTime) fail('invalid-cpu-profile');
  let redactedScriptUrls = 0;
  for (const node of profile.nodes) {
    const frame = node.callFrame;
    if (!frame || typeof frame.url !== 'string') fail('invalid-cpu-profile');
    const before = frame.url;
    const gameWindow = /\/game\/([^/]+)\//.exec(before)?.[1];
    if (gameWindow && gameWindow !== window) frame.url = '[other-game-target]';
    else {
      // URL query strings, fragments and credentials do not identify CPU owners.
      try { const url = new URL(before); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; frame.url = url.href; }
      catch { frame.url = before.split(/[?#]/, 1)[0]; }
    }
    if (frame.url !== before) redactedScriptUrls++;
  }
  return redactedScriptUrls;
}

/** Runs on the DevTools machine, using an existing authorized endpoint only. */
export async function profileGame(options, { signal = new AbortController().signal, emit = value => console.log(JSON.stringify(value)) } = {}) {
  const config = configuration(options);
  try { await mkdir(config.out, { recursive: false, mode: 0o700 }); }
  catch { fail('output-directory-unavailable'); }
  const report = {
    success: false, window: config.window, targetPath: config.targetPath,
    requestedDurationMs: config.durationMs, samplingIntervalUs: 1000,
    identityScope: 'Local manifest/game.js bytes and the caller-owned exact window path; executed JavaScript bytes are not verified.',
    interpretation: 'V8 CPU sampling adds overhead; this is CPU attribution, not an uninstrumented frame budget or exclusive GPU timing.',
    cleanup: { stop: 'not-started', disable: 'not-enabled', socketClosed: true },
  };
  let cdp, enableAttempted = false, startAttempted = false, profile;
  try {
    report.publication = await verifyPublication(config.project, config.manifestSha);
    let targets;
    try {
      const response = await fetch(config.endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: 'error' });
      if (!response.ok) fail('endpoint-unavailable');
      targets = await response.json();
    } catch { fail(signal.aborted ? 'interrupted' : 'endpoint-unavailable'); }
    cdp = new Cdp(selectTarget(targets, config));
    report.cleanup.socketClosed = false;
    await cdp.open(signal);
    report.before = await snapshot(cdp, config, signal);
    report.profilerInspection = {
      status: report.before.inspectionKeys.some(key => /profiler/i.test(key)) ? 'exposed' : 'unavailable',
      keys: report.before.inspectionKeys,
      selection: 'explicit-v8-cpu-sample',
    };
    enableAttempted = true;
    await cdp.call('Profiler.enable', {}, signal);
    await cdp.call('Profiler.setSamplingInterval', { interval: report.samplingIntervalUs }, signal);
    startAttempted = true;
    await cdp.call('Profiler.start', {}, signal);
    report.samplingStartedAtUtc = new Date().toISOString();
    emit({ phase: 'sampling-started', window: config.window, durationMs: config.durationMs, startedAtUtc: report.samplingStartedAtUtc });
    try { await pause(config.durationMs, undefined, { signal: AbortSignal.any([signal, cdp.lifetime.signal]) }); }
    catch { fail(signal.aborted ? 'interrupted' : 'cdp-socket-closed'); }
    ({ profile } = await cdp.call('Profiler.stop', {}, signal));
    startAttempted = false;
    report.cleanup.stop = 'complete';
    report.samplingStoppedAtUtc = new Date().toISOString();
    report.after = await snapshot(cdp, config, signal);
    if (report.after.renderer.generation !== report.before.renderer.generation || report.after.clockOriginMs !== report.before.clockOriginMs || report.after.clockMs <= report.before.clockMs || report.after.renderer.completed < report.before.renderer.completed || report.after.renderer.presented < report.before.renderer.presented) fail('game-generation-changed');
    await verifyPublication(config.project, config.manifestSha);
    report.publicationUnchanged = true;
    report.redactedScriptUrls = scrubProfile(profile, config.window);
    report.profile = { file: 'profile.cpuprofile', sampledDurationMs: (profile.endTime - profile.startTime) / 1000, nodeCount: profile.nodes.length, sampleCount: profile.samples.length };
    await writeFile(join(config.out, 'profile.cpuprofile'), JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
    report.success = true;
  } catch (error) {
    report.failure = { code: codeOf(error) };
  } finally {
    if (startAttempted) {
      try { await cdp.call('Profiler.stop'); report.cleanup.stop = 'complete'; }
      catch (error) { report.cleanup.stop = codeOf(error); }
    }
    if (enableAttempted) {
      try { await cdp.call('Profiler.disable'); report.cleanup.disable = 'complete'; }
      catch (error) { report.cleanup.disable = codeOf(error); }
    }
    if (cdp) {
      try { report.cleanup.socketClosed = await cdp.close(); }
      catch { report.cleanup.socketClosed = false; }
    }
    if (!report.cleanup.socketClosed || (enableAttempted && report.cleanup.disable !== 'complete') || (startAttempted && report.cleanup.stop !== 'complete')) {
      report.success = false;
      report.failure ??= { code: 'profiler-cleanup-failed' };
    }
    await writeFile(join(config.out, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  emit({ phase: 'complete', ...report });
  return report;
}

async function main() {
  const { values } = parseArgs({ options: {
    endpoint: { type: 'string', default: 'http://127.0.0.1:9422' },
    window: { type: 'string' }, project: { type: 'string' }, 'manifest-sha': { type: 'string' },
    out: { type: 'string' }, 'duration-ms': { type: 'string', default: '10000' },
    'target-path': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node profile_game_cpu.mjs --window s8 --project /absolute/game --manifest-sha SHA256 --out /new/output [--endpoint http://127.0.0.1:9422] [--duration-ms 10000..20000] [--target-path PATH]\nRun with Node 22+ on the DevTools machine. The qualified default path is /game/<window>/_sessionId/simulator-app-session-<window>/gamePage.html; override only for an observed version change. Reuses one authorized endpoint, requires an exact unique target path, checks local publication bytes before/after, and emits sampling-started for coordinated input. Executed JavaScript bytes are not verified. Never opens/restarts DevTools or changes its configuration.');
    return;
  }
  const controller = new AbortController();
  const interrupted = () => controller.abort();
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    const report = await profileGame({ endpoint: values.endpoint, window: values.window, project: values.project, manifestSha: values['manifest-sha'], out: values.out, durationMs: values['duration-ms'], targetPath: values['target-path'] }, { signal: controller.signal });
    process.exitCode = report.success ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

// Node canonicalizes module URLs, including macOS /tmp -> /private/tmp.
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.log(JSON.stringify({ success: false, failure: { code: codeOf(error) } })); process.exitCode = 1; });
}
