import catalog from '../../../../schemas/engine-capabilities.json';
import type { FeatureForm } from './feature';

const FORMS: ReadonlySet<string> = new Set([
  'built-in',
  'opt-in',
  'build-time',
  'host-side',
  'development',
  'test-experimental',
]);

function capabilityRows(): ReadonlyMap<string, FeatureForm> {
  const rows = new Map<string, FeatureForm>();
  for (const { name, form } of catalog.capabilities) {
    if (!FORMS.has(form))
      throw new Error(`[feature-lab] catalog row '${name}': unknown form '${form}'`);
    if (rows.has(name)) throw new Error(`[feature-lab] catalog row '${name}' appears twice`);
    rows.set(name, form as FeatureForm);
  }
  return rows;
}

/** Machine-owned capability facts; narrative documentation lives in Harness. */
export const CATALOG_ROWS = capabilityRows();
