import { describe, expect, it } from 'vitest';
import {
  deriveMaterialDynamicInputLayout,
  isMaterialSurfaceDeclaration,
  type MaterialDynamicInputSchema,
} from '../material/index.js';

const schema: MaterialDynamicInputSchema = {
  name: 'waterEvents',
  fields: [
    { name: 'position', type: 'vec3<f32>' },
    { name: 'time', type: 'f32' },
    { name: 'eventId', type: 'u32' },
  ],
  maxRecords: 4,
  maxDomains: 2,
  maxPageBytes: 128,
  maxBindings: 1,
  maxEventsPerSample: 8,
};

describe('Material Surface model contracts', () => {
  it('derives one deterministic aligned dynamic record layout', () => {
    const result = deriveMaterialDynamicInputLayout(schema);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stride).toBe(32);
    expect(result.value.fields).toMatchObject([
      { name: 'position', offset: 0, size: 12, alignment: 16 },
      { name: 'time', offset: 12, size: 4, alignment: 4 },
      { name: 'eventId', offset: 16, size: 4, alignment: 4 },
    ]);
    expect(result.value.identity).toContain('surface-dynamic-v1/waterEvents/stride-32');
  });

  it('rejects duplicate fields and a page that cannot hold its declared records', () => {
    const duplicate = deriveMaterialDynamicInputLayout({
      ...schema,
      fields: [...schema.fields, { name: 'time', type: 'f32' }],
    });
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'duplicate-field' } });

    const tooSmall = deriveMaterialDynamicInputLayout({ ...schema, maxPageBytes: 64 });
    expect(tooSmall).toMatchObject({ ok: false, error: { code: 'page-too-small' } });
  });

  it('keeps Surface declarations as root-owned data', () => {
    expect(
      isMaterialSurfaceDeclaration({
        model: 'single-layer-medium',
        module: 'game::water_surface',
        dynamicInput: schema,
      }),
    ).toBe(true);
    expect(isMaterialSurfaceDeclaration({ model: 'single-layer-medium' })).toBe(false);
  });
});
