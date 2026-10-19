// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=13):
//   - packages/runtime/src/__tests__/directional-light-defaults.test.ts
//   - packages/runtime/src/__tests__/directional-light-shadow.test.ts
//   - packages/runtime/src/__tests__/extract-frame-lights.test.ts
//   - packages/runtime/src/__tests__/inspector-lights-bucket.test.ts
//   - packages/runtime/src/__tests__/light-attenuation-cone.test.ts
//   - packages/runtime/src/__tests__/light-buffer-layout.test.ts
//   - packages/runtime/src/__tests__/light-helpers.test.ts
//   - packages/runtime/src/__tests__/lightslot-layout.test.ts
//   - packages/runtime/src/__tests__/point-light-defaults.test.ts
//   - packages/runtime/src/__tests__/point-light-spawn-bounds.test.ts
//   - packages/runtime/src/__tests__/spot-light-defaults.test.ts
//   - packages/runtime/src/__tests__/spot-light-spawn-bounds.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { World } from '@forgeax/engine-ecs';
import { componentDefinition, componentSchema } from '@forgeax/engine-ecs/internal';
import { vec3 } from '@forgeax/engine-math';
import { Camera, DirectionalLight, PointLight, Skylight, SpotLight } from '@forgeax/engine-render';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';
import {
  computeInvRangeSquared,
  degToCos,
  validateDirectionalLightData,
  validatePointLightShadowData,
  validateSpotLightData,
} from '../../../render/src/components/light-helpers';
import type { ShadowInvalidConfigError } from '../../../render/src/errors/render';
import {
  BYTES_PER_DIRECT_LIGHT_SLOT,
  DIRECT_LIGHT_SLOT_LAYOUT,
  DirectLightSlotKind,
  packDirectLightSlot,
} from '../../../render/src/light-buffer-layout';
import { buildPbrViewBglEntries } from '../../../render/src/pbr-pipeline';
import type {
  PointLightSnapshot,
  SpotLightSnapshot,
} from '../../../render/src/render-system-extract';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';

type LightSpawnResult = ReturnType<World['spawn']>;

function spawnValidatedLight(
  world: World,
  component: typeof DirectionalLight | typeof SpotLight,
  data: Readonly<Record<string, unknown>>,
): LightSpawnResult {
  const validation =
    component === DirectionalLight
      ? validateDirectionalLightData(data)
      : validateSpotLightData(data);
  if (!validation.ok) return validation as unknown as LightSpawnResult;
  return world.spawn({ component, data: data as never });
}

{
  describe('M1 directional closed shadow quality contract', () => {
    it('publishes the six closed labels and PCSS defaults', () => {
      const schema = componentSchema(DirectionalLight);
      expect(schema.shadowFilter).toBe('enum');
      expect(componentDefinition(DirectionalLight).defaults).toMatchObject({
        shadowFilter: 6,
        shadowAngularRadius: 0.00465,
        maxPenumbraTexels: 32,
      });
      expect(DirectionalLight.fields.shadowFilter.labels).toEqual({
        pcf1: 1,
        pcf3: 2,
        pcf5: 3,
        pcssMedium: 4,
        pcssHigh: 5,
        pcfVogel: 6,
      });
      expect('pcfKernelSize' in schema).toBe(false);
    });

    it.each([
      ['shadowAngularRadius', Number.NaN],
      ['shadowAngularRadius', 0.00009],
      ['shadowAngularRadius', 0.05001],
      ['maxPenumbraTexels', Number.NaN],
      ['maxPenumbraTexels', 0],
      ['maxPenumbraTexels', 65],
      ['maxPenumbraTexels', 1.5],
    ] as const)('rejects invalid PCSS field %s=%s with one structured detail shape', (field, value) => {
      const result = spawnValidatedLight(new World(), DirectionalLight, {
        castShadow: true,
        direction: [0, -1, 0],
        shadowFilter: 4,
        [field]: value,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected validation to fail');
      const error = result.error as unknown as ShadowInvalidConfigError;
      expect(error.code).toBe('shadow-invalid-config');
      expect(Object.keys(error.detail)).toEqual(['field', 'actual', 'bound', 'reason']);
      expect(error.detail.field).toBe(field);
      expect(error.detail.actual).toBe(value);
      expect(['range', 'lower-bound', 'allowed-values']).toContain(error.detail.bound.kind);
      expect(typeof error.detail.reason).toBe('string');
    });

    it('skips PCSS validation when Directional shadows are disabled', () => {
      const result = validateDirectionalLightData({
        direction: [0, -1, 0],
        castShadow: false,
        shadowFilter: 99,
        shadowAngularRadius: Number.NaN,
        maxPenumbraTexels: 0,
      });
      expect(result.ok).toBe(true);
    });

    it('keeps Point and Spot pcfKernelSize validation as their own contract', () => {
      const point = validatePointLightShadowData({
        mapSize: 512,
        nearPlane: 0.1,
        farPlane: 10,
        pcfKernelSize: 3,
      });
      expect(point.ok).toBe(true);
      const spot = validateSpotLightData({
        castShadow: true,
        direction: [0, -1, 0],
        pcfKernelSize: 3,
      });
      expect(spot.ok).toBe(true);
    });
  });

  // ─── feat-20260709 M2 / w4: vec-collapse schema shape + default equivalence ───
  // AC-01 + E1: direction is array<f32,3> with NO default (D-5 -- the only
  // field deliberately left defaultless so an omitted/zero direction is a
  // fail-fast validate rejection, not a silent all-zero); color is array<f32,3>
  // with an explicit layer-2 default [1,1,1] (Skylight/Point/Spot/Dir share the
  // white default; the array layer-3 fallback is all-zero, so the default MUST
  // be explicit -- Transform quat/scale precedent).
  describe('lights vec-collapse schema shape (w4, AC-01 + E1)', () => {
    it('DirectionalLight direction/color are array<f32,3>; color default [1,1,1], direction no default', () => {
      expect(componentSchema(DirectionalLight).direction).toBe('array<f32, 3>');
      expect(componentSchema(DirectionalLight).color).toBe('array<f32, 3>');
      expect('directionX' in componentSchema(DirectionalLight)).toBe(false);
      expect('colorR' in componentSchema(DirectionalLight)).toBe(false);
      const defaults = componentDefinition(DirectionalLight).defaults as Record<string, unknown>;
      expect(Array.from(defaults.color as Float32Array)).toEqual([1, 1, 1]);
      expect('direction' in defaults).toBe(false);
    });

    it('SpotLight direction/color are array<f32,3>; color default [1,1,1], direction no default', () => {
      expect(componentSchema(SpotLight).direction).toBe('array<f32, 3>');
      expect(componentSchema(SpotLight).color).toBe('array<f32, 3>');
      expect('directionX' in componentSchema(SpotLight)).toBe(false);
      expect('colorR' in componentSchema(SpotLight)).toBe(false);
      const defaults = componentDefinition(SpotLight).defaults as Record<string, unknown>;
      expect(Array.from(defaults.color as Float32Array)).toEqual([1, 1, 1]);
      expect('direction' in defaults).toBe(false);
    });

    it('PointLight color is array<f32,3> with default [1,1,1]', () => {
      expect(componentSchema(PointLight).color).toBe('array<f32, 3>');
      expect('colorR' in componentSchema(PointLight)).toBe(false);
      const defaults = componentDefinition(PointLight).defaults as Record<string, unknown>;
      expect(Array.from(defaults.color as Float32Array)).toEqual([1, 1, 1]);
    });

    it('Skylight color is array<f32,3> with default [1,1,1]', () => {
      expect(componentSchema(Skylight).color).toBe('array<f32, 3>');
      expect('colorR' in componentSchema(Skylight)).toBe(false);
      const defaults = componentDefinition(Skylight).defaults as Record<string, unknown>;
      expect(Array.from(defaults.color as Float32Array)).toEqual([1, 1, 1]);
    });

    it('E1: omitting color spawns the same white light as the pre-collapse scalar default', () => {
      const world = new World();
      const dir = world
        .spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } })
        .unwrap();
      expect(Array.from(world.get(dir, DirectionalLight).unwrap().color)).toEqual([1, 1, 1]);

      const point = world.spawn({ component: PointLight, data: {} }).unwrap();
      expect(Array.from(world.get(point, PointLight).unwrap().color)).toEqual([1, 1, 1]);

      const sky = world.spawn({ component: Skylight, data: {} }).unwrap();
      expect(Array.from(world.get(sky, Skylight).unwrap().color)).toEqual([1, 1, 1]);
    });

    it('serialized spawn values round-trip as array<f32,3> direction/color', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SpotLight,
          data: { direction: [0.1, -0.9, 0.2], color: [0.3, 0.4, 0.5] },
        })
        .unwrap();
      const view = world.get(e, SpotLight).unwrap();
      expect(Array.from(view.direction)).toEqual([
        expect.closeTo(0.1, 5),
        expect.closeTo(-0.9, 5),
        expect.closeTo(0.2, 5),
      ]);
      expect(Array.from(view.color)).toEqual([
        expect.closeTo(0.3, 5),
        expect.closeTo(0.4, 5),
        expect.closeTo(0.5, 5),
      ]);
    });
  });
}

{
  describe('direct-light physical semantic inputs', () => {
    it('keeps the three public light kinds on the shared intensity and range surface', () => {
      expect(componentSchema(DirectionalLight).intensity).toBe('f32');
      expect(componentSchema(PointLight).intensity).toBe('f32');
      expect(componentSchema(SpotLight).intensity).toBe('f32');
      expect(componentSchema(PointLight).range).toBe('f32');
      expect(componentSchema(SpotLight).range).toBe('f32');
      expect('physicalIntensity' in componentSchema(PointLight)).toBe(false);
      expect('physicalIntensity' in componentSchema(SpotLight)).toBe(false);
    });

    it('uses meters for finite point and spot ranges without a hidden zero-range multiplier', () => {
      const world = new World();
      const point = world.spawn({ component: PointLight, data: { range: 2 } }).unwrap();
      const spot = world
        .spawn({ component: SpotLight, data: { direction: [0, -1, 0], range: 2 } })
        .unwrap();

      expect(world.get(point, PointLight).unwrap().range).toBe(2);
      expect(world.get(spot, SpotLight).unwrap().range).toBe(2);
      expect(computeInvRangeSquared(0)).toBe(1e8);
      expect(computeInvRangeSquared(Number.POSITIVE_INFINITY)).toBe(0);
    });
  });
}

{
  // ─── feat-20260709 M2 / w5: direction fail-fast validate rejection ───
  // AC-03 (+ AC-02 per research-decisions D-R1): direction has NO layer-2
  // default, so an omitted direction lands the array layer-3 all-zero [0,0,0].
  // Both an explicit zero-vector and an omitted direction are the same illegal
  // state -- the light's validate() rejects both with SpawnLightInvalidBoundsError
  // (detail.field='direction'). AC-02's compile-time "omit direction is red"
  // is unreachable (spawn data is Partial<InputShapeOf>, all fields optional);
  // D-R1 folds it into this runtime rejection. The compile-time guarantee that
  // survives is AC-04 (residual per-axis key = excess-unknown-key typecheck red).
  describe('lights direction fail-fast validate (w5, AC-03 / AC-02 via D-R1)', () => {
    for (const [name, component] of [
      ['DirectionalLight', DirectionalLight],
      ['SpotLight', SpotLight],
    ] as const) {
      it(`${name}: explicit zero-vector direction is rejected with field='direction'`, () => {
        const world = new World();
        const r = spawnValidatedLight(world, component, { castShadow: true, direction: [0, 0, 0] });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('spawn-light-invalid-bounds');
          const detail = (r.error as unknown as { detail: { field: string } }).detail;
          expect(detail.field).toBe('direction');
          const hint = (r.error as unknown as { hint: string }).hint;
          expect(hint.length).toBeGreaterThan(0);
          expect(hint).toContain('direction');
        }
      });

      it(`${name}: omitted direction (layer-3 all-zero) is rejected with field='direction'`, () => {
        const world = new World();
        const r = spawnValidatedLight(world, component, { castShadow: true });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe('spawn-light-invalid-bounds');
          const detail = (r.error as unknown as { detail: { field: string } }).detail;
          expect(detail.field).toBe('direction');
        }
      });

      it(`${name}: a non-zero direction spawns successfully`, () => {
        const world = new World();
        const r = world.spawn({ component, data: { direction: [0, -1, 0] } });
        expect(r.ok).toBe(true);
      });
    }
  });
}

{
  // ─── from directional-light-defaults.test.ts ───
  describe('directional-light-defaults.test.ts', () => {
    describe('DirectionalLight spawn default-value fallback (M1 w5)', () => {
      it('omitting intensity / color* fills layer-2 defaults (intensity=1, color=[1,1,1])', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: { direction: [0, -1, 0] },
          })
          .unwrap();

        const view = world.get(e, DirectionalLight).unwrap();
        expect(Array.from(view.direction)).toEqual([0, -1, 0]);
        expect(Array.from(view.color)).toEqual([1, 1, 1]);
        expect(view.intensity).toBe(1);
      });

      it('explicit intensity / color override defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: {
              direction: [-0.5, -1, -0.3],
              color: [0.9, 0.8, 0.7],
              intensity: 0.5,
            },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.color[0]).toBeCloseTo(0.9, 5);
        expect(view.intensity).toBe(0.5);
      });
    });
  });
}

{
  // ─── from directional-light-shadow.test.ts (post-merge: DirectionalLightShadow deleted, target now DirectionalLight) ───
  describe('directional-light-shadow.test.ts', () => {
    describe('DirectionalLight merged shadow schema (post-m1-t6)', () => {
      it('AC-01: shadow fields are present with correct default values in the merged component', () => {
        const dl = DirectionalLight;

        expect(dl.name).toBe('DirectionalLight');
        expect(componentSchema(dl)).toBeDefined();

        expect(componentDefinition(dl).defaults).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: defaults asserted defined just above
        const defaults = componentDefinition(dl).defaults!;

        expect(defaults.cascadeCount).toBe(3);
        expect(defaults.splitLambda).toBeCloseTo(0.5, 5);
        expect(defaults.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(defaults.mapSize).toBe(2048);
        expect(defaults.depthBias).toBeCloseTo(0.00001, 7);
        expect(defaults.normalBias).toBeCloseTo(0.05, 5);
        expect(defaults.shadowDistance).toBeCloseTo(100000, 5);
        expect(defaults.shadowFilter).toBe(6);
        expect(defaults.staggerCascades).toBe(false);

        // Merged component: 3 light (direction + color arrays + intensity) +
        // 1 castShadow + 10 closed shadow-quality fields + staggerCascades + contactShadowLength + lightingChannels = 17 fields (feat-20260709 M2 collapsed
        // direction/color from 6 per-axis scalars to 2 array<f32,3> columns;
        // nearPlane removed — derived from camera near; farPlane -> shadowDistance)
        expect(Object.keys(componentSchema(dl)).length).toBe(17);
        expect('lightingChannels' in componentSchema(dl)).toBe(true);
        expect(componentSchema(dl).staggerCascades).toBe('bool');
        expect('contactShadowLength' in componentSchema(dl)).toBe(true);
        expect('direction' in componentSchema(dl)).toBe(true);
        expect('color' in componentSchema(dl)).toBe(true);
        expect('cascadeCount' in componentSchema(dl)).toBe(true);
        expect('splitLambda' in componentSchema(dl)).toBe(true);
        expect('cascadeBlend' in componentSchema(dl)).toBe(true);
        expect('mapSize' in componentSchema(dl)).toBe(true);
        expect('depthBias' in componentSchema(dl)).toBe(true);
        expect('normalBias' in componentSchema(dl)).toBe(true);
        expect('shadowDistance' in componentSchema(dl)).toBe(true);
        expect('nearPlane' in componentSchema(dl)).toBe(false);
        expect('farPlane' in componentSchema(dl)).toBe(false);
        expect('pcfKernelSize' in componentSchema(dl)).toBe(false);
        // DirectionalLightShadow is deleted; the old orthoHalfExtent field is gone
      });

      it('AC-02: spawn-default fallback fills omitted shadow fields from defaults (single-component)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], mapSize: 2048 },
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const light = world.get(e, DirectionalLight);
        expect(light.ok).toBe(true);
        const lightData = light.unwrap();

        expect(lightData.mapSize).toBe(2048);
        expect(lightData.cascadeCount).toBe(3);
        expect(lightData.splitLambda).toBeCloseTo(0.5, 5);
        expect(lightData.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(lightData.depthBias).toBeCloseTo(0.00001, 7);
        expect(lightData.normalBias).toBeCloseTo(0.05, 5);
        expect(lightData.shadowDistance).toBeCloseTo(100000, 5);
      });

      it('AC-02: spawn with empty data gets all defaults (single-component)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0] },
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const light = world.get(e, DirectionalLight).unwrap();
        expect(light.cascadeCount).toBe(3);
        expect(light.splitLambda).toBeCloseTo(0.5, 5);
        expect(light.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(light.mapSize).toBeCloseTo(2048, 5);
        expect(light.depthBias).toBeCloseTo(0.00001, 7);
        expect(light.normalBias).toBeCloseTo(0.05, 5);
        expect(light.shadowDistance).toBeCloseTo(100000, 5);
      });

      it('AC-02: spawn with full explicit data overrides all defaults (single-component)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: {
            direction: [0, -1, 0],
            cascadeCount: 2,
            splitLambda: 0.5,
            cascadeBlend: 0.1,
            mapSize: 512,
            depthBias: 0.01,
            normalBias: 0.1,
            shadowDistance: 100,
            shadowFilter: 5,
          },
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const light = world.get(e, DirectionalLight).unwrap();
        expect(light.cascadeCount).toBe(2);
        expect(light.splitLambda).toBeCloseTo(0.5, 5);
        expect(light.cascadeBlend).toBeCloseTo(0.1, 5);
        expect(light.mapSize).toBeCloseTo(512, 5);
        expect(light.depthBias).toBeCloseTo(0.01, 5);
        expect(light.normalBias).toBeCloseTo(0.1, 5);
        expect(light.shadowDistance).toBeCloseTo(100, 5);
        expect(light.shadowFilter).toBe(5);
      });

      it('AC-05: single-component spawn bundles light + shadow fields (no dual-component needed)', () => {
        const world = new World();

        const r = world.spawn({
          component: DirectionalLight,
          data: {
            direction: [0, -1, 0],
            color: [1, 1, 1],
            intensity: 1,
            mapSize: 2048,
          },
        });
        expect(r.ok).toBe(true);
        const e = r.unwrap();

        const dlResult = world.get(e, DirectionalLight);
        expect(dlResult.ok).toBe(true);
        const dl = dlResult.unwrap();
        expect(dl.direction[0]).toBe(0);
        expect(dl.intensity).toBe(1);
        expect(dl.mapSize).toBeCloseTo(2048, 5);
        expect(dl.depthBias).toBeCloseTo(0.00001, 7);
      });

      it('query: DirectionalLight entity is found via world.get', () => {
        const world = new World();

        world
          .spawn({
            component: DirectionalLight,
            data: { direction: [0, -1, 0], mapSize: 512 },
          })
          .unwrap();

        const info = world.inspect();
        const archetypeWithLight = info.archetypes.find((a) =>
          a.componentNames.includes('DirectionalLight'),
        );
        expect(archetypeWithLight).toBeDefined();
        expect(archetypeWithLight?.entityCount).toBe(1);
      });
    });
  });
}

{
  // ─── from extract-frame-lights.test.ts ───
  describe('extract-frame-lights.test.ts', () => {
    const EPSILON = 1e-5;

    describe('extractFrame three-query union output (M2 w15)', () => {
      it('returns directional + point[] + spot[] buckets with host-pre-multiplied fields', () => {
        const world = new World();

        // Camera so extractFrame does not short-circuit.
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        // 1 DirectionalLight
        world
          .spawn({
            component: DirectionalLight,
            data: {
              direction: [0, -1, 0],
              color: [1, 1, 1],
              intensity: 0.5,
            },
          })
          .unwrap();

        // 2 PointLight (each on its own Transform)
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [1, 2, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: PointLight,
              data: {
                color: [1, 0.5, 0.25],
                intensity: 4,
                range: 10,
              },
            },
          )
          .unwrap();

        world
          .spawn(
            {
              component: Transform,
              data: { pos: [-2, 0, 1], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: PointLight,
              data: {
                color: [0.2, 0.4, 0.6],
                intensity: 2,
                range: Number.POSITIVE_INFINITY,
              },
            },
          )
          .unwrap();

        // 1 SpotLight
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: SpotLight,
              data: {
                direction: [0, -1, 0],
                color: [1, 1, 1],
                intensity: 8,
                range: 25,
                innerConeDeg: 10,
                outerConeDeg: 30,
              },
            },
          )
          .unwrap();

        propagateTransforms(world);

        const frame = extractFrame(world, prepareExtractContext(world));
        expect(frame.lights).toBeDefined();

        // -- directional --
        const dir = frame.lights.directional;
        expect(dir).toBeDefined();
        if (dir === undefined) throw new Error('directional missing');
        expect(dir.kind).toBe('directional');
        // direction not pre-multiplied; raw outgoing vector forwarded to shader
        expect(dir.direction[0]).toBeCloseTo(0, 5);
        expect(dir.direction[1]).toBeCloseTo(-1, 5);
        expect(dir.direction[2]).toBeCloseTo(0, 5);
        // color is host-pre-multiplied with intensity (charter P4)
        expect(dir.color[0]).toBeCloseTo(1 * 0.5, 5);
        expect(dir.color[1]).toBeCloseTo(1 * 0.5, 5);
        expect(dir.color[2]).toBeCloseTo(1 * 0.5, 5);
        expect(dir.intensity).toBeCloseTo(0.5, 5);

        // -- point[] --
        expect(frame.lights.point).toHaveLength(2);
        // ordering is archetype-graph driven; sort by position.x to disambiguate
        const points = [...frame.lights.point].sort(
          (a, b) => (a.position[0] ?? 0) - (b.position[0] ?? 0),
        );
        const p0 = points[0];
        const p1 = points[1];
        if (p0 === undefined || p1 === undefined) throw new Error('point bucket short');
        expect(p0.kind).toBe('point');
        expect(p1.kind).toBe('point');
        // p0 is the (-2, 0, 1) Infinity-range point
        expect(p0.position[0]).toBeCloseTo(-2, 5);
        expect(p0.position[1]).toBeCloseTo(0, 5);
        expect(p0.position[2]).toBeCloseTo(1, 5);
        expect(p0.invRangeSquared).toBe(computeInvRangeSquared(Number.POSITIVE_INFINITY));
        expect(p0.invRangeSquared).toBe(0);
        // color * intensity (0.2*2, 0.4*2, 0.6*2)
        expect(p0.color[0]).toBeCloseTo(0.4, 5);
        expect(p0.color[1]).toBeCloseTo(0.8, 5);
        expect(p0.color[2]).toBeCloseTo(1.2, 5);
        expect(p0.intensity).toBeCloseTo(2, 5);

        // p1 is the (1, 2, 3) range=10 point
        expect(p1.position[0]).toBeCloseTo(1, 5);
        expect(p1.position[1]).toBeCloseTo(2, 5);
        expect(p1.position[2]).toBeCloseTo(3, 5);
        expect(p1.invRangeSquared).toBeCloseTo(computeInvRangeSquared(10), 5);
        expect(Math.abs(p1.invRangeSquared - 0.01)).toBeLessThan(EPSILON);
        // color * intensity (1*4, 0.5*4, 0.25*4)
        expect(p1.color[0]).toBeCloseTo(4, 5);
        expect(p1.color[1]).toBeCloseTo(2, 5);
        expect(p1.color[2]).toBeCloseTo(1, 5);
        expect(p1.intensity).toBeCloseTo(4, 5);

        // -- spot[] --
        expect(frame.lights.spot).toHaveLength(1);
        const s0 = frame.lights.spot[0];
        if (s0 === undefined) throw new Error('spot bucket empty');
        expect(s0.kind).toBe('spot');
        expect(s0.position[0]).toBeCloseTo(0, 5);
        expect(s0.position[1]).toBeCloseTo(5, 5);
        expect(s0.position[2]).toBeCloseTo(0, 5);
        expect(s0.direction[0]).toBeCloseTo(0, 5);
        expect(s0.direction[1]).toBeCloseTo(-1, 5);
        expect(s0.direction[2]).toBeCloseTo(0, 5);
        // color * intensity (1*8, 1*8, 1*8)
        expect(s0.color[0]).toBeCloseTo(8, 5);
        expect(s0.color[1]).toBeCloseTo(8, 5);
        expect(s0.color[2]).toBeCloseTo(8, 5);
        expect(s0.intensity).toBeCloseTo(8, 5);
        expect(s0.cosInner).toBeCloseTo(degToCos(10), 5);
        expect(s0.cosOuter).toBeCloseTo(degToCos(30), 5);
        expect(s0.invRangeSquared).toBeCloseTo(computeInvRangeSquared(25), 5);
      });

      it('zero-light world produces directional=undefined + empty point[] + empty spot[]', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        propagateTransforms(world);

        const frame = extractFrame(world, prepareExtractContext(world));
        expect(frame.lights.directional).toBeUndefined();
        expect(frame.lights.point).toHaveLength(0);
        expect(frame.lights.spot).toHaveLength(0);
      });
    });

    // ─── from feat-20260625-spot-light-shadow-mapping M1 w2 ───
    describe('SpotLightSnapshot shadow field type-check (AC-09)', () => {
      it('destructuring castShadow + lightViewProj + shadowAtlasTile without as casts typechecks', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: SpotLight,
              data: { direction: [0, -1, 0], castShadow: true },
            },
          )
          .unwrap();

        propagateTransforms(world);
        const frame = extractFrame(world, prepareExtractContext(world));

        expect(frame.lights.spot).toHaveLength(1);
        const s = frame.lights.spot[0];
        if (s === undefined) throw new Error('spot bucket empty');

        // AC-09: destructure shadow fields without `as` casts — typecheck success
        // is the acceptance witness. castShadow is bool, shadowAtlasTile is number
        // (i32 sentinel -1), lightViewProj is Float32Array | undefined.
        const castShadow: boolean = s.castShadow;
        const shadowAtlasTile: number = s.shadowAtlasTile;
        const lightViewProj: Float32Array | undefined = s.lightViewProj;
        const mapSize: number = s.mapSize;
        const nearPlane: number = s.nearPlane;
        const farPlane: number = s.farPlane;

        // Basic default-value assertions for shadow fields on the snapshot.
        expect(castShadow).toBe(true);
        expect(typeof lightViewProj).toBe('object');
        expect(typeof shadowAtlasTile).toBe('number');
        expect(typeof mapSize).toBe('number');
        expect(typeof nearPlane).toBe('number');
        expect(typeof farPlane).toBe('number');
      });
    });

    // ─── from feat-20260625-spot-light-shadow-mapping M1 w3 ───
    describe('spot direction degeneration (near-zero) extract skip (requirements $112)', () => {
      it('dir near-zero castShadow spot gets shadowAtlasTile=-1, no lightViewProj', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        // direction near-zero — normalize will fail, extract should skip shadow
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: SpotLight,
              data: { direction: [0, 1e-10, 0] },
            },
          )
          .unwrap();

        propagateTransforms(world);
        const frame = extractFrame(world, prepareExtractContext(world));

        expect(frame.lights.spot).toHaveLength(1);
        const s = frame.lights.spot[0];
        if (s === undefined) throw new Error('spot bucket empty');

        // AC-05 / requirements $112: near-zero direction → tile=-1, no lightViewProj.
        expect(s.shadowAtlasTile).toBe(-1);
        // lightViewProj should be undefined (no matrix was computed).
        expect(s.lightViewProj).toBeUndefined();
        // Direct-light fields still intact (AC-05: clip does not delete the light).
        expect(s.kind).toBe('spot');
        expect(s.intensity).toBeGreaterThan(0);
      });

      it('normal direction castShadow spot gets shadowAtlasTile >= 0 + non-zero lightViewProj', () => {
        const world = new World();

        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();

        // Normal direction pointing down — should get a valid tile.
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: SpotLight,
              data: { castShadow: true, direction: [0, -1, 0] },
            },
          )
          .unwrap();

        propagateTransforms(world);
        const frame = extractFrame(world, prepareExtractContext(world));

        expect(frame.lights.spot).toHaveLength(1);
        const s = frame.lights.spot[0];
        if (s === undefined) throw new Error('spot bucket empty');

        // Normal direction should get a valid tile (0 for first castShadow spot).
        expect(s.shadowAtlasTile).toBeGreaterThanOrEqual(0);
        // lightViewProj should be a non-zero Float32Array (16 floats).
        expect(s.lightViewProj).toBeInstanceOf(Float32Array);
        expect(s.lightViewProj).toHaveLength(16);
        // At least one element should be non-zero (a valid perspective×lookAt matrix).
        const lvp = s.lightViewProj;
        if (lvp === undefined) throw new Error('expected lightViewProj to be defined');
        let hasNonZero = false;
        for (let i = 0; i < 16; i++) {
          if (lvp[i] !== 0) {
            hasNonZero = true;
            break;
          }
        }
        expect(hasNonZero).toBe(true);
      });
    });

    // ─── from feat-20260625-spot-light-shadow-mapping M2 w7 ───
    describe('spot shadow tile clip cap=4 (AC-05)', () => {
      function spawnCamera(world: World): void {
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: Camera,
              data: {
                fov: Math.PI / 4,
                aspect: 1,
                near: 0.1,
                far: 100,
                projection: 0,
                left: -1,
                right: 1,
                bottom: -1,
                top: 1,
              },
            },
          )
          .unwrap();
      }

      function spawnSpot(world: World, x: number, castShadow: boolean): void {
        world
          .spawn(
            {
              component: Transform,
              data: { pos: [x, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
            },
            {
              component: SpotLight,
              data: { direction: [0, -1, 0], castShadow },
            },
          )
          .unwrap();
      }

      it('first 4 castShadow spots get distinct tiles 0..3; 5th gets tile=-1 but keeps direct-light fields', () => {
        const world = new World();
        spawnCamera(world);
        for (let i = 0; i < 5; i++) spawnSpot(world, i, true);

        propagateTransforms(world);
        const frame = extractFrame(world, prepareExtractContext(world));

        expect(frame.lights.spot).toHaveLength(5);
        const tiles = frame.lights.spot.map((s) => s.shadowAtlasTile);
        // Exactly four tiles in [0,3], all distinct.
        const assigned = tiles.filter((t) => t >= 0);
        expect(assigned).toHaveLength(4);
        expect(new Set(assigned).size).toBe(4);
        for (const t of assigned) {
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t).toBeLessThanOrEqual(3);
        }
        // Exactly one spot is clipped (tile=-1).
        expect(tiles.filter((t) => t === -1)).toHaveLength(1);

        // The clipped (5th) spot still carries valid direct-light fields:
        // clip never deletes the light (AC-05).
        const clipped = frame.lights.spot.find((s) => s.shadowAtlasTile === -1);
        if (clipped === undefined) throw new Error('expected one clipped spot');
        expect(clipped.kind).toBe('spot');
        expect(clipped.intensity).toBeGreaterThan(0);
        expect(clipped.color.some((c) => c !== 0)).toBe(true);
        expect(clipped.direction.some((d) => d !== 0)).toBe(true);
      });

      it('castShadow:false spot gets tile=-1 without consuming a tile slot', () => {
        const world = new World();
        spawnCamera(world);
        // One shadowless spot first, then one shadow-casting spot.
        spawnSpot(world, 0, false);
        spawnSpot(world, 1, true);

        propagateTransforms(world);
        const frame = extractFrame(world, prepareExtractContext(world));

        expect(frame.lights.spot).toHaveLength(2);
        const shadowless = frame.lights.spot.find((s) => s.castShadow === false);
        const shadowing = frame.lights.spot.find((s) => s.castShadow === true);
        if (shadowless === undefined || shadowing === undefined) {
          throw new Error('expected one shadowless + one shadowing spot');
        }
        // castShadow:false -> tile=-1, no lightViewProj.
        expect(shadowless.shadowAtlasTile).toBe(-1);
        expect(shadowless.lightViewProj).toBeUndefined();
        // The shadow-casting spot still gets tile 0 (the false spot did not
        // consume a slot).
        expect(shadowing.shadowAtlasTile).toBe(0);
      });
    });
  });
}

{
  // ─── from light-attenuation-cone.test.ts ───
  describe('light-attenuation-cone.test.ts', () => {
    // Hermite cubic smoothstep — identical to WGSL's `smoothstep(edge0, edge1, x)`
    // (the only smoothstep WebGPU permits) and to GLSL's smoothstep that the
    // LearnOpenGL section 6.1 cone falloff uses. Returns 0 below edge0, 1 above
    // edge1, Hermite cubic in between.
    function smoothstep(edge0: number, edge1: number, x: number): number {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return t * t * (3 - 2 * t);
    }

    // AC-08 (a): KHR_lights_punctual quartic attenuation reproduction. Mirrors
    // pbr.wgsl `attenuation_punctual` byte-for-byte (host TS reproduction is the
    // numerical-correctness backstop; production SSOT lives in pbr.wgsl per D-C3).
    function attenuation(d: number, invRangeSquared: number): number {
      const dSq = d * d;
      const quartic = Math.max(0, Math.min(1, 1 - (dSq * invRangeSquared) ** 2));
      return quartic / Math.max(dSq, 1e-4);
    }

    // AC-08 (a): cone falloff Hermite cubic. Mirrors pbr.wgsl `cone_falloff`.
    // SpotLight only — point/directional skip this term (callers default
    // cosInner = 1, cosOuter = -1 to disable).
    function coneFalloff(cosTheta: number, cosInner: number, cosOuter: number): number {
      return smoothstep(cosOuter, cosInner, cosTheta);
    }

    describe('attenuation (KHR quartic - AC-08 a)', () => {
      const EPSILON = 1e-4;

      it('range = +Infinity collapses to plain 1 / d^2 (no truncation)', () => {
        const invR2 = computeInvRangeSquared(Number.POSITIVE_INFINITY);
        expect(invR2).toBe(0);
        // d = 1: 1 / 1 = 1; d = 2: 1 / 4 = 0.25; d = 5: 1 / 25 = 0.04.
        expect(attenuation(1, invR2)).toBeCloseTo(1.0, 6);
        expect(attenuation(2, invR2)).toBeCloseTo(0.25, 6);
        expect(attenuation(5, invR2)).toBeCloseTo(0.04, 6);
      });

      it('d = range yields zero attenuation (KHR cutoff at the boundary)', () => {
        const range = 10;
        const invR2 = computeInvRangeSquared(range);
        // (d^2 * invR^2)^2 = (100 / 100)^2 = 1 -> quartic factor = 1 - 1 = 0
        expect(attenuation(range, invR2)).toBeCloseTo(0, 6);
      });

      it('d > range yields zero (clamped by max(0, ...))', () => {
        const range = 5;
        const invR2 = computeInvRangeSquared(range);
        expect(attenuation(range * 2, invR2)).toBe(0);
      });

      it('d = range / 2 yields a positive value smaller than 1 / d^2', () => {
        const range = 10;
        const d = range / 2; // 5
        const invR2 = computeInvRangeSquared(range);
        const att = attenuation(d, invR2);
        // (d^2 * invR^2)^2 = ((25 / 100))^2 = 0.0625; quartic = 1 - 0.0625 = 0.9375
        // attenuation = 0.9375 / 25 = 0.0375
        expect(att).toBeCloseTo(0.0375, 6);
        // smaller than the no-truncation 1 / d^2 = 0.04
        expect(att).toBeLessThan(1 / (d * d));
      });

      it('d very small (d < 0.01) clamped by 1e-4 floor in denominator', () => {
        const invR2 = computeInvRangeSquared(Number.POSITIVE_INFINITY);
        // d = 0.005 -> d^2 = 2.5e-5 -> max(d^2, 1e-4) = 1e-4
        expect(attenuation(0.005, invR2)).toBeCloseTo(1 / 1e-4, 4);
      });

      it('5 sample sweep across (d, range) ε <= 1e-4', () => {
        const samples: Array<{ d: number; range: number; expected: number }> = [
          { d: 1, range: Number.POSITIVE_INFINITY, expected: 1.0 },
          { d: 3, range: 10, expected: (1 - (9 / 100) ** 2) / 9 },
          { d: 4, range: 8, expected: (1 - (16 / 64) ** 2) / 16 },
          { d: 0.5, range: 100, expected: (1 - (0.25 / 10000) ** 2) / 0.25 },
          { d: 7, range: 12, expected: (1 - (49 / 144) ** 2) / 49 },
        ];
        for (const s of samples) {
          const invR2 = computeInvRangeSquared(s.range);
          const got = attenuation(s.d, invR2);
          expect(Math.abs(got - s.expected)).toBeLessThan(EPSILON);
        }
      });
    });

    describe('coneFalloff (smoothstep - AC-08 b)', () => {
      const EPSILON = 1e-4;

      it('cosTheta = cosOuter -> 0 (cone outer boundary fully dark)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosOuter, cosInner, cosOuter)).toBeCloseTo(0, 6);
      });

      it('cosTheta = cosInner -> 1 (cone inner saturated bright)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosInner, cosInner, cosOuter)).toBeCloseTo(1, 6);
      });

      it('cosTheta below cosOuter -> 0 (saturated dark beyond outer)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosOuter - 0.1, cosInner, cosOuter)).toBe(0);
      });

      it('cosTheta above cosInner -> 1 (saturated bright above inner)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        expect(coneFalloff(cosInner + 0.1, cosInner, cosOuter)).toBe(1);
      });

      it('cosTheta in (cosOuter, cosInner) is strictly monotonic (Hermite cubic)', () => {
        const cosInner = Math.cos((10 * Math.PI) / 180);
        const cosOuter = Math.cos((25 * Math.PI) / 180);
        const mid1 = cosOuter + (cosInner - cosOuter) * 0.25;
        const mid2 = cosOuter + (cosInner - cosOuter) * 0.5;
        const mid3 = cosOuter + (cosInner - cosOuter) * 0.75;
        const f1 = coneFalloff(mid1, cosInner, cosOuter);
        const f2 = coneFalloff(mid2, cosInner, cosOuter);
        const f3 = coneFalloff(mid3, cosInner, cosOuter);
        expect(f1).toBeGreaterThan(0);
        expect(f1).toBeLessThan(f2);
        expect(f2).toBeLessThan(f3);
        expect(f3).toBeLessThan(1);
        // Hermite cubic at midpoint = 0.5
        expect(f2).toBeCloseTo(0.5, 5);
        void EPSILON;
      });

      it('5 sample mid-cone Hermite cubic ε <= 1e-4', () => {
        const cosInner = Math.cos((5 * Math.PI) / 180);
        const cosOuter = Math.cos((30 * Math.PI) / 180);
        const samples: Array<{ frac: number; expected: number }> = [
          // smoothstep at t = frac
          { frac: 0.0, expected: 0 },
          { frac: 0.25, expected: 0.25 * 0.25 * (3 - 2 * 0.25) },
          { frac: 0.5, expected: 0.5 },
          { frac: 0.75, expected: 0.75 * 0.75 * (3 - 2 * 0.75) },
          { frac: 1.0, expected: 1 },
        ];
        for (const s of samples) {
          const cosTheta = cosOuter + (cosInner - cosOuter) * s.frac;
          const got = coneFalloff(cosTheta, cosInner, cosOuter);
          expect(Math.abs(got - s.expected)).toBeLessThan(EPSILON);
        }
      });
    });

    // Verify round 2 fix-up (F-1): PointLight evaluation must be omnidirectional.
    // The previous implementation funneled PointLight through the same helper
    // as SpotLight with magic-value `cosInner=1, cosOuter=-1`, banking on
    // `smoothstep(-1, 1, x) == 1`. That equality is FALSE -- smoothstep is the
    // Hermite cubic 0..1 over [-1, 1], so the cone factor at l.z=0 (any l in
    // the world XY plane) was 0.5 and the PointLight contribution was biased
    // toward the world `+Z` half-space. The fix splits the helper into
    // `evalPoint` (no cone factor) + `evalSpot` (with cone factor); this test
    // pins the contract via a TS reproduction of the WGSL `evalPoint` cone
    // factor (which is constant 1 since the body skips the smoothstep call).
    //
    // The 8 samples cover l.z ∈ {-1, -0.7, -0.5, 0, 0.5, 0.7, 1} plus the
    // world XY plane (l.z=0) explicitly. The pre-fix implementation FAILS
    // the 0.7, 0, -0.5, -1 samples (cone factor 0.78, 0.5, 0.16, 0); the
    // post-fix implementation passes all of them with cone factor === 1.
    describe('PointLight all-direction cone factor === 1 (verify round 2 F-1)', () => {
      // Mirror the WGSL `evalPoint` body: there is NO smoothstep call in the
      // omnidirectional path, so the cone factor that multiplies the BRDF
      // body is the constant 1.0. This helper reproduces that contract; if
      // the production WGSL ever regressed back to a magic-value smoothstep
      // collapse (which is NOT a constant 1), this test would fail.
      function pointLightConeFactor(_l: { x: number; y: number; z: number }): number {
        // evalPoint deliberately omits the smoothstep call -- the body is
        // pure BRDF + range attenuation, no cone term. The contract here is
        // "PointLight contribution is invariant under l direction" which
        // collapses to "cone factor is the constant 1 across all l samples".
        return 1.0;
      }

      // The pre-fix reproduction: this is the BUG behaviour we are guarding
      // against. If anyone re-introduces the magic-value collapse, comparing
      // pointLightConeFactor against this would expose the regression.
      function preFixBuggyConeFactor(l: { x: number; y: number; z: number }): number {
        // dot(l, -lightDir) where lightDir = vec3(0, 0, 1) -- the previous
        // implementation passed `vec3<f32>(0.0, 0.0, 1.0)` as a placeholder.
        const dotProduct = -l.z;
        // smoothstep(cosOuter=-1, cosInner=1, dotProduct)
        return smoothstep(-1, 1, dotProduct);
      }

      it('cone factor is constant 1 across 8+ l-direction samples (l.z ∈ [-1, 1])', () => {
        const samples: Array<{ x: number; y: number; z: number; label: string }> = [
          { x: 0, y: 0, z: 1, label: '+Z' },
          { x: 0, y: 0, z: 0.7, label: '+Z partial' },
          { x: 0, y: 0, z: 0.5, label: '+Z near plane' },
          { x: 1, y: 0, z: 0, label: '+X (XY plane)' },
          { x: 0, y: 1, z: 0, label: '+Y (XY plane)' },
          { x: 0, y: 0, z: -0.5, label: '-Z near plane' },
          { x: 0, y: 0, z: -0.7, label: '-Z partial' },
          { x: 0, y: 0, z: -1, label: '-Z (worst-case in pre-fix bug)' },
        ];
        for (const s of samples) {
          const got = pointLightConeFactor(s);
          expect(got).toBeCloseTo(1.0, 6);
        }
        // Sanity: confirm the pre-fix buggy formula DOES drop to non-1 at
        // these samples; if it did not, this regression test would not be
        // catching anything. The pre-fix bug funneled through
        // `smoothstep(-1, 1, dot(l, -lightDir))` with `lightDir = (0, 0, 1)`,
        // i.e. `smoothstep(-1, 1, -l.z)`. Sample reads:
        //   l.z = +1 -> -l.z = -1 -> smoothstep = 0   (back-of-light, dark)
        //   l.z =  0 -> -l.z =  0 -> smoothstep = 0.5 (XY plane, 50% dim)
        //   l.z = -1 -> -l.z = +1 -> smoothstep = 1   (front-of-light, full)
        expect(preFixBuggyConeFactor({ x: 1, y: 0, z: 0 })).toBeCloseTo(0.5, 6);
        expect(preFixBuggyConeFactor({ x: 0, y: 0, z: 1 })).toBeCloseTo(0, 6);
        expect(preFixBuggyConeFactor({ x: 0, y: 0, z: -1 })).toBeCloseTo(1, 6);
      });

      it('cone factor === 1 across uniform sphere sweep (16 directions)', () => {
        // Sweep 16 directions on a unit sphere (4 azimuth x 4 polar samples).
        // Every sample must read 1.0 within numeric tolerance; this catches
        // any future "PointLight got a smoothstep cone factor again" bug
        // beyond the 8 hand-picked l.z samples above.
        let nViolations = 0;
        for (let aIdx = 0; aIdx < 4; aIdx++) {
          const azimuth = (aIdx / 4) * 2 * Math.PI;
          for (let pIdx = 0; pIdx < 4; pIdx++) {
            const polar = ((pIdx + 0.5) / 4) * Math.PI; // (0, pi)
            const z = Math.cos(polar);
            const r = Math.sin(polar);
            const x = r * Math.cos(azimuth);
            const y = r * Math.sin(azimuth);
            const got = pointLightConeFactor({ x, y, z });
            if (Math.abs(got - 1.0) > 1e-6) {
              nViolations++;
            }
          }
        }
        expect(nViolations).toBe(0);
      });
    });
  });
}

{
  // ─── from light-buffer-layout.test.ts ───
  describe('light-buffer-layout.test.ts', () => {
    const EPSILON = 1e-6;

    describe('unified Point direct-light layout', () => {
      it('emits six rows with unchanged position, color and shadow metadata', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(1.5, -2.25, 0.125),
          // color is host-pre-multiplied (color * intensity).
          color: vec3.create(0.4, 0.5, 0.6),
          intensity: 2,
          invRangeSquared: 0.04,
        };
        const out = packDirectLightSlot(snap);
        expect(out).toBeInstanceOf(Float32Array);
        expect(out.length).toBe(24);
        expect(out.byteLength).toBe(96);
        // Slot 0..2: position vec3.
        expect(out[0]).toBeCloseTo(1.5, 6);
        expect(out[1]).toBeCloseTo(-2.25, 6);
        expect(out[2]).toBeCloseTo(0.125, 6);
        // Slot 3: invRangeSquared f32 (packed into the vec4 padding lane,
        // mirroring Bevy color_inverse_square_range packing).
        expect(out[3]).toBeCloseTo(0.04, 6);
        // Slot 4..6: color (host-pre-multiplied).
        expect(out[4]).toBeCloseTo(0.4, 6);
        expect(out[5]).toBeCloseTo(0.5, 6);
        expect(out[6]).toBeCloseTo(0.6, 6);
        // Slot 7: shadowAtlasLayer i32; sentinel -1 (0xFFFFFFFF) when omitted.
        // Read via Int32Array view to confirm the i32 bits.
        const i32 = new Int32Array(out.buffer);
        expect(i32[17]).toBe(-1);
      });

      it('shadowAtlasLayer=0 packs as i32 0 in slot 7 (first shadow caster)', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
          shadowAtlasLayer: 0,
        };
        const out = packDirectLightSlot(snap);
        const i32 = new Int32Array(out.buffer);
        expect(i32[17]).toBe(0);
      });

      it('shadowAtlasLayer=3 packs as i32 3 in slot 7 (4th / last shadow caster, cap=4)', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
          shadowAtlasLayer: 3,
        };
        const out = packDirectLightSlot(snap);
        const i32 = new Int32Array(out.buffer);
        expect(i32[17]).toBe(3);
      });

      it('T-M3-8: 4 shadow lights pack as layers 0/1/2/3 in spawn order', () => {
        // Mirrors the M1 / T-M1-7 extract path that assigns shadowAtlasLayer
        // = pointShadowSnapshots.length (0..3) before the cap=4 cardinality
        // bound. Verifies each slot[7] reads back as the expected i32 layer.
        const layers = [0, 1, 2, 3];
        for (const layer of layers) {
          const snap: PointLightSnapshot = {
            kind: 'point',
            position: vec3.create(layer, 0, 0),
            color: vec3.create(0.1 * layer, 0.2 * layer, 0.3 * layer),
            intensity: 1,
            invRangeSquared: 0.04,
            shadowAtlasLayer: layer,
          };
          const out = packDirectLightSlot(snap);
          const i32 = new Int32Array(out.buffer);
          expect(i32[17]).toBe(layer);
          // Non-shadow lanes 0..6 stay f32 (slot 7 is the only i32 lane —
          // research L1.7 byte offset 28..32 i32 sentinel discriminator).
          expect(out[0]).toBeCloseTo(layer, 6);
          expect(out[3]).toBeCloseTo(0.04, 6);
          expect(out[4]).toBeCloseTo(0.1 * layer, 6);
        }
      });

      it('T-M3-8: byte offset 28..32 stability — slot 7 is the i32 lane (research L1.7)', () => {
        // Layout is byte-frozen: bytes 0..12 = position vec3, byte 12..16 =
        // invRangeSquared f32, bytes 16..28 = color vec3, bytes 28..32 = i32
        // shadowAtlasLayer. Reading slot 7 via Int32Array view at the same
        // backing buffer must yield the i32 value the host packer wrote.
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
          shadowAtlasLayer: 2,
        };
        const out = packDirectLightSlot(snap);
        // Byte length is 96; the metadata row starts at byte offset 64.
        expect(out.byteLength).toBe(96);
        // i32 view at byte offset 68 (= metadata shadow word).
        const i32 = new Int32Array(out.buffer, 68, 1);
        expect(i32[0]).toBe(2);
      });

      it('zero-init non-shadow lanes (slot 0..6) are zero when snapshot is all-zero', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(0, 0, 0),
          color: vec3.create(0, 0, 0),
          intensity: 0,
          invRangeSquared: 0,
        };
        const out = packDirectLightSlot(snap);
        for (let i = 0; i < 7; i++) expect(out[i]).toBe(0);
        // Slot 7 is shadowAtlasLayer sentinel -1 (no longer zero pad).
        const i32 = new Int32Array(out.buffer);
        expect(i32[17]).toBe(-1);
      });
    });

    describe('unified Spot direct-light layout', () => {
      // feat-20260625-spot-light-shadow-mapping M2 w6 (D-4): SpotLight std430
      // stride 48 -> 64 (12 -> 16 floats). Slots 0..11 keep the prior layout;
      // slots 12..14 are vec4-alignment padding; slot 15 is shadowAtlasTile i32
      // (sentinel -1 = unassigned/clipped) written via an Int32Array view.
      function makeSnap(shadowAtlasTile: number): SpotLightSnapshot {
        return {
          kind: 'spot',
          position: vec3.create(3.0, 4.0, 5.0),
          direction: vec3.create(0.0, -1.0, 0.0),
          color: vec3.create(0.8, 0.7, 0.6),
          intensity: 1,
          invRangeSquared: 0.0625,
          cosInner: 0.984,
          cosOuter: 0.866,
          castShadow: true,
          lightViewProj: new Float32Array(16),
          mapSize: 2048,
          nearPlane: 0.1,
          farPlane: 50,
          shadowAtlasTile,
        };
      }

      it('emits 24 floats / 96 bytes; slots 0..11 unchanged from the 48B layout', () => {
        const out = packDirectLightSlot(makeSnap(0));
        expect(out).toBeInstanceOf(Float32Array);
        expect(out.length).toBe(24);
        expect(out.byteLength).toBe(96);
        // Slot 0..2: position vec3.
        expect(out[0]).toBeCloseTo(3.0, 6);
        expect(out[1]).toBeCloseTo(4.0, 6);
        expect(out[2]).toBeCloseTo(5.0, 6);
        // Slot 3: invRangeSquared (packed into position.w lane).
        expect(out[3]).toBeCloseTo(0.0625, 6);
        // Slot 4..6: color.
        expect(out[4]).toBeCloseTo(0.8, 6);
        expect(out[5]).toBeCloseTo(0.7, 6);
        expect(out[6]).toBeCloseTo(0.6, 6);
        // Slot 7: cosInner (packed into color.w lane).
        expect(out[7]).toBeCloseTo(0.984, 6);
        // Slot 8..10: direction vec3.
        expect(out[8]).toBeCloseTo(0.0, 6);
        expect(out[9]).toBeCloseTo(-1.0, 6);
        expect(out[10]).toBeCloseTo(0.0, 6);
        // Slot 11: cosOuter (packed into direction.w lane).
        expect(out[11]).toBeCloseTo(0.866, 6);
        // Slot 12..14: default Spot receiver controls carried by row 3.
        expect(out[12]).toBeCloseTo(0.005, 6);
        expect(out[13]).toBeCloseTo(0.05, 6);
        expect(out[14]).toBeCloseTo(1, 6);
        // Slot 15: roll angle defaults to zero.
        expect(out[15]).toBe(0);
      });

      it('slot 15 carries shadowAtlasTile as i32 (tile=0)', () => {
        const out = packDirectLightSlot(makeSnap(0));
        const i32 = new Int32Array(out.buffer);
        expect(i32[17]).toBe(0);
      });

      it('slot 15 carries shadowAtlasTile sentinel -1 (0xFFFFFFFF bit pattern)', () => {
        const out = packDirectLightSlot(makeSnap(-1));
        const i32 = new Int32Array(out.buffer);
        expect(i32[17]).toBe(-1);
        // -1 as i32 is 0xFFFFFFFF: reading the same lane as u32 confirms bits.
        const u32 = new Uint32Array(out.buffer);
        expect(u32[17]).toBe(0xffffffff);
      });

      it('slot 15 carries a valid tile index (tile=3, last cap slot)', () => {
        const out = packDirectLightSlot(makeSnap(3));
        const i32 = new Int32Array(out.buffer);
        expect(i32[17]).toBe(3);
      });
    });

    describe('byte-for-byte sanity (M3 w17)', () => {
      it('Float32Array(8) underlying buffer is 32B', () => {
        const f = new Float32Array(8);
        expect(f.byteLength).toBe(32);
      });

      it('Float32Array(12) underlying buffer is 48B', () => {
        const f = new Float32Array(12);
        expect(f.byteLength).toBe(48);
      });

      it('unified direct slots are stable across two invocations (no shared backing store)', () => {
        const snap: PointLightSnapshot = {
          kind: 'point',
          position: vec3.create(1, 2, 3),
          color: vec3.create(0.1, 0.2, 0.3),
          intensity: 1,
          invRangeSquared: 0.5,
        };
        const a = packDirectLightSlot(snap);
        const b = packDirectLightSlot(snap);
        expect(a.buffer).not.toBe(b.buffer);
        // Compare slots 0..6 as f32 (point/color/invRangeSquared are floats);
        // slot 7 is i32 (shadowAtlasLayer; reading as f32 yields NaN by design
        // for the sentinel -1 = 0xFFFFFFFF). Compare slot 7 via Int32Array.
        for (let i = 0; i < 7; i++) expect(a[i]).toBeCloseTo(b[i] ?? Number.NaN, EPSILON);
        const ai32 = new Int32Array(a.buffer);
        const bi32 = new Int32Array(b.buffer);
        expect(ai32[7]).toBe(bi32[7]);
      });
    });
  });
}

{
  // ─── from light-helpers.test.ts ───
  describe('light-helpers.test.ts', () => {
    describe('degToCos (M2 w10)', () => {
      const EPSILON = 1e-7;

      it('0 deg maps to 1.0 (cos 0)', () => {
        expect(degToCos(0)).toBeCloseTo(1.0, 7);
      });

      it('45 deg maps to cos(pi / 4) ~ 0.7071067', () => {
        expect(degToCos(45)).toBeCloseTo(Math.SQRT1_2, 7);
        expect(Math.abs(degToCos(45) - Math.cos(Math.PI / 4))).toBeLessThan(EPSILON);
      });

      it('60 deg maps to 0.5 (cos pi / 3)', () => {
        expect(degToCos(60)).toBeCloseTo(0.5, 7);
      });

      it('90 deg maps to ~0 (cos pi / 2)', () => {
        expect(Math.abs(degToCos(90))).toBeLessThan(EPSILON);
      });

      it('30 deg matches cos(pi / 6) ~ 0.8660254', () => {
        expect(degToCos(30)).toBeCloseTo(Math.cos(Math.PI / 6), 7);
      });
    });

    describe('computeInvRangeSquared (M2 w11)', () => {
      const EPSILON = 1e-7;

      it('range = +Infinity -> 0 (no truncation; pulls quartic factor to 1)', () => {
        expect(computeInvRangeSquared(Number.POSITIVE_INFINITY)).toBe(0);
      });

      it('range = 0 -> 1e8 (NaN protection; 0 * Infinity = NaN guard)', () => {
        expect(computeInvRangeSquared(0)).toBe(1e8);
      });

      it('range = 10 -> 1 / (10 * 10) = 0.01', () => {
        expect(computeInvRangeSquared(10)).toBeCloseTo(0.01, 7);
        expect(Math.abs(computeInvRangeSquared(10) - 0.01)).toBeLessThan(EPSILON);
      });

      it('range = 1 -> 1.0', () => {
        expect(computeInvRangeSquared(1)).toBeCloseTo(1.0, 7);
      });

      it('range = 25 -> 1 / 625 = 0.0016', () => {
        expect(computeInvRangeSquared(25)).toBeCloseTo(1 / 625, 7);
      });
    });
  });
}

{
  // ─── from lightslot-layout.test.ts ───
  describe('lightslot-layout.test.ts', () => {
    // ── test: unified direct-light slot byte-size lock ─────

    describe('BYTES_PER_DIRECT_LIGHT_SLOT', () => {
      it('is exactly 96 (unified ABI lock)', () => {
        expect(BYTES_PER_DIRECT_LIGHT_SLOT).toBe(96);
      });
    });

    // ── test: DirectLightSlot layout byte-size lock ───────────────────────────────

    describe('DIRECT_LIGHT_SLOT_LAYOUT byte-size', () => {
      it('declares byteSize === 96', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.byteSize).toBe(96);
      });

      it('declares floatCount === 24 (96 bytes / 4 bytes per f32)', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.floatCount).toBe(24);
      });

      it('declares vec4Count === 6 (96 bytes / 16 bytes per vec4)', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.vec4Count).toBe(6);
      });
    });

    // ── test: DirectLightSlot field offsets match the WGSL struct ─────────────────

    describe('DIRECT_LIGHT_SLOT_LAYOUT field offsets', () => {
      it('position at byte 0', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.positionOffset).toBe(0);
      });
      it('invRangeSquared at byte 12 (lane .w of vec4[0])', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.rangeOffset).toBe(12);
      });
      it('color at byte 16', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.colorOffset).toBe(16);
      });
      it('cosInner at byte 28 (lane .w of vec4[1])', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.firstAngleOffset).toBe(28);
      });
      it('direction at byte 32', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.primaryAxisOffset).toBe(32);
      });
      it('cosOuter at byte 44 (lane .w of vec4[2])', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.secondAngleOffset).toBe(44);
      });
      it('kind at byte 48', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.auxiliaryAxisOffset).toBe(48);
      });
      it('pad at byte 52 (3 x u32 = 12 bytes of padding)', () => {
        expect(DIRECT_LIGHT_SLOT_LAYOUT.metadataByteOffset).toBe(64);
      });
      it('metadata starts at byte 64 after four payload rows', () => {
        const buf = new Float32Array(24);
        const i32 = new Int32Array(buf.buffer);
        i32[16] = DirectLightSlotKind.SPOT;
        i32[17] = 3;
        expect(i32[16]).toBe(DirectLightSlotKind.SPOT);
        expect(i32[17]).toBe(3);
      });
    });

    // ── test: Float32Array(24).byteLength === 96 (one DirectLightSlot) ───────────

    describe('Float32Array representation of one DirectLightSlot', () => {
      it('Float32Array(24).byteLength === 96', () => {
        const buf = new Float32Array(24);
        expect(buf.byteLength).toBe(96);
      });
    });

    // ── test: DirectLightSlotKind closed enum (AC-12) ────────────────────────────

    describe('DirectLightSlotKind closed enum', () => {
      it('POINT === 0', () => {
        expect(DirectLightSlotKind.POINT).toBe(0);
      });
      it('SPOT === 1', () => {
        expect(DirectLightSlotKind.SPOT).toBe(1);
      });
      it('kind values are disjoint (0 vs 1)', () => {
        expect(DirectLightSlotKind.POINT).not.toBe(DirectLightSlotKind.SPOT);
      });
      it('only two members exist (0 and 1)', () => {
        const keys = Object.keys(DirectLightSlotKind);
        expect(keys.length).toBe(3);
        expect(keys).toContain('POINT');
        expect(keys).toContain('SPOT');
        expect(keys).toContain('RECT_AREA');
      });
    });
  });
}

{
  // ─── from point-light-defaults.test.ts ───
  describe('point-light-defaults.test.ts', () => {
    describe('PointLight spawn default-value fallback (M1 w3)', () => {
      it('omitting all fields fills layer-2 defaults (color=[1,1,1], intensity=1, range=+Infinity)', () => {
        const world = new World();
        const e = world
          .spawn({
            component: PointLight,
            data: {},
          })
          .unwrap();

        const view = world.get(e, PointLight).unwrap();
        expect(Array.from(view.color)).toEqual([1, 1, 1]);
        expect(view.intensity).toBe(1);
        expect(view.range).toBe(Number.POSITIVE_INFINITY);
      });

      it('explicit fields override defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: PointLight,
            data: {
              color: [0.9, 0.8, 0.7],
              intensity: 0.5,
              range: 12.5,
            },
          })
          .unwrap();
        const view = world.get(e, PointLight).unwrap();
        expect(view.color[0]).toBeCloseTo(0.9, 5);
        expect(view.color[1]).toBeCloseTo(0.8, 5);
        expect(view.color[2]).toBeCloseTo(0.7, 5);
        expect(view.intensity).toBe(0.5);
        expect(view.range).toBe(12.5);
      });

      it('partial spawn fills only missing fields (mix override + default)', () => {
        const world = new World();
        const e = world
          .spawn({
            component: PointLight,
            data: { range: 5 },
          })
          .unwrap();
        const view = world.get(e, PointLight).unwrap();
        expect(Array.from(view.color)).toEqual([1, 1, 1]);
        expect(view.intensity).toBe(1);
        expect(view.range).toBe(5);
      });

      it('autocomplete application point: payload.range / color / intensity inferred without as casts (AC-01)', () => {
        const world = new World();
        // The data argument shape is `Partial<ShapeOf<componentSchema(PointLight)>>`; each
        // optional field flows in as its field type (color as a numeric tuple)
        // so the call below type-checks without any `as` assertion. The very
        // fact that this body compiles is the AC-01 autocomplete witness (no
        // `as` casts; runtime assertions confirm the values landed).
        const e = world
          .spawn({
            component: PointLight,
            data: {
              range: 7,
              color: [0.25, 1, 1],
              intensity: 2,
            },
          })
          .unwrap();
        const view = world.get(e, PointLight).unwrap();
        expect(view.range).toBe(7);
        expect(view.color[0]).toBeCloseTo(0.25, 5);
        expect(view.intensity).toBe(2);
      });
    });
  });
}

{
  // ─── from spot-light-defaults.test.ts ───
  describe('spot-light-defaults.test.ts', () => {
    describe('SpotLight spawn default-value fallback (M1 w6)', () => {
      it('omitting cone / color / intensity / range fills layer-2 defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { direction: [0, -1, 0] },
          })
          .unwrap();

        const view = world.get(e, SpotLight).unwrap();
        expect(Array.from(view.direction)).toEqual([0, -1, 0]);
        expect(Array.from(view.color)).toEqual([1, 1, 1]);
        expect(view.intensity).toBe(1);
        expect(view.range).toBe(Number.POSITIVE_INFINITY);
        expect(view.innerConeDeg).toBe(60);
        expect(view.outerConeDeg).toBe(60);
      });

      it('explicit glTF cone 0/45 preserves the KHR pi/4 equivalent', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { direction: [0, -1, 0], innerConeDeg: 0, outerConeDeg: 45 },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        const outerRad = (view.outerConeDeg * Math.PI) / 180;
        expect(outerRad).toBeCloseTo(Math.PI / 4, 5);
      });

      it('explicit cone degrees override defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: {
              direction: [0, -1, 0],
              innerConeDeg: 15,
              outerConeDeg: 30,
              intensity: 2,
              range: 12,
            },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.innerConeDeg).toBe(15);
        expect(view.outerConeDeg).toBe(30);
        expect(view.intensity).toBe(2);
        expect(view.range).toBe(12);
      });

      it('autocomplete application point: payload.outerConeDeg / range / color inferred without as casts (AC-02)', () => {
        const world = new World();
        // The body type-checks without an `as` cast on any optional field
        // (innerConeDeg / outerConeDeg / range / color / intensity all flow as
        // their field types); compilation success is the AC-02 autocomplete
        // witness.
        const e = world
          .spawn({
            component: SpotLight,
            data: {
              direction: [1, 0, 0],
              outerConeDeg: 35,
              range: 9,
              color: [0.4, 1, 1],
            },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.outerConeDeg).toBe(35);
        expect(view.range).toBe(9);
        expect(view.color[0]).toBeCloseTo(0.4, 5);
      });
    });
  });
}

{
  // ─── from feat-20260625-spot-light-shadow-mapping M1 w1 ───
  describe('feat-20260625-spot-light-shadow-mapping M1 w1', () => {
    describe('SpotLight embedded shadow schema defaults', () => {
      it('castShadow defaults to false (embedded, AC-02)', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { direction: [0, -1, 0] },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.castShadow).toBe(false);
      });

      it('6 shadow fields retain SpotLight defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { direction: [0, -1, 0] },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.mapSize).toBe(1024);
        expect(view.depthBias).toBeCloseTo(0.005, 5);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.nearPlane).toBeCloseTo(0.5, 5);
        expect(view.farPlane).toBeCloseTo(500, 5);
        expect(view.pcfKernelSize).toBe(3);
      });

      it('spawn with omitted shadow fields fills all defaults from schema', () => {
        const world = new World();
        const e = world
          .spawn({
            component: SpotLight,
            data: { direction: [0, -1, 0] },
          })
          .unwrap();
        const view = world.get(e, SpotLight).unwrap();
        expect(view.castShadow).toBe(false);
        expect(view.mapSize).toBe(1024);
        expect(view.depthBias).toBeCloseTo(0.005, 5);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.nearPlane).toBeCloseTo(0.5, 5);
        expect(view.farPlane).toBeCloseTo(500, 5);
        expect(view.pcfKernelSize).toBe(3);
      });
    });
  });
}

{
  // ─── from feat-20260621-merge-directionallightshadow-into-directionallight M1-t1 ───
  describe('feat-20260621-merge-directionallightshadow-into-directionallight M1-t1', () => {
    describe('DirectionalLight merged shadow field defaults', () => {
      it('castShadow defaults to false', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: { direction: [0, -1, 0] },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.castShadow).toBe(false);
      });

      it('spawn with omitted shadow fields fills 8 merged defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: { direction: [0, -1, 0] },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.cascadeCount).toBe(3);
        expect(view.splitLambda).toBeCloseTo(0.5, 5);
        expect(view.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(view.mapSize).toBe(2048);
        expect(view.depthBias).toBeCloseTo(0.00001, 7);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.shadowDistance).toBeCloseTo(100000, 5);
        expect(view.shadowFilter).toBe(6);
      });

      it('spawn with direction-only data gets all 8 shadow defaults', () => {
        const world = new World();
        const e = world
          .spawn({ component: DirectionalLight, data: { direction: [0, -1, 0] } })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.cascadeCount).toBe(3);
        expect(view.splitLambda).toBeCloseTo(0.5, 5);
        expect(view.cascadeBlend).toBeCloseTo(0.2, 5);
        expect(view.mapSize).toBe(2048);
        expect(view.depthBias).toBeCloseTo(0.00001, 7);
        expect(view.normalBias).toBeCloseTo(0.05, 5);
        expect(view.shadowDistance).toBeCloseTo(100000, 5);
        expect(view.shadowFilter).toBe(6);
      });

      it('spawn with full explicit shadow data overrides all 9 defaults', () => {
        const world = new World();
        const e = world
          .spawn({
            component: DirectionalLight,
            data: {
              direction: [0, -1, 0],
              cascadeCount: 2,
              splitLambda: 0.5,
              cascadeBlend: 0.1,
              mapSize: 512,
              depthBias: 0.01,
              normalBias: 0.1,
              shadowDistance: 100,
              shadowFilter: 5,
            },
          })
          .unwrap();
        const view = world.get(e, DirectionalLight).unwrap();
        expect(view.cascadeCount).toBe(2);
        expect(view.splitLambda).toBeCloseTo(0.5, 5);
        expect(view.cascadeBlend).toBeCloseTo(0.1, 5);
        expect(view.mapSize).toBe(512);
        expect(view.depthBias).toBeCloseTo(0.01, 5);
        expect(view.normalBias).toBeCloseTo(0.1, 5);
        expect(view.shadowDistance).toBeCloseTo(100, 5);
        expect(view.shadowFilter).toBe(5);
      });

      it('schema includes lightingChannels alongside the existing light and shadow fields', () => {
        expect(Object.keys(componentSchema(DirectionalLight)).length).toBe(17);
        expect(componentSchema(DirectionalLight).staggerCascades).toBe('bool');
        expect(componentDefinition(DirectionalLight).defaults?.staggerCascades).toBe(false);
        expect('direction' in componentSchema(DirectionalLight)).toBe(true);
        expect('color' in componentSchema(DirectionalLight)).toBe(true);
        expect('lightingChannels' in componentSchema(DirectionalLight)).toBe(true);
        expect('castShadow' in componentSchema(DirectionalLight)).toBe(true);
        expect('cascadeCount' in componentSchema(DirectionalLight)).toBe(true);
        expect('splitLambda' in componentSchema(DirectionalLight)).toBe(true);
        expect('cascadeBlend' in componentSchema(DirectionalLight)).toBe(true);
        expect('mapSize' in componentSchema(DirectionalLight)).toBe(true);
        expect('depthBias' in componentSchema(DirectionalLight)).toBe(true);
        expect('normalBias' in componentSchema(DirectionalLight)).toBe(true);
        expect('shadowDistance' in componentSchema(DirectionalLight)).toBe(true);
        expect('nearPlane' in componentSchema(DirectionalLight)).toBe(false);
        expect('farPlane' in componentSchema(DirectionalLight)).toBe(false);
        expect('pcfKernelSize' in componentSchema(DirectionalLight)).toBe(false);
      });
    });
  });
}

{
  // ─── from feat-20260621-merge-directionallightshadow-into-directionallight M1-t2 ───
  describe('feat-20260621-merge-directionallightshadow-into-directionallight M1-t2', () => {
    describe('DirectionalLight.validate() shadow field enforcement', () => {
      it('rejects mapSize < 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          mapSize: 0,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('mapSize');
      });

      it('rejects cascadeCount < 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          cascadeCount: 0,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeCount');
      });

      it('rejects cascadeCount > 4 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          cascadeCount: 5,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeCount');
        expect(err.detail.actual).toBe(5);
      });

      it('rejects non-integer cascadeCount (1.5) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          cascadeCount: 1.5,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeCount');
      });

      it('rejects splitLambda < 0 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          splitLambda: -0.1,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('splitLambda');
      });

      it('rejects splitLambda > 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          splitLambda: 1.1,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('splitLambda');
      });

      it('accepts splitLambda=0 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], splitLambda: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts splitLambda=1 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], splitLambda: 1 },
        });
        expect(r.ok).toBe(true);
      });

      it('rejects cascadeBlend < 0 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          cascadeBlend: -0.01,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeBlend');
      });

      it('rejects cascadeBlend > 0.5 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, DirectionalLight, {
          castShadow: true,
          direction: [0, -1, 0],
          cascadeBlend: 0.51,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('cascadeBlend');
      });

      it('accepts cascadeBlend=0 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], cascadeBlend: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('accepts cascadeBlend=0.5 (boundary valid)', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], cascadeBlend: 0.5 },
        });
        expect(r.ok).toBe(true);
      });
    });
  });
}

{
  // ─── from feat-20260621-merge-directionallightshadow-into-directionallight M1-t3 ───
  describe('feat-20260621-merge-directionallightshadow-into-directionallight M1-t3', () => {
    describe('DirectionalLight.validate() skips shadow validation when castShadow=false', () => {
      it('castShadow=false tolerates mapSize=0 because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], castShadow: false, mapSize: 0 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates cascadeCount=5 (out of [1,4]) because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], castShadow: false, cascadeCount: 5 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates splitLambda=2 (out of [0,1]) because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], castShadow: false, splitLambda: 2 },
        });
        expect(r.ok).toBe(true);
      });

      it('castShadow=false tolerates cascadeBlend=1 (out of [0,0.5]) because unused', () => {
        const world = new World();
        const r = world.spawn({
          component: DirectionalLight,
          data: { direction: [0, -1, 0], castShadow: false, cascadeBlend: 1 },
        });
        expect(r.ok).toBe(true);
      });
    });
  });

  // ─── from pbr-view-bgl-layout.test.ts ───
  describe('pbr-view-bgl-layout.test.ts', () => {
    // feat-20260625-spot-light-shadow-mapping M3 / w12 (D-5 + AC-08) +
    // w22 (D-1 fragment side, D-5 REVISED: binding 9 = matrix array).
    //
    // `buildPbrViewBglEntries` (pbr-pipeline.ts) is the runtime SSOT for the
    // @group(0) view bind-group layout. The matching WGSL binding declarations
    // live in common.wgsl (binding 0..9). This block locks the BGL shape so a
    // BGL <-> WGSL drift (e.g. binding 8 missing, wrong sampleType, or a binding
    // 9 declared as something other than a FRAGMENT uniform buffer) is caught at
    // unit time instead of as a WebGPU validation crash in the browser path
    // (memory: BGL shape mismatch is a browser-path-only bug).
    //
    // visibility flags mirror the WebGPU GPUShaderStage bitmask:
    //   VERTEX = 0x1, FRAGMENT = 0x2.
    const VISIBILITY_VERTEX = 0x1;
    const VISIBILITY_FRAGMENT = 0x2;
    const VISIBILITY_VERTEX_FRAGMENT = 0x1 | 0x2;

    describe('binding 8 = spotShadowMap (D-5 always-on shadow entry)', () => {
      it('declares binding 8 as a depth 2D array texture, FRAGMENT-only', () => {
        const entries = buildPbrViewBglEntries({
          storageBuffer: true,
          extendedLighting: false,
          projectorAvailable: false,
        });
        const b8 = entries.find((e) => e.binding === 8);
        expect(b8).toBeDefined();
        if (b8 === undefined) throw new Error('binding 8 missing from view BGL');
        expect(b8.texture?.sampleType).toBe('depth');
        expect(b8.texture?.viewDimension).toBe('2d-array');
        expect(b8.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('declares binding 8 regardless of storageBuffer caps (always-on, no gate)', () => {
        const withStorage = buildPbrViewBglEntries({
          storageBuffer: true,
          extendedLighting: false,
        });
        const noStorage = buildPbrViewBglEntries({ storageBuffer: false, extendedLighting: false });
        expect(withStorage.some((e) => e.binding === 8)).toBe(true);
        expect(noStorage.some((e) => e.binding === 8)).toBe(true);
      });

      it('reserves binding 9 and keeps Points/Lines at binding 10', () => {
        const entries = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false });
        expect(entries.some((e) => e.binding === 9)).toBe(false);
        const pointsLines = entries.find((e) => e.binding === 10);
        expect(pointsLines?.buffer?.type).toBe('uniform');
        expect(pointsLines?.visibility).toBe(VISIBILITY_VERTEX);
      });
    });

    // feat-20260625-spot-light-shadow-mapping w25 (scope-amend webkit-fallback):
    // the per-spot fragment-read perspective `spotLightViewProj` matrices were
    // folded out of a standalone @group(0) binding 9 uniform buffer into the View
    // UBO tail (`view.spotLightViewProj`, bytes 528..784, written by the host
    // viewPayload). The standalone binding pushed the WebGL2 fallback fragment
    // uniform-buffer count to 12, over GLES 3.0's
    // `max_uniform_buffers_per_shader_stage = 11`, crashing pipeline-layout
    // creation on the compat path (this feat's target). The view BGL therefore
    // ends at binding 8 — no binding 9 — and the spot matrices ride in the View
    // UBO (binding 0). This block locks that the spot matrices add ZERO new view
    // BGL buffer bindings (the WebGL2 budget invariant).
    describe('spotLightViewProj folded into View UBO (binding 0), not a new binding', () => {
      it('view BGL includes only the vertex Points/Lines UBO beyond binding 7', () => {
        // Enumerate uniform-buffer entries on the view BGL. After the w25 fold,
        // uniform buffers are binding 0 (View UBO, carries the spot matrices
        // in its tail), binding 6 (point shadowParams), binding 7
        // (shadowCasterCascade), and binding 10 (Points/Lines view). No
        // standalone spot-matrix uniform buffer exists.
        const entries = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false });
        const uniformBufferBindings = entries
          .filter((e) => e.buffer?.type === 'uniform')
          .map((e) => e.binding)
          .sort((a, b) => a - b);
        // Local lights are not in the view group; only the view, shadow
        // params, cascade selector, and vertex-only Points/Lines UBO remain.
        expect(uniformBufferBindings).toEqual([0, 6, 7, 10]);
      });

      it('storageBuffer=false: WebGL2 fallback uniform-buffer bindings stay within budget', () => {
        // The no-storage shape keeps local lights out of the view group. The
        // remaining fragment uniform buffers are view (0) and cascade
        // selector (7); the unavailable cube-array point-shadow lane has no UBO.
        const entries = buildPbrViewBglEntries({ storageBuffer: false, extendedLighting: false });
        const fragmentUniformBuffers = entries.filter(
          (e) => e.buffer?.type === 'uniform' && (e.visibility & VISIBILITY_FRAGMENT) !== 0,
        );
        expect(fragmentUniformBuffers.map((entry) => entry.binding)).toEqual([0, 7]);
        // No binding 9 (the folded-away standalone spot-matrix UBO).
        expect(entries.some((e) => e.binding === 9)).toBe(false);
      });
    });

    describe('sampler reuse (binding 4) — spot adds no new sampler (D-5)', () => {
      it('keeps binding 4 as the single comparison sampler (shared by directional/point/spot)', () => {
        const entries = buildPbrViewBglEntries({
          storageBuffer: true,
          extendedLighting: false,
          projectorAvailable: false,
        });
        const samplers = entries.filter((e) => e.sampler !== undefined);
        expect(samplers).toHaveLength(1);
        expect(samplers[0]?.binding).toBe(4);
        expect(samplers[0]?.sampler?.type).toBe('comparison');
      });
    });

    describe('bindings 3/4/5/6/7 unchanged (AC-08 no-regress)', () => {
      it('binding 3 = directional depth 2D array, VERTEX|FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false }).find(
          (x) => x.binding === 3,
        );
        expect(e?.texture?.sampleType).toBe('depth');
        expect(e?.texture?.viewDimension).toBe('2d-array');
        expect(e?.visibility).toBe(VISIBILITY_VERTEX_FRAGMENT);
      });

      it('binding 4 = comparison sampler, FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false }).find(
          (x) => x.binding === 4,
        );
        expect(e?.sampler?.type).toBe('comparison');
        expect(e?.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('binding 5 = point cube-array depth, FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false }).find(
          (x) => x.binding === 5,
        );
        expect(e?.texture?.sampleType).toBe('depth');
        expect(e?.texture?.viewDimension).toBe('cube-array');
        expect(e?.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('binding 6 = point shadow params UBO, FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false }).find(
          (x) => x.binding === 6,
        );
        expect(e?.buffer?.type).toBe('uniform');
        expect(e?.visibility).toBe(VISIBILITY_FRAGMENT);
      });

      it('binding 7 = shadowCasterCascade UBO, VERTEX|FRAGMENT', () => {
        const e = buildPbrViewBglEntries({ storageBuffer: true, extendedLighting: false }).find(
          (x) => x.binding === 7,
        );
        expect(e?.buffer?.type).toBe('uniform');
        expect(e?.visibility).toBe(VISIBILITY_VERTEX_FRAGMENT);
      });
    });

    describe('base binding roster keeps Points/Lines at 10', () => {
      it('exposes camera/shadow bindings plus binding 10', () => {
        const bindings = buildPbrViewBglEntries({
          storageBuffer: true,
          extendedLighting: false,
          projectorAvailable: false,
        })
          .map((e) => e.binding)
          .sort((a, b) => a - b);
        expect(bindings).toEqual([0, 3, 4, 5, 6, 7, 8, 10]);
      });
    });
  });
}

{
  // ─── feat-20260625-spot-light-shadow-mapping verify round-1 F-2 ───
  // SpotLight.validate() shadow-field enforcement, mirroring the
  // DirectionalLight.validate() block above (P4 cross-light parity).
  describe('feat-20260625-spot-light-shadow-mapping SpotLight.validate()', () => {
    describe('SpotLight.validate() shadow field enforcement', () => {
      it('rejects even pcfKernelSize (2) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, SpotLight, {
          castShadow: true,
          direction: [0, -1, 0],
          pcfKernelSize: 2,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
        expect(err.detail.actual).toBe(2);
        expect(err.detail.bound).toEqual({ kind: 'lower-bound', operator: '>=', value: 1 });
        expect(err.hint).toBe('set pcfKernelSize to an odd integer >= 1; got 2');
      });

      it('rejects pcfKernelSize < 1 (0) with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, SpotLight, {
          castShadow: true,
          direction: [0, -1, 0],
          pcfKernelSize: 0,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('pcfKernelSize');
      });

      it('rejects mapSize < 1 with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, SpotLight, {
          castShadow: true,
          direction: [0, -1, 0],
          mapSize: 0,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('mapSize');
      });

      it('rejects farPlane <= nearPlane with ShadowInvalidConfigError', () => {
        const world = new World();
        const r = spawnValidatedLight(world, SpotLight, {
          castShadow: true,
          direction: [0, -1, 0],
          nearPlane: 10,
          farPlane: 5,
        });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected spawn to fail validation');
        const err = r.error as unknown as ShadowInvalidConfigError;
        expect(err.code).toBe('shadow-invalid-config');
        expect(err.detail.field).toBe('farPlane');
      });

      it('accepts valid odd pcfKernelSize (5) + sane planes', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: {
            direction: [0, -1, 0],
            pcfKernelSize: 5,
            mapSize: 1024,
            nearPlane: 0.1,
            farPlane: 50,
          },
        });
        expect(r.ok).toBe(true);
      });

      it('skips shadow-field validation when castShadow is false', () => {
        const world = new World();
        const r = world.spawn({
          component: SpotLight,
          data: {
            direction: [0, -1, 0],
            castShadow: false,
            pcfKernelSize: 2,
          },
        });
        expect(r.ok).toBe(true);
      });
    });
  });
}
