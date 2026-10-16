import { RenderGraphBuilder, type RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { RhiCanvasTarget } from '@forgeax/engine-rhi';
import {
  type Buffer,
  err,
  type MappedBuffer,
  type RhiAdapter,
  type RhiCanvasContext,
  type RhiDevice,
  RhiError,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RhiBackendPack } from '../backend-contract';
import { deviceOptionsForAdapter } from '../device-feature-admission';
import {
  RECOVERY_ADAPTER_DEADLINE_MS,
  RECOVERY_DEVICE_DEADLINE_MS,
  type RecoveryContinuation,
  type RecoveryDeadline,
  type RecoveryPhase,
} from '../renderer-lifecycle';

export { deviceOptionsForAdapter } from '../device-feature-admission';

const PROBE_TEXTURE_USAGE_COPY_SRC = 0x01;
const PROBE_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;
const PROBE_BUFFER_USAGE_MAP_READ = 0x01;
const PROBE_BUFFER_USAGE_COPY_DST = 0x08;
const PROBE_READBACK_BYTES_PER_ROW = 256;
const PROBE_CLEAR: readonly [number, number, number, number] = [0.125, 0.25, 0.5, 1];
type ProbeFormat = 'rgba16float' | 'rgba8unorm';

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function recoveryDeviceProbeFailure(expected: string, hint: string, cause?: unknown): RhiError {
  const inner =
    cause instanceof RhiError
      ? cause
      : {
          code: 'recovery-device-probe-failed',
          message: cause instanceof Error ? cause.message : String(cause ?? hint),
        };
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected,
    hint,
    detail: { error: inner },
  });
}

/**
 * Prove that a freshly acquired candidate device can execute and expose one
 * render attachment before recovery publishes it. Device creation and a
 * successful queue.submit are not sufficient evidence: a replacement device
 * can accept those operations while its first observable frame remains
 * empty. This probe intentionally has no shader, asset, graph, or surface
 * dependency, so its result cleanly separates backend readiness from renderer
 * graph publication.
 *
 * The null backend is structural-only and deliberately has no CPU readback
 * implementation; its contract is already exercised by command-shape tests.
 */
export async function probeCandidateDeviceExecution(
  device: RhiDevice,
): Promise<import('@forgeax/engine-types').Result<void, RhiError>> {
  if (device.caps.backendKind === 'null') return ok(undefined);

  const format = device.caps.rgba16floatRenderable ? 'rgba16float' : 'rgba8unorm';
  let texture: Texture | undefined;
  let readback: Buffer | undefined;
  let mapped: MappedBuffer | undefined;
  let outcome: import('@forgeax/engine-types').Result<void, RhiError> = err(
    recoveryDeviceProbeFailure(
      'candidate device probe completes with a mapped pixel',
      'discard the candidate and keep the renderer in device-lost until a usable device is acquired',
    ),
  );
  try {
    const textureResult = device.createTexture({
      label: 'renderer-recovery-device-probe.texture',
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format,
      usage: PROBE_TEXTURE_USAGE_RENDER_ATTACHMENT | PROBE_TEXTURE_USAGE_COPY_SRC,
      viewFormats: undefined,
      textureBindingViewDimension: undefined,
    });
    if (!textureResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate device creates a 1x1 probe texture',
          'inspect the candidate device format/resource capability before publishing recovery',
          textureResult.error,
        ),
      );
      return outcome;
    }
    texture = textureResult.value;

    const viewResult = device.createTextureView(texture, {
      label: 'renderer-recovery-device-probe.view',
      dimension: '2d',
    });
    if (!viewResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate device creates a view for the probe texture',
          'inspect candidate texture-view creation before publishing recovery',
          viewResult.error,
        ),
      );
      return outcome;
    }

    const readbackResult = device.createBuffer({
      label: 'renderer-recovery-device-probe.readback',
      size: PROBE_READBACK_BYTES_PER_ROW,
      usage: PROBE_BUFFER_USAGE_MAP_READ | PROBE_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!readbackResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate device creates a mapped readback buffer',
          'inspect candidate buffer creation before publishing recovery',
          readbackResult.error,
        ),
      );
      return outcome;
    }
    readback = readbackResult.value;

    const encoderResult = device.createCommandEncoder({
      label: 'renderer-recovery-device-probe.encoder',
    });
    if (!encoderResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate device creates a probe command encoder',
          'inspect candidate command encoding before publishing recovery',
          encoderResult.error,
        ),
      );
      return outcome;
    }
    const encoder = encoderResult.value;
    const pass = encoder.beginRenderPass({
      label: 'renderer-recovery-device-probe.pass',
      colorAttachments: [
        {
          view: viewResult.value,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: {
            r: PROBE_CLEAR[0],
            g: PROBE_CLEAR[1],
            b: PROBE_CLEAR[2],
            a: PROBE_CLEAR[3],
          },
        },
      ],
    });
    pass.end();
    encoder.copyTextureToBuffer(
      { texture },
      {
        buffer: readback,
        bytesPerRow: PROBE_READBACK_BYTES_PER_ROW,
        rowsPerImage: 1,
      },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    const commandResult = encoder.finish();
    if (!commandResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate probe encoder finishes after render and copy commands',
          'inspect candidate command encoding before publishing recovery',
          commandResult.error,
        ),
      );
      return outcome;
    }
    const submitted = device.queue.submit([commandResult.value]);
    if (!submitted.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate probe command buffer submits successfully',
          'inspect candidate queue submission before publishing recovery',
          submitted.error,
        ),
      );
      return outcome;
    }
    await device.queue.onSubmittedWorkDone();
    const mappedResult = await readback.mapAsync(PROBE_BUFFER_USAGE_MAP_READ);
    if (!mappedResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate probe readback maps after queue completion',
          'inspect candidate queue completion and readback mapping before publishing recovery',
          mappedResult.error,
        ),
      );
      return outcome;
    }
    mapped = mappedResult.value;
    const rangeResult = mapped.getMappedRange(0, format === 'rgba16float' ? 8 : 4);
    if (!rangeResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate probe readback exposes its mapped pixel',
          'inspect candidate mapped-buffer state before publishing recovery',
          rangeResult.error,
        ),
      );
      return outcome;
    }
    const view = new DataView(rangeResult.value);
    const actual =
      format === 'rgba16float'
        ? [0, 1, 2, 3].map((channel) => halfToFloat(view.getUint16(channel * 2, true)))
        : [0, 1, 2, 3].map((channel) => (view.getUint8(channel) ?? 0) / 255);
    const epsilon = format === 'rgba16float' ? 0.02 : 2 / 255;
    const matches = actual.every(
      (value, index) => Math.abs(value - (PROBE_CLEAR[index] ?? 0)) <= epsilon,
    );
    if (!matches) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate probe readback preserves the cleared pixel',
          `candidate device returned ${actual.map((value) => value.toFixed(4)).join(',')}; discard it instead of publishing alive`,
        ),
      );
      return outcome;
    }
    outcome = ok(undefined);
  } catch (cause) {
    outcome = err(
      recoveryDeviceProbeFailure(
        'candidate device executes the minimal render/readback probe',
        `discard the candidate after the execution probe raised: ${String(cause)}`,
        cause,
      ),
    );
  } finally {
    try {
      mapped?.unmap();
    } catch (cause) {
      if (outcome.ok) {
        outcome = err(
          recoveryDeviceProbeFailure(
            'candidate probe mapping closes after readback',
            `probe unmap raised: ${String(cause)}`,
            cause,
          ),
        );
      }
    }
    if (readback !== undefined) {
      const destroyed = device.destroyBuffer(readback);
      if (!destroyed.ok && outcome.ok) outcome = err(destroyed.error);
    }
    if (texture !== undefined) {
      const destroyed = device.destroyTexture(texture);
      if (!destroyed.ok && outcome.ok) outcome = err(destroyed.error);
    }
  }
  return outcome;
}

/**
 * Prove that the physical color target allocated by the candidate compiled
 * graph is writable and observable on that same candidate device. This is
 * intentionally a recovery-only boundary check: it does not run a renderer
 * pass, bind a shader, or touch the canvas surface.
 */
async function probeCandidateGraphTarget(
  device: RhiDevice,
  target: { readonly texture: Texture; readonly view: TextureView; readonly format: ProbeFormat },
  encode?: (encoder: import('@forgeax/engine-rhi').RhiCommandEncoder) => Result<void, RhiError>,
): Promise<import('@forgeax/engine-types').Result<void, RhiError>> {
  let readback: Buffer | undefined;
  let mapped: MappedBuffer | undefined;
  let outcome: import('@forgeax/engine-types').Result<void, RhiError> = err(
    recoveryDeviceProbeFailure(
      'candidate compiled graph target exposes a mapped cleared pixel',
      'discard the candidate and keep the renderer in device-lost until its graph target is usable',
    ),
  );
  try {
    const readbackResult = device.createBuffer({
      label: 'renderer-recovery-graph-probe.readback',
      size: PROBE_READBACK_BYTES_PER_ROW,
      usage: PROBE_BUFFER_USAGE_MAP_READ | PROBE_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!readbackResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe creates a mapped readback buffer',
          'inspect candidate graph target readback allocation before publishing recovery',
          readbackResult.error,
        ),
      );
      return outcome;
    }
    readback = readbackResult.value;

    const encoderResult = device.createCommandEncoder({
      label: 'renderer-recovery-graph-probe.encoder',
    });
    if (!encoderResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe creates a command encoder',
          'inspect candidate graph target command encoding before publishing recovery',
          encoderResult.error,
        ),
      );
      return outcome;
    }
    const encoder = encoderResult.value;
    const encoded =
      encode === undefined
        ? (() => {
            const pass = encoder.beginRenderPass({
              label: 'renderer-recovery-graph-probe.pass',
              colorAttachments: [
                {
                  view: target.view,
                  loadOp: 'clear',
                  storeOp: 'store',
                  clearValue: {
                    r: PROBE_CLEAR[0],
                    g: PROBE_CLEAR[1],
                    b: PROBE_CLEAR[2],
                    a: PROBE_CLEAR[3],
                  },
                },
              ],
            });
            pass.end();
            return ok(undefined);
          })()
        : encode(encoder);
    if (!encoded.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe encodes the actual compiled target',
          'inspect the candidate RenderGraph execution before publishing recovery',
          encoded.error,
        ),
      );
      return outcome;
    }
    encoder.copyTextureToBuffer(
      { texture: target.texture },
      {
        buffer: readback,
        bytesPerRow: PROBE_READBACK_BYTES_PER_ROW,
        rowsPerImage: 1,
      },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    const commandResult = encoder.finish();
    if (!commandResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe finishes after clearing and copying the target',
          'inspect candidate graph target command encoding before publishing recovery',
          commandResult.error,
        ),
      );
      return outcome;
    }
    const submitted = device.queue.submit([commandResult.value]);
    if (!submitted.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe command buffer submits successfully',
          'inspect candidate graph target queue submission before publishing recovery',
          submitted.error,
        ),
      );
      return outcome;
    }
    await device.queue.onSubmittedWorkDone();
    const mappedResult = await readback.mapAsync(PROBE_BUFFER_USAGE_MAP_READ);
    if (!mappedResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe readback maps after queue completion',
          'inspect candidate graph target queue completion before publishing recovery',
          mappedResult.error,
        ),
      );
      return outcome;
    }
    mapped = mappedResult.value;
    const rangeResult = mapped.getMappedRange(0, target.format === 'rgba16float' ? 8 : 4);
    if (!rangeResult.ok) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe readback exposes its mapped pixel',
          'inspect candidate graph target mapped-buffer state before publishing recovery',
          rangeResult.error,
        ),
      );
      return outcome;
    }
    const view = new DataView(rangeResult.value);
    const actual =
      target.format === 'rgba16float'
        ? [0, 1, 2, 3].map((channel) => halfToFloat(view.getUint16(channel * 2, true)))
        : [0, 1, 2, 3].map((channel) => (view.getUint8(channel) ?? 0) / 255);
    const epsilon = target.format === 'rgba16float' ? 0.02 : 2 / 255;
    if (!actual.every((value, index) => Math.abs(value - (PROBE_CLEAR[index] ?? 0)) <= epsilon)) {
      outcome = err(
        recoveryDeviceProbeFailure(
          'candidate graph probe readback preserves the cleared target pixel',
          `candidate graph target returned ${actual.map((value) => value.toFixed(4)).join(',')}; discard it instead of publishing alive`,
        ),
      );
      return outcome;
    }
    outcome = ok(undefined);
  } catch (cause) {
    outcome = err(
      recoveryDeviceProbeFailure(
        'candidate compiled graph target executes the minimal render/readback probe',
        `discard the candidate after its graph target probe raised: ${String(cause)}`,
        cause,
      ),
    );
  } finally {
    try {
      mapped?.unmap();
    } catch (cause) {
      if (outcome.ok) {
        outcome = err(
          recoveryDeviceProbeFailure(
            'candidate graph probe mapping closes after readback',
            `graph probe unmap raised: ${String(cause)}`,
            cause,
          ),
        );
      }
    }
    if (readback !== undefined) {
      const destroyed = device.destroyBuffer(readback);
      if (!destroyed.ok && outcome.ok) outcome = err(destroyed.error);
    }
  }
  return outcome;
}

/**
 * Exercise the actual RenderGraphBuilder/CompiledRenderGraph execution path
 * against the candidate graph's physical color target. The graph is tiny and
 * imported-target-only: it isolates pass resolution/encoding from the full
 * renderer topology while preserving the exact candidate texture and view.
 */
export async function probeCandidateGraphExecution(
  device: RhiDevice,
  target: { readonly texture: Texture; readonly view: TextureView; readonly format: ProbeFormat },
): Promise<import('@forgeax/engine-types').Result<void, RhiError>> {
  // RhiNull is intentionally structural-only: it records graph/resource
  // commands but has no pixel-producing queue or mapped readback contract.
  // Real backends still take the complete graph execution/readback probe.
  if (device.caps.backendKind === 'null') return ok(undefined);

  const builder = new RenderGraphBuilder<RenderGraphFrame>();
  const texture = builder.importTexture(
    'renderer-recovery-graph-execution-probe.texture',
    {
      format: target.format,
      size: { width: 1, height: 1 },
      usage: PROBE_TEXTURE_USAGE_RENDER_ATTACHMENT | PROBE_TEXTURE_USAGE_COPY_SRC,
      dimension: '2d',
    },
    () => target.texture,
  );
  if (!texture.ok) {
    return err(
      recoveryDeviceProbeFailure(
        'candidate graph execution probe imports the physical target',
        'inspect candidate graph probe resource declaration before publishing recovery',
        texture.error,
      ),
    );
  }
  const view = builder.importView(
    texture.value,
    { label: 'renderer-recovery-graph-execution-probe.view', dimension: '2d' },
    () => target.view,
  );
  if (!view.ok) {
    return err(
      recoveryDeviceProbeFailure(
        'candidate graph execution probe imports the physical target view',
        'inspect candidate graph probe view declaration before publishing recovery',
        view.error,
      ),
    );
  }
  const pass = builder.addRasterPass('renderer-recovery-graph-execution-probe', {
    accesses: [{ resource: view.value, usage: 'color-attachment' }],
    colorAttachments: [
      {
        view: view.value,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: {
          r: PROBE_CLEAR[0],
          g: PROBE_CLEAR[1],
          b: PROBE_CLEAR[2],
          a: PROBE_CLEAR[3],
        },
      },
    ],
    encode: () => undefined,
  });
  if (!pass.ok) {
    return err(
      recoveryDeviceProbeFailure(
        'candidate graph execution probe adds its clear pass',
        'inspect candidate graph probe pass declaration before publishing recovery',
        pass.error,
      ),
    );
  }
  const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } });
  if (!compiled.ok) {
    return err(
      recoveryDeviceProbeFailure(
        'candidate graph execution probe compiles against the candidate device',
        'inspect candidate graph probe compilation before publishing recovery',
        compiled.error,
      ),
    );
  }
  try {
    return await probeCandidateGraphTarget(device, target, (encoder) => {
      const executed = compiled.value.execute({ encoder });
      return executed.ok
        ? ok(undefined)
        : err(
            recoveryDeviceProbeFailure(
              'candidate graph execution probe records its clear pass',
              'inspect candidate compiled graph resource resolution and pass encoding before publishing recovery',
              executed.error,
            ),
          );
    });
  } finally {
    await compiled.value.retire();
  }
}

export interface AcquiredDeviceGeneration {
  readonly adapter: RhiAdapter;
  readonly device: RhiDevice;
  readonly context: RhiCanvasContext;
}

export interface DeviceGenerationAcquisitionFailure {
  readonly stage: 'adapter' | 'device' | 'context';
  readonly error: RhiError;
}

export type RecoveryStepOutcome<T, E> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'error'; readonly error: E }
  | { readonly kind: 'timeout'; readonly error: RhiError };

export async function runRecoveryStep<T, E>(
  operation: (continuation?: RecoveryContinuation) => Promise<Result<T, E>>,
  phase: RecoveryPhase,
  deadline: RecoveryDeadline | undefined,
  now: () => number = () => Date.now(),
  continuation?: RecoveryContinuation,
): Promise<RecoveryStepOutcome<T, E>> {
  const settle = (): Promise<RecoveryStepOutcome<T, E>> =>
    Promise.resolve()
      .then(() => operation(continuation))
      .then(
        (result): RecoveryStepOutcome<T, E> =>
          result.ok
            ? { kind: 'value', value: result.value }
            : { kind: 'error', error: result.error },
      )
      .catch(
        (cause): RecoveryStepOutcome<T, E> => ({
          kind: 'error',
          error: structuredStepError(cause, phase) as E,
        }),
      );
  if (deadline === undefined) return settle();
  const timedOut = (): RecoveryStepOutcome<T, E> => {
    const elapsedMs = deadline.elapsed(now());
    continuation?.abandon(now());
    continuation?.cleanupOnce();
    return { kind: 'timeout', error: timeoutError(phase, elapsedMs) };
  };
  const remaining = Math.max(0, deadline.deadlineAt - now());
  const phaseLimit =
    phase === 'acquire-adapter'
      ? RECOVERY_ADAPTER_DEADLINE_MS
      : phase === 'acquire-device'
        ? RECOVERY_DEVICE_DEADLINE_MS
        : remaining;
  const timeoutMs = Math.min(remaining, phaseLimit);
  if (timeoutMs <= 0 || !deadline.isValid(phase, now())) return timedOut();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    settle(),
    new Promise<RecoveryStepOutcome<T, E>>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(timedOut()), timeoutMs);
    }),
  ]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  if (continuation !== undefined && !continuation.isValid(phase, now())) return timedOut();
  return outcome;
}

function timeoutError(phase: RecoveryPhase, elapsedMs: number): RhiError {
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: `recovery ${phase} completes before its bounded deadline`,
    hint: `recovery ${phase} exceeded its deadline after ${elapsedMs}ms; retry after the host observes the loss`,
    detail: {
      error: {
        code: 'recovery-timeout',
        message: `${phase} exceeded its deadline after ${elapsedMs}ms`,
      },
    },
  });
}

/** Acquire the same backend generation inputs for boot and recovery. */
export async function acquireDeviceGeneration(
  pack: RhiBackendPack,
  canvas: RhiCanvasTarget,
  deadline?: RecoveryDeadline,
  continuation?: RecoveryContinuation,
  onPhase?: (phase: RecoveryPhase) => void,
): Promise<Result<AcquiredDeviceGeneration, DeviceGenerationAcquisitionFailure>> {
  onPhase?.('acquire-adapter');
  const adapterOutcome = await runRecoveryStep(
    (attempt) =>
      pack.rhi.requestAdapter(undefined, canvas).then((result) => {
        if (attempt !== undefined && !attempt.isValid('acquire-adapter', Date.now())) {
          return err(timeoutError('acquire-adapter', 0));
        }
        return result;
      }),
    'acquire-adapter',
    deadline,
    undefined,
    continuation,
  );
  if (adapterOutcome.kind !== 'value') {
    return err({ stage: 'adapter', error: adapterOutcome.error });
  }
  const adapter = adapterOutcome.value;

  deadline?.beginDeviceAcquisition(Date.now());
  onPhase?.('acquire-device');
  let deviceResult: Result<RhiDevice, RhiError>;
  try {
    const deviceOutcome = await runRecoveryStep(
      (attempt) =>
        adapter.requestDevice(deviceOptionsForAdapter(adapter)).then((result) => {
          if (attempt !== undefined && !attempt.isValid('acquire-device', Date.now())) {
            return err(timeoutError('acquire-device', 0));
          }
          return result;
        }),
      'acquire-device',
      deadline,
      undefined,
      continuation,
    );
    if (deviceOutcome.kind !== 'value') {
      return err({ stage: 'device', error: deviceOutcome.error });
    }
    deviceResult = ok(deviceOutcome.value);
  } catch (cause) {
    return err({
      stage: 'device',
      error: new RhiError({
        code: 'webgpu-runtime-error',
        expected: 'backend adapter.requestDevice resolves with a Result',
        hint: `backend device acquisition raised: ${String(cause)}`,
      }),
    });
  }
  const contextResult = pack.rhi.acquireCanvasContext(canvas);
  if (!contextResult.ok) return err({ stage: 'context', error: contextResult.error });
  return ok({
    adapter,
    device: deviceResult.value,
    context: contextResult.value,
  });
}

function structuredStepError(cause: unknown, phase: RecoveryPhase): RhiError {
  if (cause instanceof RhiError) return cause;
  return new RhiError({
    code: 'webgpu-runtime-error',
    expected: `recovery ${phase} operation rejects with a structured RhiError`,
    hint: `inspect the structured cause from recovery ${phase} before retrying`,
    detail: {
      error: {
        code: 'recovery-operation-rejected',
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof Error ? { name: cause.name } : {}),
      },
    },
  });
}
