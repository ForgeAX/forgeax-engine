// Frozen copy of the message contracts the guide fixture speaks over GameHost.port.
export const PLAYER_CONTROL_CHANNEL = 'game-3d/player-controls';
export const PLAYER_STATE_CHANNEL = 'game-3d/player-state';
export interface PlayerHudState {
  readonly height: number;
  readonly speed: number;
  readonly grounded: boolean;
  readonly running: boolean;
}
export type PlayerControl =
  | { readonly kind: 'move'; readonly horizontal: number; readonly vertical: number }
  | { readonly kind: 'look'; readonly x: number; readonly y: number }
  | { readonly kind: 'jump' }
  | { readonly kind: 'run'; readonly held: boolean }
  | { readonly kind: 'reset' };
export const VASE_CHANNEL = 'game-3d/runtime-vase';
export const VASE_PARAMETERS = [
  { name: 'height', type: 'f32', default: 2.4, minimum: 1, maximum: 4 },
  { name: 'radius', type: 'f32', default: 0.75, minimum: 0.4, maximum: 1.3 },
  { name: 'sides', type: 'u32', default: 32, minimum: 8, maximum: 64 },
] as const;
export type VaseValues = Record<(typeof VASE_PARAMETERS)[number]['name'], number>;
export interface VaseState {
  readonly busy: boolean;
  readonly guid: string;
  readonly values: VaseValues;
  readonly generation?: number;
  readonly entity?: unknown;
  readonly vertexCount?: number;
  readonly aabb?: number[];
  readonly error?: string;
}
