import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  definePack,
  definePackageId,
  projectScriptablePackMeta,
  resolvePackParameterValues,
  validatePackDefinition,
} from '../pack-authoring.js';
import { executePackBuild } from '../pack-parameter-bindings.js';

const packageId = definePackageId('01900000-0000-7000-8000-000000000077');
const binding = {
  asset: 'scene/main',
  path: ['entities', 'sun', 'components', 'DirectionalLight', 'color'],
} as const;

function scene() {
  return {
    'scene/main': {
      kind: 'scene' as const,
      entities: { sun: { components: { DirectionalLight: { intensity: 2 } } } },
    },
  };
}

describe('optional Pack live parameter bindings', () => {
  it('keeps existing zero-parameter and generated definitions on their original build path', () => {
    const build = vi.fn(() => ok(scene()));
    expect(definePack({ schemaVersion: '2.0.0', packageId, build }).build).toBe(build);
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build,
      parameters: [{ name: 'radius', type: 'f32', default: 1 }],
    });
    expect(definition.build).toBe(build);
    expect(resolvePackParameterValues(definition, { radius: 3 }).unwrap()).toEqual({ radius: 3 });
    expect(projectScriptablePackMeta(definition, 'old.pack.ts').parameters).toEqual([
      { name: 'radius', type: 'f32', default: 1 },
    ]);
  });

  it('keeps inherited and overridden values while withholding live values from generation', async () => {
    const output = scene();
    const build = vi.fn((_context: { values: Readonly<Record<string, unknown>> }) => ok(output));
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      build,
      parameters: [
        { name: 'radius', type: 'f32', default: 1 },
        { name: 'sunColor', type: 'vec3', default: [1, 1, 1], apply: binding },
      ],
    });
    const values = resolvePackParameterValues(
      definition,
      { sunColor: [0.2, 0.4, 0.8] },
      { radius: 5 },
    );
    const result = await executePackBuild(definition, {
      packageId,
      values: values.unwrap(),
      readByGuid: vi.fn(),
    });
    expect(build.mock.calls[0]?.[0]).toMatchObject({ values: { radius: 5 } });
    expect(Object.keys(build.mock.calls[0]?.[0].values)).toEqual(['radius']);
    expect(result.unwrap()['scene/main']).toMatchObject({
      entities: {
        sun: { components: { DirectionalLight: { intensity: 2, color: [0.2, 0.4, 0.8] } } },
      },
    });
    expect(output['scene/main'].entities.sun.components.DirectionalLight).toEqual({ intensity: 2 });
    expect(projectScriptablePackMeta(definition, 'live.pack.ts').parameters?.[1]).toMatchObject({
      apply: binding,
    });
  });

  it('owns binding paths and default values independently of caller mutations', async () => {
    const path = [...binding.path];
    const color = [1, 0.5, 0.1];
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      parameters: [
        { name: 'sunColor', type: 'vec3', default: color, apply: { asset: binding.asset, path } },
      ],
      build: () => ok(scene()),
    });
    path.length = 0;
    color[0] = 99;
    const values = resolvePackParameterValues(definition).unwrap();
    const result = await executePackBuild(definition, { packageId, values, readByGuid: vi.fn() });
    expect(result.unwrap()['scene/main']).toMatchObject({
      entities: { sun: { components: { DirectionalLight: { color: [1, 0.5, 0.1] } } } },
    });
  });

  it('rejects overlapping bindings and unsafe or malformed target paths', () => {
    for (const apply of [
      null,
      'runtime',
      {},
      { asset: '../scene', path: ['x'] },
      { asset: 'scene/main', path: [] },
      { asset: 'scene/main', path: ['__proto__', 'x'] },
    ]) {
      expect(
        validatePackDefinition({
          schemaVersion: '2.0.0',
          packageId,
          build: () => ok(scene()),
          parameters: [{ name: 'color', type: 'vec3', default: [1, 1, 1], apply }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
    }
    expect(
      validatePackDefinition({
        schemaVersion: '2.0.0',
        packageId,
        build: () => ok(scene()),
        parameters: [
          { name: 'one', type: 'vec3', default: [1, 1, 1], apply: binding },
          {
            name: 'two',
            type: 'f32',
            default: 1,
            apply: { ...binding, path: [...binding.path, '0'] },
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
  });

  it('fails before publishing a generated field that has two author sources', async () => {
    const definition = definePack({
      schemaVersion: '2.0.0',
      packageId,
      parameters: [{ name: 'sunColor', type: 'vec3', default: [1, 1, 1], apply: binding }],
      build: () =>
        ok({
          'scene/main': {
            kind: 'scene',
            entities: { sun: { components: { DirectionalLight: { color: [0, 0, 0] } } } },
          },
        }),
    });
    const result = await executePackBuild(definition, {
      packageId,
      values: resolvePackParameterValues(definition).unwrap(),
      readByGuid: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'pack-parameter-invalid' } });
  });
});
