// @forgeax/engine-assets-runtime - wireDefaultLoaders + seed-table SSOT
// (feat-20260603-asset-import-loader-injection M1 / w5 + w8; restructured by
// feat-20260705-runtime-tier2-decomposition M1 / w8, D-2).
//
// wireDefaultLoaders is a one-line host helper that wires the engine's default
// loader set onto a `LoaderRegistry`, mirroring the Console
// `wireDefaultInspectors` shape (packages/console/src/wire-default-inspectors.ts;
// research Finding 8). An AI user that has wired inspectors once recognises the
// same form here at near-zero cost (requirements §AI User Affordances).
//
// The two seed tables INLINE_PACK_LOADERS + PACK_ARTIFACT_LOADERS are the
// default set. videoLoader lives in graphics-extras and is wired here. The
// complete ordinary Asset vocabulary is registered once at this boundary;
// host-specific loaders may extend the table through `extraLoaders`.
//
// Default set wired internally: every runtime Asset kind plus the existing UI
// consumer loader. Host-only execution remains separate from descriptor load.
//
import { videoLoader } from '@forgeax/engine-graphics-extras';
import type { Loader } from '@forgeax/engine-types';
import { createUiLoader, type UiAsset } from '@forgeax/engine-ui';
import { LoaderRegistry } from './loader-registry';
import { iesProfileLoader } from './loaders/ies-profile';
import { INLINE_PACK_LOADERS } from './loaders/inline-pack';
import { navigationMeshLoader } from './loaders/navigation-mesh.js';
import { PACK_ARTIFACT_LOADERS } from './loaders/pack-artifact';
import { pluginAssetLoader } from './loaders/plugin.js';
import { terrainLoader } from './loaders/terrain.js';

const uiPayloadLoader = createUiLoader();
const loadUi = (payload: unknown): UiAsset | undefined => {
  const result = uiPayloadLoader.load(payload);
  return result.ok ? result.value : undefined;
};
const uiLoader: Loader<UiAsset> = {
  kind: 'ui',
  load: loadUi,
  loadPack: loadUi,
};

/**
 * Wire the engine's default loader set plus any `extraLoaders` onto `registry` in
 * one call. Returns the same `registry` for chaining (so `wireDefaultLoaders(new
 * LoaderRegistry())` is a one-expression wired registry). The `extraLoaders` are
 * appended after the defaults and must use kinds outside the ordinary set.
 *
 * @example
 * ```ts
 * import { LoaderRegistry, wireDefaultLoaders } from '@forgeax/engine-assets-runtime';
 * const loaders = wireDefaultLoaders(new LoaderRegistry());
 * // loaders.get('mesh') / .get('texture') / .get('font') / .get('video') are
 * // non-undefined; all ordinary Asset kinds share this same owner table.
 * ```
 */
export function wireDefaultLoaders(
  registry: LoaderRegistry,
  extraLoaders: readonly Loader[] = [],
): LoaderRegistry {
  const extraKinds = new Set(extraLoaders.map((loader) => loader.kind));
  const seeded = new Set<string>();
  for (const loader of [
    ...INLINE_PACK_LOADERS,
    ...PACK_ARTIFACT_LOADERS,
    iesProfileLoader,
    terrainLoader,
    navigationMeshLoader,
    pluginAssetLoader,
  ]) {
    if (extraKinds.has(loader.kind)) continue;
    if (seeded.has(loader.kind)) continue;
    seeded.add(loader.kind);
    registry.register(loader);
  }
  registry.register(videoLoader);
  registry.register(uiLoader);
  for (const loader of extraLoaders) registry.register(loader);
  return registry;
}

/**
 * Convenience factory: a fresh `LoaderRegistry` pre-wired with the default
 * loader set (plus any `extraLoaders`). The production assembly point
 * (`createRenderer`) and tests pass the result into `new LoaderRegistry()` (D-7
 * constructor-injection; loaders always wired at construction -- used by
 * `AssetRegistry` internally via `createDefaultLoaderRegistry(extraLoaders)` and
 * by host code / tests independently) -- no setter / no illegal intermediate
 * state).
 */
export function createDefaultLoaderRegistry(extraLoaders: readonly Loader[] = []): LoaderRegistry {
  return wireDefaultLoaders(new LoaderRegistry(), extraLoaders);
}
