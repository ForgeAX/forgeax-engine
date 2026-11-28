import type { RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { type BarrelDistortionMapping, mapDisplayToScene } from '../barrel-distortion';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { FrameReceipt } from '../render-contract';
import type { ViewportHitRequest, ViewportHitResult } from '../viewport-hit';
import { createViewportHitProxy, type ViewportHitCapture } from './viewport-hit-proxy';

interface HitFrame {
  readonly state: RenderFrameState;
  readonly capture: ViewportHitCapture | undefined;
  readonly mapping: BarrelDistortionMapping | undefined;
  readonly width: number;
  readonly height: number;
  readonly gpuDriven: boolean;
  readonly unsupportedView: boolean;
}

interface Request {
  readonly input: ViewportHitRequest;
  readonly finish: (result: ViewportHitResult) => void;
  readonly device: RhiDevice;
  readonly pass: ReturnType<typeof createViewportHitProxy>;
  shader?: ShaderModule;
  pipelinePending?: boolean;
}

/** Shared only by the renderer and its view recorders. A frame context never survives draw. */
export function createViewportHitRequests(options: {
  readonly warmup?: boolean;
  device(): RhiDevice;
  generation(): number;
  shader(device: RhiDevice, code: string): Promise<ShaderModule>;
  trackMeshes(completion: Promise<unknown>): void;
}) {
  let pending: Request | undefined;
  let inFlight: Request | undefined;
  let frame: HitFrame | undefined;
  let cached: { device: RhiDevice; pass: ReturnType<typeof createViewportHitProxy> } | undefined;

  let warmupPending = options.warmup === true;
  let warmupRun: AbortController | undefined;

  function passFor(device: RhiDevice) {
    if (cached?.device !== device) {
      cached = {
        device,
        pass: createViewportHitProxy(device, (code) => options.shader(device, code)),
      };
    }
    return cached.pass;
  }

  const collectingDraws = () => pending?.shader !== undefined && inFlight === undefined;

  function startWarmup(receipt: FrameReceipt, sample: HitFrame) {
    const capture = sample.capture;
    if (!warmupPending || capture === undefined) return;
    warmupPending = false;
    if (
      sample.gpuDriven ||
      sample.unsupportedView ||
      !capture.warmup ||
      capture.failure !== undefined ||
      capture.recipes.length === 0
    )
      return;
    const device = options.device();
    const pass = passFor(device);
    const { recipes } = capture;
    const run = new AbortController();
    warmupRun = run;
    // Keep only recipes while waiting for the first presented frame's GPU work.
    void receipt.completed
      .then((completed) => (completed.ok ? pass.warm(recipes, run.signal) : undefined))
      .catch(() => {
        // Optional preparation must not fail the color frame or the viewport.
      })
      .finally(() => {
        if (warmupRun === run) warmupRun = undefined;
      });
  }

  const stale = (
    reason: Extract<ViewportHitResult, { kind: 'stale' }>['reason'],
  ): ViewportHitResult => ({
    kind: 'stale',
    reason,
  });
  const unavailable = (
    reason: Extract<ViewportHitResult, { kind: 'unavailable' }>['reason'],
  ): ViewportHitResult => ({ kind: 'unavailable', reason });
  function request(input: ViewportHitRequest, signal?: AbortSignal): Promise<ViewportHitResult> {
    if (signal?.aborted) return Promise.resolve(stale('cancelled'));
    if (
      ![input.x, input.y, input.width, input.height].every(Number.isFinite) ||
      input.x < 0 ||
      input.y < 0 ||
      input.x >= input.width ||
      input.y >= input.height
    )
      return Promise.resolve(unavailable('invalid-pixel'));
    const device = options.device();
    if (device.caps.backendKind !== 'webgpu') return Promise.resolve(unavailable('backend'));
    if (input.deviceGeneration !== options.generation())
      return Promise.resolve(stale('device-generation'));
    const pass = passFor(device);
    pending?.finish(stale('superseded-request'));
    inFlight?.finish(stale('superseded-request'));
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: ViewportHitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (pending === item) pending = undefined;
        resolve(result);
      };
      const cancel = () => finish(stale('cancelled'));
      const item: Request = { input, device, pass, finish };
      const timer = setTimeout(() => {
        finish(
          unavailable(
            item.shader === undefined || item.pipelinePending
              ? 'shader-preparation-timeout'
              : inFlight === item
                ? 'readback-timeout'
                : 'no-ready-frame',
          ),
        );
      }, 3000);
      signal?.addEventListener('abort', cancel, { once: true });
      pending = item;
      void pass.prepare().then(
        (shader) => {
          item.shader = shader;
        },
        () => finish(unavailable('shader-preparation')),
      );
    });
  }

  function admitPickSample(item: Request, sample: HitFrame | undefined, primary: RenderFrameState) {
    const { input } = item;
    if (sample?.state !== primary || sample.mapping?.camera === undefined || !sample.capture) {
      item.finish(unavailable('view-mapping'));
      return undefined;
    }
    if (sample.capture.warmup) return undefined;
    if (sample.unsupportedView) {
      item.finish(unavailable('view-coverage'));
      return undefined;
    }
    if (input.width !== sample.mapping.width || input.height !== sample.mapping.height) {
      item.finish(stale('viewport-extent'));
      return undefined;
    }
    if (sample.width !== input.width || sample.height !== input.height) {
      item.finish(unavailable('view-resolution'));
      return undefined;
    }
    if (sample.gpuDriven) {
      item.finish(unavailable('gpu-driven-draws'));
      return undefined;
    }
    const pixel = { x: 0, y: 0 };
    if (!mapDisplayToScene(pixel, sample.mapping, input.x, input.y)) {
      item.finish(unavailable('view-mapping'));
      return undefined;
    }
    return {
      capture: sample.capture,
      pixel: {
        x: Math.floor(pixel.x),
        y: Math.floor(pixel.y),
        width: sample.width,
        height: sample.height,
      },
    };
  }

  function submit(
    receipt: FrameReceipt,
    primary: RenderFrameState,
    worldIdentity?: string,
    publicationRevision?: number,
    displayFrameId = receipt.frameId,
  ): void {
    const sample = frame;
    frame = undefined;
    if (sample?.state === primary && receipt.presentation === 'ready') startWarmup(receipt, sample);
    const item = pending;
    if (
      item?.shader === undefined ||
      inFlight !== undefined ||
      receipt.presentation !== 'ready' ||
      displayFrameId <= item.input.afterFrameId
    )
      return;
    const { input } = item;
    if (
      (worldIdentity !== undefined && input.worldIdentity !== worldIdentity) ||
      input.deviceGeneration !== receipt.deviceGeneration ||
      options.device() !== item.device
    ) {
      item.finish(stale('frame-identity'));
      return;
    }
    const accepted = admitPickSample(item, sample, primary);
    if (accepted === undefined) return;
    try {
      const { draws, failure } = accepted.capture;
      if (failure !== undefined) {
        const detail = accepted.capture.detail;
        item.finish({
          kind: 'unavailable',
          reason: failure,
          ...(detail === undefined ? {} : { detail }),
        });
        return;
      }
      const prepared = item.pass.prepareDraws(item.shader, draws);
      if (prepared.kind === 'failed') {
        item.finish(unavailable(prepared.reason));
        return;
      }
      item.pipelinePending = prepared.kind === 'pending';
      if (prepared.kind === 'pending') return;
      pending = undefined;
      inFlight = item;
      void item.pass
        .submit(accepted.pixel, draws, prepared.value, options.trackMeshes)
        .then(async (entity) => {
          const completed = await receipt.completed;
          if (
            !completed.ok ||
            item.device !== options.device() ||
            input.deviceGeneration !== options.generation()
          )
            item.finish(stale('device-generation'));
          else
            item.finish({
              ...(entity === null ? { kind: 'miss', entity } : { kind: 'hit', entity }),
              frameId: displayFrameId,
              ...(publicationRevision === undefined ? {} : { publicationRevision }),
            });
        })
        .catch(() => item.finish(unavailable('hit-pass')))
        .finally(() => {
          if (inFlight === item) inFlight = undefined;
        });
    } catch {
      inFlight = undefined;
      item.finish(unavailable('hit-pass'));
    }
  }

  return {
    request,
    get collecting() {
      if (collectingDraws()) return true;
      if (!warmupPending) return false;
      const device = options.device();
      return device.caps.backendKind === 'webgpu' && device.createRenderPipelineAsync !== undefined;
    },
    get collectingDraws() {
      return collectingDraws();
    },
    capture(input: HitFrame) {
      frame = input;
    },
    discardFrame() {
      frame = undefined;
    },
    submit,
    detachWorld(worldIdentity: string) {
      if (pending?.input.worldIdentity === worldIdentity) pending.finish(stale('world-or-request'));
      if (inFlight?.input.worldIdentity === worldIdentity)
        inFlight.finish(stale('world-or-request'));
    },
    invalidate(reason: 'renderer' | 'device-generation' = 'renderer') {
      pending?.finish(stale(reason));
      inFlight?.finish(stale(reason));
      if (reason === 'device-generation') inFlight = undefined;
      frame = undefined;
      cached = undefined;
      warmupRun?.abort();
      warmupRun = undefined;
      warmupPending = options.warmup === true;
    },
  };
}
