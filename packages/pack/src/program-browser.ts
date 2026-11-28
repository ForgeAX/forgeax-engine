import { linkPackProgram, type PackProgramHost, packProgramModuleIdentity } from './program.js';

const CACHE = 'forgeax-program-modules/1';
const PROGRAM_DIRECTORY = '__forgeax_programs__/';
const CLAIM_MESSAGE = 'forgeax:claim-pack-program-clients';

/** The host serves this script in its application scope; only program URLs are intercepted. */
export const PACK_PROGRAM_WORKER_SOURCE = `
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const port = event.ports[0];
  if (event.data !== ${JSON.stringify(CLAIM_MESSAGE)} || !port) return;
  event.waitUntil(self.clients.claim().then(
    () => port.postMessage(true),
    () => port.postMessage(false),
  ));
});
self.addEventListener('fetch', event => {
  const base = new URL(${JSON.stringify(PROGRAM_DIRECTORY)}, self.registration.scope).href;
  if (event.request.method !== 'GET' || !event.request.url.startsWith(base)) return;
  event.respondWith(caches.open(${JSON.stringify(CACHE)}).then(async cache =>
    await cache.match(event.request) || new Response('Program module unavailable', { status: 404 })));
});
`;

/** Recognize the HTTP namespace owned by the Pack program worker. */
export function browserPackProgramScope(moduleUrl: string): string | undefined {
  const url = new URL(moduleUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const directory = url.pathname.indexOf(`/${PROGRAM_DIRECTORY}`);
  if (directory < 0) return undefined;
  return new URL(url.pathname.slice(0, directory + 1), url.origin).href;
}

/** An already-running dedicated Worker can be claimed after the initial activation. */
export async function claimBrowserPackProgramClients(controller: ServiceWorker): Promise<boolean> {
  const { port1, port2 } = new MessageChannel();
  return new Promise((resolve) => {
    const finish = (claimed: boolean) => {
      clearTimeout(timeout);
      port1.close();
      resolve(claimed);
    };
    const timeout = setTimeout(() => finish(false), 1000);
    try {
      port1.onmessage = ({ data }) => finish(data === true);
      controller.postMessage(CLAIM_MESSAGE, [port2]);
    } catch {
      port2.close();
      finish(false);
    }
  });
}

/** The page prepares its application scope before a Worker uses native program URLs. */
export async function prepareBrowserPackProgramScope(workerUrl: string): Promise<string> {
  if (!('serviceWorker' in navigator) || !globalThis.caches)
    throw new TypeError('Pack module delivery requires ServiceWorker and CacheStorage');
  const script = new URL(workerUrl, location.href);
  const scope = new URL('./', script).href;
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    let stage = 'registration lookup';
    const stop = () => {
      finished = true;
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
    };
    const failed = (cause: unknown) => {
      if (finished) return;
      stop();
      reject(cause);
    };
    const changed = () => {
      if (finished || navigator.serviceWorker.controller?.scriptURL !== script.href) return;
      stop();
      resolve(scope);
    };
    const timeout = setTimeout(
      () => failed(new Error(`Pack service worker preparation timed out during ${stage}`)),
      10000,
    );
    void (async () => {
      const existing = await navigator.serviceWorker.getRegistration(scope);
      if (finished) return;
      if (existing?.active && existing.active.scriptURL !== script.href)
        throw new TypeError(
          'Host must integrate Pack program delivery into its existing service worker',
        );
      stage = 'registration';
      await navigator.serviceWorker.register(script.href, { scope, type: 'module' });
      if (finished) return;
      stage = 'page control';
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      changed();
    })().catch(failed);
  });
}

/** Publish from either browser realm into a scope already prepared by its page. */
export function createBrowserPackProgramHost(scopeUrl: string): PackProgramHost {
  const scope = new URL(scopeUrl).href;
  if (!/^https?:/.test(scope) || !scope.endsWith('/'))
    throw new TypeError('Pack program delivery requires an absolute HTTP application scope');
  return {
    async publish(program, imports) {
      const cache = await caches.open(CACHE);
      const base = new URL(
        `${PROGRAM_DIRECTORY}${packProgramModuleIdentity(program, imports).unwrap().replace(':', '-')}/`,
        scope,
      ).href;
      const linked = linkPackProgram(program, base, imports).unwrap();
      // Await the entire closure before returning its entry URL. Cycles see all their peers.
      await Promise.all(
        linked.files.map((file) =>
          cache.put(
            file.url,
            new Response(file.source, {
              headers: { 'content-type': 'text/javascript; charset=utf-8' },
            }),
          ),
        ),
      );
      return linked.entryUrl;
    },
  };
}
