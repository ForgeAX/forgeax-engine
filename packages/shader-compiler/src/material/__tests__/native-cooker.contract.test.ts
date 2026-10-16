import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import type { AssetGuid, MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook.js';
import {
  createMaterialNativeCooker,
  type MaterialCookRequest,
  materialCookPublication,
} from '../native-cooker.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const shader = `#define_import_path game::pbr
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(material.roughness); }
`;
const material: MaterialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: { module: 'game::pbr', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
    },
  ],
  parameters: [{ name: 'roughness', type: 'f32', default: 0.5 }],
  values: { roughness: 0.5 },
};
const request: MaterialCookRequest = {
  guid: 'mat-root',
  sourceClosure: ['materials/root.material.json'],
  profile: 'webgpu/v1',
  compilerVersion: 'compiler/1',
  material,
  moduleSources: { 'game::pbr': shader },
};
function fixture() {
  let count = 0;
  const cooker = createMaterialNativeCooker({
    compile: async (input) => {
      count += 1;
      const sources = buildMaterialSourceCatalog({
        engine: [],
        project: Object.entries(input.moduleSources ?? { 'game::pbr': shader }).map(
          ([moduleId, source]) => ({ moduleId, source, path: `${moduleId}.wgsl` }),
        ),
      }).unwrap();
      return (
        await cookMaterialAsset({
          material: input.guid,
          table: { ...input.table, [input.guid]: input.material },
          sources,
        })
      ).unwrap();
    },
  });
  return { cooker, count: () => count };
}
function publication(
  product: Awaited<ReturnType<ReturnType<typeof createMaterialNativeCooker>['cook']>>,
) {
  const result = materialCookPublication(product);
  if (result === undefined) throw new Error('Missing material publication');
  return result;
}

describe('shader-compiler material native cooker', () => {
  it('publishes a complete validated program set and matching artifact descriptors', async () => {
    const { cooker } = fixture();
    const product = await cooker.cook(request);
    const published = publication(product);
    const record = validateCookedMaterialRecord(
      JSON.parse(new TextDecoder().decode(published.recordBytes)),
    ).unwrap();
    expect(record.programs).toHaveLength(1);
    for (const { artifact } of record.programs) {
      expect(product.artifacts[artifact.path]).toEqual({
        path: artifact.path,
        mediaType: artifact.mediaType,
        byteLength: artifact.bytes.byteLength,
        integrity: { algorithm: 'sha256', digest: artifact.digest },
      });
      expect(new TextDecoder().decode(artifact.bytes)).toContain('fn fs_main');
    }
    expect(product.digest).toBe(record.receipt.identity.artifactDigest);
    expect(published.catalog).toEqual({
      guid: request.guid,
      key: product.digest,
      artifactDigest: product.digest,
    });
    expect(record.resolved.values).toEqual({ roughness: 0.5 });
    expect(product.receipt.outputDigest).toBe(product.digest);
  });

  it('reuses exact products and programs across values, defaults and render-state changes', async () => {
    const { cooker, count } = fixture();
    const first = await cooker.cook(request);
    expect(await cooker.cook(request)).toBe(first);
    const values = await cooker.cook({
      ...request,
      material: { ...material, values: { roughness: 0.8 } },
    });
    const defaults = await cooker.cook({
      ...request,
      material: {
        ...material,
        parameters: [{ name: 'roughness', type: 'f32', default: 0.9 }],
        values: {},
      },
    });
    const state = await cooker.cook({
      ...request,
      material: {
        ...material,
        passes: [
          {
            name: 'Forward',
            program: { module: 'game::pbr', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
            renderState: { cullMode: 'none' },
          },
        ],
      },
    });
    expect(count()).toBe(1);
    for (const product of [values, defaults, state])
      expect(publication(product).record.programs).toEqual(publication(first).record.programs);
    expect(publication(values).record.resolved.values.roughness).toBe(0.8);
    expect(publication(defaults).record.resolved.parameters[0]?.default).toBe(0.9);
    expect(publication(state).record.receipt.identity.pipelineIdentity).not.toBe(
      publication(first).record.receipt.identity.pipelineIdentity,
    );
  });

  it('invalidates compilation on source changes and never trusts paths as content identity', async () => {
    const { cooker, count } = fixture();
    const first = await cooker.cook(request);
    const moved = await cooker.cook({ ...request, sourceClosure: ['moved/material.json'] });
    expect(publication(moved).record.programs).toEqual(publication(first).record.programs);
    const changed = await cooker.cook({
      ...request,
      moduleSources: {
        'game::pbr': shader.replace(
          'vec4<f32>(material.roughness)',
          'vec4<f32>(material.roughness * 2.0)',
        ),
      },
    });
    expect(publication(changed).record.programs).not.toEqual(publication(first).record.programs);
    expect(count()).toBe(2);
    const { moduleSources: _sources, ...withoutSnapshot } = request;
    await cooker.cook(withoutSnapshot);
    await cooker.cook(withoutSnapshot);
    expect(count()).toBe(4);
  });

  it('refuses to publish a compiler result with an unpublished Pass', async () => {
    const sources = buildMaterialSourceCatalog({
      engine: [],
      project: [{ source: shader, path: 'pbr.wgsl' }],
    }).unwrap();
    const cooker = createMaterialNativeCooker({
      compile: async (input) => {
        const compiled = (
          await cookMaterialAsset({
            material: input.guid,
            table: { [input.guid]: input.material },
            sources,
          })
        ).unwrap();
        return { ...compiled, passes: compiled.passes.slice(0, 1) };
      },
    });
    await expect(
      cooker.cook({
        ...request,
        material: {
          ...material,
          passes: [
            { name: 'Forward', program: { module: 'game::pbr' } },
            { name: 'Overlay', program: { module: 'game::pbr' } },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: 'material-cook-record-invalid',
      detail: { field: 'programs.selections' },
    });
  });

  it('resolves child values against the parent and preserves zero values while sharing programs', async () => {
    const { cooker, count } = fixture();
    const root = await cooker.cook(request);
    const child = await cooker.cook({
      ...request,
      guid: 'child',
      table: { 'mat-root': material },
      material: {
        kind: 'material',
        parent: 'mat-root' as unknown as AssetGuid,
        values: { roughness: 0 },
      },
    });
    expect(publication(child).record.resolved.values.roughness).toBe(0);
    expect(publication(child).record.refs.parent).toEqual(['mat-root']);
    expect(publication(child).record.programs).toEqual(publication(root).record.programs);
    expect(count()).toBe(1);
  });
});
