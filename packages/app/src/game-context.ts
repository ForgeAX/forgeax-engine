// @forgeax/engine-app -- Host service for asset-resident game plugins.
//
// App, Preview, and Devkit provide one realm-local GameHost service. Project
// code default-exports a native Cordis plugin that injects this service and
// owns all non-ECS teardown through Fiber effects.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { WebAudioEngine } from '@forgeax/engine-audio-webaudio';
import type { Plugin } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import type { ExecutionOptions } from './execution/types';
import type { App, CanvasDrawingBufferSize, ExecutionApp } from './types';

/** JSON-shaped data a game may intentionally project through a host bridge. */
export type GameProjectionValue =
  | null
  | boolean
  | number
  | string
  | GameProjectionValue[]
  | { [key: string]: GameProjectionValue };

/** Lightweight, host-agnostic argument schema for a game-owned action. */
export interface GameActionArgsSchema {
  readonly type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  readonly properties?: Record<string, GameActionArgsSchema>;
  readonly required?: string[];
  readonly enum?: GameProjectionValue[];
  readonly items?: GameActionArgsSchema;
  readonly nullable?: boolean;
  readonly description?: string;
}

/**
 * A Play-only capability owned by game code. The host may discover and invoke it,
 * but never supplies its gameplay semantics or reaches into the game World.
 */
export interface GameActionDef {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: GameActionArgsSchema;
  /** Return an optional JSON-shaped result for inspection clients. */
  readonly run: (
    args: GameProjectionValue,
  ) => GameProjectionValue | void | Promise<GameProjectionValue | void>;
}

/** A named, serializable Play-only read projection owned by game code. */
export interface GameReadDef {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly read: () => GameProjectionValue | Promise<GameProjectionValue>;
}

/**
 * Host-provided registration sink for one Play run. Games receive this only while
 * bootstrapping the fresh transient world; registrations are discarded when the run is disposed.
 */
export interface GameProjectionRegistrar {
  registerAction(def: GameActionDef): () => void;
  registerRead(def: GameReadDef): () => void;
}

/** Realm-local Host capability injected into an asset-resident game plugin. */
export interface GameHost {
  /** Project-wide startup deadline; null means startup waits until completion or cancellation. */
  readonly startupTimeoutMs?: number | null;
  /** Present only when this realm owns the presentation canvas. */
  readonly canvas?: HTMLCanvasElement | OffscreenCanvas;
  /** Current input-coordinate extent, including source realms without a canvas. */
  readonly drawingBufferSize?: () => CanvasDrawingBufferSize;
  /** The WebGPU Renderer (optional — some hosts may not expose it). */
  readonly renderer?: Renderer;
  /** Borrowed current Host audio engine. App owns replacement and disposal; never retain it across rebuilds. */
  readonly audio?: WebAudioEngine;
  /**
   * Optional per-App source message endpoint. In a Worker, the presentation
   * Host borrows the opposite end; in one realm it is presentationPort. The
   * owner closes both ends. Games own their protocol and listeners, but must
   * not close either borrowed port.
   */
  readonly port?: MessagePort;
  /** Presentation end when the game and UI share a realm; paired with port. */
  readonly presentationPort?: MessagePort;
  /** The realm-local AssetRegistry. */
  readonly assets: AssetRegistry;
  /** Source realms expose World/assets; presentation Hosts expose local App controls. */
  readonly app: Pick<App, 'world' | 'assets'> | App | ExecutionApp;
  /**
   * Controlled UI container for this presentation realm. UI plugins require this
   * mount and create nodes through its ownerDocument; it may be a real browser
   * element or the native standard facade. Source-only realms omit it.
   * The Host removes the container when this run is disposed.
   */
  readonly uiRoot?: HTMLElement;
  /** Actual presentation input mode; observation owns no acquisition loop. */
  readonly controlMode?: {
    read(): 'pointer' | 'pointer-locked' | 'touch';
    subscribe(listener: () => void): () => void;
  };
  /**
   * M2 D-3: command-set pointer-lock gate. The game template calls this
   * when the view mode changes (e.g. `setPointerLockAllowed(mode === 'fps')`
   * to allow lock in FPS, disallow in top-down). The host wires this to
   * App.input.setPointerLockAllowed?.() which delegates to the input backend.
   * Absent → the host does not support pointer-lock gating (e.g. a host
   * that only runs top-down games).
   */
  readonly setPointerLockAllowed?: (allowed: boolean) => void;
  /**
   * Optional Play-only projection seam. A game registers its own action and read
   * capabilities here; the host may only discover/invoke/read those closures. It
   * is deliberately absent outside a host that can clear registrations on disposal.
   */
  readonly gameProjection?: GameProjectionRegistrar;
}

/**
 * Provide the Host boundary to a native Cordis game plugin.
 */
export function gameHostPlugin(host: GameHost): Plugin {
  return {
    name: 'game-host',
    provide: 'gameHost',
    apply(ctx) {
      ctx.provide('gameHost', host);
    },
  };
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    gameHost?: GameHost;
    /** Host-only native factory, resolved synchronously for each execution generation. */
    executionHostAudioFactory?: ExecutionOptions['createHostAudio'];
  }
}
