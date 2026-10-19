import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_REQUEST_BYTES = 16_384;
const MAX_RESULT_BYTES = 24_576;
const PACK_TIMEOUT_MS = 5_000;
const PACK_WORKER = fileURLToPath(new URL('./pack-inspect.mjs', import.meta.url));

function failure(code, expected, hint, detail) {
  return { ok: false, error: { code, expected, hint, ...(detail === undefined ? {} : { detail }) } };
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredString(value, label, max = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw Object.assign(new Error(`${label} must be a nonempty string of at most ${max} characters`), { code: 'invalid-argument' });
  return value;
}

function boundedInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw Object.assign(new Error(`${label} must be an integer from ${min} to ${max}`), { code: 'invalid-argument' });
  return value;
}

function bounded(value) {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded) <= MAX_RESULT_BYTES
    ? value
    : failure('result-too-large', `a result of at most ${MAX_RESULT_BYTES} bytes`, 'Narrow the query or inspect this item in View.');
}

async function runTool(api, operation, args, signal) {
  const owners = api.list().filter(entry => entry.callable && entry.descriptor.id === operation);
  if (owners.length !== 1) return failure('owner-unavailable', `one active ${operation} provider`, 'Start the owning View workspace and retry.');
  const owner = owners[0].owner;
  const terminal = await api.run(operation, args, {
    sourceId: owner.sourceId,
    providerId: owner.providerId,
    generation: owner.generation,
    signal,
  }).terminal;
  if (terminal.outcome === 'failed') {
    const { code, expected, hint, detail } = terminal.failure;
    const ownerCode = typeof object(detail).code === 'string' && /^(view|engine)-/.test(detail.code)
      ? detail.code : code;
    return failure(ownerCode, expected, hint,
      typeof object(detail).generation === 'number' ? { generation: detail.generation } : undefined);
  }
  if (terminal.outcome !== 'succeeded')
    return failure('mcp-cancelled', 'a completed owner operation', 'Retry after checking the current target.');
  if (object(terminal.result).ok === false && typeof object(object(terminal.result).error).code === 'string') {
    const domainError = object(terminal.result.error);
    return failure(String(domainError.code), String(domainError.expected ?? 'the owner operation to succeed'),
      String(domainError.hint ?? 'Refresh the target identity and retry.'),
      typeof object(domainError.detail).generation === 'number' ? { generation: domainError.detail.generation } : undefined);
  }
  return { ok: true, value: terminal.result };
}

async function workspace(api, operation, args, signal) {
  const result = await runTool(api, 'view.workspace.call', { operation, args }, signal);
  if (!result.ok) return result;
  const value = result.value;
  return object(value).ok === false
    ? failure(String(object(value.error).code ?? object(value).code ?? 'workspace-failed'),
      String(object(value.error).expected ?? 'the workspace operation to succeed'),
      String(object(value.error).hint ?? 'Refresh workspace status and retry.'),
      Array.isArray(object(value).candidates) ? { candidates: value.candidates.slice(0, 16) }
        : typeof object(value).reason === 'string' ? { reason: value.reason } : undefined)
    : { ok: true, value };
}

function targetSummary(target) {
  const row = object(target);
  return {
    targetId: row.targetId,
    generation: row.generation,
    ...(typeof row.role === 'string' ? { role: row.role } : {}),
    ...(typeof row.phase === 'string' ? { phase: row.phase } : {}),
  };
}

function pageSummary(page) {
  const row = object(page);
  const project = object(row.project);
  const targets = Array.isArray(row.targets) ? row.targets : [];
  return {
    connectionId: row.connectionId,
    ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
    ...(typeof project.id === 'string' ? { project: { id: project.id, root: project.root, name: project.name } } : {}),
    ...(typeof row.projectPhase === 'string' ? { projectPhase: row.projectPhase } : {}),
    ...(typeof row.browserGeneration === 'number' ? { browserGeneration: row.browserGeneration } : {}),
    targets: targets.slice(0, 4).map(targetSummary),
    ...(row.hasMoreTargets === true || targets.length > 4 ? { hasMoreTargets: true } : {}),
  };
}

async function inspectPack(root, args, signal, workerPath) {
  const sourcePath = requiredString(args.subject, 'subject', 2048);
  if (!isAbsolute(sourcePath)) return failure('invalid-argument', 'an absolute Pack source path', 'Pass the canonical source path.');
  let canonical;
  try { canonical = await realpath(sourcePath); }
  catch { return failure('pack-source-not-found', 'an existing Pack source', 'Read the project source path and retry.'); }
  const within = relative(root, canonical);
  if (!within || within.startsWith('..') || isAbsolute(within))
    return failure('root-mismatch', 'a source within the active project root', 'Connect to the backend for this project.');
  if (!/\.pack\.(ts|json)$/.test(canonical))
    return failure('invalid-argument', 'a .pack.ts or .pack.json source', 'Choose a Pack authoring source.');
  const workerSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(PACK_TIMEOUT_MS)]) : AbortSignal.timeout(PACK_TIMEOUT_MS);
  try {
    const { stdout } = await execFileAsync(process.execPath, [workerPath, root, canonical], {
      signal: workerSignal, timeout: PACK_TIMEOUT_MS, maxBuffer: MAX_RESULT_BYTES, encoding: 'utf8',
    });
    const inspected = JSON.parse(stdout);
    if (inspected.ok && inspected.value) inspected.value.projectRelativePath = relative(root, canonical).split('\\').join('/');
    return bounded(inspected);
  } catch (error) {
    return failure(signal?.aborted ? 'pack-inspect-cancelled' : workerSignal.aborted ? 'pack-inspect-timeout' : 'pack-inspect-failed',
      `Pack inspection within ${PACK_TIMEOUT_MS} ms`, 'Inspect the Pack source in the project and retry.',
      { reason: String(error.code ?? error.message).slice(0, 160) });
  }
}

export async function dispatch(api, root, tool, input, signal, workerPath = PACK_WORKER) {
  const args = object(input);
  try {
    switch (tool) {
      case 'view.start': return bounded(await runTool(api, 'view.start', { root }, signal));
      case 'view.status': {
        const status = await runTool(api, 'view.status', {}, signal);
        if (!status.ok) return status;
        const phase = object(status.value).phase;
        const workspaceState = phase === 'ready' ? await workspace(api, 'summary.get', {}, signal) : undefined;
        if (workspaceState && !workspaceState.ok) return workspaceState;
        const state = workspaceState?.ok ? object(workspaceState.value) : {};
        const pageState = phase === 'ready' ? await workspace(api, 'pages.list', {}, signal) : undefined;
        if (pageState && !pageState.ok) return pageState;
        const pages = pageState?.ok && Array.isArray(pageState.value?.pages)
          ? pageState.value.pages.slice(0, 16).map(pageSummary) : [];
        const targets = Array.isArray(state.targets) ? state.targets : [];
        return bounded({ ok: true, value: {
          root,
          phase,
          ...(typeof object(status.value).url === 'string' ? { url: status.value.url } : {}),
          ...(state.project ? { project: { id: state.project.id, root: state.project.root, name: state.project.name } } : {}),
          ...(typeof state.projectPhase === 'string' ? { projectPhase: state.projectPhase } : {}),
          ...(Number.isSafeInteger(state.revision) ? { revision: state.revision } : {}),
          ...(Number.isSafeInteger(state.browserGeneration) ? { browserGeneration: state.browserGeneration } : {}),
          targets: targets.slice(0, 16).map(targetSummary),
          ...(state.hasMoreTargets === true || targets.length > 16 ? { hasMoreTargets: true } : {}),
          pages,
          ...(pageState?.value?.hasMorePages === true ? { hasMorePages: true } : {}),
        } });
      }
      case 'asset.inspect': return inspectPack(root, args, signal, workerPath);
      case 'view.workspace.pack.reveal': {
        const projectId = requiredString(args.projectId, 'projectId', 256);
        const sourcePath = requiredString(args.sourcePath, 'sourcePath', 2048);
        const revision = requiredString(args.revision, 'revision', 128);
        const packageId = args.packageId === undefined ? undefined : requiredString(args.packageId, 'packageId', 128);
        const connectionId = args.connectionId === undefined ? undefined : requiredString(args.connectionId, 'connectionId', 128);
        const revealed = await workspace(api, 'pack.reveal', { projectId, sourcePath, revision,
          ...(packageId ? { packageId } : {}), ...(connectionId ? { connectionId } : {}) }, signal);
        return bounded(revealed);
      }
      case 'engine.asset.inspect': {
        const guid = requiredString(args.guid, 'guid', 128);
        const projectId = requiredString(args.projectId, 'projectId', 256);
        const targetId = requiredString(args.targetId, 'targetId', 128);
        // The Engine owner routes this call to the exact target's session and
        // checks projectId. No View page is selected as an implicit default.
        const response = await runTool(api, 'engine.asset.inspect', {
          guid, projectId, targetId,
        }, signal);
        if (!response.ok) return response;
        if (object(response.value).ok === false) return bounded(response.value);
        const inspected = object(object(response.value).inspection);
        const asset = object(inspected.asset);
        const meta = object(inspected.meta);
        return bounded({ ok: true, value: {
          guid: inspected.guid ?? guid, kind: inspected.kind ?? asset.kind, revision: inspected.revision,
          source: inspected.source, ddc: inspected.ddc,
          ...(typeof meta.packageId === 'string' ? { packageId: meta.packageId } : {}),
          asset: { guid: asset.guid, kind: asset.kind, sourcePath: asset.sourcePath ?? asset.path,
            packageId: asset.packageId ?? meta.packageId, sourceKey: asset.sourceKey },
        } });
      }
      case 'engine.scene.tree.get': {
        const targetId = requiredString(args.targetId, 'targetId', 128);
        const targetGeneration = boundedInteger(args.targetGeneration, 'targetGeneration', 1, Number.MAX_SAFE_INTEGER);
        const offset = boundedInteger(args.offset ?? 0, 'offset', 0, 1_000_000);
        const limit = boundedInteger(args.limit ?? 50, 'limit', 1, 50);
        const response = await runTool(api, 'engine.scene.tree.get', { targetId, targetGeneration, offset, limit,
          ...(args.revision === undefined ? {} : { revision: boundedInteger(args.revision, 'revision', 0, Number.MAX_SAFE_INTEGER) }) }, signal);
        return bounded(response);
      }
      case 'engine.entity.inspect': {
        const targetId = requiredString(args.targetId, 'targetId', 128);
        const targetGeneration = boundedInteger(args.targetGeneration, 'targetGeneration', 1, Number.MAX_SAFE_INTEGER);
        const entityId = requiredString(args.entityId, 'entityId', 128);
        return bounded(await runTool(api, 'engine.entity.inspect', { targetId, targetGeneration, entityId }, signal));
      }
      default: return failure('operation-not-exposed', 'one of the six fixed tools', 'Update the MCP tool package.');
    }
  } catch (error) {
    return failure(error.code ?? 'bridge-failed', 'a valid bounded tool request', String(error.message).slice(0, 240));
  }
}

export default {
  name: 'forgeax.mcp.bridge',
  inject: ['devkitBackend', 'toolApi'],
  async apply(ctx) {
    const root = await realpath(ctx.devkitBackend.root);
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-mcp-'));
    await chmod(directory, 0o700);
    const socketPath = join(directory, 'bridge.sock');
    const statePath = join(root, '.forgeax', 'host', 'mcp-bridge.json');
    const clients = new Set();
    const server = createServer(socket => {
      clients.add(socket);
      socket.once('close', () => clients.delete(socket));
      let buffer = '';
      const controller = new AbortController();
      socket.once('close', () => controller.abort());
      // A timed-out MCP client can close while a bounded owner query is still
      // completing. Its late EPIPE belongs to this socket, not the Host.
      socket.on('error', () => controller.abort());
      const reply = value => {
        if (!controller.signal.aborted && !socket.destroyed)
          socket.end(`${JSON.stringify(value)}\n`);
      };
      socket.setTimeout(20_000, () => socket.destroy());
      socket.on('data', async chunk => {
        buffer += chunk.toString('utf8');
        if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) { socket.destroy(); return; }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        socket.removeAllListeners('data');
        try {
          const request = JSON.parse(buffer.slice(0, newline));
          const answer = request.token !== token || request.id !== id || request.root !== root
            ? failure('bridge-unauthorized', 'the active backend session and exact root', 'Reconnect the matching MCP server.')
            : await dispatch(ctx.toolApi, root, request.tool, request.args,
              AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              join(ctx.devkitBackend.hostPackageRoot, 'src', 'pack-inspect.mjs'));
          reply(bounded(answer));
        } catch (error) {
          reply(failure('bridge-invalid-request', 'one JSON request', String(error.message)));
        }
      });
    });
    try {
      await once(server.listen(socketPath), 'listening');
      await chmod(socketPath, 0o600);
      await mkdir(dirname(statePath), { recursive: true });
      const pending = `${statePath}.${id}.tmp`;
      await writeFile(pending, `${JSON.stringify({ id, root, socketPath, token })}\n`, { mode: 0o600, flag: 'wx' });
      await rename(pending, statePath);
    } catch (error) {
      server.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    ctx.effect(() => async () => {
      for (const socket of clients) socket.destroy();
      await new Promise(done => server.close(done));
      try {
        const current = JSON.parse(await readFile(statePath, 'utf8'));
        if (current.id === id) await rm(statePath, { force: true });
      } catch { /* Host is already retiring. */ }
      await rm(directory, { recursive: true, force: true });
    });
  },
};
