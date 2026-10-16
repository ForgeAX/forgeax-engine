import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetGuid, PackageId } from '../guid.js';
import {
  definePack,
  definePackageId,
  type PackParameterInheritanceSubject,
  parsePackSourceJson,
  projectDirectPackJson,
  projectScriptablePackMeta,
  resolvePackParameterInheritance,
  resolvePackParameterValues,
  validatePackDefinition,
} from '../pack-authoring.js';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function packageId(value: string) {
  const result = PackageId.parse(value);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('ScriptablePack and Pack authoring', () => {
  it('preserves explicit runtime capability without evaluating its build', () => {
    const dependency = '01900000-0000-7000-8000-000000000033';
    const dependencies = [dependency];
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000032'),
      runtime: { dependencies },
      build() {
        throw new Error('metadata must not build');
      },
    });
    dependencies.length = 0;
    expect(definition.runtime?.dependencies).toEqual([dependency]);
    expect(Object.isFrozen(definition.runtime?.dependencies)).toBe(true);
    expect(projectScriptablePackMeta(definition, 'new.pack.js').runtime).toEqual({
      dependencies: [dependency],
    });
    for (const runtime of [
      true,
      {},
      { dependencies: ['invalid'] },
      { dependencies: [dependency, dependency] },
      { dependencies: [], extra: true },
    ]) {
      expect(validatePackDefinition({ ...definition, runtime })).toMatchObject({
        ok: false,
        error: { code: 'pack-parameter-invalid' },
      });
    }
  });

  it('accepts boolean and string defaults and overrides without coercion', () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000031'),
      parameters: [
        { name: 'animated', type: 'bool', default: true },
        { name: 'label', type: 'string', default: 'smoke' },
      ],
      build: () => ok({ 'scene/main': { kind: 'scene', entities: {} } }),
    });
    expect(resolvePackParameterValues(definition, {})).toMatchObject({
      ok: true,
      value: { animated: true, label: 'smoke' },
    });
    expect(resolvePackParameterValues(definition, { animated: false, label: '' })).toMatchObject({
      ok: true,
      value: { animated: false, label: '' },
    });
    for (const values of [{ animated: 'false' }, { animated: 0 }, { label: false }, { label: 0 }]) {
      expect(resolvePackParameterValues(definition, values)).toMatchObject({
        ok: false,
        error: { code: 'pack-parameter-invalid' },
      });
    }
  });

  it('derives the RFC 4122 UUIDv5 vector and keeps PackageId branded separately', () => {
    const namespace = packageId(NAMESPACE);
    expect(AssetGuid.format(AssetGuid.derive(namespace, 'www.widgets.com'))).toBe(
      '21f7f8de-8051-5b89-8680-0195ef798b6a',
    );
    expect(PackageId.format(namespace)).toBe(NAMESPACE);
    expect(AssetGuid.derive(namespace, 'mesh/a')).not.toBe(namespace);
  });

  it('derives an explicit context shape for zero-parameter and parameter-bearing ScriptablePacks', async () => {
    const zero = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000001'),
      build: ({ packageId: subjectId }) =>
        ok({
          'scene/main': {
            kind: 'scene',
            entities: {},
            source: AssetGuid.format(AssetGuid.derive(subjectId, 'mesh/main')),
          },
        }),
    });
    expect('parameters' in zero).toBe(false);
    const zeroResult = await zero.build({
      packageId: zero.packageId,
      readByGuid: async () => ok(null as never),
    });
    expect(zeroResult.ok).toBe(true);

    const withParameters = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000002'),
      parameters: [
        { name: 'segments', type: 'u32', default: 12, minimum: 3, maximum: 128 },
        { name: 'style', type: 'enum', values: ['oak', 'pine'], default: 'oak' },
      ] as const,
      build: ({ values }) =>
        ok({
          'scene/main': {
            kind: 'scene',
            entities: values.segments >= 0 ? {} : {},
          },
        }),
    });
    const values = resolvePackParameterValues(withParameters, { segments: 24 });
    expect(values).toMatchObject({ ok: true, value: { segments: 24, style: 'oak' } });
    expect(resolvePackParameterValues(withParameters, { unknown: true })).toMatchObject({
      ok: false,
      error: { code: 'pack-parameter-invalid' },
    });

    const bounded = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000003'),
      parameters: [
        { name: 'unsigned', type: 'u32', default: 0 },
        { name: 'signed', type: 'i32', default: 0 },
        { name: 'float', type: 'f32', default: 0 },
      ] as const,
      build: () => ok({}),
    });
    expect(resolvePackParameterValues(bounded, { unsigned: 0x1_0000_0000 })).toMatchObject({
      ok: false,
      error: { code: 'pack-parameter-invalid' },
    });
    expect(resolvePackParameterValues(bounded, { signed: 0x8000_0000 })).toMatchObject({
      ok: false,
      error: { code: 'pack-parameter-invalid' },
    });
    expect(resolvePackParameterValues(bounded, { float: Number.MAX_VALUE })).toMatchObject({
      ok: false,
      error: { code: 'pack-parameter-invalid' },
    });
  });

  it('validates and preserves optional scene component schemas without exposing output identity', () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000004'),
      sceneComponents: [
        { name: 'Transform', fields: { pos: { type: 'vec3' }, quat: 'quat' } },
        { name: 'Name', fields: { value: 'string' } },
      ],
      build: () => ok({}),
    });
    expect(definition.sceneComponents).toEqual([
      { name: 'Transform', fields: { pos: { type: 'vec3' }, quat: 'quat' } },
      { name: 'Name', fields: { value: 'string' } },
    ]);
    expect(Object.isFrozen(definition.sceneComponents)).toBe(true);
    expect(Object.isFrozen(definition.sceneComponents?.[0])).toBe(true);
    expect(Object.isFrozen(definition.sceneComponents?.[0]?.fields)).toBe(true);

    const duplicate = validatePackDefinition({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000005'),
      sceneComponents: [
        { name: 'Transform', fields: {} },
        { name: 'Transform', fields: {} },
      ],
      build: () => ok({}),
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: {
        code: 'pack-parameter-invalid',
        detail: { reason: 'scene component names must be unique' },
      },
    });
    const malformed = validatePackDefinition({
      schemaVersion: '2.0.0',
      packageId: definePackageId('01900000-0000-7000-8000-000000000006'),
      sceneComponents: [{ name: 'Transform', fields: { pos: { type: '' } } }],
      build: () => ok({}),
    });
    expect(malformed).toMatchObject({
      ok: false,
      error: {
        code: 'pack-parameter-invalid',
        detail: { reason: 'scene component field schema is malformed' },
      },
    });
  });

  it('parses direct and instance JSON without accepting GUID fields', () => {
    const direct = parsePackSourceJson({
      schemaVersion: '3.0.0',
      packageId: '01900000-0000-7000-8000-000000000010',
      assets: {
        'scene/main': { kind: 'scene', payload: {}, refs: [] },
      },
    });
    expect(direct.ok).toBe(true);
    if (direct.ok && direct.value.format === 'direct') {
      const projected = projectDirectPackJson(direct.value);
      expect(projected).toMatchObject({
        packageId: '01900000-0000-7000-8000-000000000010',
        assets: [{ sourceKey: 'scene/main', guid: expect.any(String) }],
      });
    }
    expect(
      parsePackSourceJson({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000010',
        assets: { 'scene/main': { guid: NAMESPACE, kind: 'scene', payload: {}, refs: [] } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
    expect(
      parsePackSourceJson({
        schemaVersion: '3.0.0',
        packageId: '01900000-0000-7000-8000-000000000020',
        parent: '01900000-0000-7000-8000-000000000002',
        values: { segments: 24 },
      }),
    ).toMatchObject({ ok: true, value: { format: 'instance' } });
  });

  it('rejects legacy static output fields in the v2 source definition', () => {
    expect(() =>
      definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-000000000021'),
        assets: [],
        build: () => ok({}),
      } as never),
    ).toThrow(/repair the parameter declaration|authoring/);
    expect(() =>
      definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-000000000022'),
        externalAssets: [],
        build: () => ok({}),
      } as never),
    ).toThrow();
  });

  it('rejects unknown parameter descriptor fields instead of carrying a second schema', () => {
    expect(() =>
      definePack({
        schemaVersion: '2.0.0',
        packageId: definePackageId('01900000-0000-7000-8000-000000000023'),
        parameters: [{ name: 'count', type: 'u32', default: 1, editor: 'slider' }] as never,
        build: () => ok({}),
      }),
    ).toThrow();
  });

  it('resolves finite shallow inheritance and reports missing parent and cycle', async () => {
    const rootId = packageId('01900000-0000-7000-8000-000000000030');
    const middleId = packageId('01900000-0000-7000-8000-000000000031');
    const leafId = packageId('01900000-0000-7000-8000-000000000032');
    const root: PackParameterInheritanceSubject = {
      format: 'source',
      packageId: rootId,
      parameters: [{ name: 'segments', type: 'u32', default: 12, minimum: 3 }],
    };
    const middle: PackParameterInheritanceSubject = {
      format: 'instance',
      packageId: middleId,
      parent: rootId,
      values: { segments: 24 },
    };
    const leaf: PackParameterInheritanceSubject = {
      format: 'instance',
      packageId: leafId,
      parent: middleId,
      values: {},
    };
    const subjects = new Map<string, PackParameterInheritanceSubject>([
      [PackageId.format(rootId), root],
      [PackageId.format(middleId), middle],
    ]);
    const resolved = await resolvePackParameterInheritance(leaf, (id) =>
      subjects.get(PackageId.format(id)),
    );
    expect(resolved).toMatchObject({
      ok: true,
      value: {
        values: { segments: 24 },
        parentChain: [PackageId.format(middleId), PackageId.format(rootId)],
      },
    });

    const missing = await resolvePackParameterInheritance(leaf, () => undefined);
    expect(missing).toMatchObject({ ok: false, error: { code: 'pack-parent-not-found' } });

    const cycleA: PackParameterInheritanceSubject = {
      format: 'instance',
      packageId: middleId,
      parent: leafId,
      values: {},
    };
    const cycle = await resolvePackParameterInheritance(cycleA, (id) =>
      PackageId.format(id) === PackageId.format(leafId) ? leaf : cycleA,
    );
    expect(cycle).toMatchObject({ ok: false, error: { code: 'pack-parent-cycle' } });
  });
});
