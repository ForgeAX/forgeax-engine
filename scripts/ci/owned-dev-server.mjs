import { execFileSync, spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const PORT_PLACEHOLDER = '__PORT__';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_READINESS_PATH = '/';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const CLEANUP_TIMEOUT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readProcessTable() {
  let output;
  try {
    output = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' });
  } catch {
    output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' });
  }

  const processes = new Map();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, pgid, stat, command] = match;
    processes.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      sid: Number(pgid),
      stat,
      command,
    });
  }
  return processes;
}

function processTree(rootPid, processes = readProcessTable()) {
  const children = new Map();
  for (const entry of processes.values()) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry.pid);
    children.set(entry.ppid, siblings);
  }

  const result = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (processes.has(pid) || isAlive(pid)) result.push(pid);
    for (const childPid of children.get(pid) ?? []) pending.push(childPid);
  }
  return result;
}

function listenerPidsWithLsof(port) {
  const output = execFileSync('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return [...new Set(output.split(/\s+/).filter(Boolean).map(Number))].filter(Number.isInteger);
}

function listenerPidsWithSs(port) {
  const output = execFileSync('ss', ['-ltnpH'], { encoding: 'utf8' });
  const portPattern = new RegExp(`\\S+:${port}\\s`);
  const pids = [];
  for (const line of output.split('\n')) {
    if (!portPattern.test(line)) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.push(Number(match[1]));
  }
  return [...new Set(pids)];
}

function listenerPids(port) {
  try {
    return listenerPidsWithLsof(port);
  } catch (error) {
    if (error?.status === 1) return [];
    if (error?.code !== 'ENOENT') {
      throw new Error(`cannot prove TCP listener ownership with lsof: ${error.message}`, {
        cause: error,
      });
    }
    try {
      return listenerPidsWithSs(port);
    } catch (fallbackError) {
      if (fallbackError?.status === 1) return [];
      throw new Error(
        `cannot prove TCP listener ownership with lsof or ss: ${fallbackError.message}`,
        {
          cause: fallbackError,
        },
      );
    }
  }
}

async function allocateFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_HOST, resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : null;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error('free-port allocation returned no TCP port');
  return port;
}

async function choosePort(requestedPort) {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error(`invalid requested port: ${requestedPort}`);
  }
  if (requestedPort === 0) {
    return { port: await allocateFreePort(), requestedPortOccupied: false };
  }
  const occupied = listenerPids(requestedPort).length > 0;
  return {
    port: occupied ? await allocateFreePort() : requestedPort,
    requestedPortOccupied: occupied,
  };
}

function requestReadiness(url, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(url, { timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on('end', () => {
        resolvePromise({ statusCode: response.statusCode ?? 0, body });
      });
    });
    request.once('timeout', () => request.destroy(new Error('readiness request timed out')));
    request.once('error', reject);
    request.end();
  });
}

function writeJson(path, value) {
  return mkdir(dirname(path), { recursive: true }).then(() =>
    writeFile(path, `${JSON.stringify(value, null, 2)}\n`),
  );
}

function resolveCommandArgs(args, port) {
  return args.map((arg) => (arg === PORT_PLACEHOLDER ? String(port) : arg));
}

async function waitForOwnedReadiness({ childPid, port, url, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'not ready';
  while (Date.now() < deadline) {
    if (!isAlive(childPid)) {
      throw new Error(`launched process ${childPid} exited before readiness (${lastReason})`);
    }
    const processes = readProcessTable();
    const treePids = processTree(childPid, processes);
    const pids = listenerPids(port);
    if (pids.length === 0) {
      lastReason = 'no listener';
      await sleep(pollIntervalMs);
      continue;
    }
    if (!pids.some((pid) => treePids.includes(pid))) {
      lastReason = `foreign listener pids=${pids.join(',')}; launched tree=${treePids.join(',')}`;
      await sleep(pollIntervalMs);
      continue;
    }
    try {
      const response = await requestReadiness(url, Math.min(1_000, timeoutMs));
      if (response.statusCode >= 200 && response.statusCode < 400) {
        if (!isAlive(childPid)) throw new Error('launched process exited after HTTP readiness');
        const afterProcesses = readProcessTable();
        const afterTreePids = processTree(childPid, afterProcesses);
        const afterListeners = listenerPids(port);
        if (!afterListeners.some((pid) => afterTreePids.includes(pid))) {
          throw new Error('listener ownership changed after HTTP readiness');
        }
        return {
          response,
          treePids: afterTreePids,
          listenerPids: afterListeners,
          processes: afterProcesses,
        };
      }
      lastReason = `HTTP ${response.statusCode}`;
    } catch (error) {
      lastReason = error.message;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`owned server readiness timed out after ${timeoutMs}ms: ${lastReason}`);
}

function sendSignal(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForCleanup(pids, port) {
  const deadline = Date.now() + CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remainingTreePids = pids.filter(isAlive);
    const remainingListenerPids = listenerPids(port);
    if (remainingTreePids.length === 0 && remainingListenerPids.length === 0) {
      return { remainingTreePids, remainingListenerPids };
    }
    await sleep(100);
  }
  return {
    remainingTreePids: pids.filter(isAlive),
    remainingListenerPids: listenerPids(port),
  };
}

export async function startOwnedServer({
  command,
  args = [],
  cwd = process.cwd(),
  requestedPort,
  stateFile,
  envName,
  envFile = process.env.GITHUB_ENV,
  readinessPath = DEFAULT_READINESS_PATH,
  readinessTimeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  logFile,
  writeEnvironment = true,
  extraEnv = {},
}) {
  if (!command || !stateFile) throw new Error('command and stateFile are required');
  const absoluteStateFile = resolve(stateFile);
  const absoluteCwd = resolve(cwd);
  const selected = await choosePort(requestedPort);
  const absoluteLogFile = resolve(logFile ?? `${absoluteStateFile}.log`);
  await mkdir(dirname(absoluteLogFile), { recursive: true });
  const logHandle = await open(absoluteLogFile, 'a');
  const resolvedArgs = resolveCommandArgs(args, selected.port);
  const url = `http://127.0.0.1:${selected.port}${readinessPath.startsWith('/') ? readinessPath : `/${readinessPath}`}`;
  const child = spawn(command, resolvedArgs, {
    cwd: absoluteCwd,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  const spawnError = new Promise((_, reject) => child.once('error', reject));
  child.unref();
  await logHandle.close();

  const initial = {
    version: 1,
    phase: 'starting',
    pid: child.pid,
    command,
    args: resolvedArgs,
    cwd: absoluteCwd,
    requestedPort,
    requestedPortOccupied: selected.requestedPortOccupied,
    port: selected.port,
    url,
    logFile: absoluteLogFile,
    processGroupId: child.pid,
    sessionId: child.pid,
    startedAt: new Date().toISOString(),
  };
  await writeJson(absoluteStateFile, initial);

  try {
    const ready = await Promise.race([
      waitForOwnedReadiness({
        childPid: child.pid,
        port: selected.port,
        url,
        timeoutMs: readinessTimeoutMs,
        pollIntervalMs,
      }),
      spawnError,
    ]);
    const readyState = {
      ...initial,
      phase: 'ready',
      readyAt: new Date().toISOString(),
      processAliveAtReadiness: isAlive(child.pid),
      treePidsAtReadiness: ready.treePids,
      listenerPids: ready.listenerPids,
      processGroupsAtReadiness: ready.treePids
        .map((pid) => ready.processes.get(pid))
        .filter(Boolean)
        .map(({ pid, pgid, sid }) => ({ pid, pgid, sid })),
      readiness: {
        statusCode: ready.response.statusCode,
        bodyBytes: Buffer.byteLength(ready.response.body),
      },
    };
    await writeJson(absoluteStateFile, readyState);
    if (envName) {
      if (!writeEnvironment) throw new Error(`environment export disabled for ${envName}`);
      if (!envFile) throw new Error(`GITHUB_ENV is unavailable for ${envName}`);
      await writeFile(envFile, `${envName}=${url}\n`, { flag: 'a' });
    }
    return readyState;
  } catch (error) {
    await stopOwnedServer({ stateFile: absoluteStateFile, allowMissing: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

export async function stopOwnedServer({ stateFile, allowMissing = false }) {
  const absoluteStateFile = resolve(stateFile);
  let state;
  try {
    state = JSON.parse(await readFile(absoluteStateFile, 'utf8'));
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return { missing: true };
    throw error;
  }
  const processes = readProcessTable();
  const processGroupId = Number.isInteger(state.processGroupId) ? state.processGroupId : state.pid;
  const sessionPids = [...processes.values()]
    .filter((entry) => entry.pgid === processGroupId)
    .map((entry) => entry.pid);
  const savedPids = [
    ...new Set([state.pid, ...(state.treePidsAtReadiness ?? []), ...sessionPids]),
  ].filter(Number.isInteger);
  const treeBefore = savedPids.filter(isAlive);
  const processGroupsBefore = savedPids
    .map((pid) => processes.get(pid))
    .filter(Boolean)
    .map(({ pid, pgid, sid }) => ({ pid, pgid, sid }));
  const listenerPidsBefore = listenerPids(state.port);
  const pgid = processGroupId;
  sendSignal(-pgid, 'SIGTERM');
  for (const pid of [...treeBefore].reverse()) sendSignal(pid, 'SIGTERM');
  let cleanup = await waitForCleanup(savedPids, state.port);
  if (cleanup.remainingTreePids.length > 0 || cleanup.remainingListenerPids.length > 0) {
    sendSignal(-pgid, 'SIGKILL');
    for (const pid of [...cleanup.remainingTreePids].reverse()) sendSignal(pid, 'SIGKILL');
    cleanup = await waitForCleanup(savedPids, state.port);
  }
  const result = {
    ...cleanup,
    complete: cleanup.remainingTreePids.length === 0 && cleanup.remainingListenerPids.length === 0,
    processGroupId: pgid,
    sessionId: state.sessionId,
    treeBefore,
    processGroupsBefore,
    listenerPidsBefore,
    stoppedAt: new Date().toISOString(),
  };
  await writeJson(absoluteStateFile, {
    ...state,
    phase: result.complete ? 'stopped' : 'cleanup-failed',
    cleanup: result,
  });
  if (!result.complete) {
    throw new Error(
      `owned server cleanup incomplete: tree=${result.remainingTreePids.join(',')} listeners=${result.remainingListenerPids.join(',')}`,
    );
  }
  return result;
}

function parseArgs(argv) {
  const [operation, ...rest] = argv;
  const options = {};
  const commandArgs = [];
  let commandMode = false;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--') {
      commandMode = true;
      commandArgs.push(...rest.slice(index + 1));
      break;
    }
    if (commandMode) {
      commandArgs.push(value);
      continue;
    }
    if (!value.startsWith('--')) throw new Error(`unexpected argument: ${value}`);
    const [key, inlineValue] = value.slice(2).split('=', 2);
    const next = inlineValue ?? rest[++index];
    if (next === undefined) throw new Error(`missing value for --${key}`);
    options[key] = next;
  }
  return { operation, options, commandArgs };
}

async function main() {
  const { operation, options, commandArgs } = parseArgs(process.argv.slice(2));
  if (operation === 'start') {
    const state = await startOwnedServer({
      command: commandArgs[0],
      args: commandArgs.slice(1),
      cwd: options.cwd,
      requestedPort: Number(options['requested-port'] ?? 0),
      stateFile: options['state-file'],
      envName: options['env-name'],
      readinessPath: options['readiness-path'] ?? DEFAULT_READINESS_PATH,
      readinessTimeoutMs: Number(options['timeout-ms'] ?? DEFAULT_TIMEOUT_MS),
      pollIntervalMs: Number(options['poll-ms'] ?? DEFAULT_POLL_INTERVAL_MS),
      logFile: options['log-file'],
    });
    console.log(JSON.stringify(state));
    return;
  }
  if (operation === 'stop') {
    const result = await stopOwnedServer({
      stateFile: options['state-file'],
      allowMissing: options['allow-missing'] === 'true',
    });
    console.log(JSON.stringify(result));
    return;
  }
  throw new Error(`unknown operation: ${operation}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
