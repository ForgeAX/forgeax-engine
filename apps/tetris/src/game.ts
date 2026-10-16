// Tetris game state — pure, framework-free. Board is row-major: index 0 is the
// bottom-left cell, `BOARD_W * BOARD_H - 1` is the top-right. Cell values are
// 0 (empty) or 1..7 (locked piece kind id, used to recover colour). The active
// piece floats above the locked board and is rasterised on top during draw.

import { type Cell, PIECE_KINDS, PIECES, type PieceKind } from './pieces';

export const BOARD_W = 10;
export const BOARD_H = 20;

export type ColorRGB = readonly [number, number, number];

export interface ActivePiece {
  readonly kind: PieceKind;
  readonly rot: number; // 0..3
  readonly x: number; // origin column of the 4x4 box (can be negative)
  readonly y: number; // origin row (bottom-left of the 4x4 box; can be < 0)
}

export type Phase = 'playing' | 'over' | 'paused';

export interface GameState {
  readonly board: Uint8Array; // length BOARD_W * BOARD_H, values 0..7
  active: ActivePiece;
  next: PieceKind;
  bag: PieceKind[]; // 7-bag randomiser remainder
  phase: Phase;
  score: number;
  lines: number;
  level: number;
  dropTimer: number; // seconds accumulated since last gravity step
  dropInterval: number; // seconds per gravity step (derived from level)
}

const KIND_TO_ID: Record<PieceKind, number> = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
const ID_TO_KIND: readonly (PieceKind | null)[] = [null, 'I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export function idx(x: number, y: number): number {
  return y * BOARD_W + x;
}

export function cellColor(id: number): ColorRGB | null {
  const k = ID_TO_KIND[id];
  if (!k) return null;
  return PIECES[k].color;
}

function refillBag(prev: PieceKind[]): PieceKind[] {
  const out = prev.slice();
  const bag = PIECE_KINDS.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = bag[i] as PieceKind;
    bag[i] = bag[j] as PieceKind;
    bag[j] = tmp;
  }
  out.push(...bag);
  return out;
}

function takeFromBag(state: GameState): PieceKind {
  if (state.bag.length === 0) state.bag = refillBag(state.bag);
  return state.bag.shift() as PieceKind;
}

function spawnPiece(kind: PieceKind): ActivePiece {
  // Spawn near the top, horizontally centred for a 4-wide bounding box.
  return { kind, rot: 0, x: 3, y: BOARD_H - 4 };
}

export function cellsOf(p: ActivePiece): Cell[] {
  const rots = PIECES[p.kind].rotations;
  const tab = rots[p.rot & 3] as readonly Cell[];
  const out: Cell[] = [];
  for (const [dx, dy] of tab) out.push([p.x + dx, p.y + (3 - dy)]);
  return out;
}

function isValid(state: GameState, p: ActivePiece): boolean {
  for (const [cx, cy] of cellsOf(p)) {
    if (cx < 0 || cx >= BOARD_W || cy < 0) return false;
    if (cy >= BOARD_H) continue; // allow spawn rows above visible board
    if ((state.board[idx(cx, cy)] ?? 0) !== 0) return false;
  }
  return true;
}

function levelFromLines(lines: number): number {
  return Math.floor(lines / 10) + 1;
}

function intervalForLevel(level: number): number {
  // Classic Tetris curve, clamped at ~50ms.
  const t = Math.max(0.05, (0.8 - (level - 1) * 0.007) ** (level - 1));
  return t;
}

export function createGame(): GameState {
  const bag = refillBag([]);
  const firstKind = bag.shift() as PieceKind;
  const nextKind = bag.shift() as PieceKind;
  const active = spawnPiece(firstKind);
  return {
    board: new Uint8Array(BOARD_W * BOARD_H),
    active,
    next: nextKind,
    bag,
    phase: 'playing',
    score: 0,
    lines: 0,
    level: 1,
    dropTimer: 0,
    dropInterval: intervalForLevel(1),
  };
}

function tryMove(state: GameState, dx: number, dy: number): boolean {
  if (state.phase !== 'playing') return false;
  const moved = { ...state.active, x: state.active.x + dx, y: state.active.y + dy };
  if (isValid(state, moved)) {
    state.active = moved;
    return true;
  }
  return false;
}

export function moveLeft(state: GameState): void {
  tryMove(state, -1, 0);
}

export function moveRight(state: GameState): void {
  tryMove(state, 1, 0);
}

export function softDrop(state: GameState): void {
  if (tryMove(state, 0, -1)) state.score += 1;
  else lockPiece(state);
}

export function hardDrop(state: GameState): void {
  if (state.phase !== 'playing') return;
  let fall = 0;
  while (tryMove(state, 0, -1)) fall += 1;
  state.score += fall * 2;
  lockPiece(state);
}

export function rotate(state: GameState, dir: 1 | -1): void {
  if (state.phase !== 'playing') return;
  const rot = ((state.active.rot + dir) & 3) as 0 | 1 | 2 | 3;
  // Wall-kick: try offsets in order — neutral, left 1, right 1, up 1, left 2,
  // right 2. Enough to clear the common wall/floor conflicts for non-I pieces.
  const kicks: readonly Cell[] = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, 1],
    [-2, 0],
    [2, 0],
  ];
  for (const [kx, ky] of kicks) {
    const cand = { ...state.active, rot, x: state.active.x + kx, y: state.active.y + ky };
    if (isValid(state, cand)) {
      state.active = cand;
      return;
    }
  }
}

function lockPiece(state: GameState): void {
  const id = KIND_TO_ID[state.active.kind];
  let landedAboveTop = false;
  for (const [cx, cy] of cellsOf(state.active)) {
    if (cy >= BOARD_H) {
      landedAboveTop = true;
      continue;
    }
    if (cx < 0 || cx >= BOARD_W || cy < 0) continue;
    state.board[idx(cx, cy)] = id;
  }
  const cleared = clearLines(state);
  if (cleared > 0) {
    const table = [0, 100, 300, 500, 800];
    state.score += (table[cleared] ?? 800) * state.level;
    state.lines += cleared;
    const newLevel = levelFromLines(state.lines);
    if (newLevel !== state.level) {
      state.level = newLevel;
      state.dropInterval = intervalForLevel(newLevel);
    }
  }
  // Spawn next piece.
  const kind = state.next;
  state.next = takeFromBag(state);
  state.active = spawnPiece(kind);
  if (!isValid(state, state.active) || landedAboveTop) {
    state.phase = 'over';
  }
}

function clearLines(state: GameState): number {
  let write = 0;
  let cleared = 0;
  const next = new Uint8Array(state.board.length);
  for (let y = 0; y < BOARD_H; y++) {
    let full = true;
    for (let x = 0; x < BOARD_W; x++) {
      if ((state.board[idx(x, y)] ?? 0) === 0) {
        full = false;
        break;
      }
    }
    if (full) {
      cleared += 1;
      continue;
    }
    for (let x = 0; x < BOARD_W; x++) next[write * BOARD_W + x] = state.board[idx(x, y)] ?? 0;
    write += 1;
  }
  state.board.set(next);
  return cleared;
}

export function tick(state: GameState, dtSeconds: number): void {
  if (state.phase !== 'playing') return;
  state.dropTimer += dtSeconds;
  while (state.dropTimer >= state.dropInterval) {
    state.dropTimer -= state.dropInterval;
    if (!tryMove(state, 0, -1)) {
      lockPiece(state);
      if (state.phase !== 'playing') return;
    }
  }
}

export function togglePause(state: GameState): void {
  if (state.phase === 'playing') state.phase = 'paused';
  else if (state.phase === 'paused') state.phase = 'playing';
}

export function ghostY(state: GameState): number {
  let y = state.active.y;
  // Drop until invalid.
  while (true) {
    const cand = { ...state.active, y: y - 1 };
    if (!isValid(state, cand)) return y;
    y -= 1;
  }
}
