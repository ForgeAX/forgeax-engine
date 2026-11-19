import { AssetGuid } from '@forgeax/engine-pack/guid';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { derive, type MaterialAsset, resolveMaterialAsset } from '@forgeax/engine-types';
import {
  buildWaterWaveUploadPlan,
  WATER_WAVE_LWC_TILE_LENGTH_M,
  type WaterWaveUploadBody,
} from '@forgeax/engine-water';
import { assert, describe, expect, it, vi } from 'vitest';
import type { RenderSystemInternals } from '../../record/render-context';
import type { RenderPipelineBuildContext, RenderPipelineFrame } from '../../render-pipeline';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { ViewDrawReceipt, type WaterBakedDrawReceiptFact } from '../../world/view-draw-receipt';
import { prepareWaterFluidFoamFrame } from '../fluid-foam';
import {
  addWaterFluidGraph,
  type WaterFluidMaterialPublication,
  waterFluidBodyDescriptorReader,
} from '../fluid-graph';
import { inspectWaterFoamDraw, type WaterFoamDrawEvidence } from '../foam-inspection';
import type { WaterInfoFramePublication } from '../water-info-feature';

describe('accepted Water foam inspection', () => {
  it('joins Baked provenance to the accepted draw, publication, and exact binding closure', () => {
    const context = {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    } as const;
    const material = {
      ...defaultMaterialSnapshot(),
      surfaceModel: 'single-layer-water' as const,
      staticSwitches: { waterBakedSimulation: true },
      materialPublication: {
        identity: {
          materialGuid: 'water-material',
          publicationGeneration: 3,
          specializationKey: 'material-specialization',
          artifactHash: 'material-artifact',
        },
        programs: [
          {
            pass: 'forward',
            context,
            address: 'direct' as const,
            specializationKey: 'water-program',
            artifactHash: 'water-artifact',
          },
        ],
      },
    };
    const lineage = {
      version: 'water-river-bake/2' as const,
      textureGuid: 'baked-texture',
      textureRevision: 19,
      normalTextureGuid: 'baked-normal-texture',
      normalTextureRevision: 20,
      normalTextureFormat: 'rgba16float' as const,
      normalBasis: 'lattice-axis0-axis1-up/1' as const,
      sourceRecipeGuid: 'historical-recipe',
      sourceRecipeVersion: 'sha256:historical-recipe',
      sourceBodyGuid: 'historical-body',
      sourceBodyGeneration: 7,
      simulationGeneration: 2,
      sequence: 3,
      frameId: 4,
      deviceGeneration: 5,
      graphGeneration: 6,
      sourceWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
      sourceGeometryProjectionHash: 'a'.repeat(64),
      sourceFrame: { generation: 2, sequence: 3, step: 4, timeSeconds: 1.5 },
    };
    const draw = (
      overrides: Partial<WaterBakedDrawReceiptFact> = {},
      sourceOverrides: Record<string, unknown> = {},
    ): WaterBakedDrawReceiptFact => {
      const binding = {
        viewIdentity: 'view-main',
        frameGeneration: 9,
        deviceGeneration: 2,
        drawDataBufferIdentity: 10,
        drawDataDynamicOffset: 256,
        waterInfoDynamicOffset: 512,
        waterMeshInstanceBufferIdentity: 12,
        waterMeshInstanceBufferByteLength: 256,
        waterMeshInstanceDynamicOffset: 0,
        waterMeshInstanceRange: [0, 64] as const,
        bakedDescriptorBufferIdentity: 13,
        bakedSamplesBufferIdentity: 14,
      };
      const source = {
        worldIdentity: 'world-main',
        bodyIndex: 1,
        bodyGuid: 'current-body',
        bodyGeneration: 2,
        zoneGeneration: 3,
        descriptorRange: [48, 96] as const,
        sampleRange: [0, 144] as const,
        binding: {
          drawDataRowOffset: 256,
          descriptorBufferIdentity: 13,
          descriptorBufferByteLength: 96,
          sampleBufferIdentity: 14,
          sampleBufferByteLength: 144,
          complete: true,
          viewIdentity: 'view-main',
          frameGeneration: 9,
          deviceGeneration: 2,
        },
        lineage,
        ...sourceOverrides,
      };
      return {
        entityKey: 21,
        submeshIndex: 0,
        materialSlot: 0,
        viewIdentity: 'view-main',
        frameId: 9,
        deviceGeneration: 2,
        graphGeneration: 4,
        drawKey: 'draw-water-21-0',
        ownerWorldIdentity: 'world-main',
        materialWorldIdentity: 'world-main',
        drawBinding: binding,
        materialIdentity: {
          materialGuid: 'water-material',
          publicationGeneration: 3,
          specializationKey: 'material-specialization',
          artifactHash: 'material-artifact',
          programKey: 'water-program',
        },
        programIdentity: {
          pass: 'forward',
          context,
          address: 'direct' as const,
          specializationKey: 'water-program',
          artifactHash: 'water-artifact',
        },
        sourceBodyIndices: [1],
        sources: [source],
        ...overrides,
      } as WaterBakedDrawReceiptFact;
    };
    const evidenceFor = (
      draws: readonly WaterBakedDrawReceiptFact[],
      overrides: Partial<WaterFoamDrawEvidence> = {},
    ) => ({
      frameId: 9,
      deviceGeneration: 2,
      graphGeneration: 4,
      viewIdentity: 'view-main',
      drawKey: 'draw-water-21-0',
      ownerWorldIdentity: 'world-main',
      materialWorldIdentity: 'world-main',
      entityKey: 21,
      materialSlot: 0,
      submitted: true,
      descriptor: undefined,
      shared: undefined,
      waterBakedDraws: draws,
      ...overrides,
    });
    const acceptedReceipt = (...draws: WaterBakedDrawReceiptFact[]) => {
      const receipt = new ViewDrawReceipt();
      for (const fact of draws)
        receipt.stageWaterBakedDraw(9, fact, {
          viewIdentity: 'view-main',
          deviceGeneration: 2,
          graphGeneration: 4,
        });
      receipt.commitWaterBakedDraws(9);
      return receipt.waterBakedDraws;
    };
    const inspect = (
      draws: readonly WaterBakedDrawReceiptFact[],
      overrides?: Partial<WaterFoamDrawEvidence>,
    ) =>
      inspectWaterFoamDraw(
        material,
        {} as RenderSystemInternals,
        undefined,
        4,
        evidenceFor(draws, overrides),
      )?.bakedSource;

    const historicalDraw = draw();
    const historicalProgram = historicalDraw.programIdentity;
    assert(historicalProgram);
    const historicalBinding = historicalDraw.drawBinding;
    assert(historicalBinding);
    const repeatedClosure = acceptedReceipt(historicalDraw, { ...historicalDraw, submeshIndex: 1 });
    expect(repeatedClosure).toHaveLength(1);
    expect(inspect(repeatedClosure)).toMatchObject({
      status: 'provenance-available',
      sources: [
        {
          bodyGuid: 'current-body',
          lineage: {
            sourceBodyGuid: 'historical-body',
            sourceWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
            sourceGeometryProjectionHash: 'a'.repeat(64),
            sourceFrame: { generation: 2, sequence: 3, step: 4, timeSeconds: 1.5 },
          },
        },
      ],
    });
    const directDraw = draw();
    const directInspection = inspect(acceptedReceipt(directDraw));
    const mutableLineage = lineage as unknown as {
      sourceWorldMatrixM: number[];
      sourceFrame: { step: number };
    };
    mutableLineage.sourceWorldMatrixM[12] = 999;
    mutableLineage.sourceFrame.step = 999;
    expect(directInspection).toMatchObject({
      status: 'provenance-available',
      sources: [
        {
          lineage: {
            sourceWorldMatrixM: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 5, 1],
            sourceFrame: { step: 4 },
          },
        },
      ],
    });
    mutableLineage.sourceWorldMatrixM[12] = 3;
    mutableLineage.sourceFrame.step = 4;

    expect(
      inspect(repeatedClosure, {
        ownerWorldIdentity: 'other-world',
        materialWorldIdentity: 'other-world',
      }),
    ).toMatchObject({ status: 'provenance-unavailable', reason: 'world-identity-mismatch' });
    expect(
      inspect(repeatedClosure, {
        frameId: 10,
        ownerWorldIdentity: 'new-owner-world',
        materialWorldIdentity: 'world-main',
      }),
    ).toMatchObject({ status: 'provenance-unavailable', reason: 'frame-mismatch' });
    expect(
      inspect(
        acceptedReceipt(
          draw({
            materialIdentity: { ...historicalDraw.materialIdentity, programKey: 'wrong-program' },
            programIdentity: {
              ...historicalProgram,
              specializationKey: 'wrong-program',
            },
          }),
        ),
      ),
    ).toMatchObject({ status: 'provenance-unavailable', reason: 'draw-receipt-missing' });
    expect(
      inspect(
        acceptedReceipt(
          draw({
            drawBinding: { ...historicalBinding, drawDataDynamicOffset: 512 },
          }),
        ),
      ),
    ).toMatchObject({
      status: 'provenance-unavailable',
      reason: 'source-identity-incomplete',
    });
    expect(
      inspect(
        acceptedReceipt(
          historicalDraw,
          draw(
            {
              submeshIndex: 1,
              sourceBodyIndices: [2],
            },
            {
              bodyIndex: 2,
              bodyGuid: 'another-current-body',
              descriptorRange: [0, 48],
              sampleRange: [0, 144],
            },
          ),
        ),
      ),
    ).toMatchObject({ status: 'provenance-unavailable', reason: 'ambiguous-draw-match' });
    expect(
      inspect(acceptedReceipt(draw({}, { lineage: { ...lineage, textureRevision: undefined } }))),
    ).toMatchObject({
      status: 'provenance-unavailable',
      reason: 'source-lineage-unavailable',
    });
  });

  it('refreshes one compiled descriptor upload from the exact recording publication', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const texture = graph
      .createTexture('shared-fields', {
        format: 'rgba32float',
        size: { width: 1, height: 1, depthOrArrayLayers: 5 },
      })
      .unwrap();
    const fields = graph.view(texture, { dimension: '2d-array', arrayLayerCount: 5 }).unwrap();
    const foamTexture = graph
      .createTexture('shared-foam', {
        format: 'rgba16float',
        size: { width: 16, height: 16 },
      })
      .unwrap();
    const foam = graph.view(foamTexture).unwrap();
    const publication = (frameNumber: number, names: readonly string[], owner: string) => {
      const waveBodies: WaterWaveUploadBody[] = names.map((bodyGuid) => ({
        worldId: 0,
        worldIdentity: 'test-world',
        bodyGuid,
        bodyGeneration: 1,
        zoneGeneration: 3,
        waveSet: {
          inputDigest: '0'.repeat(64),
          waves: [],
          depthMaskM: 0,
          maxWaveHeightM: 0,
          timeSource: 'scene-clock',
        },
        timeSeconds: frameNumber,
        previousTimeSeconds: frameNumber - 1,
        baseHeightM: 0,
        tileOriginWorldXZ: [0, 0],
        tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
        heightSource: { kind: 'fixed', fixedHeightM: 0, fixedDepthM: 5, fixedVelocityXZ: [0, 0] },
        supportsWaves: false,
        usesFlatSurfaceHeight: true,
        meshEdgeOverlayEnabled: false,
      }));
      const contactFoam = prepareWaterFluidFoamFrame(
        {
          timeSeconds: frameNumber,
          roots: [],
          events: [],
          materials: [
            {
              worldIdentity: 'test-world',
              bodyGuid: owner,
              bodyGeneration: 1,
              materialHandle: 1,
              mapping: { kind: 'mapped', centerXZ: [frameNumber, 0], extentM: 16 },
            },
          ],
        },
        { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
        1,
        frameNumber,
      ).unwrap();
      assert(contactFoam);
      const target = { address: frameNumber === 7 ? 'repeat' : 'clamp-to-edge', filter: 'linear' };
      const simulation = {
        instance: {
          bodyGuid: 'ocean',
          bodyGeneration: 1,
          recipe: {
            solverMode: 'ripple',
            gridExtentM: [32, 48],
            resolution: [16, 16],
            foamEnabled: true,
            targets: { normalHeight: target, velocityForces: target, forces: target, foam: target },
            waveFoam: { resolution: 16, gridExtentM: 24 },
          },
        },
        simulationGeneration: frameNumber,
        deviceGeneration: 1,
        baseStep: 0,
        previousCenterM: [frameNumber, 0, -frameNumber],
        previousFrameCenterM: [frameNumber - 1, 0, 0],
        waveFoamCenterM: [frameNumber, 0, 2],
        previousWaveFoamCenterM: [frameNumber - 1, 0, 2],
        steps: [{ fixedStep: frameNumber * 2 }],
      } as unknown as WaterFluidMaterialPublication['render']['simulations'][number]['frame'];
      return {
        render: {
          token: String(frameNumber),
          simulations: [{ worldIndex: 0, worldIdentity: 'test-world', frame: simulation }],
          waterInfoViewIdentity: 'main',
          frameNumber,
          deviceGeneration: 1,
          contactFoam,
          required: new Set<string>(),
          encoded: new Set<string>(),
        },
        waterInfo: {
          viewIdentity: 'main',
          frameGeneration: frameNumber,
          deviceGeneration: 1,
          graphResourceVersion: 'test',
          targets: [],
          rows: new Map(),
          waterInfoAvailability: new Map(),
          waveBodies,
          waveUploadPlan: buildWaterWaveUploadPlan(waveBodies).unwrap(),
        } as WaterInfoFramePublication,
      };
    };
    const first = publication(7, ['ocean', 'lake'], 'ocean');
    const context = {
      graph,
      viewIdentity: 'main',
      waterFluid: { publication: first, read: (frame: { fluid?: typeof first }) => frame.fluid },
      getSharedGraphTextureBinding: (name: string) =>
        name === 'water-fluid-material-fields'
          ? { view: fields, format: 'rgba32float' }
          : name === 'water-fluid-foam'
            ? { view: foam, format: 'rgba16float' }
            : undefined,
    } as unknown as RenderPipelineBuildContext<RenderPipelineFrame>;
    addWaterFluidGraph(context).unwrap();
    const secondaryOf = (frameNumber: number) => {
      const selected = publication(frameNumber, ['ocean', 'sea'], 'sea');
      return { ...selected, waterInfo: { ...selected.waterInfo, viewIdentity: 'secondary' } };
    };
    addWaterFluidGraph({
      ...context,
      viewIdentity: 'secondary',
      waterFluid: {
        publication: secondaryOf(7),
        read: (frame) => (frame as unknown as { secondary?: typeof first }).secondary,
      },
    }).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const writes: Float32Array[] = [];
    const write = device.queue.writeBuffer.bind(device.queue);
    vi.spyOn(device.queue, 'writeBuffer').mockImplementation((buffer, offset, data, ...rest) => {
      if (data instanceof Float32Array) writes.push(data.slice());
      return write(buffer, offset, data, ...rest);
    });
    const descriptorOf = waterFluidBodyDescriptorReader(graph);
    assert(descriptorOf);
    const body = {
      guid: 'ocean',
      generation: 1,
      worldIdentity: 'test-world',
      zoneGeneration: 3,
      viewIdentity: 'main',
    };
    const execute = (fluid: typeof first | undefined) =>
      compiled.execute({
        encoder: device.createCommandEncoder().unwrap(),
        runtime: { device },
        fluid,
        secondary: fluid === undefined ? undefined : secondaryOf(fluid.render.frameNumber),
      } as unknown as RenderPipelineFrame);
    expect(descriptorOf(body)).toBeUndefined();
    execute(first).unwrap();
    const held = descriptorOf(body);
    expect(held).toMatchObject({ frameId: 7, deviceGeneration: 1, bodyIndex: 1, sharedFoam: true });
    expect(descriptorOf({ ...body, viewIdentity: 'secondary' })).toMatchObject({
      frameId: 7,
      bodyIndex: 0,
      sharedFoam: false,
    });
    expect(writes.at(-2)?.slice(32, 32 + 16)).toEqual(
      new Float32Array([7, -7, 32, 48, 0, 1, 7, 14, 1, 1, 1, 1, 16, 16, 31, 31]),
    );
    const second = publication(8, ['ocean', 'river'], 'river');
    expect(descriptorOf(body)).toEqual(held);
    execute(second).unwrap();
    expect(descriptorOf(body)).toMatchObject({ frameId: 8, bodyIndex: 0, sharedFoam: false });
    expect(descriptorOf({ ...body, guid: 'river' })).toMatchObject({
      frameId: 8,
      bodyIndex: 1,
      sharedFoam: true,
    });
    expect(descriptorOf({ ...body, guid: 'lake' })).toBeUndefined();
    expect(writes.at(-2)?.slice(0, 16)).toEqual(
      new Float32Array([8, -8, 32, 48, 0, 1, 8, 16, 1, 1, 1, 0, 16, 16, 0, 31]),
    );
    expect(writes.at(-2)?.[32 + 11]).toBe(1);
    expect(descriptorOf({ ...body, guid: 'river', viewIdentity: 'secondary' })).toBeUndefined();
    expect(held).toMatchObject({ frameId: 7, bodyIndex: 1, sharedFoam: true });
    compiled.discardExecution();
    expect(execute(undefined).ok).toBe(false);
    expect(execute({ ...second, waterInfo: { ...second.waterInfo, frameGeneration: 7 } }).ok).toBe(
      false,
    );
    expect(
      execute({ ...second, waterInfo: { ...second.waterInfo, viewIdentity: 'other' } }).ok,
    ).toBe(false);
    expect(execute(publication(9, ['ocean', 'lake', 'river'], 'ocean')).ok).toBe(false);
    expect(descriptorOf(body)).toMatchObject({ frameId: 8, bodyIndex: 0, sharedFoam: false });
    execute(publication(10, ['ocean', 'river'], 'ocean')).unwrap();
    expect(descriptorOf(body)).toMatchObject({ frameId: 10, bodyIndex: 0, sharedFoam: true });
    expect(descriptorOf({ ...body, viewIdentity: 'secondary' })).toMatchObject({
      frameId: 10,
      bodyIndex: 0,
      sharedFoam: false,
    });
    expect(held).toMatchObject({ frameId: 7, bodyIndex: 1, sharedFoam: true });
    compiled.commitExecution();
    (await compiled.retire()).unwrap();
    vi.restoreAllMocks();
  });

  it('attributes shared foam only to the uploaded Body row, reflected bindings and current physical graph closure', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shared = new RenderGraphBuilder();
    const foam = shared
      .createTexture('water-fluid-foam-final', {
        format: 'rgba16float',
        size: { width: 16, height: 16 },
      })
      .unwrap();
    const foamView = shared.view(foam).unwrap();
    shared
      .addRasterPass('water-fluid-foam-final-write', {
        accesses: [{ resource: foamView, usage: 'color-attachment' }],
        colorAttachments: [
          { view: foamView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
        encode() {},
      })
      .unwrap();
    const producer = shared.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const publishedTexture = producer.getColorTargetTexture('water-fluid-foam-final');
    assert(publishedTexture);
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const imported = graph
      .importTexture(
        'shared:water-fluid-foam-final',
        {
          format: 'rgba16float',
          size: { width: 16, height: 16 },
          usage: 4,
        },
        () => publishedTexture,
      )
      .unwrap();
    const importedView = graph.view(imported).unwrap();
    const waveBodies: WaterWaveUploadBody[] = ['ocean', 'lake'].map((bodyGuid) => ({
      worldId: 0,
      worldIdentity: 'test-world',
      bodyGuid,
      bodyGeneration: 1,
      zoneGeneration: 3,
      waveSet: {
        inputDigest: '0'.repeat(64),
        waves: [],
        depthMaskM: 0,
        maxWaveHeightM: 0,
        timeSource: 'scene-clock',
      },
      timeSeconds: 2,
      previousTimeSeconds: 1,
      baseHeightM: 0,
      tileOriginWorldXZ: [0, 0],
      tileLengthM: WATER_WAVE_LWC_TILE_LENGTH_M,
      heightSource: { kind: 'fixed', fixedHeightM: 0, fixedDepthM: 5, fixedVelocityXZ: [0, 0] },
      supportsWaves: false,
      usesFlatSurfaceHeight: true,
      meshEdgeOverlayEnabled: false,
    }));
    const contactFoam = prepareWaterFluidFoamFrame(
      {
        timeSeconds: 0,
        roots: [],
        events: [],
        materials: [
          {
            worldIdentity: 'test-world',
            bodyGuid: 'ocean',
            bodyGeneration: 1,
            materialHandle: 1,
            mapping: { kind: 'mapped', centerXZ: [0, 0], extentM: 16 },
          },
        ],
      },
      { resolution: 16, decayPerSecond: 1, strengthPerMps: 1 },
      1,
      7,
    ).unwrap();
    assert(contactFoam);
    const materialPublication = {
      waterInfo: {
        graphResourceVersion: 'test',
        targets: [],
        rows: new Map(),
        waterInfoAvailability: new Map(),
        waveBodies,
        waveUploadPlan: buildWaterWaveUploadPlan(waveBodies).unwrap(),
        viewIdentity: 'main',
        frameGeneration: 7,
        deviceGeneration: 1,
      } as WaterInfoFramePublication,
      render: {
        token: 'frame',
        simulations: [],
        waterInfoViewIdentity: undefined,
        frameNumber: 7,
        deviceGeneration: 1,
        contactFoam,
        required: new Set<string>(),
        encoded: new Set<string>(),
      },
    };
    const context = {
      graph,
      viewIdentity: 'main',
      waterFluid: { publication: materialPublication, read: () => materialPublication },
      getSharedGraphTextureBinding: (name: string) =>
        name === 'water-fluid-foam' ? { view: importedView, format: 'rgba16float' } : undefined,
    } as unknown as RenderPipelineBuildContext<RenderPipelineFrame>;
    const fluid = addWaterFluidGraph(context).unwrap();
    const output = graph
      .createTexture('water-slw-optics-hdr', { format: 'rgba16float', size: 'surface' })
      .unwrap();
    const outputView = graph.view(output).unwrap();
    graph
      .addRasterPass('water-slw-inner-color', {
        accesses: [
          { resource: importedView, usage: 'sampled-read' },
          { resource: fluid.fields, usage: 'sampled-read' },
          { resource: fluid.descriptors, usage: 'storage-read' },
          { resource: outputView, usage: 'color-attachment' },
        ],
        colorAttachments: [
          { view: outputView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        encode() {},
      })
      .unwrap();
    const consumer = graph.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    consumer
      .execute({
        encoder: device.createCommandEncoder().unwrap(),
        runtime: { device },
      } as unknown as RenderPipelineFrame)
      .unwrap();
    const body = {
      guid: 'ocean',
      generation: 1,
      worldIdentity: 'test-world',
      zoneGeneration: 3,
      viewIdentity: 'main',
    };
    const descriptorOf = waterFluidBodyDescriptorReader(graph);
    assert(descriptorOf);
    const descriptor = descriptorOf(body);
    assert(descriptor);
    const sharedProof = { frameId: 7, deviceGeneration: 1, graph: producer.inspect() };
    const evidence: WaterFoamDrawEvidence = {
      frameId: 7,
      deviceGeneration: 1,
      submitted: true,
      descriptor,
      shared: sharedProof,
    };
    const end = derive([]).userRegionBindingEnd;
    const reflected = [end + 17, end + 19, end + 20];
    const internals = (bindings = reflected, water = 'water-frame/3') =>
      ({
        shaderRegistry: {
          findMaterialArtifact: () => ({
            ok: true,
            value: {
              paramSchema: [],
              program: { materialBindings: bindings },
              receipt: { systemInputs: { water } },
            },
          }),
        },
      }) as unknown as RenderSystemInternals;
    const material = {
      ...defaultMaterialSnapshot(),
      surfaceModel: 'single-layer-water' as const,
      materialShaderId: 'water',
    };
    const inspect = (proof = evidence, info = consumer.inspect(), runtime = internals()) =>
      inspectWaterFoamDraw(material, runtime, info, 9, proof);
    expect(evidence.descriptor).toMatchObject({ sharedFoam: true });
    expect(inspect()).toMatchObject({
      foamRtConsumer: true,
      foamRt: { mode: 'produced', initialized: true },
      inputs: { materialSwitches: { fluidSimulationFoam: true } },
    });
    expect(descriptorOf({ ...body, guid: 'lake' })).toMatchObject({ sharedFoam: false });
    for (const owner of [
      { ...body, generation: 2 },
      { ...body, zoneGeneration: 4 },
      { ...body, worldIdentity: 'other' },
      { ...body, viewIdentity: 'other' },
    ])
      expect(descriptorOf(owner)).toBeUndefined();
    const reject = (proof = evidence, info = consumer.inspect(), runtime = internals()) => {
      const result = inspect(proof, info, runtime);
      expect(result?.inputs.materialSwitches.fluidSimulationFoam).toBe(false);
      expect(result?.foamRt.mode).toBe('unavailable');
    };
    reject({ ...evidence, descriptor: descriptorOf({ ...body, guid: 'lake' }) });
    reject({ ...evidence, descriptor: undefined });
    reject({ ...evidence, submitted: false });
    reject({ ...evidence, shared: { ...sharedProof, frameId: 6 } });
    reject({ ...evidence, shared: { ...sharedProof, deviceGeneration: 2 } });
    reject({ ...evidence, descriptor: { ...descriptor, frameId: 6 } });
    for (const binding of reflected)
      reject(
        evidence,
        consumer.inspect(),
        internals(reflected.filter((value) => value !== binding)),
      );
    reject(evidence, consumer.inspect(), internals(reflected, 'water-frame/2'));
    const info = consumer.inspect();
    reject(evidence, {
      ...info,
      resources: info.resources.map((resource) =>
        resource.label === 'shared:water-fluid-foam-final'
          ? { ...resource, physicalAllocationKey: 'unrelated' }
          : resource,
      ),
    });
    reject(evidence, {
      ...info,
      passes: info.passes.map((pass) => ({ ...pass, dependencies: [] })),
    });
    for (const label of ['shared:water-fluid-foam-final', descriptor.resource])
      reject(evidence, {
        ...info,
        passes: info.passes.map((pass) =>
          pass.name !== 'water-slw-inner-color'
            ? pass
            : { ...pass, accesses: pass.accesses.filter((access) => access.resource !== label) },
        ),
      });
    reject({
      ...evidence,
      shared: { ...sharedProof, graph: { ...sharedProof.graph, passes: [] } },
    });
    (await consumer.retire()).unwrap();
    (await producer.retire()).unwrap();
  });

  it('does not attribute a shared FoamRT resource to a draw without its Body descriptor and reflected binding', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder();
    graph
      .importTexture(
        'shared:water-fluid-foam-final',
        {
          format: 'rgba16float',
          size: { width: 16, height: 16 },
          usage: 4,
        },
        () => {
          throw new Error('inspection only');
        },
      )
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 16, height: 16 } }).unwrap();
    const inspection = inspectWaterFoamDraw(
      { ...defaultMaterialSnapshot(), surfaceModel: 'single-layer-water' },
      {} as RenderSystemInternals,
      compiled.inspect(),
      9,
    );
    expect(inspection?.inputs.materialSwitches.fluidSimulationFoam).toBe(false);
    expect(inspection?.foamRt.mode).toBe('unavailable');
    (await compiled.retire()).unwrap();
  });

  it.each([
    undefined,
    false,
  ])('reports the accepted parent selection with child override %s', (override) => {
    const parsed = AssetGuid.parse('019d0000-0000-7000-8000-000000000001');
    assert(parsed.ok);
    const parentGuid = parsed.value;
    const parent: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'test::water' } }],
      staticSwitches: { waterOceanFoam: true, waterBakedSimulation: true },
    };
    const child: MaterialAsset = {
      kind: 'material',
      parent: parentGuid,
      values: { foamPower: 0.2 },
      ...(override === undefined ? {} : { staticSwitches: { waterOceanFoam: override } }),
    };
    const resolved = resolveMaterialAsset('child', {
      [AssetGuid.format(parentGuid)]: parent,
      child,
    }).unwrap().asset;
    const snapshot = {
      ...defaultMaterialSnapshot(),
      surfaceModel: 'single-layer-water' as const,
      staticSwitches: resolved.staticSwitches,
      sourceAssets: {
        root: 2,
        revision: 7,
        assets: [
          { handle: 2, revision: 7, value: child },
          { handle: 1, revision: 4, value: parent },
        ],
      },
    };
    const inspection = inspectWaterFoamDraw(snapshot, {} as RenderSystemInternals, undefined, 9);
    expect(inspection?.inputs.materialSwitches).toMatchObject({
      waterOceanFoam: override ?? true,
      waterBakedSimulation: true,
      fluidSimulationFoam: false,
    });
    expect(inspection?.inputs.bakedRef).toBeUndefined();
    expect(inspection).toMatchObject({
      bakedSource: { status: 'provenance-unavailable', reason: 'submission-not-accepted' },
    });
  });
});
