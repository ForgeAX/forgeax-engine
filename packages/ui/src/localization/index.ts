import { createInstance, type i18n, type TFunction } from 'i18next';
import type { UiAsset, UiInstance } from '../asset.js';
import { type UiResult, uiError } from '../errors.js';
import { isUiLocalization } from './resources.js';

export type { UiLocalization } from './resources.js';

/** Each call owns a native i18next instance; no singleton, backend or network. */
export async function createUiLocalization(
  asset: UiAsset,
  options: {
    readonly lng: string;
    readonly onMissingKey?: (lngs: readonly string[], ns: string, key: string) => void;
  },
): Promise<UiResult<i18n>> {
  if (!isUiLocalization(asset.localization))
    return uiError(
      'invalid-asset',
      'UI localization requires validated resources and a fallback namespace',
    );
  const instance = createInstance();
  await instance.init({
    ...asset.localization,
    resources: structuredClone(asset.localization.resources),
    lng: options.lng,
    initAsync: false,
    interpolation: { escapeValue: false }, // consumers write textContent, never innerHTML
    saveMissing: true,
    missingKeyHandler: (lngs, ns, key) => options.onMissingKey?.(lngs, ns, key),
  });
  return { ok: true, value: instance };
}

/** Adopt a validated new asset revision atomically; removed keys do not survive. */
export async function refreshUiLocalization(
  instance: i18n,
  asset: UiAsset,
): Promise<UiResult<void>> {
  if (!isUiLocalization(asset.localization))
    return uiError(
      'invalid-asset',
      'Invalid localization revision; repair and reimport its JSON source',
    );
  const data = asset.localization;
  // ResourceStore.data is native state; replace the complete validated snapshot.
  const resources = structuredClone(data.resources);
  const store = instance.store;
  store.data = resources;
  instance.options.fallbackLng = data.fallbackLng;
  instance.options.defaultNS = data.defaultNS;
  instance.setDefaultNamespace(data.defaultNS);
  await instance.changeLanguage(instance.language);
  return { ok: true, value: undefined };
}

/** The game owns text/attribute semantics; the UI signal owns subscriptions. */
export function bindUiLocalization(
  ui: UiInstance,
  instance: i18n,
  render: (t: TFunction) => void,
): () => void {
  if (ui.signal.aborted) return () => {};
  const update = () => render(instance.t.bind(instance));
  const dispose = () => {
    instance.off('languageChanged', update);
    instance.store.off('added', update);
    instance.store.off('removed', update);
    ui.signal.removeEventListener('abort', dispose);
  };
  instance.on('languageChanged', update);
  instance.store.on('added', update);
  instance.store.on('removed', update);
  ui.signal.addEventListener('abort', dispose, { once: true });
  try {
    update();
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
