import {
  AssetRegistry,
  type CatalogListener,
  type CatalogSource,
} from '@forgeax/engine/assets-runtime';
import { ok } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01';
const B = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02';
const PACK_URL = 'https://feature-lab.invalid/lifecycle.pack.json';

const row = (guid: string, name: string) => ({
  guid,
  kind: 'sampler',
  packageUrl: PACK_URL,
  sourcePath: `${name}.pack.json`,
  name,
});

interface ProbeSource {
  readonly source: CatalogSource;
  readonly log: string[];
  emit(delta: Parameters<CatalogListener>[0]): void;
}

function probeSource(
  label: string,
  onEnumerate?: (emit: ProbeSource['emit']) => void,
): ProbeSource {
  const log: string[] = [];
  const listeners = new Set<CatalogListener>();
  const emit: ProbeSource['emit'] = (delta) => {
    for (const listener of listeners) listener(delta);
  };
  const source: CatalogSource = {
    async enumerate() {
      log.push(`${label}:enumerate`);
      onEnumerate?.(emit);
      return ok([row(A, 'a')] as never);
    },
    subscribe(listener) {
      log.push(`${label}:subscribe`);
      listeners.add(listener);
      return () => {
        log.push(`${label}:release`);
        listeners.delete(listener);
      };
    },
  };
  return { source, log, emit };
}

const names = (assets: AssetRegistry) =>
  (assets.catalogSnapshot()?.entries ?? [])
    .map((entry) => `${entry.guid.slice(-2)}:${String(entry.name)}`)
    .sort();

export default defineFeature({
  title: 'CatalogSource lifecycle',
  catalog: 'CatalogSource lifecycle',
  kind: 'headless',
  summary:
    'AssetRegistry subscribes to a CatalogSource before enumerating, merges complete rows by GUID, and releases replaced sources.',
  expect:
    'subscribe precedes enumerate, an early delta survives the baseline, changes replace rows by GUID, replacement releases the old source.',
  async run(checks) {
    const assets = new AssetRegistry({} as never);
    const first = probeSource('first', (emit) =>
      emit({ added: [row(B, 'early')] as never, changed: [], removed: [] }),
    );
    assets.setCatalogSource(first.source);
    const listed = await assets.enumerateCatalog();
    checks.ok('enumerate succeeds', listed.ok, listed.ok ? undefined : listed.error.code);
    checks.equal('subscription is installed before enumeration', first.log.slice(0, 2), [
      'first:subscribe',
      'first:enumerate',
    ]);
    checks.equal('delta observed during the baseline is kept', names(assets), ['01:a', '02:early']);

    first.emit({ added: [], changed: [row(A, 'renamed')] as never, removed: [] });
    checks.equal('changed row replaces by GUID', names(assets), ['01:renamed', '02:early']);
    first.emit({ added: [], changed: [], removed: [B] });
    checks.equal('removed GUID leaves the replica', names(assets), ['01:renamed']);

    const second = probeSource('second');
    assets.setCatalogSource(second.source);
    checks.ok(
      'replacing the source releases the old subscription',
      first.log.includes('first:release'),
      first.log.join(','),
    );
    await assets.enumerateCatalog();
    first.emit({ added: [row(B, 'ghost')] as never, changed: [], removed: [] });
    checks.equal('old source deltas no longer reach the replica', names(assets), ['01:a']);

    assets.clearCatalogSource();
    checks.ok('clear releases the current source', second.log.includes('second:release'));
    const cleared = await assets.enumerateCatalog();
    checks.equal(
      'cleared registry reports an unconfigured source',
      cleared.ok ? 'ok' : cleared.error.code,
      'catalog-source-unconfigured',
    );
  },
});
