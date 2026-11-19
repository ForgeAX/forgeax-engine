import { resolve } from 'node:path';
import { startViewerStaticServer, VIEWER_BOOTSTRAP_PATH } from './viewer-static-server.ts';

export type ViewEnsureResult = {
  ok: boolean;
  value?: { view?: { url?: string; ok?: boolean; value?: { url?: string } } };
  error?: { code?: string; hint?: string };
};
export type ViewServiceOptions = {
  root: string; hostPack: string; project?: string; port?: number; staticRoot?: string;
  ensure(project?: string, signal?: AbortSignal): Promise<ViewEnsureResult>;
};

/** Independent foreground presentation; H's process manager owns the backend. */
export async function createViewService(options: ViewServiceOptions) {
  let active: Promise<ViewEnsureResult> | undefined;
  const lifetime = new AbortController();
  const server = await startViewerStaticServer({
    staticRoot: options.staticRoot ?? resolve(import.meta.dirname, '../viewer'),
    port: options.port,
    waitForBootstrap: true,
    launcher: async project => {
      if (lifetime.signal.aborted) return { ok: false, error: { code: 'view-service-closed', hint: 'The View presentation service is closed.' } };
      // One launch is admitted at a time; other calls receive an explicit busy result.
      if (active) return { ok: false, error: { code: 'view-launch-busy', hint: 'Backend startup is already in progress. Wait for it to finish.' } };
      server.setBootstrapPreparing();
      try {
        // Capture synchronous owner failures and forward presentation cancellation.
        active = Promise.resolve().then(() => options.ensure(project, lifetime.signal));
        const result = await active;
        if (lifetime.signal.aborted) return { ok: false, error: { code: 'view-service-closed', hint: 'The View presentation service is closed.' } };
        if (result.ok) {
          const view = result.value?.view;
          const url = view?.url ?? view?.value?.url;
          if (!url) throw new Error('The View owner did not publish its bootstrap URL.');
          server.setBootstrapSource(new URL(VIEWER_BOOTSTRAP_PATH, url));
        } else server.setBootstrapFailure(result.error?.hint ?? 'Backend startup failed.');
        return result;
      } catch (cause) {
        const hint = cause instanceof Error ? cause.message : String(cause);
        server.setBootstrapFailure(hint);
        return { ok: false, error: { code: 'view-launch-failed', hint } };
      } finally { active = undefined; }
    },
  });
  const close = async () => {
    lifetime.abort(new Error('View presentation service closed'));
    // Cancellation revokes the ensure caller. H retains backend process ownership.
    await server.close();
  };
  return { server, start: server.launch, close };
}

/** Publishes the plain URL immediately; backend preparation proceeds asynchronously. */
export async function serveView(options: ViewServiceOptions) {
  const service = await createViewService(options);
  const close = async () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await service.close();
  };
  const stop = () => { void close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  void service.start(options.project);
  return { url: service.server.viewerUrl, root: options.root, hostPack: options.hostPack, close };
}
