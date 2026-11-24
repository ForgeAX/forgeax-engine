import { expect, it } from 'vitest';
import { runCanonicalFieldEdit } from './canonical-field-edit.fixture';

it('copies complete canonical placements and publishes ready after all admitted row data', async () => {
  const result = await runCanonicalFieldEdit();
  for (const row of result.rows) {
    expect(row.publicationHeld).toBe(true);
    expect(row.previousUnchanged).toBe(true);
    expect(row.cold.headers[0]).toBe(0x53534650);
    expect(row.unpublished.instances).toEqual(result.expectedInstances);
    expect(row.published.instances).toEqual(result.expectedInstances);
    expect(row.published.headers[0]).toBe(0x53534650);
    if (row.variant === 'omit-invalidation') expect(row.unpublished.headers[0]).not.toBe(0);
    else expect(row.unpublished.headers[0]).toBe(0);
    if (row.variant === 'omit-row-header' || row.variant === 'wrong-row-header') {
      expect(row.published.headers).not.toEqual(result.expectedHeaders);
      expect(row.published.headers[22]).toBeGreaterThan(0);
    } else expect(row.published.headers).toEqual(result.expectedHeaders);
    expect(row.published.instances.slice(144)).toEqual(row.cold.instances.slice(144));
    expect(row.published.bounds.slice(0, 28)).toEqual(row.cold.bounds.slice(0, 28));
    expect(row.published.bounds.slice(144)).toEqual(row.cold.bounds.slice(144));
  }
}, 30_000);
