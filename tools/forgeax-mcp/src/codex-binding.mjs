import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** One durable chat binding authority shared by the App and business MCP processes. */
export function createCodexBindingStore(binding) {
  const home = binding.codexContext?.home ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const directory = join(home, 'forgeax', 'view-bindings', digest(JSON.stringify([binding.enginePackage, binding.hostPack])).slice(0, 24));
  const recordPath = id => join(directory, `${digest(id)}.json`);
  const leasePath = (id, document) => join(directory, 'documents', `${digest(id)}-${document}.json`);
  const read = async path => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  };
  const write = async (path, value) => {
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  };
  return {
    async get(id) {
      const value = await read(recordPath(id));
      if (value && (value.schemaVersion !== 1 || value.threadId !== id || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        typeof value.root !== 'string' || (value.directory !== undefined && typeof value.directory !== 'string')))
        throw new Error('Invalid persisted View chat binding.');
      // A crashed migration cannot change the last committed directory.
      if (value?.migration && !alive(value.migration.pid)) {
        value.recovery = true;
      }
      return value;
    },
    async set(id, value) { await write(recordPath(id), { schemaVersion: 1, threadId: id, ...value }); },
    async lock(id) {
      await mkdir(directory, { recursive: true });
      const lock = `${recordPath(id)}.lock`;
      try { await mkdir(lock); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = await read(join(lock, 'owner.json'));
        if (owner ? alive(owner.pid) : Date.now() - (await stat(lock)).mtimeMs < 5000)
          throw new Error('This chat View binding is already migrating.');
        await rm(lock, { recursive: true });
        await mkdir(lock);
      }
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      return () => rm(lock, { recursive: true, force: true });
    },
    async lease(id, document, root) {
      await mkdir(join(directory, 'documents'), { recursive: true });
      await write(leasePath(id, document), { threadId: id, document, root, pid: process.pid });
    },
    async release(id, document) { await rm(leasePath(id, document), { force: true }); },
    async leases(id) {
      const folder = join(directory, 'documents');
      const files = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const leases = [];
      for (const file of files) {
        if (!file.startsWith(`${digest(id)}-`) || !file.endsWith('.json')) continue;
        const value = await read(join(folder, file));
        if (value && alive(value.pid)) leases.push(value);
        else await rm(join(folder, file), { force: true });
      }
      return leases;
    },
  };
}
