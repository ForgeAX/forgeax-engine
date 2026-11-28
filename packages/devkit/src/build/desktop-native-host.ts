// createApp-compatible desktop host adapter backed by ForgeaxDesktopNativeRenderer
// (dedicated Rust wgpu 30 OS render thread + native winit window + RGBA UI overlay compositor).

import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type {
  FrameReceipt,
  Renderer,
  RenderFrameInput,
  RenderWorldLease,
} from '@forgeax/engine-render';
import {
  createDesktopNativeSceneRenderer,
  type DesktopNativeSceneRenderer,
  type DesktopNativeSceneRendererOptions,
  type DesktopSceneStats,
  type DesktopWitnessFrameResult,
  type NativeWindowEvent,
} from '@forgeax/engine-render-kernel/native';
import { err, ok, type Result, type UiPaintSource } from '@forgeax/engine-types';
import { ForgeaxDesktopNativeRenderer } from './desktop-native-kernel.js';

export interface NativeKernelDesktopHostOptions extends DesktopNativeSceneRendererOptions {
  /** Optional shared AssetRegistry; when omitted a fresh AssetRegistry is created and owned. */
  readonly assets?: AssetRegistry | undefined;
  /** Optional UI paint source (e.g. Blitz UI RGBA mode) composited over each frame. */
  readonly ui?: UiPaintSource | undefined;
  /** Override scene ambient RGB when no Skylight entity exists. */
  readonly ambientColor?: readonly [number, number, number] | undefined;
  /** Logical/headless drawing width fallback when running without an OS window. */
  readonly width?: number | undefined;
  /** Logical/headless drawing height fallback when running without an OS window. */
  readonly height?: number | undefined;
}

export interface NativeKernelDesktopCanvas {
  width: number;
  height: number;
}

export interface NativeKernelDesktopHost {
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly canvas: NativeKernelDesktopCanvas;
  readonly sceneRenderer: DesktopNativeSceneRenderer;
  readonly initialization: Promise<Result<void, unknown>>;
  readonly window: {
    facts(): Result<
      {
        readonly width: number;
        readonly height: number;
        readonly scaleFactor: number;
        readonly visible: boolean;
      },
      unknown
    >;
    pollEvents(): Result<readonly NativeWindowEvent[], unknown>;
    requestRedraw(): Result<void, unknown>;
    setPointerLock(locked: boolean): Result<boolean, unknown>;
    setImeArea(area: readonly [number, number, number, number] | null): Result<number, unknown>;
    close(): Result<void, unknown>;
  };
  getAttachedBridge(): ForgeaxDesktopNativeRenderer | undefined;
  renderWitnessFrame(
    width?: number,
    height?: number,
  ): Result<DesktopWitnessFrameResult, unknown> | undefined;
  getStats(): Result<DesktopSceneStats, unknown>;
  dispose(): void;
}

/**
 * Constructs a `createApp`-compatible desktop renderer host backed directly by
 * `@forgeax/engine-render-kernel/native` (dedicated Rust wgpu 30 OS render thread + winit window).
 */
export function createNativeKernelDesktopHost(
  options?: NativeKernelDesktopHostOptions,
): Result<NativeKernelDesktopHost, unknown> {
  const created = createDesktopNativeSceneRenderer(options);
  if (!created.ok) return err(created.error);
  const sceneRenderer = created.value;

  const ownedAssets = options?.assets === undefined;
  const assets = options?.assets ?? new AssetRegistry();
  const initialFacts = sceneRenderer.getWindowFacts();
  const defaultWidth = Math.max(
    1,
    (initialFacts.ok && initialFacts.value.width > 0
      ? initialFacts.value.width
      : (options?.window?.width ?? options?.width ?? 1280)) | 0,
  );
  const defaultHeight = Math.max(
    1,
    (initialFacts.ok && initialFacts.value.height > 0
      ? initialFacts.value.height
      : (options?.window?.height ?? options?.height ?? 720)) | 0,
  );
  const canvas: NativeKernelDesktopCanvas = { width: defaultWidth, height: defaultHeight };

  let state: 'alive' | 'device-lost' | 'disposed' = 'alive';
  let deviceGeneration = 1;
  let frameCounter = 0;
  let lastSampleTime = 0;
  let attachedWorld: World | undefined;
  let bridge: ForgeaxDesktopNativeRenderer | undefined;
  const listeners = new Set<(event: Record<string, unknown>) => void>();

  const emitEvent = (event: Record<string, unknown>): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Observer errors never disrupt host execution.
      }
    }
  };

  const resolveExtent = (): readonly [number, number] => {
    if (!sceneRenderer.headless) {
      const f = sceneRenderer.getWindowFacts();
      if (f.ok && f.value.width > 0 && f.value.height > 0) {
        canvas.width = f.value.width;
        canvas.height = f.value.height;
      }
    }
    return [Math.max(1, canvas.width | 0), Math.max(1, canvas.height | 0)];
  };

  const paintUi = (sampleTimeSeconds: number, width: number, height: number): void => {
    const ui = options?.ui;
    if (ui === undefined || ui.kind !== 'rgba') return;
    const rgba = ui.paint(sampleTimeSeconds * 1000, width, height);
    if (rgba !== null) {
      sceneRenderer.setUiOverlayRgba(width, height, rgba);
    }
  };

  const rendererAdapter = {
    state: () => state,
    currentDeviceGeneration: () => deviceGeneration,
    ready: () => Promise.resolve(ok(undefined)),
    attach(world: World) {
      if (state === 'disposed') {
        return err(new Error('NativeKernelDesktopHost is disposed'));
      }
      if (attachedWorld !== world || bridge === undefined) {
        attachedWorld = world;
        bridge = new ForgeaxDesktopNativeRenderer(
          world,
          assets,
          sceneRenderer,
          options?.ambientColor,
        );
      }
      const lease = {
        world,
        dispose: () => {
          if (attachedWorld === world) {
            attachedWorld = undefined;
            bridge = undefined;
          }
        },
      } as unknown as RenderWorldLease;
      return ok(lease);
    },
    draw(input: RenderFrameInput) {
      if (state !== 'alive') {
        return err(new Error(`NativeKernelDesktopHost cannot draw in state '${state}'`));
      }
      const [width, height] = resolveExtent();
      const sampleTime =
        typeof input.sampleTimeSeconds === 'number' && Number.isFinite(input.sampleTimeSeconds)
          ? input.sampleTimeSeconds
          : lastSampleTime + 1 / 60;
      const dt = Math.max(1 / 240, Math.min(0.1, sampleTime - lastSampleTime || 1 / 60));
      lastSampleTime = sampleTime;

      paintUi(sampleTime, width, height);

      if (input.source !== null && bridge !== undefined) {
        const sub = bridge.submitFrameAsync(width, height, dt);
        if (!sub.ok) {
          emitEvent({ kind: 'error', error: sub.error });
          return err(sub.error);
        }
      } else {
        // UI-only admission before scene becomes active
        const sub = sceneRenderer.submitIncrementalFrameAsync({
          width,
          height,
          camera: {
            viewProj: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            position: [0, 0, 5],
          },
          lights: [],
          elapsedSeconds: sampleTime,
          deltaSeconds: dt,
        });
        if (!sub.ok) {
          emitEvent({ kind: 'error', error: sub.error });
          return err(sub.error);
        }
      }

      frameCounter += 1;
      const receipt = {
        frameId: frameCounter,
        deviceGeneration,
        backendId: 'rust-wgpu-native',
        graphGeneration: 1,
        presentation: 'ready' as const,
        completed: Promise.resolve(ok(undefined)),
      } as unknown as FrameReceipt;
      return ok(receipt);
    },
    inspect() {
      const statsRes = sceneRenderer.getStats();
      const thread = statsRes.ok ? statsRes.value.thread : undefined;
      return {
        capabilities: {
          backendKind: 'rust-wgpu-native',
          rayQuery: false,
        },
        deviceInfo: {
          adapterInfo: {
            device: thread?.adapterName ?? 'unknown',
            description: thread?.backendName ?? 'wgpu',
          },
        },
        frame: {
          frameId: frameCounter,
          deviceGeneration,
        },
        nativeKernel: statsRes.ok ? statsRes.value : undefined,
      };
    },
    subscribe(listener: (event: Record<string, unknown>) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recover() {
      if (state === 'disposed') {
        return Promise.resolve(err(new Error('NativeKernelDesktopHost is disposed')));
      }
      const prev = state;
      if (prev === 'alive') {
        state = 'device-lost';
        emitEvent({ kind: 'state-changed', previous: prev, current: state });
      }
      const recRes = sceneRenderer.recover();
      if (!recRes.ok) {
        emitEvent({ kind: 'error', error: recRes.error });
        return Promise.resolve(err(recRes.error));
      }
      bridge?.resetForRecovery();
      const lostState = state;
      state = 'alive';
      deviceGeneration = recRes.value;
      emitEvent({ kind: 'state-changed', previous: lostState, current: state });
      return Promise.resolve(ok({ outcome: 'recovered', deviceGeneration }));
    },
    dispose() {
      if (state === 'disposed') return;
      const prev = state;
      state = 'disposed';
      emitEvent({ kind: 'state-changed', previous: prev, current: state });
      listeners.clear();
      bridge = undefined;
      attachedWorld = undefined;
      sceneRenderer.dispose();
      if (ownedAssets) assets.dispose();
    },
  } as unknown as Renderer;

  const windowAdapter = {
    facts: () => {
      if (sceneRenderer.headless) {
        return ok({
          width: canvas.width,
          height: canvas.height,
          scaleFactor: 1,
          visible: state !== 'disposed',
        });
      }
      return sceneRenderer.getWindowFacts();
    },
    pollEvents: () => {
      const evs = sceneRenderer.pollWindowEvents();
      if (!evs.ok) return evs;
      return ok(
        evs.value.map((ev) =>
          ev.kind === 'resized' || ev.kind === 'scale-changed' ? { kind: 'display' } : ev,
        ),
      );
    },
    requestRedraw: () => sceneRenderer.requestRedraw(),
    setPointerLock: (locked: boolean) => sceneRenderer.setPointerLock(locked),
    setImeArea: (area: readonly [number, number, number, number] | null) =>
      sceneRenderer.setImeArea(area),
    close: () => {
      rendererAdapter.dispose();
      return ok(undefined);
    },
  };

  return ok({
    renderer: rendererAdapter,
    assets,
    canvas,
    sceneRenderer,
    initialization: Promise.resolve(ok(undefined)),
    window: windowAdapter,
    getAttachedBridge: () => bridge,
    renderWitnessFrame: (width?: number, height?: number) => {
      if (bridge === undefined) return undefined;
      const [w, h] = resolveExtent();
      return bridge.renderWitnessFrame(width ?? w, height ?? h);
    },
    getStats: () => sceneRenderer.getStats(),
    dispose: () => rendererAdapter.dispose(),
  });
}
