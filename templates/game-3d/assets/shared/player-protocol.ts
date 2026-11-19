import type { EntityHandle } from '@forgeax/engine/ecs';

/** Port channels between the player plugin (World) and the guide UI (presentation). */
export const PLAYER_CONTROL_CHANNEL = 'game-3d/player-controls';
export const PLAYER_STATE_CHANNEL = 'game-3d/player-state';

/** Engine -> UI snapshot: what the HUD shows about the player. */
export interface PlayerHudState {
  readonly height: number;
  readonly speed: number;
  readonly grounded: boolean;
  readonly running: boolean;
}

/** UI -> engine semantic touch intent. */
export type PlayerControl =
  | { readonly kind: 'move'; readonly horizontal: number; readonly vertical: number }
  | { readonly kind: 'look'; readonly x: number; readonly y: number }
  | { readonly kind: 'jump' }
  | { readonly kind: 'transform' }
  | { readonly kind: 'run'; readonly held: boolean }
  | { readonly kind: 'reset' };

/** One frame of combined keyboard, mouse and touch intent. */
export interface PlayerInput {
  readonly horizontal: number;
  readonly vertical: number;
  readonly lookX: number;
  readonly lookY: number;
  readonly run: boolean;
}

/** Camera orbit angles. The camera writes them; movement reads yaw to make WASD camera-relative. */
export interface PlayerLook {
  readonly yaw: number;
  readonly pitch: number;
}

/** Service the player plugin provides; the camera plugin consumes it by name. */
export interface Game3dPlayerService {
  readonly entity: EntityHandle;
  readonly readInput: () => PlayerInput;
  readonly readLook: () => PlayerLook;
  readonly setLook: (look: PlayerLook) => void;
  /** Move the player without sweeping (respawn, checkpoint); followers snap instead of easing. */
  readonly teleport: (position: readonly [number, number, number]) => void;
  /** Called after every teleport. Returns the unsubscribe function. */
  readonly onTeleport: (listener: () => void) => () => void;
}

declare module '@forgeax/engine/plugin' {
  interface EngineContextServices {
    game3dPlayer: Game3dPlayerService;
  }
}
