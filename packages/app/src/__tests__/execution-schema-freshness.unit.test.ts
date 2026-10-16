import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_CAPABILITY_NAMES,
  EXECUTION_REPORT_SCHEMA_VERSION,
  EXECUTION_WORKERS,
} from '../index';

describe('execution schema freshness', () => {
  it('keeps runtime catalogs aligned with the JSON schema authority', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../../schema/execution-report.schema.json', import.meta.url), 'utf8'),
    ) as {
      properties: Record<
        string,
        {
          const?: number;
          enum?: unknown[];
          required?: string[];
          properties?: Record<string, { required?: string[] }>;
        }
      >;
    };
    expect(schema.properties.schemaVersion?.const).toBe(EXECUTION_REPORT_SCHEMA_VERSION);
    expect(schema.properties.workers?.required).toEqual(EXECUTION_WORKERS);
    expect(schema.properties.capabilities?.required).toEqual(EXECUTION_CAPABILITY_NAMES);
    expect(schema.properties.render?.properties?.capabilities?.required).toEqual([
      'backendKind',
      'compute',
      'storageBuffer',
    ]);
    expect(schema.properties.render?.properties?.limits?.required).toEqual([
      'maxStorageBuffersPerShaderStage',
    ]);
  });
});
