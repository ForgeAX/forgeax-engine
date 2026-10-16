import {
  type CatalogDelta,
  type CatalogEntry,
  catalogDeltaDigest,
  validateCatalogDelta,
} from '@forgeax/engine-types';
import { CATALOG_DELTA_EVENT } from './catalog-transport.js';
import { createPluginPackFailure } from './errors.js';

export interface CatalogHotChannel {
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
}

export interface CatalogClient {
  enumerate(): Promise<readonly CatalogEntry[]>;
  subscribe(listener: (delta: CatalogDelta) => void): () => void;
  readonly desynchronized: () => boolean;
}
export function createCatalogClient(
  enumerate: () => Promise<readonly CatalogEntry[]>,
  hot: CatalogHotChannel | undefined,
): CatalogClient {
  const listeners = new Set<(delta: CatalogDelta) => void>();
  let desynchronized = false;
  let lastDigest: string | undefined;

  const readSnapshot = async (): Promise<readonly CatalogEntry[]> => {
    const entries = await enumerate();
    const validation = validateCatalogDelta({ added: entries, changed: [], removed: [] });
    if (!validation.ok) {
      desynchronized = true;
      throw createPluginPackFailure({
        ...validation.error,
        code: 'route-failed',
        detail: { stage: 'route', subject: 'catalog-enumeration' },
        cause: validation.error,
      });
    }
    desynchronized = false;
    return entries;
  };

  const publish = (delta: CatalogDelta): void => {
    const digest = catalogDeltaDigest(delta);
    if (digest === lastDigest) return;
    lastDigest = digest;
    for (const listener of [...listeners]) {
      try {
        listener(delta);
      } catch (error) {
        console.error('[forgeax-pack] catalog subscriber failure', error);
      }
    }
  };

  const recover = (): void => {
    desynchronized = true;
    void readSnapshot().catch((error: unknown) => {
      console.error('[forgeax-pack] catalog re-enumeration failure', error);
    });
  };

  return {
    enumerate: readSnapshot,
    subscribe(listener): () => void {
      listeners.add(listener);
      if (hot === undefined) return () => listeners.delete(listener);
      const onDelta = (data: unknown): void => {
        const validation = validateCatalogDelta(data);
        if (!validation.ok) {
          recover();
          return;
        }
        const delta = validation.value;
        desynchronized = false;
        publish(delta);
      };
      hot.on(CATALOG_DELTA_EVENT, onDelta);
      return () => {
        hot.off(CATALOG_DELTA_EVENT, onDelta);
        listeners.delete(listener);
      };
    },
    desynchronized: () => desynchronized,
  };
}
