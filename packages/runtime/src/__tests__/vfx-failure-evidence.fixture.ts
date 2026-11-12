import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import type { World } from '@forgeax/engine-ecs';
import {
  Camera,
  type FrameReceipt,
  type FrameReceiptObservation,
  type Renderer,
} from '@forgeax/engine-render';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type EncodedTape,
  type RecorderAttachment,
  summarizeFrame,
  tapeDigest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
} from '@forgeax/engine-vfx';
import type { VfxRuntimeHost } from '@forgeax/engine-vfx-render';

type Observation = NonNullable<FrameReceiptObservation['observations']>[number];
export type EvidenceWriter = (name: string, bytes: Uint8Array) => void | Promise<void>;

/** Read WebIDL/native numeric limits, including prototype accessors. */
function numericLimits(limits: object): Record<string, number> {
  const names = new Set<string>();
  for (
    let value = limits;
    value !== Object.prototype && value !== null;
    value = Object.getPrototypeOf(value)
  )
    for (const name of Object.getOwnPropertyNames(value)) names.add(name);
  return Object.fromEntries(
    [...names].flatMap((name) => {
      const value = Reflect.get(limits, name);
      return typeof value === 'number' ? [[name, value]] : [];
    }),
  );
}

/** Observe the same adapter/device consumed by the RHI; never request a second adapter. */
export function observeVfxGpu(gpu: GPU) {
  const adapters: unknown[] = [];
  const provider: webgpu.GpuLike = {
    async requestAdapter(options) {
      const adapter = await gpu.requestAdapter(options);
      if (adapter === null) return null;
      const info = adapter.info;
      const devices: unknown[] = [];
      adapters.push({
        ordinal: adapters.length,
        options,
        info: {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        },
        features: [...adapter.features],
        limits: numericLimits(adapter.limits),
        devices,
      });
      return {
        features: adapter.features,
        limits: adapter.limits,
        async requestDevice(descriptor) {
          const device = await adapter.requestDevice(descriptor);
          const errors: { name: string; message: string }[] = [];
          device.addEventListener('uncapturederror', (event) => {
            errors.push({ name: event.error.constructor.name, message: event.error.message });
          });
          devices.push({
            ordinal: devices.length,
            descriptor,
            features: [...device.features],
            limits: numericLimits(device.limits),
            errors,
          });
          return device;
        },
      };
    },
  };
  return { provider, adapters };
}

export function createVfxEvidenceBackend(loader: unknown) {
  const observed = observeVfxGpu(navigator.gpu);
  const recorder = attachRecorder({
    ...webgpu,
    rhi: {
      ...webgpu.rhi,
      requestAdapter: (options) =>
        webgpu.requestAdapterFrom(
          observed.provider,
          options ?? { powerPreference: 'high-performance' },
        ),
    },
  }).unwrap();
  return { recorder, metadata: () => ({ loader, adapters: observed.adapters }) };
}

export interface VfxFrameDiagnostics {
  readonly recorder: RecorderAttachment;
  readonly write: EvidenceWriter;
  readonly prefix: string;
  readonly backend: () => unknown;
}

/** Enclose exactly the caller's existing frame, including capture failure cleanup. */
export async function captureVfxFrame<T>(
  recorder: RecorderAttachment | undefined,
  step: () => Promise<T>,
) {
  if (recorder === undefined) return { value: await step(), tape: undefined };
  const abort = new AbortController();
  const pending = recorder.captureFrame({ signal: abort.signal });
  try {
    (await recorder.frameBoundary()).unwrap();
    const value = await step();
    (await recorder.frameBoundary()).unwrap();
    return { value, tape: (await pending).unwrap() };
  } catch (cause) {
    abort.abort();
    await pending;
    throw cause;
  }
}

function effectFacts(world: World, handle: number) {
  const assets = runtimeAssets(world.assets);
  const version = assets.version(handle);
  const effect = assets.borrow<VfxGpuEffectAsset>(handle);
  return {
    handle,
    revision: version.ok ? version.value : version.error,
    value: !effect.ok
      ? effect.error
      : {
          kind: effect.value.kind,
          schemaVersion: effect.value.schemaVersion,
          fingerprint: effect.value.program.fingerprint,
          emitters: effect.value.program.emitters.map(({ wgsl: _wgsl, ...emitter }) => emitter),
        },
  };
}

export function snapshotVfxFailureState(world: World, renderer: Renderer, host: VfxRuntimeHost) {
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const inspection = renderer.inspect();
  return {
    worldIdentity: world.identity,
    host: host.inspect(world),
    feature: host.feature.inspect(),
    players: Array.from(world.query({ read: [ParticleEffectPlayer] }).unwrap(), (row) => {
      const player = row.get(ParticleEffectPlayer);
      const local = world.get(row.entity, Transform);
      const global = world.get(row.entity, GlobalTransform);
      return {
        entity: Number(row.entity),
        authored: player,
        transform: local.ok ? local.value : null,
        globalTransform: global.ok ? global.value : null,
        effect: effectFacts(world, player.effect),
      };
    }),
    cameras: Array.from(world.query({ read: [Camera] }).unwrap(), (row) => {
      const local = world.get(row.entity, Transform);
      const global = world.get(row.entity, GlobalTransform);
      return {
        entity: Number(row.entity),
        camera: row.get(Camera),
        transform: local.ok ? local.value : null,
        globalTransform: global.ok ? global.value : null,
      };
    }),
    queued: runtime.snapshot().map((intent) => ({
      sequence: intent.sequence,
      player: Number(intent.player),
      tick: intent.tick,
      phaseTick: intent.phaseTick,
      playCycle: intent.playCycle,
      reset: intent.reset,
      spawnCount: intent.spawnCount,
      firstParticleId: intent.firstParticleId,
      elapsed: intent.elapsed,
      delta: intent.delta,
      programFingerprint: intent.programFingerprint,
      emitter: intent.emitter.id,
      effect: runtime.effectVersion(intent.effect),
    })),
    renderer: {
      frame: inspection.frame,
      features: inspection.featureDiagnostics,
      submission: inspection.renderScene.submission,
    },
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(
      value,
      (_key, item: unknown) => {
        if (item instanceof DataView)
          return Array.from(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
        if (ArrayBuffer.isView(item)) return Array.from(item as unknown as ArrayLike<number>);
        if (item instanceof Map) return [...item.entries()];
        if (item instanceof Set) return [...item];
        if (item instanceof Error) return { ...item, name: item.name, message: item.message };
        return item;
      },
      2,
    ),
  );
}

/** Persist before a visibility assertion can throw; pixels and tape keep their own hashes. */
export async function saveVfxFailureFrame(input: {
  readonly write: EvidenceWriter;
  readonly name: string;
  readonly receipt: FrameReceipt;
  readonly observation: Observation;
  readonly tape?: EncodedTape | undefined;
  readonly backend: unknown;
  readonly state: unknown;
}) {
  const { write, name, receipt, observation, tape } = input;
  await write(`${name}.rgba`, observation.bytes);
  if (tape !== undefined) await write(`${name}.rhitape`, tape.bytes);
  const decoded = tape === undefined ? undefined : decodeTape(tape.bytes);
  const model = decoded?.ok ? buildFrameModel(decoded.value) : undefined;
  if (model !== undefined)
    await write(
      `${name}-work.json`,
      jsonBytes({
        ...summarizeFrame(model),
        works: model.works.map((work) => ({
          workIndex: work.workIndex,
          eventIndex: work.eventIndex,
          passIndex: work.passIndex,
          kind: work.kind,
          drawCall: work.drawCall,
          pipelineId: work.pipeline.pipelineHandleId,
          group: model.commands[work.commandIndex]?.group,
          entryPoints: work.pipeline.shaders.map(({ stage, entryPoint }) => ({
            stage,
            entryPoint,
          })),
          bindings: work.bindings,
          vertexBuffers: work.vertexBuffers,
          attachments: work.attachments,
        })),
      }),
    );
  await write(
    `${name}.json`,
    jsonBytes({
      receipt: { ...receipt, completed: await receipt.completed, creditCompleted: undefined },
      observation: observation.metadata,
      receiptMatchesObservation:
        receipt.backendId !== undefined &&
        receipt.backendId === observation.metadata.backendId &&
        receipt.graphGeneration !== undefined &&
        receipt.frameId === observation.metadata.frameId &&
        receipt.deviceGeneration === observation.metadata.deviceGeneration &&
        receipt.graphGeneration === observation.metadata.graphGeneration,
      pixels: { bytes: observation.bytes.byteLength, sha256: tapeDigest(observation.bytes) },
      tape:
        tape === undefined
          ? null
          : {
              bytes: tape.bytes.byteLength,
              sha256: tapeDigest(tape.bytes),
              decoded: decoded?.ok ?? false,
              decodeError: decoded?.ok ? undefined : decoded?.error,
              unseededResources: model?.unseededResources,
            },
      backend: input.backend,
      state: input.state,
    }),
  );
  if (decoded !== undefined && !decoded.ok) throw decoded.error;
}
