import { isStandardRootModule } from '@forgeax/engine-pack';
import {
  type CookedMaterialRecord,
  createMaterialArtifactDigest,
  createMaterialProgramSetDigest,
  type MaterialCookProgram,
  type MaterialCookRasterContext,
} from '@forgeax/engine-pack/material-cook';
import {
  deriveStandardLayerPlan,
  type MaterialParameter,
  type MaterialPass,
  type MaterialSurfaceDeclaration,
  type MaterialValue,
} from '@forgeax/engine-types';
import type { MaterialPublication, MaterialReady } from '../../material/loader.js';

const FIXTURE_ABI = {
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_scene_index',
  materialRow: { addressUnitBytes: 16, byteLength: 16, fields: [] },
  resourceSlots: [],
  uvSets: [],
  vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
  alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
  reflection: {
    layoutIdentity: 'layout',
    resourceSlots: [],
    vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
  },
  receiptIdentity: 'layout',
  generation: 1,
} as const;

export const MATERIAL_CONTEXT: MaterialCookRasterContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
};
/** The direct and scene-index selections every raster program of a cooked record carries. */
export function fixtureSelections(pass: string, context: MaterialCookRasterContext) {
  return (['direct', 'scene-index'] as const).map((address) => ({
    pass,
    context,
    address,
    entry: address === 'direct' ? 'vs_main' : 'vs_scene_index',
    abi: FIXTURE_ABI,
  }));
}
/** Loader fixture: deterministic bytes, not a GPU shader compilation fixture. */
export function materialRecordFixture(
  options: {
    guid?: string;
    specializationKey?: string;
    generation?: number;
    passes?: readonly MaterialPass[];
    parameters?: readonly MaterialParameter[];
    values?: Readonly<Record<string, MaterialValue | null>>;
    surface?: MaterialSurfaceDeclaration;
    contexts?: readonly MaterialCookRasterContext[];
    programs?: readonly MaterialCookProgram[];
    sourceClosure?: readonly string[];
  } = {},
): MaterialReady['record'] {
  const guid = options.guid ?? '019f0000-0000-7000-8000-000000000701';
  const generation = options.generation ?? 7;
  const passes = options.passes ?? [{ name: 'Forward', program: { module: 'game::ready' } }];
  const parameters = options.parameters ?? [];
  const values = options.values ?? {};
  const surface = options.surface;
  const programs =
    options.programs ??
    (options.contexts ?? [MATERIAL_CONTEXT]).flatMap((context) =>
      [...new Set(passes.map((pass) => pass.program.module))].map((module) => {
        const bytes = new TextEncoder().encode(
          `published ${module} ${context.backend}/${context.capability}`,
        );
        const digest = createMaterialArtifactDigest(bytes);
        return {
          specializationKey: `program/${digest}`,
          artifact: {
            mediaType: 'text/wgsl',
            path: `materials/${digest.slice(7)}.wgsl`,
            digest,
            bytes,
          },
          selections: passes
            .filter((pass) => pass.program.module === module)
            .flatMap((pass) =>
              fixtureSelections(pass.name, {
                ...context,
                pass: /shadow/i.test(pass.name) ? 'shadow' : context.pass,
              }),
            ),
        };
      }),
    );
  const artifactDigest = createMaterialProgramSetDigest(programs, passes);
  const sourceClosure = options.sourceClosure ?? ['material.json', 'shader.wgsl'];
  const standard = passes.some((pass) => isStandardRootModule(pass.program.module));
  return {
    schemaVersion: 'material-cook/5',
    guid,
    materialGuid: guid,
    publicationGeneration: generation,
    specializationKey: options.specializationKey ?? 'publication/ready',
    artifactDigest,
    sourceClosure,
    parameterContract: { parameters, values },
    resolved: {
      passes,
      parameters,
      values,
      ...(surface === undefined ? {} : { surface }),
    },
    refs: { parent: [], textures: [], samplers: [], modules: [] },
    programs,
    receipt: {
      schemaVersion: 'material-cook/5',
      sourceClosure,
      profile: 'webgpu/v1',
      compilerVersion: 'fixture/1',
      identity: {
        materialContractDigest: 'contract',
        sourceRevision: 'source',
        sourceClosureDigest: 'closure',
        layoutIdentity: 'layout',
        programIdentity: 'program',
        pipelineIdentity: 'pipeline',
        materialPublicationIdentity: 'publication',
        cookIdentity: 'cook',
        compilerFingerprint: 'compiler',
        wasm: { sourceContentKey: 'source', artifactSha256: 'artifact', glueSha256: 'glue' },
        artifactDigest,
        valueGeneration: generation,
        dependencyGeneration: generation,
        cookGeneration: generation,
      },
      derivedInterface: {
        layoutIdentity: 'layout',
        ...(standard
          ? { layerPlanIdentity: deriveStandardLayerPlan(parameters, passes).identity }
          : {}),
      },
    },
  };
}
export function materialPublicationFixture(
  record: CookedMaterialRecord = materialRecordFixture(),
): MaterialPublication {
  return {
    guid: record.guid,
    record,
    artifacts: Object.fromEntries(
      record.programs.map(({ artifact }) => [
        artifact.path,
        { bytes: new Uint8Array(artifact.bytes) },
      ]),
    ),
  };
}
