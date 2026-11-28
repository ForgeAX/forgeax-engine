import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { selectMaterialPassProgram } from '@forgeax/engine-assets-runtime';
import type { RenderFeatureExtractContext } from '@forgeax/engine-render';
import {
  type RenderFeature,
  type RenderFeatureWork,
  waterGerstnerSurfaceBindings,
} from '@forgeax/engine-render';
import { type AssetHandle, ok } from '@forgeax/engine-types';
import type { WaterBodySnapshot, WaterSystem } from '@forgeax/engine-water';
import { WATER_SYSTEM_RESOURCE } from '../runtime-resources.js';
import { type WaterGerstnerSurfaceSource, waterGerstnerSurfaceSource } from '../surface-source.js';
import {
  DEFAULT_WATER_CAUSTICS_FIELD,
  WATER_CAUSTICS_ADDITIVE_BLEND,
  type WaterCausticsField,
  waterCausticsFieldPass,
  waterCausticsFieldResource,
} from './field.js';

export type WaterCausticsMode = 'off' | 'texture' | 'dynamic';
interface ReadyFrame {
  readonly kind: 'ready';
  readonly mode: WaterCausticsMode;
  readonly sunActive: boolean;
  readonly source: WaterGerstnerSurfaceSource;
  readonly shader: string;
  readonly material: number;
}

/** Current source readiness is explicit; an unavailable source publishes a cleared field. */
type Frame = ReadyFrame | { readonly kind: 'waiting'; readonly mode: WaterCausticsMode };

export interface WaterGerstnerCausticsOptions {
  readonly identity?: string;
  readonly field?: WaterCausticsField;
}

/** Gerstner adapter for the shared Water optical field. The scene selects its Body and sun. */
export function createWaterGerstnerCausticsFeature(options: WaterGerstnerCausticsOptions = {}) {
  const identity = options.identity ?? 'water-caustics';
  const fieldDescription = options.field ?? DEFAULT_WATER_CAUSTICS_FIELD;
  let input:
    | {
        assets: AssetRegistry;
        material: AssetHandle<'material'>;
        body: (context: RenderFeatureExtractContext) => WaterBodySnapshot | undefined;
        mode: () => WaterCausticsMode;
        sunActive: () => boolean;
      }
    | undefined;
  let submissions = 0;
  let lastSubmitted: { submission: number; mode: WaterCausticsMode; bodyKey: string } | undefined;
  const feature: RenderFeature<Frame | undefined> = {
    identity,
    placement: 'environment',
    extract(context) {
      if (input === undefined) return ok(undefined);
      if (context.materialContext === undefined) return ok({ kind: 'waiting', mode: input.mode() });
      const body = input.body(context);
      if (body === undefined) return ok({ kind: 'waiting', mode: input.mode() });
      // Let the ordinary Water owners publish their geometry receipt
      // before a dependent producer requests that branch. Until then, the field
      // is explicitly cleared, so its receiver cannot block Water admission.
      const water = context.world.getResource<WaterSystem>(WATER_SYSTEM_RESOURCE);
      const admitted = context.views.some((view) =>
        water
          .waterMeshOwnerRoster(view.identity)
          .some(
            (owner) =>
              owner.bodyGuid === body.guid &&
              owner.bodyGeneration === body.sceneGeneration &&
              body.binding.kind === 'bound' &&
              owner.zoneGeneration === body.binding.zoneGeneration,
          ),
      );
      if (!admitted) return ok({ kind: 'waiting', mode: input.mode() });
      const source = waterGerstnerSurfaceSource(context.world.identity, body);
      if (!source.ok) return ok({ kind: 'waiting', mode: input.mode() });
      const projection = input.assets.getMaterialProjection(input.material).unwrap();
      if (projection === undefined) return ok({ kind: 'waiting', mode: input.mode() });
      const selected = selectMaterialPassProgram(projection, 'Forward', context.materialContext);
      return ok({
        kind: 'ready',
        sunActive: input.sunActive(),
        mode: input.mode(),
        source: source.value,
        shader: selected.specializationKey,
        material: Number(input.material),
      });
    },
    assetDependencies: (frame) => (frame?.kind === 'ready' ? [frame.material] : []),
    plan(frame, context) {
      if (frame === undefined) return ok({ work: [] });
      const contract =
        frame.kind === 'ready' ? context.materialShaderBindingContract?.(frame.shader) : undefined;
      const work: RenderFeatureWork[] = [];
      for (const view of context.views) {
        if (!view.render) continue;
        const field = waterCausticsFieldResource(fieldDescription);
        if (
          frame.kind !== 'ready' ||
          frame.mode === 'off' ||
          !frame.sunActive ||
          contract === undefined
        ) {
          work.push({
            scope: { view: view.identity },
            resources: [field],
            passes: [
              waterCausticsFieldPass({
                field: fieldDescription,
                name: `${identity}-neutral-field`,
                program: 'field-program',
                bindings: [],
                mode: 'off',
              }),
            ],
          });
          continue;
        }
        const bindings = waterGerstnerSurfaceBindings({
          name: 'wave-frame',
          program: 'field-program',
          viewIdentity: view.identity,
          source: frame.source,
          contract,
        });
        if (!bindings.ok) return bindings;
        work.push({
          scope: { view: view.identity },
          resources: [
            field,
            {
              kind: 'graphics-program',
              name: 'field-program',
              program: {
                shader: frame.shader,
                vertexLayout: 'none',
                colorFormats: ['rgba16float'],
                preparePipelines: true,
                renderState: {
                  cullMode: 'none',
                  depthWriteEnabled: false,
                  blend: WATER_CAUSTICS_ADDITIVE_BLEND,
                },
              },
            },
            {
              kind: 'graphics-bindings',
              name: 'field-material',
              program: 'field-program',
              values: { group: 1, material: { world: 0, handle: frame.material } },
            },
            bindings.value,
          ],
          passes: [
            waterCausticsFieldPass({
              field: fieldDescription,
              name: `${identity}-forward-field`,
              program: 'field-program',
              bindings: ['field-material', 'wave-frame'],
              mode: frame.mode,
            }),
          ],
        });
      }
      return ok({ work });
    },
    onFrameSubmitted(frame, submission) {
      if (frame !== undefined && frame.kind === 'ready' && submission !== undefined)
        lastSubmitted = {
          submission: ++submissions,
          mode: frame.mode,
          bodyKey: frame.source.bodyKey,
        };
    },
  };
  return {
    feature,
    configure(value: NonNullable<typeof input>) {
      input = value;
    },
    readState: () => ({
      lastSubmitted,
      field: fieldDescription.name,
      size: fieldDescription.resolution,
      sourceCells: fieldDescription.sourceGrid * fieldDescription.sourceGrid,
    }),
  };
}
