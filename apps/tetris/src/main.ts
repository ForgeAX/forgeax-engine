// apps/tetris — Tetris built on @forgeax/engine-runtime.
//
// Architecture: pure game state in `./game` + `./pieces`; a pool of ECS
// entities mirrors the visible board (one entity per cell + one per "next"
// preview cell). Each frame, the input → tick → render pipeline reads the
// board, paints the active piece + its ghost on top of locked cells, and
// writes Transform.scale / pos and MeshRenderer.material (handle
// pointing at a cached unlit MaterialAsset) into the pre-allocated
// entities. Empty cells are hidden by collapsing the transform scale to 0
// (vertices collapse to a single NDC point, no fragments emitted).

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  perspective,
} from '@forgeax/engine-render';
import {
  createRenderer,
  EngineEnvironmentError,
  type Handle,
  type MaterialAsset,
} from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

import {
  BOARD_H,
  BOARD_W,
  cellColor,
  cellsOf,
  createGame,
  ghostY,
  hardDrop,
  idx,
  moveLeft,
  moveRight,
  rotate,
  softDrop,
  tick,
  togglePause,
} from './game';
import { PIECES } from './pieces';

const CELL = 1; // world units per board cell
const BOARD_OX = -(BOARD_W - 1) / 2; // centre the board on x
const BOARD_OY = -(BOARD_H - 1) / 2; // centre the board on y
const HIDDEN_SCALE = 0; // collapses cube to a point — clipped before raster
const VISIBLE_SCALE = 0.46; // half-extent of cube mesh is ~1; 0.46 leaves a 0.08 gap between cells

// Preview area (4x4) is offset to the right of the board.
const PREVIEW_OX = (BOARD_W - 1) / 2 + 3;
const PREVIEW_OY = (BOARD_H - 1) / 2 - 2;
const PREVIEW_CELL = 0.6;
const PREVIEW_SCALE = 0.28;

const GHOST_DIM = 0.18; // multiplier applied to the active piece colour for the ghost

const canvasMaybe = document.querySelector<HTMLCanvasElement>('#app');
if (!canvasMaybe) throw new Error('tetris: missing <canvas id="app"> in index.html');
const canvas: HTMLCanvasElement = canvasMaybe;

resizeCanvas(canvas);
window.addEventListener('resize', () => resizeCanvas(canvas));

const game = createGame();
const world = new World();

// Entity pools: one per board cell + one per preview cell. References stay
// stable for the lifetime of the page; the per-frame render walk only mutates
// Transform + MeshRenderer fields via `world.set`.
const boardEntities = spawnGrid(world, BOARD_W * BOARD_H);
const previewEntities = spawnGrid(world, 16);

// Camera + directional light.
const cameraDistance = 28;
world
  .spawn(
    {
      component: Transform,
      data: { pos: [0, 0, cameraDistance] },
    },
    {
      component: Camera,
      data: perspective({
        fov: Math.PI / 4,
        aspect: canvas.width / canvas.height,
        near: 0.1,
        far: 200,
      }),
    },
  )
  .unwrap();
world
  .spawn({
    component: DirectionalLight,
    data: {
      direction: [-0.4, -0.7, -0.6],
      color: [1, 1, 1],
      intensity: 1.1,
    },
  })
  .unwrap();

const scoreEl = document.getElementById('score');
const linesEl = document.getElementById('lines');
const levelEl = document.getElementById('level');
const nextEl = document.getElementById('next');
const overlayEl = document.getElementById('overlay');
const overlayTitleEl = document.getElementById('overlayTitle');
const overlayTextEl = document.getElementById('overlayText');
const restartBtn = document.getElementById('restart');

restartBtn?.addEventListener('click', () => restart());

window.addEventListener('keydown', (e) => {
  if (
    e.repeat &&
    (e.code === 'ArrowDown' ||
      e.code === 'KeyS' ||
      e.code === 'ArrowLeft' ||
      e.code === 'KeyA' ||
      e.code === 'ArrowRight' ||
      e.code === 'KeyD')
  ) {
    // Allow held-key auto-repeat for these only; other keys (rotate / drop /
    // pause / restart) should fire once per press.
  } else if (e.repeat) {
    return;
  }
  switch (e.code) {
    case 'ArrowLeft':
    case 'KeyA':
      moveLeft(game);
      e.preventDefault();
      break;
    case 'ArrowRight':
    case 'KeyD':
      moveRight(game);
      e.preventDefault();
      break;
    case 'ArrowDown':
    case 'KeyS':
      softDrop(game);
      e.preventDefault();
      break;
    case 'ArrowUp':
    case 'KeyW':
    case 'KeyX':
      rotate(game, 1);
      e.preventDefault();
      break;
    case 'KeyZ':
      rotate(game, -1);
      e.preventDefault();
      break;
    case 'Space':
      hardDrop(game);
      e.preventDefault();
      break;
    case 'KeyP':
      togglePause(game);
      e.preventDefault();
      break;
    case 'KeyR':
      restart();
      e.preventDefault();
      break;
  }
});

bootstrap().catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) console.error('[tetris] no usable backend:', err);
  else console.error('[tetris] bootstrap error:', err);
});

// Test bus (opt-in): browser tests set globalThis.__learnRenderErrors before
// importing this module; pushing RHI errors into it lets the shared
// onerror-gate observe SUT-attributable failures. No-op in production (the
// bus is undefined), so this stays a pure diagnostic tap.
function pushError(code: string, hint: string | undefined): void {
  const bus = (
    globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }
  ).__learnRenderErrors;
  if (bus !== undefined) bus.push(hint === undefined ? { code } : { code, hint });
}

async function bootstrap(): Promise<void> {
  const created = await createRenderer(canvas, {});
  if (!created.ok) throw created.error;
  const renderer = created.value;
  const worldAttachment1 = renderer.attach(world);
  if (!worldAttachment1.ok) throw worldAttachment1.error;
  const lease = worldAttachment1.value;
  renderer.subscribe((event) => {
    if (event.kind !== 'error') return;
    const e = event.error;
    console.error('[tetris] renderer error:', e.code, e.hint);
    pushError(e.code, e.hint);
  });
  console.warn(`[tetris] backend=${renderer.inspect().capabilities.backendKind}`);

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(game, dt);
    paint();
    updateHud();
    world.update().unwrap();
    const r = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!r.ok) {
      console.error('[tetris] draw error:', r.error);
      pushError(r.error.code, r.error.hint);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function spawnGrid(w: World, count: number): EntityHandle[] {
  const out: EntityHandle[] = [];
  for (let i = 0; i < count; i++) {
    const r = w.spawn(
      {
        component: Transform,
        data: {
          scale: [HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      {
        component: MeshRenderer,
        data: {},
      },
    );
    out.push(r.unwrap());
  }
  return out;
}

// Per-cell colour is dynamic (active piece, ghost, locked). Each distinct
// RGB triple is registered as an unlit MaterialAsset on first request and
// reused thereafter via a Map keyed on the quantised RGB string. AI users
// reading this pattern see one MaterialAsset per palette entry, not one
// per cell — the AssetRegistry keeps the handle space bounded.
const materialCache = new Map<string, Handle<'MaterialAsset', 'shared'>>();

function colorKey(r: number, g: number, b: number): string {
  // Quantise to 1/256 so floating-point drift between paint frames does
  // not blow up the cache for the same logical colour.
  const qr = Math.round(r * 255);
  const qg = Math.round(g * 255);
  const qb = Math.round(b * 255);
  return `${qr},${qg},${qb}`;
}

function materialFor(r: number, g: number, b: number): Handle<'MaterialAsset', 'shared'> | null {
  const key = colorKey(r, g, b);
  const cached = materialCache.get(key);
  if (cached !== undefined) return cached;
  const handle = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.unlit([r, g, b, 1]),
  );
  materialCache.set(key, handle);
  return handle;
}

function paint(): void {
  // 1) overlay ghost cells (dim colour of active piece) for the playing phase.
  const ghostCells = new Set<number>();
  if (game.phase === 'playing') {
    const gy = ghostY(game);
    const ghost = { ...game.active, y: gy };
    for (const [cx, cy] of cellsOf(ghost)) {
      if (cx < 0 || cx >= BOARD_W || cy < 0 || cy >= BOARD_H) continue;
      ghostCells.add(idx(cx, cy));
    }
  }
  // 2) overlay active piece cells.
  const activeCells = new Set<number>();
  if (game.phase !== 'over') {
    for (const [cx, cy] of cellsOf(game.active)) {
      if (cx < 0 || cx >= BOARD_W || cy < 0 || cy >= BOARD_H) continue;
      activeCells.add(idx(cx, cy));
    }
  }
  const activeColor = PIECES[game.active.kind].color;

  // 3) paint board cells.
  for (let y = 0; y < BOARD_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const i = idx(x, y);
      const entity = boardEntities[i] as EntityHandle;
      const locked = game.board[i] ?? 0;
      let color: readonly [number, number, number] | null = null;
      if (activeCells.has(i)) color = activeColor;
      else if (locked !== 0) color = cellColor(locked);
      else if (ghostCells.has(i)) {
        color = [
          activeColor[0] * GHOST_DIM,
          activeColor[1] * GHOST_DIM,
          activeColor[2] * GHOST_DIM,
        ];
      }
      if (color) {
        world.set(entity, Transform, {
          pos: [BOARD_OX + x * CELL, BOARD_OY + y * CELL, 0],
          scale: [VISIBLE_SCALE, VISIBLE_SCALE, VISIBLE_SCALE],
        });
        const mat = materialFor(color[0], color[1], color[2]);
        if (mat !== null) {
          world.set(entity, MeshRenderer, {
            materials: [mat],
          });
        }
      } else {
        world.set(entity, Transform, {
          scale: [HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE],
        });
      }
    }
  }

  // 4) preview "next" piece in its own 4x4 mini grid.
  const nextSpec = PIECES[game.next];
  const nextCells = new Set<string>();
  for (const [dx, dy] of nextSpec.rotations[0] as readonly (readonly [number, number])[]) {
    nextCells.add(`${dx},${3 - dy}`);
  }
  for (let py = 0; py < 4; py++) {
    for (let px = 0; px < 4; px++) {
      const entity = previewEntities[py * 4 + px] as EntityHandle;
      if (nextCells.has(`${px},${py}`)) {
        world.set(entity, Transform, {
          pos: [PREVIEW_OX + (px - 1.5) * PREVIEW_CELL, PREVIEW_OY + (py - 1.5) * PREVIEW_CELL, 0],
          scale: [PREVIEW_SCALE, PREVIEW_SCALE, PREVIEW_SCALE],
        });
        const mat = materialFor(nextSpec.color[0], nextSpec.color[1], nextSpec.color[2]);
        if (mat !== null) {
          world.set(entity, MeshRenderer, {
            materials: [mat],
          });
        }
      } else {
        world.set(entity, Transform, {
          scale: [HIDDEN_SCALE, HIDDEN_SCALE, HIDDEN_SCALE],
        });
      }
    }
  }
}

function updateHud(): void {
  if (scoreEl) scoreEl.textContent = String(game.score);
  if (linesEl) linesEl.textContent = String(game.lines);
  if (levelEl) levelEl.textContent = String(game.level);
  if (nextEl) nextEl.textContent = game.next;
  if (overlayEl && overlayTitleEl && overlayTextEl) {
    if (game.phase === 'over') {
      overlayTitleEl.textContent = 'GAME OVER';
      overlayTextEl.textContent = `Final score ${game.score} — press R to restart`;
      overlayEl.classList.add('show');
    } else if (game.phase === 'paused') {
      overlayTitleEl.textContent = 'PAUSED';
      overlayTextEl.textContent = 'Press P to resume';
      overlayEl.classList.add('show');
    } else {
      overlayEl.classList.remove('show');
    }
  }
}

function restart(): void {
  const fresh = createGame();
  game.board.set(fresh.board);
  game.active = fresh.active;
  game.next = fresh.next;
  game.bag = fresh.bag;
  game.phase = fresh.phase;
  game.score = fresh.score;
  game.lines = fresh.lines;
  game.level = fresh.level;
  game.dropTimer = fresh.dropTimer;
  game.dropInterval = fresh.dropInterval;
}

function resizeCanvas(target: HTMLCanvasElement): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = target.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;
}
