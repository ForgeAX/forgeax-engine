import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { compileShader } from '../../compile.js';
import { createShaderProgramCompiler } from '../../program-compiler.js';
import { cookMaterialAsset, type MaterialCookRequest } from '../cook.js';
import { createMaterialPackVariantCompiler } from '../pack-variant-reuse.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const shader = `#define_import_path test::reuse
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(material.roughness); }
`;
const material: MaterialAsset = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'test::reuse' } }],
  parameters: [{ name: 'roughness', type: 'f32', default: 0.5 }],
  values: { roughness: 0.5 },
};

function request(
  guid: string,
  asset = structuredClone(material),
  source = shader,
): MaterialCookRequest {
  return {
    material: guid,
    table: { [guid]: asset },
    sources: buildMaterialSourceCatalog({
      engine: [],
      project: [{ path: '/project/reuse.wgsl', source }],
    }).unwrap(),
  };
}

function fixture() {
  let calls = 0;
  const native = createShaderProgramCompiler();
  const compile: typeof compileShader = (...args) => {
    calls++;
    return native(...args);
  };
  return { cook: createMaterialPackVariantCompiler(compile), calls: () => calls };
}

describe('Pack variant compilation ownership', () => {
  it('reuses native-validated passes across GUIDs while resolving each material values and ancestry', async () => {
    const f = fixture();
    const firstRequest = request('first');
    const first = (await f.cook(firstRequest, 'actual-source-snapshot')).unwrap();
    const secondRequest = request('second', { ...material, values: { roughness: 0.9 } });
    const second = (await f.cook(secondRequest, 'actual-source-snapshot')).unwrap();
    expect(f.calls()).toBe(1);
    expect(second).toEqual((await cookMaterialAsset(secondRequest)).unwrap());
    expect(first.resolved.asset.values).toEqual({ roughness: 0.5 });
    expect(second.resolved.asset.values).toEqual({ roughness: 0.9 });
    expect(second.resolved).not.toEqual(first.resolved);
    expect(second.passes).toEqual(first.passes);
  });

  it('owns cached metadata against edits to a returned pass or the original schema', async () => {
    const f = fixture();
    const input = request('first');
    const first = (await f.cook(input, 'snapshot')).unwrap();
    Object.assign(first.passes[0]?.parameters[0] ?? {}, { default: 99 });
    const nextRequest = request('second');
    const next = (await f.cook(nextRequest, 'snapshot')).unwrap();
    expect(f.calls()).toBe(1);
    expect(next).toEqual((await cookMaterialAsset(nextRequest)).unwrap());
    Object.assign(next.passes[0]?.paramSchema[0] ?? {}, { name: 'borrowed-edit' });
    expect((await f.cook(request('third'), 'snapshot')).unwrap().passes).toEqual(
      (await cookMaterialAsset(request('third'))).unwrap().passes,
    );
  });

  it('recompiles defaults, pass state, static switches, Surface, namespace bytes and geometry facts', async () => {
    const f = fixture();
    await f.cook(request('base'), 'snapshot');
    const variants: MaterialAsset[] = [
      { ...material, parameters: [{ name: 'roughness', type: 'f32', default: 0.9 }] },
      {
        ...material,
        passes: [
          {
            name: 'Forward',
            program: { module: 'test::reuse' },
            renderState: { cullMode: 'none' },
          },
        ],
      },
      { ...material, staticSwitches: { alphaClipping: false } },
      { ...material, surface: { model: 'standard', module: 'test::authored-surface' } },
    ];
    for (const [index, asset] of variants.entries())
      expect((await f.cook(request(`variant-${index}`, asset), 'snapshot')).ok).toBe(true);
    const changedSource = request(
      'source',
      structuredClone(material),
      shader.replace('material.roughness', 'material.roughness * 2.0'),
    );
    expect((await f.cook(changedSource, 'changed-full-namespace')).ok).toBe(true);
    expect((await f.cook({ ...request('color'), vertexColorAvailable: true }, 'snapshot')).ok).toBe(
      true,
    );
    expect(f.calls()).toBe(7);
  });

  it('keeps getter-bearing schemas on the original observation path', async () => {
    const trace: string[] = [];
    const asset: MaterialAsset = {
      ...material,
      parameters: [
        {
          name: 'roughness',
          type: 'f32',
          get default() {
            trace.push('default');
            return 0.5;
          },
        },
      ],
    };
    const input = request('getter', asset);
    await cookMaterialAsset(input);
    const expected = trace.splice(0);
    const f = fixture();
    await f.cook(input, 'snapshot');
    expect(trace.splice(0)).toEqual(expected);
    await f.cook(input, 'snapshot');
    expect(trace.splice(0)).toEqual(expected);
    expect(f.calls()).toBe(2);
  });

  it('does not retain failed compilation or turn a retry into a false success', async () => {
    const f = fixture();
    const input = request(
      'invalid',
      structuredClone(material),
      shader.replace('material.roughness', 'missing_symbol'),
    );
    expect((await f.cook(input, 'broken-source')).ok).toBe(false);
    expect((await f.cook(input, 'broken-source')).ok).toBe(false);
    expect(f.calls()).toBe(2);
    expect((await f.cook(request('fixed'), 'fixed-source')).ok).toBe(true);
  });

  it('keys variants by source identity so interleaved Packs keep their compiled programs', async () => {
    const f = fixture();
    await f.cook(request('first'), 'namespace-a');
    await f.cook(request('second'), 'namespace-a');
    expect(f.calls()).toBe(1);
    await f.cook(request('replacement'), 'namespace-b');
    expect(f.calls()).toBe(2);
    const restoredRequest = request('restored');
    const restored = (await f.cook(restoredRequest, 'namespace-a')).unwrap();
    expect(f.calls()).toBe(2);
    expect(restored).toEqual((await cookMaterialAsset(restoredRequest)).unwrap());
  });

  it('compiles one variant once while concurrent Packs request it', async () => {
    const f = fixture();
    const requests = ['a', 'b', 'c'].map((guid, index) =>
      request(guid, { ...material, values: { roughness: index / 4 } }),
    );
    const cooked = await Promise.all(requests.map((input) => f.cook(input, 'snapshot')));
    expect(f.calls()).toBe(1);
    for (const [index, result] of cooked.entries())
      expect(result.unwrap()).toEqual(
        (await cookMaterialAsset(requests[index] as MaterialCookRequest)).unwrap(),
      );
  });

  it('lets concurrent requests retry after a shared compilation fails', async () => {
    const f = fixture();
    const input = request(
      'invalid',
      structuredClone(material),
      shader.replace('material.roughness', 'missing_symbol'),
    );
    const results = await Promise.all([f.cook(input, 'broken'), f.cook(input, 'broken')]);
    expect(results.map((result) => result.ok)).toEqual([false, false]);
    expect(f.calls()).toBe(2);
  });

  it('keeps an untyped null selector on ordinary admission instead of an undefined-selector hit', async () => {
    const f = fixture();
    await f.cook(request('base'), 'snapshot');
    const invalid = { ...request('invalid'), vertexColorAvailable: null as unknown as boolean };
    expect(await f.cook(invalid, 'snapshot')).toEqual(await cookMaterialAsset(invalid));
    expect(f.calls()).toBe(2);
  });
});
