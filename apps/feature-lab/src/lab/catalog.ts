import catalogSource from '../../../../skills/forgeax-engine-sdk/references/feature-catalog.md?raw';
import type { FeatureForm } from './feature';

/** A capability row of the SDK feature catalog: `| Name | **Form** | ... |`. */
const ROW = /^\| ([^|]+?) \| \*\*([A-Za-z/-]+)\*\* \|/gm;

const FORMS: Readonly<Record<string, FeatureForm>> = {
  'Built-in': 'built-in',
  'Opt-in': 'opt-in',
  'Build-time': 'build-time',
  'Host-side': 'host-side',
  Development: 'development',
  'Test/experimental': 'test-experimental',
};

function parseCatalog(source: string): ReadonlyMap<string, FeatureForm> {
  const rows = new Map<string, FeatureForm>();
  for (const [, name, label] of source.matchAll(ROW) as IterableIterator<
    [string, string, string]
  >) {
    const form = FORMS[label];
    if (form === undefined)
      throw new Error(`[feature-lab] catalog row '${name}': unknown form '${label}'`);
    if (rows.has(name)) throw new Error(`[feature-lab] catalog row '${name}' appears twice`);
    rows.set(name, form);
  }
  return rows;
}

/** Catalog row name -> form. The catalog is the SSOT; features name a row, never restate its form. */
export const CATALOG_ROWS = parseCatalog(catalogSource);
