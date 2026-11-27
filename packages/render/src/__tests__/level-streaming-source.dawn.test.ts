import { writeFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { inspect as inspectError } from 'node:util';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { type Component, Disabled, Entity } from '@forgeax/engine-ecs';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { textureContribution } from '@forgeax/engine-image';
import { Collider, RigidBody } from '@forgeax/engine-physics';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import {
  ChildOf,
  Children,
  Mobility,
  Name,
  sceneAssetContribution,
  Transform,
} from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import {
  createLevelStreamingPack,
  levelComponents,
} from '../../../../scripts/bench/fixtures/level-streaming-pack.mjs';
import profile from '../../../../scripts/bench/level-streaming-profile.json';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import { createLevelCandidate } from '../../../app/src/levels/candidate';
import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program-template';
import { loadRhiPack } from '../assembly/backend-contract';
import { MeshRenderer } from '../components';
import type { GpuScene } from '../gpu-scene';
import type { GpuSceneCapacityStatus } from '../gpu-scene-capacity';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import {
  Instances,
  Layer,
  MeshFilter,
  materialContribution,
  SceneInstance,
  ShadowParticipation,
  Visibility,
} from '../index';
import {
  dataOnlyLevelRenderHost,
  levelShaderManifestFixture,
} from './level-native-resources-fixture';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';

// App's package imports and this source Renderer must use the same real owner
// modules. The Pack producer still serializes its ordinary built output.
vi.mock('@forgeax/engine-render', () => import('../index'));
vi.mock('@forgeax/engine-render/internal', () => import('../internal'));

const shaders = await levelShaderManifestFixture();

// Actual Data admission still grants no C1, public Prepared or budget qualification.
it('admits two real closed Source Data sets while the old world renders, then retires without frames', async () => {
  const caseStarted = performance.now();
  const caseWindows: { stage: string; elapsedMs: number }[] = [];
  const mark = (stage: string) => {
    caseWindows.push({ stage, elapsedMs: performance.now() - caseStarted });
  };
  let pack: Awaited<ReturnType<typeof createLevelStreamingPack>> | undefined;
  let assets: AssetRegistry | undefined;
  let target: GPUTexture | undefined;
  let native: GPUDevice | undefined;
  const errors: unknown[] = [];
  const context = {
    configure(configuration: GPUCanvasConfiguration) {
      native = configuration.device;
      native.addEventListener('uncapturederror', (event) => errors.push(event.error));
      target?.destroy();
      target = native.createTexture({
        size: profile.target.drawingBuffer,
        format: configuration.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: configuration.viewFormats ?? [],
      });
    },
    getCurrentTexture() {
      if (target === undefined) throw Error('missing target');
      return target;
    },
    unconfigure() {},
  };
  let f: Awaited<ReturnType<typeof rendererInputHandoffFixture>> | undefined;
  const candidates: ReturnType<typeof createLevelCandidate>[] = [];
  const quanta: { phase: string; ms: number; resourcePhase: string | undefined }[] = [];
  const capacityAtRefusal: (GpuSceneCapacityStatus | undefined)[] = [];
  const peakPrivateInputPageBytes: number[] = [];
  let inputObservation: ReturnType<typeof observeSourceInputs> | undefined;
  const resources: unknown[] = [];
  const preparationSlices: { copy: number; phase: string; ms: number; work: number }[] = [];
  const frameWork: {
    index: number;
    candidatePhase: string | undefined;
    resourcePhase: string | undefined;
    drawMs: number;
    readyReturnIntervalMs: number | null;
    presentation: string;
  }[] = [];
  const preparationFailures: unknown[] = [];
  let pictures = 0;
  let postRetirementFrames = 0;
  const failures: unknown[] = [];
  try {
    pack = await createLevelStreamingPack(profile);
    mark('pack-produced');
    const components = new Map<string, Component>(
      [
        Disabled,
        Transform,
        ChildOf,
        Children,
        Name,
        Mobility,
        MeshFilter,
        MeshRenderer,
        ShadowParticipation,
        Visibility,
        Instances,
        Layer,
        SceneInstance,
        Collider,
        RigidBody,
      ].map((component) => [component.name, component]),
    );
    for (const component of levelComponents) {
      if (!components.has(component.name))
        throw Error(`missing owner component: ${component.name}`);
    }
    expect(components.size).toBe(levelComponents.length);
    assets = new AssetRegistry({
      components,
      shaderRegistry: new ShaderRegistry({
        manifestUrl: shaders.manifestUrl,
        prepareProgramCompiler: prepareShaderProgramCompiler,
      }),
    });
    assets.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
    assets.installDecoder(textureContribution.kind, textureContribution.decoder);
    assets.installDecoder(materialContribution.kind, materialContribution.decoder);
    assets.installDecoder(sceneAssetContribution.kind, sceneAssetContribution.decoder);
    f = await rendererInputHandoffFixture({
      assets,
      ...shaders,
      canvas: {
        width: profile.target.drawingBuffer[0],
        height: profile.target.drawingBuffer[1],
        getContext: () => context,
      },
      backend: loadRhiPack(webgpu),
    });
    mark('renderer-and-first-old-frame-ready');
    pictures++;
    const { world, scene: gpuScene, internals, draw, assets: sourceAssets } = f;
    const render = dataOnlyLevelRenderHost(f);
    const sourceInputs = observeSourceInputs(gpuScene);
    inputObservation = sourceInputs;
    if (native === undefined) throw Error('actual Renderer did not acquire native device');
    native.pushErrorScope('validation');
    for (const component of components.values()) {
      world.components.register(component).unwrap();
      expect(world.components.resolve(component.name)).toBe(component);
    }
    assets.setCatalogSource(pack.producer.catalog, pack.producer.fetch);
    const scene = (await assets.load(pack.rootGuid, 'scene')).unwrap();
    mark('runtime-pack-loaded');
    const loaded = runtimeAssets(assets).inspect();
    const permanentRows = gpuScene.inspect().tables;
    const entry = internals.sceneComposition?.entry;
    if (entry === undefined || target === undefined) throw Error('missing actual Scene/target');
    const nativeDevice = native,
      fixedTarget = target;
    const permanent = entry.projection.slotsSnapshot().at(0);
    if (permanent === undefined) throw Error('missing permanent row');
    const permanentIndex = gpuScene.primitiveIndexForSlot(permanent.slot);
    const pixels = await readTargetPixels(nativeDevice, fixedTarget);
    mark('starting-pixels-read');
    expect(pixels.some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
    expect(f.manager.currentOwner.gpuDriven.inspect().gpuOwnedEntityCount).toBeGreaterThan(0);
    let previousReadyReturn: number | undefined;
    const oldFrame = async (referencePose = false) => {
      if (f === undefined) throw Error('missing renderer');
      const candidate = candidates.at(-1)?.inspect();
      const before = performance.now();
      world
        .set(f.camera, Transform, {
          pos: [referencePose ? 0 : Math.sin(pictures * 0.1) * 0.05, 0, 4],
        })
        .unwrap();
      const result = await draw();
      const ended = performance.now();
      frameWork.push({
        index: pictures,
        candidatePhase: candidate?.phase,
        resourcePhase: candidate?.render?.resources?.phase,
        drawMs: ended - before,
        readyReturnIntervalMs:
          previousReadyReturn === undefined ? null : ended - previousReadyReturn,
        presentation: result.presentation,
      });
      expect(result.presentation).toBe('ready');
      previousReadyReturn = ended;
      pictures++;
    };
    const prepareCopy = async (copy: number) => {
      const candidate = createLevelCandidate({
        world,
        assets: sourceAssets,
        scene,
        render,
      });
      candidates.push(candidate);
      const before = pictures;
      const frames = drawWhilePreparing(oldFrame);
      let result: ReturnType<typeof candidate.step>;
      try {
        do {
          const phase = candidate.inspect().phase;
          let work = 0;
          const begin = performance.now();
          do {
            const before = performance.now();
            result = candidate.step();
            const observed = result.ok ? result.value : candidate.inspect();
            quanta.push({
              phase: observed.phase,
              ms: performance.now() - before,
              resourcePhase: observed.render?.resources?.phase,
            });
            peakPrivateInputPageBytes[copy] = sourceInputs.observe(
              copy,
              peakPrivateInputPageBytes[copy],
            );
            if (!result.ok) capacityAtRefusal[copy] = observed.render?.resources?.capacity;
            work++;
          } while (result.ok && performance.now() - begin < profile.budgets.preparationSliceMs);
          preparationSlices.push({ copy, phase, ms: performance.now() - begin, work });
          await frames.turn();
        } while (result.ok);
      } catch (cause) {
        await frames.settle().catch((drawFailure) => {
          if (drawFailure !== cause)
            throw new AggregateError(
              [cause, drawFailure],
              'Source preparation and ordinary draw failed',
            );
        });
        throw cause;
      }
      await frames.settle();
      expect(pictures).toBeGreaterThan(before);
      expect(result.ok).toBe(false);
      if (result.ok) throw Error('incomplete native preparation was accepted');
      const observed = candidate.inspect().render;
      preparationFailures.push({
        error: inspectError(result.error, { depth: 8, maxArrayLength: 16, maxStringLength: 2000 }),
        render:
          observed === undefined
            ? undefined
            : {
                phase: observed.phase,
                admitted: observed.admitted,
                members: observed.members,
                resources: observed.resources,
                waiting: observed.pending !== undefined,
              },
      });
      expect(result.error.detail.phase).toBe('render-source');
      expect(result.error.detail.reason).toBe('native-preparation-incomplete');
      const state = candidate.inspect().render;
      expect(state).toMatchObject({
        phase: 'resident-input',
        admitted: profile.streetBlock.meshEntities - profile.streetBlock.authorDisabledMeshes,
        resources: {
          phase: 'data',
          meshes: profile.streetBlock.meshAssets,
          textures: profile.streetBlock.textureAssets,
        },
      });
      expect(capacityAtRefusal[copy]).toMatchObject({ phase: 'published' });
      expect(state?.resources?.capacity?.transferredTables).toBeGreaterThan(0);
      expect(gpuScene.inspect().tables.primitive.bytes).toBeGreaterThanOrEqual(
        permanentRows.primitive.bytes,
      );
      expect(state?.resources?.capacity?.privateWriteBytes).toBeGreaterThan(0);
      if (copy === 0) expect(state?.resources?.capacity?.privateDescriptorBytes).toBeGreaterThan(0);
      else expect(state?.resources?.capacity?.privateDescriptorBytes).toBe(0);
      expect(state?.resources?.inputs?.uploadedBytes).toBeGreaterThan(0);
      assertSourceInputCustody(
        sourceInputs.preparations[copy],
        copy,
        peakPrivateInputPageBytes[copy],
        sourceInputs.committed,
      );
      expect(state?.resources?.inputs?.privatePageBytes).toBe(0);
      expect(state?.resources?.inputs?.resourceRoot).not.toBe(0xffffffff);
      resources.push(state?.resources);
      expect(
        candidate.members.filter((entity) => world.hasComponent(entity, MeshRenderer)),
      ).toHaveLength(profile.streetBlock.meshEntities);
      expect(
        candidate.members.filter((entity) => world.hasComponent(entity, Collider)),
      ).toHaveLength(256);
      expect(candidate.authorDisabled.size).toBe(profile.streetBlock.authorDisabledMeshes);
      expect(candidate.members.every((entity) => world.hasComponent(entity, Disabled))).toBe(true);
      expect(gpuScene.primitiveIndexForSlot(permanent.slot)).toBe(permanentIndex);
      const members = new Set<number>(candidate.members);
      const admitted = [...entry.projection.slotsSnapshot()].filter((slot) =>
        members.has(slot.entityKey),
      );
      expect(admitted).toHaveLength(
        profile.streetBlock.meshEntities - profile.streetBlock.authorDisabledMeshes,
      );
      const selection = entry.topology.captureResidencySelection();
      for (const row of admitted) {
        expect(row.snapshot.residencyGroup).toBeDefined();
        expect(selection.includes(row.snapshot.residencyGroup)).toBe(false);
        expect(gpuScene.primitiveIndexForSlot(row.slot)).toBeDefined();
        expect(gpuScene.materialIndexForResource(row.snapshot.material)).toBeDefined();
      }
      await oldFrame(true);
      expect(equalBytes(await readTargetPixels(nativeDevice, fixedTarget), pixels)).toBe(true);
    };
    for (let copy = 0; copy < 2; copy++) {
      mark(`copy-${copy}-preparing`);
      await prepareCopy(copy);
      mark(`copy-${copy}-prepared`);
    }
    expect(new Set(candidates.flatMap((candidate) => candidate.members)).size).toBe(
      candidates.reduce((count, candidate) => count + candidate.members.length, 0),
    );
    expect(quanta.filter((quantum) => quantum.phase === 'capture-begin')).toHaveLength(2);
    while (pictures < 60) await oldFrame();
    const beforeCleanupPictures = pictures;
    for (const candidate of [...candidates].reverse()) {
      while (candidate.inspect().phase !== 'retired') {
        const status = candidate.retireStep().unwrap();
        if (status.render?.pending !== undefined) await status.render.pending;
      }
      expect(candidate.inspect().phase).toBe('retired');
      expect(candidate.members.every((entity) => !world.get(entity, Entity).ok)).toBe(true);
    }
    expect(pictures).toBe(beforeCleanupPictures);
    expect(runtimeAssets(assets).inspect().snapshots).toBe(loaded.snapshots);
    expect(runtimeAssets(assets).inspect().snapshotBytes).toBe(loaded.snapshotBytes);
    await oldFrame();
    postRetirementFrames++;
    assets.release(scene).unwrap();
    expect(await native.popErrorScope()).toBeNull();
    expect(errors).toEqual([]);
  } catch (error) {
    failures.push(error);
  } finally {
    mark('cleanup-started');
    const attempt = async (run: () => unknown | Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() =>
      writeFile(
        '/tmp/forgeax-level-source-capacity-20261117.json',
        JSON.stringify({
          scope:
            'real App candidates/Pack/two admitted closed Source Data sets and shared native Mesh-Texture resources; old-world pixels/continuity and no-frame cleanup; C1/public Prepared remain refused',
          pictures,
          caseWindows,
          postRetirementFrames,
          quanta,
          preparationSlices,
          frameWork,
          timingScope:
            'bounded Source turns overlap at most one ordinary draw receipt; fixed-pose pixel probes add two frames and GPU readbacks; setup and Pack ingestion precede the ready return window',
          resources,
          capacityAtRefusal,
          peakPrivateInputPageBytes,
          observedInputCommits: inputObservation?.committed.size ?? 0,
          preparationFailures,
          phases: candidates.map((candidate) => candidate.inspect().phase),
          profileBudgetsUnchanged: true,
        }),
      ),
    );
    await attempt(() => inputObservation?.close());
    if (f !== undefined) {
      for (const candidate of [...candidates].reverse()) {
        await attempt(async () => {
          while (candidate.inspect().phase !== 'retired') {
            const status = candidate.retireStep().unwrap();
            if (status.render?.pending !== undefined) await status.render.pending;
          }
        });
      }
      await attempt(async () => {
        const result = await f?.close();
        if (result !== undefined && !result.ok) throw result.error;
      });
    } else await attempt(() => assets?.dispose());
    await attempt(() => target?.destroy());
    await attempt(() => pack?.producer.dispose());
  }
  reportFailures(failures);
}, 180000);

/** Continue Source turns while an ordinary submitted draw waits for native completion. */
function drawWhilePreparing(draw: () => Promise<void>) {
  let pending: Promise<void> | undefined;
  let settled = true;
  return {
    async turn() {
      if (settled) {
        await pending;
        settled = false;
        pending = draw().finally(() => {
          settled = true;
        });
        // The next turn or the retirement boundary observes the original failure.
        void pending.catch(() => {});
      }
      await setImmediate();
    },
    async settle() {
      await pending;
    },
  };
}

/** Observe the original issuer; the delegate and capture order stay unchanged. */
function observeSourceInputs(scene: GpuScene) {
  const preparations: GpuSceneInputPreparation[] = [];
  const prepare = scene.prepareSourceInputs;
  const spy = vi
    .spyOn(scene, 'prepareSourceInputs')
    .mockImplementation(function* (task, capture, current, retired) {
      return yield* prepare.call(
        scene,
        task,
        (input) => {
          preparations.push(input);
          capture(input);
        },
        current,
        retired,
      );
    });
  const committed = new Set<GpuSceneInputPreparation>();
  return {
    preparations,
    committed,
    observe(copy: number, previous: number | undefined): number {
      const input = preparations[copy];
      const peak = Math.max(previous ?? 0, input?.privatePageBytes ?? 0);
      if (input?.inspect().phase === 'committed' && !committed.has(input)) {
        assertInputTransferIdentity(scene, input);
        committed.add(input);
      }
      return peak;
    },
    close: () => spy.mockRestore(),
  };
}

function assertSourceInputCustody(
  input: GpuSceneInputPreparation | undefined,
  copy: number,
  peak: number | undefined,
  committed: ReadonlySet<GpuSceneInputPreparation>,
): void {
  if (input === undefined) throw Error('missing original Source Inputs receipt');
  if (copy === 0) expect(peak).toBeGreaterThan(0);
  else expect(peak).toBe(0);
  expect(input.inspect().phase).toBe('committed');
  expect(input.privatePageBytes).toBe(0);
  expect(committed.has(input)).toBe(true);
}

function assertInputTransferIdentity(scene: GpuScene, input: GpuSceneInputPreparation): void {
  expect(input.privatePageBytes).toBe(0);
  const read = scene.inputs.capture();
  try {
    const accepted = read.buffer().unwrap();
    expect(accepted.buffer).toBe(input.buffer);
    expect(accepted.resourceRoot).toBe(input.resourceRoot);
    read.seal().unwrap();
  } finally {
    read.release();
  }
}

function reportFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'lifecycle and cleanup failures');
}

async function readTargetPixels(device: GPUDevice, texture: GPUTexture): Promise<Uint8Array> {
  const [width, height] = profile.target.drawingBuffer;
  if (width === undefined || height === undefined)
    throw Error('missing frozen drawing-buffer extent');
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [
      width,
      height,
      1,
    ]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    try {
      const source = new Uint8Array(buffer.getMappedRange());
      const pixels = new Uint8Array(width * height * 4);
      for (let row = 0; row < height; row++)
        pixels.set(
          source.subarray(row * bytesPerRow, row * bytesPerRow + width * 4),
          row * width * 4,
        );
      return pixels;
    } finally {
      buffer.unmap();
    }
  } finally {
    buffer.destroy();
  }
}
