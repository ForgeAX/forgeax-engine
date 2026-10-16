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
  it('keeps the runtime publication tuple flat and atomic', async () => {
    const schema = JSON.parse(
      await readFile(new URL('../../schema/pack-index.schema.json', import.meta.url), 'utf8'),
    ) as CatalogSchema;
    const properties = schema.$defs?.packIndexEntry?.properties ?? {};

    expect(properties).toHaveProperty('scopeId');
    expect(properties).toHaveProperty('generation');
    expect(properties).toHaveProperty('digest');
    expect(properties).toHaveProperty('outputSetDigest');
    expect(properties).toHaveProperty('publication.$ref', '#/$defs/publication');
  });

  it('requires packageUrl and rejects legacy/content facts', async () => {
    const schema = JSON.parse(
      await readFile(new URL('../../schema/pack-index.schema.json', import.meta.url), 'utf8'),
    ) as CatalogSchema;
    const entry = schema.$defs?.packIndexEntry;
    const properties = entry?.properties ?? {};

    expect(entry?.required).toContain('packageUrl');
    expect(entry?.required).toContain('packageUrl');
    expect(properties).toHaveProperty('packageUrl');
    expect(properties).toHaveProperty('packageUrl');
    expect(properties).not.toHaveProperty('metadata');
    expect(properties).not.toHaveProperty('compression');
    expect(properties).not.toHaveProperty('artifacts');
    expect(properties).not.toHaveProperty('contentEncoding');
    expect(properties).not.toHaveProperty('assetCodec');
    expect(schema.$comment).toContain('SCRIPTABLE_PACK_CAPABILITY_MANIFEST');
  });

  it('keeps diagnostic navigation separate from package content', async () => {
    const schema = JSON.parse(
      await readFile(new URL('../../schema/pack-index.schema.json', import.meta.url), 'utf8'),
    ) as CatalogSchema;
    const properties = schema.$defs?.packIndexEntry?.properties ?? {};

    expect(properties).toHaveProperty('sourcePath');
    expect(properties).toHaveProperty('cookReceiptUrl');
  });
});
