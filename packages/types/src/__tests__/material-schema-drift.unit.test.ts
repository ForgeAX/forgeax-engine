import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Schema = {
  properties?: Record<string, unknown>;
  $defs?: Record<string, { properties?: Record<string, unknown> }>;
};

const schemaPath = fileURLToPath(new URL('../../schema/material.schema.json', import.meta.url));

function readMaterialSchema(): Schema {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as Schema;
}

describe('material schema vocabulary', () => {
  it('keeps the authoring fields and legacy removals aligned', () => {
    const schema = readMaterialSchema();
    const rootFields = Object.keys(schema.properties ?? {}).sort();
    const passFields = Object.keys(schema.$defs?.pass?.properties ?? {}).sort();
    const programFields = Object.keys(schema.$defs?.program?.properties ?? {}).sort();

    expect(rootFields).toEqual(['colorSpace', 'kind', 'parameters', 'parent', 'passes', 'values']);
    expect(passFields).toEqual(['name', 'outputs', 'program', 'renderState']);
    expect(programFields).toEqual([
      'bindings',
      'fragmentEntry',
      'module',
      'moduleSlots',
      'sceneDepth',
      'vertexEntry',
    ]);
    expect(passFields).not.toContain('shader');
    expect(schema.properties?.kind).toEqual({ const: 'material' });
    expect(schema.properties?.colorSpace).toMatchObject({
      enum: ['srgb', 'linear'],
      default: 'srgb',
    });
    expect(schema.$defs?.valueOrNull).toBeDefined();
    expect(schema.$defs?.value).toMatchObject({
      anyOf: expect.arrayContaining([{ $ref: '#/$defs/textureGuid' }]),
    });
    expect(schema.$defs?.textureGuid).toMatchObject({ type: 'string', minLength: 1 });
  });
});
