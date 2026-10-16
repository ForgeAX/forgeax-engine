// dev-import-transport.ts -- the dev-only ImportTransport adapter (M4 / w15,
// AC-04). A host explicitly wires this into createRenderer / createApp so a
// DDC miss at runtime triggers an on-demand import against the vite-plugin-pack
// dev server (POST to the binding's scoped import endpoint). The shipped form
// unwired so a miss fails fast with `asset-not-imported` (AC-08).
//
// Pure browser fetch -- no Node-only dependency (AC-04), no import.meta.env /
// import.meta.hot / NODE_ENV probe (AC-05 / OOS-1: host-explicit assembly is
// the only path, the library never auto-detects dev vs prod). The module also
// never imports @forgeax/engine-image (image-pipeline-isolation: runtime/src
// must not statically depend on the image package).

import type { ImportTransport, PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';

export type DevImportTransportBinding = Pick<
  RuntimeAssetBinding,
  'scopeId' | 'generation' | 'status' | 'importUrlBase'
>;

/**
 * Build the dev-only {@link ImportTransport}. A caller must provide the
 * current runtime binding; `fetchPack(guid)` then issues a scoped POST against
 * the vite-plugin-pack dev server, which imports
 * exactly that GUID's `.bin` and returns the single imported catalog row (+ any
 * sub-asset siblings). The caller patches those rows into its catalog cache
 * incrementally -- per-asset, never a whole-catalog re-fetch (the four-verb
 * redesign, 2026-06-06). On a non-2xx / network failure it reports
 * `{ ok: false }`.
 *
 * Aligns with the `wireDefaultLoaders` `create*` / `wire*` factory family so
 * IDE autocomplete on `@forgeax/engine-runtime` surfaces it.
 *
 * @example
 *   import { createApp } from '@forgeax/engine-app';
 *   import { createDevImportTransport } from '@forgeax/engine-runtime';
 *   const app = await createApp(canvas, opts, {
 *     importTransport: createDevImportTransport(runtimeBinding),
 *   });
 */
export function createDevImportTransport(binding?: DevImportTransportBinding): ImportTransport {
  return {
    async fetchPack(
      guid: string,
      scope?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation' | 'status'>,
    ): Promise<
      { readonly ok: true; readonly entries?: readonly PackIndexEntry[] } | { readonly ok: false }
    > {
      const active = binding;
      if (
        active === undefined ||
        active.status !== 'ready' ||
        scope === undefined ||
        scope.status !== 'ready' ||
        scope.scopeId !== active.scopeId ||
        scope.generation !== active.generation
      ) {
        return { ok: false };
      }
      try {
        const base = active.importUrlBase.replace(/\/+$/, '');
        const response = await fetch(`${base}/${encodeURIComponent(guid)}`, { method: 'POST' });
        if (!response.ok) {
          // The ImportTransport contract has no error channel (returns only
          // ok:false), so the runtime would otherwise report a generic
          // `asset-not-imported`. Surface the dev server's structured failure
          // body (e.g. `code: fbx-mesh-type-unsupported`, reason, hint) to the
          // console so the actual cause is visible to AI/human users.
          try {
            const fail = (await response.json()) as {
              code?: string;
              error?: string;
              reason?: string;
              hint?: string;
            };
            console.warn(
              `[forgeax] import failed for ${guid} (HTTP ${response.status}): ` +
                `${fail.code ?? fail.error ?? 'import-failed'} - ${fail.reason ?? ''}` +
                (fail.hint ? ` | hint: ${fail.hint}` : ''),
            );
          } catch {
            // Non-JSON error body; nothing extra to surface.
          }
          return { ok: false };
        }
        try {
          const body = (await response.json()) as unknown;
          if (Array.isArray(body)) return { ok: true, entries: body as readonly PackIndexEntry[] };
        } catch {
          // Body was not JSON (or empty) -- success without inline rows; the
          // caller re-resolves the GUID from its cache.
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}
