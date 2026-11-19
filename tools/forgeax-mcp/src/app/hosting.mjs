import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** The installed Engine/View owns startup; MCP owns only its static presentation lease. */
export function createAppHosting(binding, { initialProject } = {}) {
  let opening;
  let service;
  let starting;
  let closed = false;
  const presentationId = createHash('sha256')
    .update(JSON.stringify([binding.root, binding.enginePackage, binding.hostPack]))
    .digest('hex');
  const open = () => opening ??= (async () => {
    const viewRoot = binding.viewRoot;
    const { createViewService } = await import(pathToFileURL(join(viewRoot, 'dist/modules/service.mjs')).href);
    service = await createViewService({
      root: binding.root,
      staticRoot: join(viewRoot, 'dist/viewer'),
      ensure: async (project, signal) => {
        const { ensureDevKitView } = await import(pathToFileURL(join(binding.enginePackage, 'dist/facades/devkit.mjs')).href);
        const result = await ensureDevKitView(binding.root, { hostPack: binding.hostPack, ...(binding.codexContext ? { lifetime: 'clients' } : {}), ...(project === undefined ? {} : { project }), signal });
        // First adopt the backend's existing project. The working directory is
        // only an initial selection for a fresh, unbound workspace instance.
        if (project !== undefined || !result.ok || initialProject === undefined || result.value?.view?.project) return result;
        if (binding.codexContext) {
          try { await access(join(binding.root, '.forgeax/host/workspace-selection.json')); return result; }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        try { await access(join(initialProject, 'forge.json')); }
        catch { return result; }
        return ensureDevKitView(binding.root, { hostPack: binding.hostPack, ...(binding.codexContext ? { lifetime: 'clients' } : {}), project: initialProject, signal });
      },
    });
    if (closed) {
      await service.close();
      throw new Error('MCP presentation retired');
    }
    return { url: service.server.viewerUrl, presentationId };
  })();
  return {
    open,
    async prepare(signal) {
      if (closed) throw new Error('MCP presentation retired');
      await open();
      const result = await service.start();
      if (signal?.aborted) throw signal.reason;
      if (!result.ok) throw new Error(result.error?.hint ?? 'View backend preparation failed');
    },
    async bind(directory, signal) {
      await open();
      if (signal?.aborted) throw signal.reason;
      try { await access(join(directory, 'forge.json')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // A source workspace without a game returns to the owner project chooser.
        const response = await fetch(service.server.bootstrapUrl, { signal, cache: 'no-store' });
        const bootstrap = await response.json();
        const { connectViewWorkspace } = await import(pathToFileURL(join(binding.viewRoot, 'dist/modules/index.mjs')).href);
        const workspace = await connectViewWorkspace({ endpoint: bootstrap.endpoint, token: bootstrap.token, clientId: 'codex-binding' });
        try {
          const state = await workspace.getState({ signal });
          if (state.project) await workspace.closeProject(state.project.id, { signal });
        } finally { workspace.close(); }
        return;
      }
      const result = await service.start(directory);
      if (!result.ok) throw new Error(result.error?.hint ?? 'View project binding failed');
    },
    start(project) {
      if (closed) throw new Error('MCP presentation retired');
      if (!starting) {
        starting = (async () => {
          await open();
          // Every App mounts this adapter, but only an offline service needs
          // startup. Reopening must not reset a healthy shared bootstrap.
          if (project === undefined) {
            try {
              const response = await fetch(service.server.bootstrapUrl, { signal: AbortSignal.timeout(3000), cache: 'no-store' });
              const bootstrap = await response.json();
              if (response.ok && typeof bootstrap.endpoint === 'string' && typeof bootstrap.token === 'string') return;
            } catch {
              // A stale service response still needs the owning startup path.
            }
          }
          return service.start(project);
        })()
          .finally(() => { starting = undefined; });
        // The retained View reports the owning service's preparation/failure through bootstrap.
        void starting.catch(() => {});
      }
      return { phase: 'preparing' };
    },
    async close() {
      closed = true;
      await opening?.catch(() => {});
      await service?.close();
    },
  };
}
