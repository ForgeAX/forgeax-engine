import {
  err,
  ok,
  type Result,
  type WaterBrushActor,
  type WaterBrushActorRules,
  type WaterBrushBodyActor,
  type WaterBrushLegacyActor,
  type WaterBrushRecipeAsset,
  type WaterBrushTerrainCapture,
} from '@forgeax/engine-types';
import type { WaterError } from './contracts.js';
import { validateWaterAsset } from './validate.js';

export type WaterBrushRecipeV0 = Omit<
  WaterBrushRecipeAsset,
  'actorVersion' | 'terrainCapture' | 'orderedActors'
> & {
  readonly actorVersion?: 0;
  readonly terrainCapture?: WaterBrushTerrainCapture;
  readonly orderedActors: readonly WaterBrushLegacyActor[];
};

export type WaterBrushLegacyActorResolution = Pick<
  WaterBrushBodyActor,
  'bodyGuid' | 'bodyType' | 'fullName'
>;

function defaults(
  recipe: WaterBrushRecipeV0,
  weightLayer: string,
  weight: number,
): WaterBrushActorRules {
  return {
    falloff: {
      mode: 'width',
      widthM: recipe.rules.falloff.widthM,
      angleDegrees: 0,
      edgeOffsetM: 0,
      zOffsetM: 0,
    },
    blend: { type: recipe.rules.blend.type as WaterBrushActorRules['blend']['type'] },
    blurring: { enabled: false, radiusPx: 0 },
    curlNoise: { firstAmount: 0, firstTiling: 0, secondAmount: 0, secondTiling: 0 },
    curves: { useCurveChannel: false, channelEdgeOffsetM: 0, channelDepthM: 0, curveRampWidthM: 0 },
    displacement: {
      enabled: false,
      heightM: 0,
      textureTiling: 0,
      midpoint: 0.5,
      channel: 0,
      weightmapInfluence: 0,
    },
    smoothBlending: { innerDistanceM: 0, outerDistanceM: 0 },
    terracing: { alpha: 0, spacingM: 0, smoothness: 0, maskLengthM: 0, maskStartOffsetM: 0 },
    weightSettings: [
      {
        layerName: weightLayer,
        falloffWidthM: recipe.rules.falloff.widthM,
        edgeOffsetM: 0,
        textureTiling: 0,
        textureInfluence: 0,
        midpoint: 0.5,
        finalOpacity: weight,
      },
    ],
  };
}

function legacyRuleError(recipe: WaterBrushRecipeV0): WaterError | undefined {
  const unrepresentable = (expected: string, hint: string): WaterError => ({
    code: 'invalid-source',
    expected,
    hint,
  });
  if (recipe.rules.falloff.type === 'angle')
    return unrepresentable(
      'explicit angleDegrees for each legacy actor before v1 migration',
      'legacy falloff angle does not store the angle value; author it explicitly rather than migrating a fabricated 0-degree default',
    );
  if (recipe.rules.falloff.type !== 'width')
    return unrepresentable(
      'legacy falloff type width before v1 migration',
      'legacy falloff type cannot be represented by actor rules; author a typed v1 actor rule',
    );
  if (recipe.rules.falloff.strength !== 1)
    return unrepresentable(
      'legacy falloff strength 1 before v1 migration',
      'v1 falloff has no global strength multiplier; preserve the old recipe or author per-actor settings',
    );
  if (!['alpha', 'min', 'max', 'additive'].includes(recipe.rules.blend.type))
    return unrepresentable(
      'legacy blend type alpha, min, max or additive',
      'the legacy blend mode cannot be represented by actor rules',
    );
  if (recipe.rules.blend.alpha !== 1)
    return unrepresentable(
      'legacy blend alpha 1 before v1 migration',
      'v1 actor blend modes do not store a separate global alpha',
    );
  if (
    recipe.rules.heightRules.mode !== 'offset' ||
    recipe.rules.heightRules.offsetM !== 0 ||
    recipe.rules.heightRules.velocityMPerSec !== 0
  )
    return unrepresentable(
      'neutral legacy height rules (offset mode, zero offset and velocity)',
      'v1 WaterBrush reads body height/velocity from captured source geometry and has no global height adjustment fields',
    );
  if (recipe.rules.weightRules.blend !== 'add' && recipe.rules.weightRules.blend !== 'additive')
    return unrepresentable(
      'legacy additive weight blend before v1 migration',
      'WaterBrush weights use additive composition; replacement cannot be represented by actor weight settings',
    );
  return undefined;
}

function migrateLegacyActors(
  recipe: WaterBrushRecipeV0,
  sourceBodyGuids: Set<string>,
  resolveActor: (sourceKey: string) => WaterBrushLegacyActorResolution | undefined,
): Result<WaterBrushActor[], WaterError> {
  const orderedActors: WaterBrushActor[] = [];
  for (const actor of recipe.orderedActors as readonly unknown[]) {
    if (typeof actor === 'string') {
      const resolved = resolveActor(actor);
      if (!resolved)
        return err({
          code: 'missing-dependency',
          expected:
            'resolved Body identity, kind, full name and GUID for legacy orderedActors sourceKey',
          hint: 'supply the Pack sourceKey-to-Body resolver before migrating',
          detail: actor,
        });
      sourceBodyGuids.add(resolved.bodyGuid);
      const body: WaterBrushBodyActor = {
        kind: 'body',
        actorId: actor,
        ...resolved,
        rules: defaults(recipe, recipe.rules.weightRules.layer, recipe.rules.weightRules.value),
      };
      orderedActors.push(body);
    } else if (
      actor &&
      typeof actor === 'object' &&
      (actor as { kind?: unknown }).kind === 'island' &&
      'terrainRules' in actor
    ) {
      const island = actor as Extract<WaterBrushLegacyActor, { kind: 'island' }>;
      orderedActors.push({
        kind: 'island',
        actorId: island.actorId ?? island.sourceKey,
        fullName: island.fullName ?? island.sourceKey,
        sourceKey: island.sourceKey,
        heightOffsetM: island.heightOffsetM ?? island.terrainRules.heightOffsetM,
        spline: island.spline,
        rules:
          island.rules ??
          defaults(recipe, island.terrainRules.weightLayer, island.terrainRules.weightValue),
      });
    } else
      return err({
        code: 'invalid-source',
        expected: 'legacy source-key or Island actor in BrushRecipe v0',
        hint: 'migrate typed v1 Body records separately; a v0 Body record is malformed',
        detail: actor,
      });
  }
  return ok(orderedActors);
}

/** Migrate legacy source-key actors to stable, typed actor records before cooking. */
export function migrateWaterBrushRecipeV0ToV1(
  recipe: WaterBrushRecipeV0,
  terrainCapture: WaterBrushTerrainCapture,
  resolveActor: (sourceKey: string) => WaterBrushLegacyActorResolution | undefined,
): Result<WaterBrushRecipeAsset, WaterError> {
  if (!recipe || recipe.kind !== 'water-brush-recipe' || !Array.isArray(recipe.orderedActors))
    return err({
      code: 'invalid-source',
      expected: 'WaterBrushRecipe v0 with an actor list',
      hint: 'supply a legacy source-key or Island actor list',
    });
  if (recipe.actorVersion !== undefined && recipe.actorVersion !== 0)
    return err({
      code: 'invalid-source',
      expected: 'WaterBrushRecipe actorVersion 0 for migration',
      hint: 'only migrate legacy v0 actor references with this function',
    });
  const checkedLegacy = validateWaterAsset({ ...recipe, terrainCapture });
  if (!checkedLegacy.ok || checkedLegacy.value.kind !== 'water-brush-recipe')
    return err({
      code: 'invalid-source',
      expected: 'structurally valid WaterBrushRecipe v0 before reading legacy defaults',
      hint: 'repair the legacy rule and actor records before migration',
      detail: checkedLegacy.ok ? checkedLegacy.value.kind : checkedLegacy.error,
    });
  const ruleError = legacyRuleError(recipe);
  if (ruleError) return err(ruleError);
  const sourceBodyGuids = new Set(recipe.sourceBodyGuids);
  const actors = migrateLegacyActors(recipe, sourceBodyGuids, resolveActor);
  if (!actors.ok) return err(actors.error);
  const [neutralLayer] = Object.keys(terrainCapture.layerNameToIndex);
  if (neutralLayer === undefined)
    return err({
      code: 'invalid-source',
      expected: 'captured Terrain weight layer before migration',
      hint: 'provide a nonempty Terrain layer mapping',
    });
  const migrated: WaterBrushRecipeAsset = {
    ...recipe,
    actorVersion: 1,
    terrainCapture,
    sourceBodyGuids: [...sourceBodyGuids],
    orderedActors: actors.value,
    rules: {
      falloff: { type: 'width', widthM: 0, strength: 1 },
      blend: { type: 'alpha', alpha: 1 },
      heightRules: { mode: 'offset', offsetM: 0, velocityMPerSec: 0 },
      weightRules: { layer: neutralLayer, value: 0, blend: 'additive' },
    },
  };
  const checked = validateWaterAsset(migrated);
  if (!checked.ok || checked.value.kind !== 'water-brush-recipe')
    return err({
      code: 'invalid-source',
      expected: 'valid v1 typed WaterBrushRecipe after legacy migration',
      hint: 'repair actor refs, rules and Terrain layer mapping before migration',
      detail: checked.ok ? checked.value.kind : checked.error,
    });
  return ok(migrated);
}
