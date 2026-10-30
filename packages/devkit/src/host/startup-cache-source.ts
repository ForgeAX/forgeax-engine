import type { HostVersions } from './versions.js';

export interface StartupCacheIdentity extends HostVersions {
  readonly project: string;
  readonly version: string;
  readonly revision?: string;
}

/** Keep literal imports visible to Vite CSS preloading and embedded module transport. */
export function startupEntrySource(identity?: StartupCacheIdentity, entry = './main.ts'): string {
  const normal =
    identity === undefined ? entry : `${entry}?forgeax-startup-version=${identity.version}`;
  const retry = `${normal}${normal.includes('?') ? '&' : '?'}forgeax-startup-retry=1`;
  return `try {
    await globalThis.__forgeaxStartup?.ready?.();
    if (new URLSearchParams(globalThis.location?.search ?? '').get('forgeax-startup-retry') === '1')
      await import(${JSON.stringify(retry)});
    else await import(${JSON.stringify(normal)});
  } catch (error) { globalThis.__forgeaxStartup?.fail?.(error); }`;
}

/** Inline browser startup policy: it must exist before any Engine module loads.
 * CacheStorage stays with its owner; the Host never enumerates/deletes origin data. */
export function startupCacheSource(identity?: StartupCacheIdentity): string {
  if (identity === undefined) return 'undefined';
  const { version, ...facts } = identity;
  return `(() => {
    // Workspace targets have frozen admission and a parent-owned failure/close
    // lifecycle. Autonomous navigation would race that owner's retirement.
    if (host !== undefined || !gamePage || query.has('forgeaxWorkspace') ||
        !/^https?:$/.test(globalThis.location?.protocol ?? '')) return undefined;
    const identity = ${JSON.stringify(facts).replaceAll('<', '\\u003c')};
    const version = ${JSON.stringify(version)};
    const protocol = 'forgeax-startup-cache/1';
    const retryKey = 'forgeax-startup-retry';
    const original = new URL(location.href);
    const scope = new URL('./', document.baseURI).href;
    const key = 'forgeax.startup/' + encodeURIComponent(identity.project) + '/' + scope;
    const retried = original.searchParams.get(retryKey) === '1';
    let complete = false, recovering = false, owner = false, preparation;
    const cancellation = new AbortController();
    const retire = () => {complete = true; cancellation.abort(); globalThis.removeEventListener('pagehide', retire);};
    globalThis.addEventListener('pagehide', retire, {once: true});
    const signal = () => AbortSignal.any([cancellation.signal, AbortSignal.timeout(10000)]);
    const read = (storage, name) => { try { return globalThis[storage]?.getItem(name); } catch { return null; } };
    const write = (storage, name, value) => { try { globalThis[storage]?.setItem(name, value); } catch {} };
    const remove = (storage, name) => { try { globalThis[storage]?.removeItem(name); } catch {} };
    const command = (action, timeout) => {
      const controller = globalThis.navigator?.serviceWorker?.controller;
      if (!controller || typeof MessageChannel !== 'function') return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const finish = (error, value) => { clearTimeout(timer); channel.port1.close(); error ? reject(error) : resolve(value); };
        let timer = setTimeout(() => action === 'reset' && owner
          ? finish(Error('Startup cache owner reset timed out')) : finish(undefined, null), timeout);
        channel.port1.onmessage = event => {
          const response = event.data;
          if (response?.protocol !== protocol) return;
          owner = true;
          if (response.accepted === true) { clearTimeout(timer); timer = setTimeout(() => finish(Error('Startup cache owner timed out')), 30000); return; }
          finish(response.ok === true ? undefined : Error(response.error ?? 'Startup cache owner failed'), response);
        };
        try { controller.postMessage({kind: 'forgeax-startup-cache', protocol, action, project: identity.project, version, versions: identity}, [channel.port2]); }
        catch (error) { finish(error); }
      });
    };
    const refreshHttp = async () => {
      const target = new URL(original);
      target.searchParams.set('forgeax-startup-cache-reset', '1');
      const response = await fetch(target, {cache: 'reload', signal: signal()});
      if (!response.ok) throw Error('Startup HTTP cache refresh failed: ' + response.status);
    };
    const updateController = async () => {
      const workers = globalThis.navigator?.serviceWorker;
      if (!workers?.controller) return;
      // An older installed owner may predate this protocol. Update its existing
      // registration; never register a replacement or claim another scope.
      await Promise.race([
        (async () => {
          const registration = await workers.getRegistration(location.href);
          if (!registration) return;
          await registration.update();
          const installing = registration.installing;
          if (installing && !['activated', 'redundant'].includes(installing.state))
            await new Promise(resolve => installing.addEventListener('statechange', () => {
              if (['activated', 'redundant'].includes(installing.state)) resolve();
            }));
        })(),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    };
    return {
      ready: () => preparation ??= (async () => {
        const previous = read('localStorage', key);
        if (previous && previous !== version) await refreshHttp();
        await command('prepare', 500);

      })(),
      complete: () => {
        retire();
        write('localStorage', key, version);
        remove('sessionStorage', key + '/failure');
        if (retried) { const target = new URL(location.href); target.searchParams.delete(retryKey); try { history.replaceState(history.state, '', target); } catch {} }
      },
      retire,
      recover: async (details, onRetry) => {
        if (complete || recovering) return {status: 'disabled'};
        recovering = true;
        if (retried) return {status: 'exhausted', previous: read('sessionStorage', key + '/failure')};
        write('sessionStorage', key + '/failure', 'Game ' + identity.game + ' | Engine ' + identity.engine + '\\n' + details.slice(0, 12000));
        onRetry?.();
        try {
          await updateController();
          if (complete) return {status: 'disabled'};
          await command('reset', owner ? 30000 : 500);
          if (complete) return {status: 'disabled'};
          await refreshHttp();
          const modules = [...document.querySelectorAll('script[type=module][src],link[rel=modulepreload][href]')].map(node => node.src || node.href);
          for (let index = 0; index < modules.length; index += 4) {
            // These URLs belong to the failed generation. A scoped reset may
            // retire its document, and an update may remove an old hashed URL.
            // Best-effort HTTP revalidation must never prevent the one retry.
            await Promise.allSettled(modules.slice(index, index + 4).map(async url => {
              const response = await fetch(url, {cache: 'reload', signal: signal()});
              if (!response.ok) throw Error('Startup module refresh failed: ' + response.status);
              await response.arrayBuffer();
            }));
          }
          if (complete) return {status: 'disabled'};
          const target = new URL(original); target.searchParams.set(retryKey, '1');
          location.replace(target.href);
          return {status: 'reloaded'};
        } catch (error) { return complete ? {status: 'disabled'} : {status: 'failed', error: String(error)}; }
      },
    };
  })()`;
}
