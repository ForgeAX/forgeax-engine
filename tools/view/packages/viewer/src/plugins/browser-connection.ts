import type { HostTransportClient } from '@forgeax/engine-host';
import type { HostConnection } from '../shell/HostConnectionIndicator';
import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
type BrowserSession = { transport: Pick<HostTransportClient, 'onDisconnect' | 'connected'>; dispose: (reason?: string) => Promise<unknown> };
export type BrowserConnectionUpdate<TSession> = HostConnection & { session?: TSession };
import { Context } from '@forgeax/engine-plugin';

const terminal = (cause: unknown) => {
  const error = workspaceDiagnosticRecord(cause);
  return /stopped|stopping|unauthorized|forbidden|incompatible|invalid.*assembly|401|403/i.test(
  [error?.code, error?.message, error?.hint].filter(Boolean).join(' '),
);
};

/** Native connection plugin, outside the domain-neutral Host infrastructure. */
export function createBrowserConnection<TSession extends BrowserSession>({ connect, onChange, delays = [250, 500, 1000, 2000, 4000] }: { connect: (signal: AbortSignal) => Promise<TSession | undefined>; onChange: (update: BrowserConnectionUpdate<TSession>) => void; delays?: readonly number[] }) {
  const context = new Context();
  let reconnect: (() => void) | undefined;
  const fiber = context.plugin({
    name: 'forgeax.view.browser-connection',
    apply(ctx) {
      let generation = 0;
      let disposed = false;
      let session: TSession | undefined;
      let removeDisconnect: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: AbortController | undefined;
      let retries = 0;
      const publish = (value: BrowserConnectionUpdate<TSession>) => { if (!disposed) onChange({ ...value, onReconnect: reconnect }); };
      const retry = (error: unknown) => {
        const retrying = !terminal(error) && retries < delays.length;
        const detail = error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error);
        console.error('ForgeaX Host connection failed:', detail);
        publish({ phase: 'disconnected', detail, reconnectBusy: retrying });
        if (retrying) timer = setTimeout(() => void attempt(), delays[retries++]);
      };
      const attempt = async () => {
        clearTimeout(timer);
        const current = ++generation;
        abort?.abort();
        abort = new AbortController();
        removeDisconnect?.();
        removeDisconnect = undefined;
        const previous = session;
        session = undefined;
        publish({ phase: 'connecting', reconnectBusy: true, session: undefined });
        try {
          await previous?.dispose('View reconnecting');
          if (disposed || current !== generation) return;
          const next = await connect(abort.signal);
          if (disposed || current !== generation) { await next?.dispose('Superseded connection'); return; }
          session = next;
          if (!next) {
            publish({ phase: 'unconfigured', reconnectBusy: false });
            return;
          }
          publish({ phase: 'connected', reconnectBusy: false, session: next });
          const connectedAt = Date.now();
          let disconnected = false;
          removeDisconnect = next.transport.onDisconnect(error => {
            if (disposed || current !== generation || disconnected) return;
            disconnected = true;
            // An immediately accepted then closed socket is still the same outage.
            if (Date.now() - connectedAt >= 30_000) retries = 0;
            retry(error);
          });
          if (next.transport.connected === false && !disconnected) {
            disconnected = true;
            retry(new Error('Host connection closed during activation'));
          }
        } catch (error) {
          if (!disposed && current === generation) retry(error);
        }
      };
      reconnect = () => { retries = 0; void attempt(); };
      ctx.effect(() => () => {
        disposed = true;
        generation++;
        clearTimeout(timer);
        abort?.abort();
        removeDisconnect?.();
        return session?.dispose('View browser owner disposed');
      });
      reconnect();
    },
  });
  return {
    ready: fiber.await(),
    reconnect: () => reconnect?.(),
    dispose: () => context.fiber.dispose(),
  };
}
