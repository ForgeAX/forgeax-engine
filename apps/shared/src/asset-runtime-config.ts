/// <reference path="./virtual-pack-runtime.d.ts" />

import {
  createRuntimeAssetImportTransport as createPluginRuntimeAssetImportTransport,
  runtimeBinding as pluginRuntimeBinding,
} from 'virtual:forgeax/pack-runtime';
import type { ImportTransport, RuntimeAssetBinding } from '@forgeax/engine-types';

declare global {
  interface ImportMetaEnv {
    DEV: boolean;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

/** The catalog emitted by a production Vite build. */
export const DEFAULT_RUNTIME_PACK_INDEX_URL = '/pack-index.json';
const DEV_RUNTIME_BINDING_REQUIRED_ERROR =
  'forgeax: Vite Pack runtime binding is required in development; pass runtimeBinding to pluginPack()';

/** The Pack plugin owns this identity; app sources only consume its projection. */
export const runtimeBinding: RuntimeAssetBinding | undefined = pluginRuntimeBinding;

/** The minimal registry surface needed by the app catalog bootstrap. */
export interface RuntimeAssetCatalogOwner {
  configurePackIndex(url: string): void;
  configureRuntimeBinding(binding: RuntimeAssetBinding): void;
}

export interface RuntimeAssetCatalogOptions {
  /** Override Vite's mode flag in a deterministic test or host. */
  readonly isDevelopment?: boolean;
  /** Override the production catalog URL when a host mounts a build elsewhere. */
  readonly packIndexUrl?: string;
}

function isViteDevelopment(): boolean {
  // Keep this access direct: Vite statically replaces `import.meta.env.DEV`
  // during bundling, but does not rewrite an aliased `import.meta` object.
  // Vite serve still installs HMR when NODE_ENV=production makes DEV false;
  // that host must keep using the scoped dev routes instead of pack-index.
  const hot = (import.meta as ImportMeta & { readonly hot?: unknown }).hot;
  return import.meta.env.DEV === true || hot !== undefined;
}

function defaultProductionPackIndexUrl(): string {
  if (typeof document === 'undefined') return DEFAULT_RUNTIME_PACK_INDEX_URL;
  return new URL('pack-index.json', document.baseURI).href;
}

/**
 * Assemble the optional development import transport from the same binding as
 * the catalog. Production bundles deliberately receive no transport.
 */
export function createRuntimeAssetImportTransport(
  binding: RuntimeAssetBinding | undefined = runtimeBinding,
): ImportTransport | undefined {
  if (!isViteDevelopment()) return undefined;
  if (binding === undefined) {
    throw new Error(DEV_RUNTIME_BINDING_REQUIRED_ERROR);
  }
  const transport = createPluginRuntimeAssetImportTransport(binding);
  if (transport === undefined) throw new Error(DEV_RUNTIME_BINDING_REQUIRED_ERROR);
  return transport;
}

/**
 * Configure one AssetRegistry for the current app execution mode.
 *
 * Development hosts use the scope/generation-bound catalog carried by the
 * RuntimeAssetBinding. Production builds use the static catalog emitted by
 * Vite while retaining the same binding identity for publication-tuple
 * validation and package instantiation. Exactly one catalog URL is selected,
 * so a development binding cannot be accidentally overwritten by the
 * production URL. A development host without a binding fails fast instead of
 * retaining stale state or probing the intentionally disabled global route.
 */
export function configureRuntimeAssetCatalog(
  assets: RuntimeAssetCatalogOwner,
  binding: RuntimeAssetBinding | undefined,
  options: RuntimeAssetCatalogOptions = {},
): void {
  const isDevelopment = options.isDevelopment ?? isViteDevelopment();
  if (isDevelopment) {
    if (binding === undefined) {
      throw new Error(DEV_RUNTIME_BINDING_REQUIRED_ERROR);
    }
    assets.configureRuntimeBinding(binding);
    return;
  }

  if (binding !== undefined) assets.configureRuntimeBinding(binding);
  assets.configurePackIndex(options.packIndexUrl ?? defaultProductionPackIndexUrl());
}
