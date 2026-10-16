/** Shared generated module: metadata is eager, native module delivery is explicit and lazy. */
export const runtimePacksSource = `import type { RuntimePackOptions } from '@forgeax/engine/app';
import { createBrowserPackProgramHost, prepareBrowserPackProgramScope } from '@forgeax/engine/pack/runtime-browser';
import type { PackProgramHostFactory } from '@forgeax/engine/pack/runtime';
import imports, { loadImport } from 'virtual:forgeax/pack-program-imports';

type Delivery = { scope: string } | { error: string };
let preparing: Promise<Delivery> | undefined;
export function prepareRuntimePackDelivery(): Promise<Delivery> {
  if (preparing) return preparing;
  preparing = (async () => {
    try {
      if (typeof document === 'undefined' || !/^https?:$/.test(location.protocol))
        throw new Error('Native runtime modules require an HTTP application with ServiceWorker support');
      return { scope: await prepareBrowserPackProgramScope(new URL('forgeax-pack-program-worker.js', document.baseURI).href) };
    } catch (cause) {
      preparing = undefined;
      return { error: String(cause) };
    }
  })();
  return preparing;
}

/** This private channel leaves the game's borrowed MessagePort queue untouched. */
export function serveRuntimePackDelivery(name: string): () => void {
  let channel: BroadcastChannel;
  try { channel = new BroadcastChannel(name); }
  catch { return () => {}; }
  let active = true;
  const receive = (event: MessageEvent) => {
    if (event.data?.kind !== 'forgeax:prepare-pack-programs' || typeof event.data.id !== 'string') return;
    const id = event.data.id;
    void prepareRuntimePackDelivery().then(delivery => {
      if (active) channel.postMessage({ kind: 'forgeax:pack-program-delivery', id, delivery });
    });
  };
  channel.addEventListener('message', receive);
  return () => { active = false; channel.removeEventListener('message', receive); channel.close(); };
}

/** Each World owns its waiting request; late replies cannot reach its replacement. */
export function createRuntimePackDeliveryClient(name: string | undefined, signal: AbortSignal): () => Promise<Delivery> {
  let pending: Promise<Delivery> | undefined;
  return () => {
    if (signal.aborted) return Promise.resolve({ error: 'Runtime Pack delivery owner is disposed' });
    if (!name || typeof BroadcastChannel === 'undefined')
      return Promise.resolve({ error: 'Runtime Pack delivery requires its page channel' });
    return pending ??= new Promise<Delivery>(resolve => {
      let channel: BroadcastChannel;
      try { channel = new BroadcastChannel(name); }
      catch (cause) { resolve({ error: String(cause) }); return; }
      const id = crypto.randomUUID();
      let finished = false;
      const finish = (delivery: Delivery) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        channel.removeEventListener('message', receive);
        channel.close();
        signal.removeEventListener('abort', aborted);
        resolve(delivery);
      };
      const receive = (event: MessageEvent) => {
        if (event.data?.kind !== 'forgeax:pack-program-delivery' || event.data.id !== id) return;
        const delivery = event.data.delivery;
        if (typeof delivery?.scope === 'string') finish({ scope: delivery.scope });
        else if (typeof delivery?.error === 'string') finish({ error: delivery.error });
      };
      const aborted = () => finish({ error: 'Runtime Pack delivery owner is disposed' });
      const timer = setTimeout(() => finish({ error: 'Runtime Pack page delivery timed out' }), 15000);
      channel.addEventListener('message', receive);
      signal.addEventListener('abort', aborted, { once: true });
      try { channel.postMessage({ kind: 'forgeax:prepare-pack-programs', id }); }
      catch (cause) { finish({ error: String(cause) }); }
    }).then(delivery => {
      if ('error' in delivery) pending = undefined;
      return delivery;
    });
  };
}

export async function createRuntimePackOptions(scopeId: string, prepared?: Delivery | (() => Promise<Delivery>), nativeHost?: PackProgramHostFactory): Promise<RuntimePackOptions> {
  if (nativeHost) return { scopeId, imports, programHost: nativeHost(imports, loadImport) };
  const delivery = prepared;
  let host: ReturnType<typeof createBrowserPackProgramHost> | undefined;
  return {
    scopeId, imports,
    programHost: { async publish(program, bindings) {
      const ready = typeof delivery === 'function' ? await delivery() : delivery ?? await prepareRuntimePackDelivery();
      if ('error' in ready) throw new Error(ready.error);
      host ??= createBrowserPackProgramHost(ready.scope);
      return host.publish(program, bindings);
    } },
  };
}
`;
