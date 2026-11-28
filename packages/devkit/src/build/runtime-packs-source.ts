import type { AuthoredRuntimePack } from '@forgeax/engine-app';
import type { ProjectFacts } from '../types.js';
import { authoredRuntimePackDeclarations } from './authored-runtime-packs.js';
import type { PluginSourceInventory } from './plugin-assets.js';
import {
  shippedBrowserPackProgramsSource,
  staticPackProgramsSource,
} from './static-pack-programs.js';

/** Shared generated module: metadata is eager, native module delivery is explicit and lazy. */
export const runtimePacksSource = runtimePacksModule('const authored = [];');

export async function runtimePacksModuleSource(
  facts: ProjectFacts,
  sourceInventory: PluginSourceInventory,
  delivery: 'native' | 'browser' | 'published-browser',
  packs: readonly AuthoredRuntimePack[],
  generatedRoot: string,
): Promise<string> {
  if (delivery !== 'native')
    return runtimePacksModule(
      authoredRuntimePackDeclarations(packs),
      packs.length ? facts.id : undefined,
      delivery === 'published-browser' && packs.length > 0
        ? await shippedBrowserPackProgramsSource(packs, generatedRoot)
        : undefined,
    );
  return `${await staticPackProgramsSource(facts, sourceInventory, { packs, generatedRoot })}
import type { RuntimePackOptions } from '@forgeax/engine/app';
export async function createRuntimePackOptions(scopeId: string): Promise<RuntimePackOptions> {
  return { scopeId, imports, authored, programHost };
}
`;
}

export function runtimePacksModule(
  declarations: string,
  projectId?: string,
  shippedPrograms?: string,
): string {
  return `${declarations}
import type { RuntimePackOptions } from '@forgeax/engine/app';
${projectId === undefined ? '' : "import { createBrowserRuntimePackCache } from '@forgeax/engine/platform-browser';"}
import { createBrowserPackProgramHost, prepareBrowserPackProgramScope } from '@forgeax/engine/pack/runtime-browser';
import type { PackProgramHostFactory } from '@forgeax/engine/pack/runtime';
import imports, { loadImport } from 'virtual:forgeax/pack-program-imports';
${
  shippedPrograms === undefined
    ? ''
    : `import { createStaticPackProgramHost } from '@forgeax/engine/pack/runtime';
${shippedPrograms}`
}

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

function listenDelivery(channel: BroadcastChannel, receive: (event: MessageEvent) => void) {
  channel.addEventListener('message', receive);
  return () => { channel.removeEventListener('message', receive); channel.close(); };
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
  const close = listenDelivery(channel, receive);
  return () => { active = false; close(); };
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
        close();
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
      const close = listenDelivery(channel, receive);
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
  const options = { scopeId, imports, authored${projectId === undefined ? '' : `, cache: createBrowserRuntimePackCache(${JSON.stringify(projectId)})`} };
  if (nativeHost) return { ...options, programHost: nativeHost(imports, loadImport) };
  const delivery = prepared;
  let host: ReturnType<typeof createBrowserPackProgramHost> | undefined;
  const browserHost: Pick<import('@forgeax/engine/pack/runtime').PackProgramHost, 'publish'> = { async publish(program, bindings) {
    const ready = typeof delivery === 'function' ? await delivery() : delivery ?? await prepareRuntimePackDelivery();
    if ('error' in ready) throw new Error(ready.error);
    host ??= createBrowserPackProgramHost(ready.scope);
    return host.publish(program, bindings);
  } };
  return { ...options, programHost: ${shippedPrograms === undefined ? 'browserHost' : 'createStaticPackProgramHost(shippedPrograms, imports, browserHost)'} };
}
`;
}
