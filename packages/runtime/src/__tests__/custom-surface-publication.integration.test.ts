import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createRuntimePackPublication } from '@forgeax/engine-pack/runtime';
import { materialContribution } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../../../assets-runtime/src/asset-registry';
import {
  materialParametersToParamSchema,
  selectMaterialPassProgram,
} from '../../../assets-runtime/src/material/runtime-shader';
import { normaliseForPack } from '../../../import/src/import-runner';
import { AssetGuid } from '../../../pack/src/guid';
import { validateCookedMaterialRecord } from '../../../pack/src/material-cook';
import {
  materialProgramKeysForMaterial,
  materialSceneIndexProgramKeysForMaterial,
} from '../../../render/src/render-system-extract';
import { ShaderRegistry } from '../../../shader/src/index';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { derive, type MaterialAsset, standardSurfaceParameters } from '../../../types/src/index';

const GUID = '019f0000-0000-7000-8000-0000000007a1';
const customSurface = `#define_import_path game::custom_surface
#import game::surface_helper::{read_tint as read_tint_a}
#import game::surface_helper_other as helper_other
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let tint = read_tint_a(input) + helper_other::read_other(input) * 0.0;
  return SurfaceData(
    tint,
    input.vertexNormalWS,
    0.1,
    0.65,
    vec3<f32>(0.0),
    1.0,
    1.0,
    0.0,
  );
}
`;

const surfaceHelper = `#define_import_path game::surface_helper
#import forgeax_material::parameters::{material as mat}
#import forgeax_material::surface_v1::{SurfaceInput as Input}
const tintScale: f32 = 0.5;
struct LocalSample { scale: f32, }
alias LocalSampleType = LocalSample;
var<private> scratch: f32;
fn local_tint(input: Input) -> vec3<f32> {
  for (var tintScale = 0.0; tintScale < 1.0; tintScale += 1.0) {
  }
  let sample = LocalSampleType(tintScale);
  {
    let prior = tintScale;
    let tintScale = input.vertexColor.x;
    scratch = sample.scale + (tintScale + prior) * 0.0;
  }
  return mat.baseColor.rgb * input.vertexColor.rgb * scratch;
}
fn read_tint(input: SurfaceInput) -> vec3<f32> {
  return local_tint(input);
}
`;

const surfaceHelperOther = `#define_import_path game::surface_helper_other
#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceInput}
const tintScale: f32 = 0.25;
struct LocalSample { scale: f32, }
alias LocalSampleType = LocalSample;
var<private> scratch: f32;
fn local_tint(input: SurfaceInput) -> vec3<f32> {
  for (var tintScale = 0.0; tintScale < 1.0; tintScale += 1.0) {
  }
  let sample = LocalSampleType(tintScale);
  {
    let prior = tintScale;
    let tintScale = input.vertexColor.y;
    scratch = sample.scale + (tintScale + prior) * 0.0;
  }
  return material.baseColor.rgb * (1.0 - input.vertexColor.rgb) * scratch;
}
fn read_other(input: SurfaceInput) -> vec3<f32> {
  return local_tint(input);
}
`;

const material = {
  kind: 'material',
  parameters: standardSurfaceParameters([{ name: 'baseColor', type: 'color' }]),
  values: { baseColor: [0.72, 0.18, 0.04, 1] },
  passes: [
    {
      name: 'Forward',
      program: {
        module: 'forgeax::default-standard-pbr',
        moduleSlots: { surface: 'game::custom_surface' },
      },
    },
    {
      // Pass names are authored labels; the LightMode tag is the semantic
      // owner used by extraction and record. Keep this name intentionally
      // unrelated to "shadow" so the selection path cannot rely on naming.
      name: 'Occluder',
      program: {
        module: 'forgeax::default-shadow-caster',
        moduleSlots: { surface: 'game::custom_surface' },
      },
      renderState: { tags: { LightMode: 'ShadowCaster' } },
    },
  ],
} satisfies MaterialAsset;

function parseGuid(value: string) {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

describe('custom Surface publication path', () => {
  it('routes the declared ShadowCaster pass by semantic tag', () => {
    const shadowPass = material.passes[1];
    expect(shadowPass?.name).toBe('Occluder');
    expect(shadowPass?.renderState?.tags?.LightMode).toBe('ShadowCaster');
    expect(shadowPass?.program.module).toBe('forgeax::default-shadow-caster');
  });

  it('keeps helper imports inside the Surface ABI boundary', () => {
    expect(customSurface).toContain(
      '#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}',
    );
    expect(surfaceHelper).toContain('#import forgeax_material::parameters::{material as mat}');
    expect(surfaceHelperOther).toContain('#import forgeax_material::parameters::{material}');
    expect(surfaceHelper).toContain('struct LocalSample');
    expect(surfaceHelperOther).toContain('struct LocalSample');
  });

  it('cooks, transports, loads and selects the producer scene-index ABI', {
    timeout: 30_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-custom-surface-publication-'));
    const sourcePath = join(root, 'custom-surface.wgsl');
    const helperPath = join(root, 'surface-helper.wgsl');
    const helperOtherPath = join(root, 'surface-helper-other.wgsl');
    const materialPath = join(root, 'custom-surface.material.json');
    await writeFile(sourcePath, customSurface);
    await writeFile(helperPath, surfaceHelper);
    await writeFile(helperOtherPath, surfaceHelperOther);
    await writeFile(materialPath, '{}');
    const previousFetch = globalThis.fetch;
    try {
      const draft = await createMaterialPackCooker([root]).cook({
        guid: GUID,
        source: material,
        sourcePath: materialPath,
        sourceKey: 'custom-surface.wgsl',
      });
      const payload = draft.payload as Record<string, unknown>;
      const cooked = validateCookedMaterialRecord(payload.cooked).unwrap();
      const forward = cooked.programs.flatMap((program) =>
        program.selections.filter(
          (selection) => selection.pass === 'Forward' && selection.context.pipeline !== 'ray',
        ),
      );
      const ray = cooked.programs.flatMap((program) =>
        program.selections.filter((selection) => selection.context.pipeline === 'ray'),
      );
      expect(ray).toHaveLength(1);
      expect(ray[0]).toMatchObject({ pass: 'Forward', entry: 'cs_surface' });
      expect(ray[0]?.address).toBeUndefined();
      expect(ray[0]?.abi).toBeUndefined();
      for (const capability of [
        'storage-buffer-minimum',
        'storage-buffer-projector',
        'storage-buffer',
        'storage-buffer-atmosphere',
      ]) {
        for (const visibleSurface of [false, true]) {
          expect(
            forward
              .filter(
                (selection) =>
                  selection.context.pipeline !== 'ray' &&
                  selection.context.capability === capability &&
                  (selection.context.visibleSurface === true) === visibleSurface,
              )
              .map((selection) => selection.address),
            `Forward ${capability} visibleSurface=${visibleSurface}`,
          ).toEqual(['direct', 'scene-index', 'direct', 'scene-index']);
        }
      }
      expect(
        forward
          .filter((selection) => selection.context.capability !== 'uniform-fallback')
          .every((selection) => selection.abi?.sceneIndexEntry === 'vs_scene_index'),
      ).toBe(true);
      const sceneProgram = cooked.programs.find((program) =>
        program.selections.some((selection) => selection.address === 'scene-index'),
      );
      expect(sceneProgram).toBeDefined();
      expect(new TextDecoder().decode(sceneProgram?.artifact.bytes)).toContain(
        'evaluate_surface_with_material',
      );
      const sceneWgsl = new TextDecoder().decode(sceneProgram?.artifact.bytes);
      const helperLocalNames = [...sceneWgsl.matchAll(/fn\s+(\w*local_tint)\s*\(/g)].map(
        (match) => match[1],
      );
      expect(new Set(helperLocalNames).size).toBe(2);
      const helperScaleNames = [...sceneWgsl.matchAll(/const\s+(\w*tintScale)\s*:/g)].map(
        (match) => match[1],
      );
      expect(new Set(helperScaleNames).size).toBe(2);
      expect(sceneWgsl).toContain('sample.scale');
      expect(sceneWgsl).not.toMatch(/let fxSurfaceHelper_[A-Za-z0-9_]+_tintScale\s*=/);
      const privateMaterial = sceneWgsl.match(/var<private>\s+(\w+)\s*:/)?.[1];
      expect(privateMaterial).toBeDefined();
      if (privateMaterial === undefined) return;
      expect(sceneWgsl).toMatch(
        new RegExp(`fn \\w*read_tint[\\s\\S]*?${privateMaterial}\\.baseColor`),
      );
      expect(sceneWgsl).toMatch(
        new RegExp(`fn evaluateStandardSurface[\\s\\S]*?${privateMaterial}\\s*=`),
      );

      const shadow = cooked.programs.flatMap((program) =>
        program.selections.filter((selection) => selection.pass === 'Occluder'),
      );
      for (const capability of [
        'storage-buffer-minimum',
        'storage-buffer-projector',
        'storage-buffer',
        'storage-buffer-atmosphere',
      ]) {
        expect(
          shadow
            .filter((selection) => selection.context.capability === capability)
            .map((selection) => selection.address),
        ).toEqual(['direct', 'scene-index', 'direct', 'scene-index']);
      }
      const shadowSceneProgram = cooked.programs.find((program) =>
        program.selections.some(
          (selection) => selection.pass === 'Occluder' && selection.address === 'scene-index',
        ),
      );
      expect(shadowSceneProgram).toBeDefined();
      const shadowSceneWgsl = new TextDecoder().decode(shadowSceneProgram?.artifact.bytes);
      expect(shadowSceneWgsl).toContain('evaluate_surface_with_material');
      expect(shadowSceneWgsl).toContain('fn fs_shadow');

      const packageUrl = `/materials/${GUID}.pack.json`;
      const pack = {
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: GUID,
            kind: 'material',
            payload,
            refs: draft.refs,
            // Inline artifact bytes are part of the cooked record; an empty
            // descriptor map exercises the same JSON transport used by the
            // dev-server Pack route without an extra artifact fetch.
            artifacts: {},
          },
        ],
      };
      const publication = createRuntimePackPublication({
        scopeId: 'asset-runtime',
        sourcePath: 'custom-surface.material.json',
        sourceRevision: '1',
        packageUrl,
        pack,
      });
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/pack-index.json')) {
          return new Response(
            JSON.stringify([
              {
                guid: GUID,
                packageUrl,
                kind: 'material',
                sourcePath: 'custom-surface.material.json',
                publication: publication.publication,
              },
            ]),
          );
        }
        if (url.endsWith('.pack.json'))
          return new Response(JSON.stringify(normaliseForPack(publication.pack)));
        return new Response('not found', { status: 404 });
      });
      globalThis.fetch = fetcher as typeof fetch;

      const shaders = new ShaderRegistry({
        device: {
          createShaderModule: () => {
            throw new Error('runtime must consume cooked WGSL, not compile it');
          },
        } as never,
        manifestUrl: undefined,
      });
      const registry = new AssetRegistry({ shaderRegistry: shaders });
      registry.installDecoder(materialContribution.kind, materialContribution.decoder);
      registry.configurePackIndex('/pack-index.json');
      const loaded = await registry.load(parseGuid(GUID), 'material');
      expect(loaded.ok, loaded.ok ? '' : JSON.stringify(loaded.error)).toBe(true);
      const projection = registry.getMaterialProjectionForPayload(
        runtimeAssets(registry).borrow<MaterialAsset>(loaded.unwrap()).unwrap(),
      );
      expect(projection).toBeDefined();
      if (projection === undefined) return;

      const uniformRowBytes = derive(
        materialParametersToParamSchema(material.parameters ?? []),
      ).totalBytes;
      for (const backend of ['webgpu', 'webgl2']) {
        for (const [pass, selections] of [
          ['Forward', forward],
          ['Occluder', shadow],
        ] as const) {
          const uniform = selections.filter(
            (selection) =>
              selection.context.backend === backend &&
              selection.context.capability === 'uniform-fallback',
          );
          expect(uniform.map((selection) => selection.address)).toEqual(['direct', 'direct']);
          const uniformContext = uniform[0]?.context;
          if (uniformContext === undefined) throw new Error('missing uniform publication');
          for (const color of [false, true]) {
            const selected = selectMaterialPassProgram(
              projection,
              pass,
              uniformContext,
              'direct',
              color,
            );
            expect(selected.entry).toBe('vs_main');
            expect(selected.abi?.sceneIndexEntry).toBeUndefined();
            expect(selected.abi?.materialRow.byteLength).toBe(uniformRowBytes);
            expect(selected.abi?.vertexInputs.some((input) => input.semantic === 'color')).toBe(
              color,
            );
          }
        }
      }

      const context = forward[0]?.context;
      expect(context).toBeDefined();
      if (context === undefined || context.pipeline === 'ray')
        throw new Error('missing raster context');
      if (shadow[0] === undefined) throw new Error('missing shadow selection');
      for (const color of [false, true]) {
        for (const address of ['direct', 'scene-index'] as const) {
          for (const pass of ['Forward', 'Occluder']) {
            const selected = selectMaterialPassProgram(
              projection,
              pass,
              pass === 'Forward' ? context : shadow[0].context,
              address,
              color,
            );
            expect(selected.abi?.vertexInputs.some((input) => input.semantic === 'color')).toBe(
              color,
            );
          }
        }
      }
      const direct = selectMaterialPassProgram(projection, 'Forward', context, 'direct');
      const scene = selectMaterialPassProgram(projection, 'Forward', context, 'scene-index');
      const rayContext = ray[0]?.context;
      if (rayContext === undefined) throw new Error('missing published ray context');
      const rayProgram = selectMaterialPassProgram(projection, 'Forward', rayContext);
      expect(rayProgram.entry).toBe('cs_surface');
      expect(rayProgram.abi).toBeUndefined();
      expect(rayProgram.specializationKey).not.toBe(scene.specializationKey);
      expect(scene.abi?.receiptIdentity).toBe(direct.abi?.receiptIdentity);
      expect(scene.entry).toBe('vs_scene_index');
      const shadowContext = shadow[0]?.context;
      expect(shadowContext).toBeDefined();
      if (shadowContext === undefined) return;
      const shadowDirect = selectMaterialPassProgram(
        projection,
        'Occluder',
        shadowContext,
        'direct',
      );
      const shadowScene = selectMaterialPassProgram(
        projection,
        'Occluder',
        shadowContext,
        'scene-index',
      );
      expect(shadowScene.abi?.receiptIdentity).toBe(shadowDirect.abi?.receiptIdentity);
      expect(shadowScene.entry).toBe('vs_scene_index');
      // The Engine shadow wrapper exposes a different fragment entry, but a
      // Surface-backed Standard pass still owns the same geometry/material
      // ABI as its forward scene-index sibling. A full-custom shadow program
      // remains free to publish an independent receipt.
      expect(shadowScene.abi?.receiptIdentity).toBe(scene.abi?.receiptIdentity);
      expect(shadowScene.abi?.vertexInputs).toEqual(scene.abi?.vertexInputs);
      const resolved = runtimeAssets(registry).borrow<MaterialAsset>(loaded.unwrap()).unwrap();
      const keys = materialProgramKeysForMaterial(resolved, registry, context);
      expect(keys?.Forward).toBe(direct.specializationKey);
      const sceneKeys = materialSceneIndexProgramKeysForMaterial(resolved, registry, context);
      expect(sceneKeys?.Forward).toMatchObject({
        specializationKey: scene.specializationKey,
        pass: 'forward',
      });
      expect(sceneKeys?.Occluder).toMatchObject({
        specializationKey: shadowScene.specializationKey,
        pass: 'shadow',
      });
      expect(registry.getMaterialArtifact(scene.specializationKey)).toBeDefined();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = previousFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
