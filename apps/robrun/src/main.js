import { mat4, quat, vec3 } from '@forgeax/engine/math';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const upAxis = vec3.create(0, 1, 0);
function addScaled(out, a, b, scale) {
  for (let axis = 0; axis < 3; axis++) out[axis] = a[axis] + b[axis] * scale;
  return out;
}

import { createCollision } from './collision.js';
import { DATA, loadData, MAP_ID, MAP_INFO, MAPS } from './data.js';
import { createMaterials } from './materials.js';
import { createNativeRenderer } from './native-renderer.js';
import { createOverlay } from './overlay.js';
import { createWorld } from './world.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const QUALITY = {
  low: {
    pixelRatio: 1,
    shadowMap: 0,
    shadowRadius: 0,
    lodScale: 0.55,
    minScreen: 0.008,
    normals: false,
  },
  medium: {
    pixelRatio: 1.5,
    shadowMap: 1024,
    shadowRadius: 110,
    lodScale: 0.8,
    minScreen: 0.005,
    normals: true,
  },
  high: {
    pixelRatio: 2,
    shadowMap: 2048,
    shadowRadius: 200,
    lodScale: 1,
    minScreen: 0.0035,
    normals: true,
  },
};
const q = QUALITY[params.get('q')] ?? QUALITY.high;
const debug = { ready: false, errors: [], startedAt: performance.now() };
window.__looty = debug;
const fail = (m) => {
  debug.errors.push(String(m));
  $('err').textContent = debug.errors.slice(-6).join('\n');
};
addEventListener('error', (e) =>
  fail(e.message + (e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}` : '')),
);
addEventListener('unhandledrejection', (e) => fail(e.reason?.stack ?? e.reason));
const stage = (text, a = 0, b = 1) => {
  $('stage').textContent = text;
  $('bar').firstElementChild.style.width = `${(a / b) * 100}%`;
};
const paint = () => new Promise((r) => setTimeout(r, 0));

document.title = `${MAP_INFO.name} roam`;
$('loading').querySelector('h1').textContent = MAP_INFO.name.toUpperCase();
for (const m of MAPS) {
  const a = document.createElement('a');
  const qs = new URLSearchParams();
  if (m !== MAPS[0]) qs.set('map', m.id);
  if (params.get('q')) qs.set('q', params.get('q'));
  a.href = location.pathname + (qs.size ? `?${qs}` : '');
  a.textContent = m.name;
  a.title = m.note;
  if (m === MAP_INFO) a.className = 'on';
  $('maps').append(a);
}

const renderer = await createNativeRenderer(q, debug);
const camera = {
  fov: 60,
  aspect: innerWidth / innerHeight,
  near: 0.25,
  far: 14000,
  position: vec3.create(),
  quaternion: quat.create(),
  projectionMatrix: mat4.create(),
  matrixWorldInverse: mat4.create(),
};
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
});

const phi = (54 * Math.PI) / 180,
  theta = (215 * Math.PI) / 180;
const sunDir = vec3.create(
  Math.sin(phi) * Math.sin(theta),
  Math.cos(phi),
  Math.sin(phi) * Math.cos(theta),
);
const sun = {
  intensity: 2.6,
  castShadow: q.shadowMap > 0,
  position: vec3.create(),
  target: { position: vec3.create() },
  shadow: {
    mapSize: q.shadowMap || 1024,
    camera: {
      left: -(q.shadowRadius || 100),
      right: q.shadowRadius || 100,
      top: q.shadowRadius || 100,
      bottom: -(q.shadowRadius || 100),
      near: 1,
      far: 1400,
    },
  },
};
function makeWater(list) {
  renderer.setWater(list);
  return {
    time: { value: 0 },
    level: list.length ? Math.max(...list.map((w) => w.p[1])) : -Infinity,
  };
}
const RADIUS = 0.35,
  HEIGHT = 1.75,
  GRAVITY = -22,
  JUMP = 8;
const player = {
  pos: vec3.create(),
  velY: 0,
  grounded: false,
  fly: params.get('fly') === '1',
  heading: 0,
  visible: true,
};

const view = {
  yaw: Number(params.get('yaw') ?? 0.6),
  pitch: Number(params.get('pitch') ?? 0.25),
  dist: Number(params.get('dist') ?? 7),
  cur: 7,
  y: 0,
};
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'KeyF') {
    player.fly = !player.fly;
    player.velY = 0;
  }
  if (e.code === 'KeyR') respawn();
  if (e.code === 'KeyH') {
    const hide = !$('hud').hidden;
    for (const id of ['hud', 'help', 'maps']) $(id).hidden = hide;
  }
  if (e.code === 'KeyL' && q.shadowMap > 0) sun.castShadow = !sun.castShadow;
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
renderer.domElement.addEventListener('click', () => {
  if (overlay?.click()) return;
  if (document.pointerLockElement !== renderer.domElement)
    renderer.domElement.requestPointerLock?.();
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return;
  view.yaw -= e.movementX * 0.0025;
  view.pitch = clamp(view.pitch + e.movementY * 0.0025, -1.2, 1.45);
});
addEventListener(
  'wheel',
  (e) => {
    view.dist = clamp(view.dist * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 1.2, 60);
  },
  { passive: true },
);

let world,
  col,
  mats,
  water,
  overlay,
  interior = null,
  spawn = vec3.create();
function respawn() {
  vec3.copy(player.pos, spawn);
  player.velY = 0;
  player.grounded = false;
  view.y = spawn[1] + 1.5;
}

const move = vec3.create(),
  seg = { start: vec3.create(), end: vec3.create() },
  before = vec3.create(),
  push = vec3.create();
function stepPlayer(dt) {
  const key = (...c) => (c.some((k) => keys.has(k)) ? 1 : 0);
  const f = key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown'),
    r = key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft');
  const sy = Math.sin(view.yaw),
    cy = Math.cos(view.yaw);
  vec3.set(move, -sy * f + cy * r, 0, -cy * f - sy * r);
  const moving = vec3.lengthSq(move) > 0;
  if (moving) vec3.normalize(move, move);
  const sprint = key('ShiftLeft', 'ShiftRight'),
    p = player.pos;
  if (player.fly) {
    const v = sprint ? 90 : 25;
    addScaled(p, p, move, v * dt);
    p[1] += (key('Space') - key('KeyC')) * v * dt;
    player.velY = 0;
    player.grounded = false;
  } else {
    stepGroundedPlayer(dt, moving, sprint, p);
  }
  if (moving) {
    const want = Math.atan2(move[0], move[2]);
    const d = Math.atan2(Math.sin(want - player.heading), Math.cos(want - player.heading));
    player.heading += d * (1 - Math.exp(-14 * dt));
  }
}

function stepGroundedPlayer(dt, moving, sprint, p) {
  const v = sprint ? 11 : 5.5,
    was = player.grounded;
  let jumped = false;
  if (player.grounded && keys.has('Space')) {
    player.velY = JUMP;
    player.grounded = false;
    jumped = true;
  }
  const n = 5,
    h = dt / n,
    x0 = p[0],
    z0 = p[2];
  for (let i = 0; i < n; i++) {
    player.velY = player.grounded ? GRAVITY * h : player.velY + GRAVITY * h;
    p[0] += move[0] * v * h;
    p[2] += move[2] * v * h;
    p[1] += player.velY * h;
    vec3.set(seg.start, p[0], p[1] + RADIUS, p[2]);
    vec3.set(seg.end, p[0], p[1] + HEIGHT - RADIUS, p[2]);
    vec3.copy(before, seg.start);
    col.collide(seg, RADIUS);
    vec3.sub(push, seg.start, before);
    player.grounded = push[1] > Math.abs(h * player.velY * 0.25);
    const len = Math.max(0, vec3.length(push) - 1e-5);
    if (len > 0) {
      vec3.normalize(push, push);
      addScaled(p, p, push, len);
      if (player.grounded) player.velY = 0;
      else player.velY -= push[1] * push[1] * player.velY;
    }
  }

  if (!moving && was && player.grounded) {
    p[0] = x0;
    p[2] = z0;
  }

  if (!player.grounded && was && !jumped && player.velY <= 0) {
    const y = col.groundAt(p[0], p[1] + 0.4, p[2], 0.85);
    if (y !== null) {
      p[1] = y;
      player.grounded = true;
      player.velY = 0;
    }
  }
  if (interior) {
    p[0] = clamp(p[0], interior.box[0] + 1, interior.box[2] - 1);
    p[2] = clamp(p[2], interior.box[1] + 1, interior.box[3] - 1);
  }
  if (p[1] < water.level - 1.25) {
    p[1] = water.level - 1.25;
    player.velY = 0;
    player.grounded = true;
  }
  if (p[1] < -300) respawn();
}

const tgt = vec3.create(),
  off = vec3.create();
function updateCamera(dt) {
  view.y += (player.pos[1] + 1.5 - view.y) * (1 - Math.exp(-18 * dt));
  vec3.set(tgt, player.pos[0], view.y, player.pos[2]);
  const cp = Math.cos(view.pitch);
  vec3.set(off, Math.sin(view.yaw) * cp, Math.sin(view.pitch), Math.cos(view.yaw) * cp);
  let d = view.dist;
  if (!player.fly) {
    const hit = col.raycast(tgt, off, view.dist + 0.3);
    if (hit) d = Math.max(hit.distance - 0.3, 0.3);

    if (interior && off[1] > 1e-6)
      d = Math.min(d, Math.max((interior.ceiling - 0.3 - tgt[1]) / off[1], 0.3));
  }
  view.cur = d < view.cur ? d : view.cur + (d - view.cur) * (1 - Math.exp(-8 * dt));
  addScaled(camera.position, tgt, off, view.cur);
  mat4.lookAt(camera.matrixWorldInverse, camera.position, tgt, upAxis);
  quat.fromLookAt(camera.quaternion, camera.position, tgt, upAxis);
  mat4.perspective(
    camera.projectionMatrix,
    (camera.fov * Math.PI) / 180,
    camera.aspect,
    camera.near,
    camera.far,
  );
  player.visible = view.cur > 0.9;
}

const lr = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), upAxis, sunDir));
const lu = vec3.cross(vec3.create(), sunDir, lr);
const shadowAt = vec3.create(Infinity, 0, 0);
function updateLight() {
  const R = q.shadowRadius || 100,
    texel = (2 * R) / sun.shadow.mapSize,
    p = player.pos;
  const a = Math.round(vec3.dot(p, lr) / texel) * texel,
    b = Math.round(vec3.dot(p, lu) / texel) * texel,
    c = vec3.dot(p, sunDir);
  vec3.set(
    sun.target.position,
    lr[0] * a + lu[0] * b + sunDir[0] * c,
    lr[1] * a + lu[1] * b + sunDir[1] * c,
    lr[2] * a + lu[2] * b + sunDir[2] * c,
  );
  addScaled(sun.position, sun.target.position, sunDir, 600);
  if (q.shadowRadius > 0 && Math.hypot(p[0] - shadowAt[0], p[2] - shadowAt[2]) > 10) {
    vec3.copy(shadowAt, p);
    world.updateShadow(p[0], p[2], R * 1.45 + 20);
  }
}

let last = performance.now(),
  frames = 0,
  fpsAt = last,
  fps = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  stepPlayer(dt);
  updateCamera(dt);
  world.update(camera, q);
  updateLight();
  water.time.value += dt;
  col.prefetch(player.pos[0], player.pos[2]);
  overlay.update(dt);
  renderer.updateView(camera, sun, player);
  frames++;
  if (now - fpsAt > 400) {
    fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
    const s = debug.stats(),
      p = player.pos;
    $('hud').textContent =
      `${fps.toFixed(0)} fps   ${player.fly ? 'fly' : player.grounded ? 'ground' : 'air'}\n` +
      `position  ${p[0].toFixed(1)}, ${p[1].toFixed(1)}, ${p[2].toFixed(1)}\n` +
      `instances  ${s.drawn} / ${s.instances}   batches ${s.shown}\n` +
      `textures  ${s.textures}${s.pending ? `  (pending ${s.pending})` : ''}\n` +
      `collision  ${s.cells} cells  ${(s.colTris / 1e6).toFixed(2)}M triangles\n` +
      `markers  ${s.markers.shown} / ${s.markers.enabled}   ziplines ${s.markers.ziplines}   districts ${s.markers.districts}`;
  }
}

(async () => {
  stage('Downloading geometry…');
  const data = await loadData((a, b) => stage(`Downloading geometry ${a}/${b}`, a, b * 2));
  mats = createMaterials(data.scene, data.texIndex, `${DATA}/tex`, {
    normals: q.normals,
  });
  stage('Building scene…', 1, 2);
  await paint();
  world = await createWorld(data, mats, (a, b) => stage(`Building scene ${a}/${b}`, b + a, b * 2));
  stage('Building collision…', 1, 1);
  await paint();
  col = createCollision(data);
  water = makeWater(data.scene.water ?? []);

  interior = data.scene.interior ?? null;

  const up = vec3.create(0, 1, 0),
    probe = vec3.create();
  const pl = data.scene.playable;
  const [cx, cz] =
    MAP_ID === 'looty-bay' || !pl ? [30, -40] : [(pl[0] + pl[2]) / 2, (pl[1] + pl[3]) / 2];
  const pts = [...(data.scene.heights?.points ?? [])].sort(
    (a, b) => Math.hypot(a[0] - cx, a[2] - cz) - Math.hypot(b[0] - cx, b[2] - cz),
  );
  const open = (x, y, z) => {
    const g = col.groundAt(x, y + 2, z, 6);
    return (
      g !== null && Math.abs(g - y) < 0.4 && !col.raycast(vec3.set(probe, x, g + 0.5, z), up, 150)
    );
  };
  vec3.set(spawn, cx, 40, cz);

  const drop = col.groundAt(cx, 400, cz, 800);
  if (drop !== null) vec3.set(spawn, cx, drop + 0.05, cz);
  else if (pts.length) vec3.set(spawn, pts[0][0], pts[0][1] + 0.05, pts[0][2]);
  if (interior?.spawn) vec3.set(spawn, ...interior.spawn);
  else
    for (const p of pts.slice(0, 300)) {
      const y = col.groundAt(p[0], p[1] + 2, p[2], 6);
      if (y === null || Math.abs(y - p[1]) > 0.3) continue;
      let ok = open(p[0], y, p[2]);
      for (let a = 0; ok && a < 8; a++)
        ok = open(
          p[0] + Math.cos((a * Math.PI) / 4) * 4,
          y,
          p[2] + Math.sin((a * Math.PI) / 4) * 4,
        );
      if (!ok) continue;
      vec3.set(spawn, p[0], y + 0.05, p[2]);
      break;
    }
  if (params.get('pos')) vec3.set(spawn, ...params.get('pos').split(',').map(Number));
  respawn();

  const teleport = (x, y, z) => {
    vec3.set(player.pos, x, y, z);
    player.velY = 0;
    player.grounded = false;
    view.y = y + 1.5;
  };
  overlay = await createOverlay({ sceneData: data.scene, renderer, camera, player, teleport });

  Object.assign(debug, {
    player,
    view,
    camera,
    renderer: renderer.app.renderer,
    spawn,
    overlay,
    teleport,
    groundAt: (x, y, z) => col.groundAt(x, y, z, 400),
    stats: () => {
      const w = world.stats(),
        c = col.stats();
      return {
        ...w,
        instances: data.inst.n,
        textures: mats.loaded(),
        pending: mats.pending(),
        cells: c.built,
        colTris: c.tris + c.bigTris,
        markers: overlay.stats(),
        fps: +fps.toFixed(1),
        pos: Array.from(player.pos).map((v) => +v.toFixed(2)),
        grounded: player.grounded,
        fly: player.fly,
      };
    },
  });
  $('loading').remove();
  debug.cpuReadyMs = performance.now() - debug.startedAt;
  renderer.start(frame);
})().catch((e) => {
  fail(e.stack ?? e);
  stage('Load failed');
});
