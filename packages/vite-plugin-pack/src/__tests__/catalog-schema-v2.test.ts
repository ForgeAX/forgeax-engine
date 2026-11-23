import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

interface SchemaEntry {
  required?: string[];
  properties?: Record<string, unknown>;
}

interface CatalogSchema {
  $comment?: string;
  $defs?: { packIndexEntry?: SchemaEntry };
}

describe('Pack index catalog v2 schema', () => {
  it('exposes the publication tuple and diagnostic navigation without asset storage facts', async () => {
    const schema = JSON.parse(
      await readFile(new URL('../../schema/pack-index.schema.json', import.meta.url), 'utf8'),
    ) as CatalogSchema;
    const entry = schema.$defs?.packIndexEntry;
    const properties = entry?.properties ?? {};
    for (const field of [
      'scopeId',
      'generation',
      'digest',
      'outputSetDigest',
      'packageUrl',
      'sourcePath',
      'cookReceiptUrl',
    ]) {
      expect(properties).toHaveProperty(field);
    }
    expect(properties).toHaveProperty('publication.$ref', '#/$defs/publication');
    expect(entry?.required).toContain('packageUrl');
    for (const field of ['metadata', 'compression', 'artifacts', 'contentEncoding', 'assetCodec']) {
      expect(properties).not.toHaveProperty(field);
    }
    expect(schema.$comment).toContain('SCRIPTABLE_PACK_CAPABILITY_MANIFEST');
  });
});
