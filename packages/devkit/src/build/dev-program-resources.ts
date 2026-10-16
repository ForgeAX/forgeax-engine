import type { Plugin } from 'vite';

export const devProgramResourceMeta = 'forgeax.programResource';

/** Vite 8 producer evidence; preserve its code, filters and hook ordering. */
export function markDevProgramResources(plugins: readonly Plugin[]): void {
  for (const name of ['vite:asset', 'vite:worker', 'vite:wasm-helper']) {
    const plugin = plugins.find((plugin) => plugin.name === name);
    const hook = plugin?.load;
    if (!plugin || !hook) throw new TypeError(`Vite resource producer unavailable: ${name}`);
    const handler = typeof hook === 'function' ? hook : hook.handler;
    const wrapped: typeof handler = async function (...args) {
      const result = await handler.apply(this, args);
      if (
        result == null ||
        (name === 'vite:asset' && new URLSearchParams(args[0].split('?')[1]).has('raw'))
      )
        return result;
      return typeof result === 'string'
        ? { code: result, meta: { [devProgramResourceMeta]: name } }
        : { ...result, meta: { ...result.meta, [devProgramResourceMeta]: name } };
    };
    plugin.load = typeof hook === 'function' ? wrapped : { ...hook, handler: wrapped };
  }
  for (const name of ['vite:asset-import-meta-url', 'vite:worker-import-meta-url', 'vite:css']) {
    const plugin = plugins.find((plugin) => plugin.name === name);
    const hook = plugin?.transform;
    if (!plugin || !hook) throw new TypeError(`Vite resource producer unavailable: ${name}`);
    const handler = typeof hook === 'function' ? hook : hook.handler;
    const wrapped: typeof handler = async function (...args) {
      const result = await handler.apply(this, args);
      if (result == null) return result;
      return typeof result === 'string'
        ? { code: result, meta: { [devProgramResourceMeta]: name } }
        : { ...result, meta: { ...result.meta, [devProgramResourceMeta]: name } };
    };
    plugin.transform = typeof hook === 'function' ? wrapped : { ...hook, handler: wrapped };
  }
}
