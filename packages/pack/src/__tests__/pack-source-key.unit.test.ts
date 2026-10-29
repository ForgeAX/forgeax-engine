import { describe, expect, it } from 'vitest';
import { AssetGuid, PackageId, suggestPackSourceKey } from '../guid.js';
import { parsePackSourceJson } from '../pack-authoring.js';

function packageId() {
  const parsed = PackageId.parse('019fb7ce-2200-7000-8000-000000000000');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe('Pack source-key failures name the fix', () => {
  it.each([
    ['material/rockLight', 'material/rock-light'],
    ['land/auroraTop', 'land/aurora-top'],
    ['Material/Rock Light', 'material/rock-light'],
    ['mesh/HTMLPanel', 'mesh/html-panel'],
    ['HANDLE_CUBE', 'handle_cube'],
    ['/texture//_dust/', 'texture/dust'],
  ])('suggests %s -> %s', (key, suggestion) => {
    expect(suggestPackSourceKey(key)).toBe(suggestion);
  });

  it('has no suggestion when nothing valid remains', () => {
    expect(suggestPackSourceKey('///')).toBeUndefined();
  });

  it('throws a structured AssetGuid.derive failure with the rule and the kebab-case key', () => {
    let thrown: unknown;
    try {
      AssetGuid.derive(packageId(), 'material/rockLight');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).toMatchObject({
      message: expect.stringContaining('use kebab-case: "material/rock-light"'),
      code: 'pack-source-key-invalid',
      expected: expect.stringContaining('lower-case segments'),
      hint: expect.stringContaining('"material/rock-light"'),
      detail: {
        operation: 'AssetGuid.derive',
        sourceKey: 'material/rockLight',
        suggestedSourceKey: 'material/rock-light',
      },
    });
  });

  it('reports a pack.json asset key with its property path and suggestion', () => {
    const parsed = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId: '019fb7ce-2200-7000-8000-000000000000',
      assets: { 'material/rockLight': { kind: 'material' } },
    });
    expect(parsed).toMatchObject({
      ok: false,
      error: {
        code: 'pack-source-key-invalid',
        actual: 'material/rockLight',
        detail: {
          propertyPath: '$.assets.material/rockLight',
          sourceKey: 'material/rockLight',
          suggestedSourceKey: 'material/rock-light',
        },
      },
    });
  });
});
