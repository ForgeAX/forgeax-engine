import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCodexBindingStore } from './codex-binding.mjs';
import { createBridgeClient } from './client.mjs';
import { codexThreadId, createCodexDirectoryReader } from './codex-context.mjs';

export function workspaceBackendRoot(binding, threadId, temporary = tmpdir()) {
  const digest = createHash('sha256').update(JSON.stringify([
    binding.enginePackage, binding.hostPack, binding.codexContext?.home, threadId,
  ])).digest('hex').slice(0, 24);
  return join(temporary, 'forgeax/view-chats', digest);
}

/** Host context selects H; the existing owners retain projects, sessions and resources. */
export function createCodexRouting(binding, {
  directoryReader = createCodexDirectoryReader(binding.codexContext),
  createClient = createBridgeClient,
  createPresentation,
  bindingStore = createCodexBindingStore(binding),
  retainInstance = async root => {
    const { retainBackendLifetime } = await import(pathToFileURL(join(binding.enginePackage, 'dist/facades/devkit.mjs')).href);
    return retainBackendLifetime(root);
  },
  migrationTimeoutMs = 60000,
  documentIdleTimeoutMs = 120000,
} = {}) {
  const routes = new Map();
  const documents = new Map();
  const usage = new Map();
  let closed = false;
  const reaper = setInterval(() => {
    for (const [id, owner] of documents) {
      if (!owner.threadId || Date.now() - owner.touchedAt < documentIdleTimeoutMs || owner.retiring) continue;
      owner.retiring = true;
      void owner.route.then(selected => selected.service.invoke({ action: 'app-close', appDocumentId: id }))
        .then(async () => { documents.delete(id); await bindingStore.release(owner.threadId, id); })
        .catch(() => { owner.retiring = false; });
    }
  }, Math.min(15000, documentIdleTimeoutMs));
  reaper.unref();
  const assertCurrentBinding = (record, owner, message) => {
    if (record?.migration || record?.recovery || owner && owner.revision !== (record?.revision ?? 0))
      throw new Error(message);
  };
  const waitForRetirement = async (threadId, message, signal) => {
    const deadline = performance.now() + migrationTimeoutMs;
    while ((await bindingStore.leases(threadId)).length) {
      if (signal?.aborted) throw signal.reason;
      if (performance.now() >= deadline) throw new Error(message);
      await new Promise(done => setTimeout(done, 100));
    }
  };
  const route = async (scope, meta) => {
    if (closed) throw new Error('Codex View routing retired.');
    if (scope !== 'global' && scope !== 'workspace') throw new Error('View entry scope is required.');
    const threadId = scope === 'workspace' ? codexThreadId(meta) : undefined;
    if (!threadId) return select(binding.root);
    let record = await bindingStore.get(threadId);
    if (!record) {
      const directory = await realpath(await directoryReader.read(threadId));
      const release = await bindingStore.lock(threadId);
      try {
        record = await bindingStore.get(threadId);
        if (!record) {
          const selected = await select(workspaceBackendRoot(binding, threadId), directory);
          record = { revision: 0, root: selected.root, directory };
          await bindingStore.set(threadId, record);
        }
      } finally { await release(); }
    }
    if (record.recovery) {
      if (!createPresentation) throw new Error('Reopen this chat View to recover its interrupted binding.');
      const release = await bindingStore.lock(threadId);
      try {
        record = await bindingStore.get(threadId);
        if (record.recovery) {
          await waitForRetirement(threadId, 'View pages did not acknowledge recovery retirement.');
          const selected = await select(record.root, record.directory);
          await selected.service.prepare();
          if (record.directory) await selected.service.bind(record.directory);
          const { migration, recovery, ...committed } = record;
          record = { ...committed, revision: record.revision + 1 };
          await bindingStore.set(threadId, record);
        }
      } finally { await release(); }
    }
    if (record.migration) throw new Error('This chat View binding is migrating.');
    return select(record.root, record.directory);
  };
  const select = async (root, directory) => {
    const key = JSON.stringify([root, directory]);
    if (!routes.has(key)) {
      routes.set(key, (async () => {
        await mkdir(root, { recursive: true });
        const selected = { ...binding, root: await realpath(root) };
        if (!usage.has(selected.root)) usage.set(selected.root, retainInstance(selected.root).catch(error => { usage.delete(selected.root); throw error; }));
        await usage.get(selected.root);
        if (closed) throw new Error('Codex View routing retired.');
        const client = await createClient(selected);
        const service = createPresentation ? createPresentation(client, selected, directory) : undefined;
        return { root: selected.root, directory, client, service };
      })().catch(error => { routes.delete(key); throw error; }));
    }
    return routes.get(key);
  };
  return {
    route,
    async bind(inputDirectory, meta, signal) {
      if (!isAbsolute(inputDirectory)) throw new Error('An absolute workspace directory is required.');
      const directory = await realpath(inputDirectory);
      if (!(await stat(directory)).isDirectory()) throw new Error('The workspace must be an existing directory.');
      const threadId = codexThreadId(meta);
      const existing = await bindingStore.get(threadId);
      const first = existing?.root ? { root: existing.root } : await route('workspace', meta).catch(() => undefined);
      const release = await bindingStore.lock(threadId);
      let prior;
      let committed = false;
      let admissionAttempted = false;
      let unlocked = false;
      try {
        prior = await bindingStore.get(threadId) ?? { revision: 0, root: first?.root ?? workspaceBackendRoot(binding, threadId) };
        const destination = await select(prior.root, directory);
        const root = destination.root;
        if (prior.directory === directory && !prior.migration) return { phase: 'ready', directory, root, revision: prior.revision };
        const migration = { id: randomUUID(), pid: process.pid, directory, root, phase: 'preparing' };
        await bindingStore.set(threadId, { ...prior, migration });
        if (!destination.service?.prepare) throw new Error('View migration preparation is unavailable.');
        await destination.service.prepare(signal);
        if (signal?.aborted) throw signal.reason;
        migration.phase = 'retiring';
        await bindingStore.set(threadId, { ...prior, migration });
        await waitForRetirement(threadId, 'View pages did not acknowledge migration retirement.', signal);
        if (!destination.service?.bind) throw new Error('View project binding is unavailable.');
        admissionAttempted = true;
        await destination.service.bind(directory, signal);
        const revision = prior.revision + 1;
        await bindingStore.set(threadId, { revision, directory, root });
        committed = true;
        await release(); unlocked = true;
        const previousKey = JSON.stringify([root, prior.directory]);
        const previous = routes.get(previousKey);
        if (prior.directory !== directory && previous) {
          routes.delete(previousKey);
          await previous.then(selected => selected.service?.close()).catch(() => {});
        }
        return { phase: 'ready', directory, root, revision };
      } catch (error) {
        if (prior && !committed) {
          if (admissionAttempted && prior.directory) {
            try { await (await select(prior.root, prior.directory)).service.bind(prior.directory); }
            catch (rollback) {
              await bindingStore.set(threadId, { ...prior, recovery: true });
              throw new AggregateError([error, rollback], 'View project binding failed and recovery requires reopening this chat View.');
            }
          }
          delete prior.migration; delete prior.recovery;
          await bindingStore.set(threadId, prior);
        }
        throw error;
      } finally { if (!unlocked) await release(); }
    },
    async invoke(input, meta, options) {
      const id = input.appDocumentId;
      if (typeof id !== 'string') throw new Error('App document identity required for instance routing.');
      const scope = input.entryScope;
      const threadId = scope === 'workspace' ? codexThreadId(meta) : undefined;
      let record = threadId ? await bindingStore.get(threadId) : undefined;
      const selectSource = async () => {
        const owner = documents.get(id);
        if (owner && (owner.scope !== scope || owner.threadId !== threadId || owner.retiring))
          throw new Error('App document belongs to another or retiring View entry.');
        assertCurrentBinding(record, owner, 'This chat View binding is migrating or obsolete.');
        const selected = await route(scope, meta);
        const before = threadId ? await bindingStore.get(threadId) : undefined;
        assertCurrentBinding(before, owner, 'This chat View binding changed before selecting the source.');
        const result = await selected.service.invoke(input, options);
        const after = threadId ? await bindingStore.get(threadId) : undefined;
        if (after?.migration || after?.recovery || (after?.revision ?? 0) !== (before?.revision ?? 0))
          throw new Error('View binding changed while selecting this source.');
        return result;
      };
      if (input.action === 'source-select') return selectSource();
      const readBinding = async () => {
        const owner = documents.get(id);
        if (owner && (owner.scope !== scope || owner.threadId !== threadId)) throw new Error('App document belongs to another View entry.');
        if (owner) owner.touchedAt = Date.now();
        if (record?.recovery && !owner) { await route(scope, meta); record = await bindingStore.get(threadId); }
        return { phase: record?.recovery ? 'retiring' : record?.migration?.phase ?? 'ready', revision: record?.revision ?? 0 };
      };
      if (input.action === 'binding-read') return readBinding();
      let owner = documents.get(id);
      if (owner && (owner.scope !== scope || owner.threadId !== threadId))
        throw new Error('App document belongs to another View entry.');
      const admitDocument = async () => {
        if (input.action !== 'view-document') throw new Error('Open this App document before accessing its instance.');
        if (threadId && (!record || record.recovery)) await route(scope, meta);
        const release = threadId ? await bindingStore.lock(threadId) : undefined;
        try {
          const latest = threadId ? await bindingStore.get(threadId) : undefined;
          const selected = latest?.root ? await select(latest.root, latest.directory) : await select(binding.root);
          if (latest?.migration) throw new Error('This chat View binding is migrating.');
          owner = { scope, threadId, revision: latest?.revision ?? 0, route: Promise.resolve(selected), touchedAt: Date.now() };
          if (threadId) await bindingStore.lease(threadId, id, (await owner.route).root);
          documents.set(id, owner);
        } finally { await release?.(); }
      };
      if (!owner) {
        if (input.action === 'app-close') return {};
        await admitDocument();
      }
      if (owner.retiring) throw new Error('This App document is retiring.');
      owner.touchedAt = Date.now();
      let selected;
      if (threadId && input.action !== 'app-close' && owner.revision !== (record?.revision ?? 0))
        throw new Error('This App document belongs to an older View binding.');
      try { selected = await owner.route; }
      catch (error) { documents.delete(id); throw error; }
      if (!selected.service) throw new Error('View presentation owner is unavailable.');
      try { return await selected.service.invoke(input, options); }
      finally { if (input.action === 'app-close') { documents.delete(id); if (threadId) await bindingStore.release(threadId, id); } }
    },
    async request(operation, args, meta, signal) {
      const threadId = codexThreadId(meta);
      const before = await bindingStore.get(threadId);
      const selected = await route('workspace', meta);
      const result = await selected.client.request(operation, args, signal);
      const after = await bindingStore.get(threadId);
      if (after?.migration || (after?.revision ?? 0) !== (before?.revision ?? 0)) throw new Error('View binding changed while this request was in flight; refresh target identity.');
      return result;
    },
    async close() {
      closed = true;
      clearInterval(reaper);
      directoryReader.close();
      const results = await Promise.allSettled([...routes.values()].map(async value => (await value).service?.close()));
      for (const [id, owner] of documents) if (owner.threadId) await bindingStore.release(owner.threadId, id);
      documents.clear();
      routes.clear();
      const released = await Promise.allSettled([...usage.values()].map(async value => (await value).close()));
      usage.clear();
      const failures = [...results, ...released].filter(value => value.status === 'rejected').map(value => value.reason);
      if (failures.length) throw new AggregateError(failures, 'Codex View instance cleanup failed');
    },
  };
}
