import { PhysicsWorldResource } from '@forgeax/engine-physics';
import { rhi } from '@forgeax/engine-rhi-null';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { ok } from '@forgeax/engine-types';
import { assert, describe, expect, it, vi } from 'vitest';
import {
  createRenderFeatureHost,
  getRenderFeaturePlanExecutionProjection,
  type RenderFeaturePlanExecution,
} from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import {
  createWaterAdvancedFeature,
  waterAdvancedShallowFoamTargets,
} from '../water/advanced-feature';
import { advancedShallowShader } from '../water/advanced-shallow-shader';
import { createWaterFluidFeature } from '../water/fluid-feature';
import { advancedPhysicsFixture, advancedWaterFixture } from './advanced-water-fixture';
import {
  abortFeatureFrame,
  allFeaturePlans,
  prepareFeatureFrame,
  submitFeatureFrame,
} from './feature-frame-driver';

describe('advanced shallow compute resource contract', () => {
  it('keeps producer WaterInfo current when fluid extraction runs first', async () => {
    const fixture = await advancedWaterFixture(undefined, ['shallow', 'shallowFoam'], 'ocean');
    fixture.simulation.reset();
    fixture.update();
    const previous = {
      status: 'ready' as const,
      bodyGeneration: fixture.simulation.body.generation,
      zoneGeneration: 7,
      targetName: 'water-info-previous',
      targetFormat: 'rgba16float' as const,
      slice: 0,
      centerXZ: [10, 20] as const,
      extentM: [64, 64] as const,
      waterHeightRangeM: [-4, 8] as const,
      groundHeightRangeM: [-12, 8] as const,
      maxVelocityMPerSec: 10,
    };
    fixture.simulation.bindWaterInfo(previous);
    const fluid = createWaterFluidFeature({
      contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
    });
    fluid.extract(fixture.context).unwrap();
    const current = {
      ...previous,
      zoneGeneration: 8,
      targetName: 'water-info-current',
      slice: 1,
      centerXZ: [12, 24] as const,
    };
    fixture.simulation.bindWaterInfo(current);
    expect(fixture.simulation.frame()?.waterInfo).toEqual(current);
  });

  it('feeds shared history only from the current publishing Advanced generation', async () => {
    const fixture = await advancedWaterFixture(undefined, ['shallow', 'shallowFoam'], 'ocean');
    const physics = {
      getCommittedColliderPrimitives: (entity: number) =>
        ok({
          entity,
          generation: 1,
          completedStep: 0,
          motionDiscontinuity: 0,
          positionM: [0, 0, 0] as const,
          rotation: [0, 0, 0, 1] as const,
          scale: [1, 1, 1] as const,
          centerOfMassM: [0, 0, 0] as const,
          linearVelocityMps: [0, 0, 0] as const,
          angularVelocityRadps: [0, 0, 0] as const,
          rawAggregateCount: 0,
          elements: [],
        }),
      intersectsCommittedBodyObb: () => ok(false),
    };
    fixture.world.insertResource(PhysicsWorldResource, advancedPhysicsFixture(physics));
    fixture.world.update(1 / 60).unwrap();
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const module = (await rhi.createShaderModule(device, { code: 'unit plan module' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(module) }),
    });
    const advanced = createWaterAdvancedFeature({});
    const fluid = createWaterFluidFeature({
      contactFoam: { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
    });
    const producerFrame = vi.spyOn(fixture.simulation, 'frame');
    fluid.extract(fixture.context).unwrap();
    expect(producerFrame).not.toHaveBeenCalled();
    producerFrame.mockRestore();
    const host = createRenderFeatureHost([advanced]).unwrap();
    const input = {
      world: fixture.world,
      frameNumber: 1,
      generation: 0,
      deviceGeneration: 0,
      caps: {
        ...device.caps,
        compute: true,
        storageBuffer: true,
        storageTexture: true,
        rgba16floatStorage: true,
        rgba32floatStorage: true,
      },
      limits: { maxTextureDimension2D: 8192 },
      gpuWork: gpu,
    };
    let batch: ReturnType<typeof prepareFeatureFrame> | undefined;
    const plan = () => {
      batch = prepareFeatureFrame(host, [
        { ...input, identity: 'main', render: true },
        { ...input, identity: 'secondary', render: true },
      ]);
      const executions = allFeaturePlans(batch)
        .map(getRenderFeaturePlanExecutionProjection)
        .filter((execution): execution is RenderFeaturePlanExecution => execution !== undefined);
      const source = fluid.extract(fixture.context).unwrap().shallowFoamSources?.[0];
      return { executions, source };
    };
    const release = (submit: boolean) => {
      if (submit) submitFeatureFrame(host);
      else abortFeatureFrame(host);
      for (const resources of batch?.preparedResourceBatches ?? []) resources.release().unwrap();
      batch = undefined;
    };
    try {
      const first = plan();
      assert(first.source);
      const accepted = waterAdvancedShallowFoamTargets(first.source, first.executions);
      expect(accepted?.foam.allocationKey).toMatch(/-b1-g1$/);
      expect(accepted?.mapping.allocationKey).toMatch(/-b1-g1$/);
      expect(
        first.executions
          .flatMap((execution) => execution.passes)
          .filter((pass) => pass.name.endsWith('-publish-shallow')),
      ).toHaveLength(1);
      release(true);
      fixture.update(2);
      fixture.world.removeResource(PhysicsWorldResource);
      const blocked = plan();
      assert(blocked.source);
      expect(blocked.source.simulationGeneration).toBe(first.source.simulationGeneration);
      expect(
        blocked.executions
          .flatMap((execution) => execution.materialTextureTargets ?? [])
          .some((target) => target.name === accepted?.foam.name),
      ).toBe(true);
      expect(waterAdvancedShallowFoamTargets(blocked.source, blocked.executions)).toBeUndefined();
      release(false);
      fixture.world.insertResource(PhysicsWorldResource, advancedPhysicsFixture(physics));
      fixture.simulation.reset();
      fixture.update(3);
      const reset = plan();
      assert(reset.source);
      expect(reset.source.simulationGeneration).toBe(2);
      expect(
        waterAdvancedShallowFoamTargets(reset.source, reset.executions)?.foam.allocationKey,
      ).toMatch(/-g2$/);
      expect(waterAdvancedShallowFoamTargets(first.source, reset.executions)).toBeUndefined();
      release(true);
      fixture.simulation.setEnabled(false);
      const disabled = plan();
      expect(disabled.source).toBeUndefined();
      expect(waterAdvancedShallowFoamTargets(reset.source, disabled.executions)).toBeUndefined();
      release(false);
    } finally {
      if (batch !== undefined) release(false);
      host.dispose().unwrap();
      gpu.dispose().unwrap();
    }
  });

  it('captures initial foam without reading the unpublished render grid', async () => {
    const fixture = await advancedWaterFixture({ kind: 'disabled' }, ['shallow', 'shallowFoam']);
    fixture.simulation.reset();
    fixture.simulation.requestStageCapture();
    fixture.update(2);
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const feature = createWaterAdvancedFeature({});
    const plan = feature
      .plan(feature.extract(fixture.context).unwrap(), {
        caps: {
          ...device.caps,
          compute: true,
          storageBuffer: true,
          storageTexture: true,
          rgba16floatStorage: true,
          rgba32floatStorage: true,
        },
        limits: { maxTextureDimension2D: 8192 },
        frame: { frameNumber: 2 },
        generation: 1,
        views: [],
      })
      .unwrap();
    const capture = plan.work
      .flatMap((work) => work.passes)
      .find((pass) => pass.name.endsWith('-foam-capture'));
    expect(capture?.kind).toBe('copy');
    if (capture?.kind !== 'copy') throw new Error('Missing initial foam capture');
    expect(capture.textureReadbacks?.some((row) => row.name.endsWith('-render-grid'))).toBe(false);
  });

  it('reprojects the previous frame only in the first WaterBody substep', async () => {
    const fixture = await advancedWaterFixture({ kind: 'disabled' });
    fixture.simulation.submitted(fixture.frame, fixture.frame.stages.length).unwrap();
    fixture.simulation
      .completed(fixture.frame, { frameId: 1, deviceGeneration: 0, graphGeneration: 1 })
      .unwrap();
    fixture.simulation
      .update({ deltaSeconds: 1 / 30, timeSeconds: 2, centerXZ: [11, 20], yawRadians: 0 })
      .unwrap();
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const feature = createWaterAdvancedFeature({});
    const data = feature.extract(fixture.context).unwrap();
    const plan = feature
      .plan(data, {
        caps: {
          ...device.caps,
          compute: true,
          storageBuffer: true,
          storageTexture: true,
          rgba16floatStorage: true,
          rgba32floatStorage: true,
        },
        limits: { maxTextureDimension2D: 8192 },
        frame: { frameNumber: 2 },
        generation: 1,
        views: [],
      })
      .unwrap();
    const params = plan.work
      .flatMap((work) => work.resources)
      .filter((row) => row.kind === 'buffer' && /-pre-sim-params$/.test(row.name));
    expect(params).toHaveLength(2);
    const previousCenters = params.map((row) => {
      if (row.kind !== 'buffer' || row.data === undefined)
        throw new Error('Missing Pre Sim inputs');
      return Array.from(
        new Float32Array(row.data.buffer, row.data.byteOffset, row.data.byteLength / 4).slice(
          12,
          14,
        ),
      );
    });
    expect(previousCenters).toEqual([
      [10, 20],
      [11, 20],
    ]);
  });

  it.each([
    'initial',
    'reset',
    'device-generation',
  ] as const)('seeds %s mapping without reading unwritten history', async (boundary) => {
    const fixture = await advancedWaterFixture({ kind: 'disabled' });
    if (boundary !== 'initial') {
      if (boundary === 'reset') fixture.simulation.reset();
      else fixture.simulation.deviceLost();
      fixture.update(2);
    }
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const feature = createWaterAdvancedFeature({});
    const data = feature.extract(fixture.context).unwrap();
    const plan = feature
      .plan(data, {
        caps: {
          ...device.caps,
          compute: true,
          storageBuffer: true,
          storageTexture: true,
          rgba16floatStorage: true,
          rgba32floatStorage: true,
        },
        limits: { maxTextureDimension2D: 8192 },
        frame: { frameNumber: 1 },
        generation: 1,
        views: [],
      })
      .unwrap();
    const work = plan.work[0];
    assert(work);
    const publish = work.resources.find(
      (row) => row.kind === 'compute-program' && row.program.entryPoints.includes('publish'),
    );
    const bindings = work.resources.find(
      (row) => row.kind === 'compute-bindings' && row.name.endsWith('-publish-shallow-bindings'),
    );
    if (publish?.kind !== 'compute-program' || bindings?.kind !== 'compute-bindings')
      throw new Error('missing shallow publication');
    const compiled = (
      await compileShader(
        typeof publish.program.wgsl === 'string'
          ? publish.program.wgsl
          : publish.program.wgsl.read(),
        { computeEntry: 'publish' },
      )
    ).unwrap();
    expect(compiled.reflection.boundGlobals.some((row) => row.binding === 16)).toBe(false);
    expect(
      publish.program.bindings?.flatMap((group) => group.entries).some((row) => row.binding === 16),
    ).toBe(false);
    expect(bindings.entries.some((row) => row.binding === 16)).toBe(false);
    expect(work.passes.findIndex((row) => row.name.endsWith('-copy-history'))).toBeGreaterThan(
      work.passes.findIndex((row) => row.name.endsWith('-publish-shallow')),
    );
  });

  it('retains the previous accepted mapping after seeding', async () => {
    const compiled = (
      await compileShader(advancedShallowShader('rgba16float', false, false, 'retained'), {
        computeEntry: 'publish',
      })
    ).unwrap();
    expect(compiled.reflection.boundGlobals.some((row) => row.binding === 16)).toBe(true);
  });

  it('copies River Bake using only the declared input and output textures', async () => {
    const compiled = (
      await compileShader(advancedShallowShader('rgba16float', true), {
        computeEntry: 'bake',
      })
    ).unwrap();
    expect(
      compiled.reflection.boundGlobals.map((row) => row.binding).sort((a, b) => a - b),
    ).toEqual([0, 12]);
  });

  it.each([
    false,
    true,
  ])('compiles the actual Pre Sim kernel with rigid fields=%s', async (rigid) => {
    const compiled = (
      await compileShader(advancedShallowShader('rgba16float', true, rigid), {
        computeEntry: 'stage',
      })
    ).unwrap();
    const globals = compiled.reflection.boundGlobals;
    expect(globals.filter((row) => row.resourceKind === 'storage-buffer')).toHaveLength(
      rigid ? 7 : 4,
    );
    expect(globals.filter((row) => row.textureClass === 'storage')).toHaveLength(4);
    for (const binding of [17, 18, 19])
      expect(globals.some((row) => row.binding === binding)).toBe(rigid);
  });
});
