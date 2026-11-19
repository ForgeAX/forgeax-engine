import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';

export function codexThreadId(meta) {
  const candidates = [meta?.threadId, meta?.thread_id, meta?.['x-codex-turn-metadata']?.thread_id]
    .filter(value => typeof value === 'string' && value.length > 0);
  if (candidates.length === 0 || new Set(candidates).size !== 1)
    throw new Error('Codex did not provide one unambiguous chat identity for this View request.');
  return candidates[0];
}

/** Read only public thread metadata. Never resume a chat or read its messages. */
export function createCodexDirectoryReader({ command, home }) {
  const pending = new Map();
  const children = new Set();
  let closed = false;
  const read = threadId => {
    if (closed) return Promise.reject(new Error('Codex directory reader retired.'));
    if (pending.has(threadId)) return pending.get(threadId);
    const task = new Promise((resolve, reject) => {
      const child = spawn(command, ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(home ? { CODEX_HOME: home } : {}) },
      });
      children.add(child);
      // stderr may contain host diagnostics; retain none of its content.
      child.stderr.resume();
      const lines = createInterface({ input: child.stdout });
      const forceClose = () => {
        const killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
        killTimer.unref();
        child.once('exit', () => clearTimeout(killTimer));
      };
      let settled = false;
      const timer = setTimeout(() => finish(new Error('Codex working directory lookup timed out.')), 5000);
      const finish = (error, directory) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.close();
        child.stdin.end();
        child.kill('SIGTERM');
        forceClose();
        children.delete(child);
        if (error) reject(error); else resolve(directory);
      };
      const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
      child.on('error', () => finish(new Error('The configured Codex command could not read chat metadata.')));
      child.on('exit', () => finish(new Error('Codex exited before returning chat metadata.')));
      child.stdin.on('error', () => finish(new Error('Codex metadata transport closed.')));
      lines.on('line', async line => {
        if (Buffer.byteLength(line) > 262144) { finish(new Error('Codex metadata response exceeded its bound.')); return; }
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id === 1) {
          if (message.error) { finish(new Error('Codex rejected metadata initialization.')); return; }
          send({ method: 'initialized', params: {} });
          send({ method: 'thread/read', id: 2, params: { threadId, includeTurns: false } });
        }
        if (message.id !== 2) return;
        const thread = message.result?.thread;
        if (message.error || thread?.id !== threadId || typeof thread.cwd !== 'string' || !isAbsolute(thread.cwd)) {
          finish(new Error('Codex did not return a local working directory for this chat.'));
          return;
        }
        try {
          const directory = await realpath(thread.cwd);
          if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory');
          finish(undefined, directory);
        } catch { finish(new Error('The Codex chat working directory is unavailable.')); }
      });
      send({ method: 'initialize', id: 1, params: {
        clientInfo: { name: 'forgeax_view_workspace', title: 'ForgeAX View workspace', version: '1' },
      } });
    }).finally(() => pending.delete(threadId));
    pending.set(threadId, task);
    return task;
  };
  return { read, close() { closed = true; for (const child of children) child.kill('SIGTERM'); } };
}
