import { mat4 } from '@forgeax/engine/math';

const CELL = 64,
  ATLAS = 2048,
  COLS = ATLAS / CELL;
const HEAD_Y = 25,
  HEAD_R = 21,
  TIP_Y = 57;
const LIFT = 0.4,
  SIZE = 34;
const TARGET = 400,
  GROUP_REF = 12,
  MAX_BOOST = 40;

export function createMarkers(list, iconOf) {
  const n = list.length;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = CELL;
  const tctx = tmp.getContext('2d');

  function drawCell(i, icon, img) {
    const x = (i % COLS) * CELL,
      y = Math.floor(i / COLS) * CELL,
      cx = x + CELL / 2,
      cy = y + HEAD_Y;
    ctx.clearRect(x, y, CELL, CELL);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = icon.bg ?? '#26282c';
    ctx.beginPath();
    ctx.arc(cx, cy, HEAD_R, Math.PI * 0.62, Math.PI * 2.38);
    ctx.lineTo(cx, y + TIP_Y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!img) return;
    const raw = !icon.bg || icon.variant === 'none' || icon.variant === 'prebaked';
    const box = 42 * (raw ? 0.78 : 0.6 * (icon.scale ?? 1)),
      k = Math.min(box / img.width, box / img.height);
    const w = img.width * k,
      h = img.height * k;
    tctx.clearRect(0, 0, CELL, CELL);
    tctx.globalCompositeOperation = 'source-over';
    tctx.drawImage(img, (CELL - w) / 2, HEAD_Y - h / 2, w, h);
    if (!raw) {
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = icon.tint ?? '#ffffff';
      tctx.fillRect(0, 0, CELL, CELL);
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 19.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(tmp, x, y);
    ctx.restore();
  }
  const cells = new Map();
  let iconsPending = 0;
  function cellOf(icon) {
    const key = `${icon.url}|${icon.bg ?? ''}|${icon.tint ?? ''}|${icon.variant ?? ''}|${icon.scale ?? ''}`;
    let i = cells.get(key);
    if (i !== undefined) return i;
    i = cells.size;
    cells.set(key, i);
    drawCell(i, icon, null);
    const img = new Image();
    iconsPending++;
    img.onload = () => {
      drawCell(i, icon, img);
      iconsPending--;
    };
    img.onerror = () => {
      iconsPending--;
      console.warn('marker icon failed', icon.url);
    };
    img.src = icon.url;
    return i;
  }

  let scale = 1;
  const sizeOf = (m) => SIZE * scale * ((m.priority ?? 1) >= 3 ? 1 : 0.86);
  const pos = new Float32Array(n * 3),
    cell = new Float32Array(n),
    sizes = new Float32Array(n);
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  list.forEach((m, i) => {
    pos.set([m.x, m.y + LIFT, m.z], i * 3);
    cell[i] = cellOf(iconOf(m));
    sizes[i] = sizeOf(m);
    x0 = Math.min(x0, m.x);
    x1 = Math.max(x1, m.x);
    z0 = Math.min(z0, m.z);
    z1 = Math.max(z1, m.z);
  });
  const area = n ? Math.max((x1 - x0) * (z1 - z0), 1e4) : 1;
  const vis = new Float32Array(n);
  const xray = { visible: true };
  const layer = document.createElement('canvas');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1';
  document.body.append(layer);
  const draw = layer.getContext('2d');

  const pass = new Uint8Array(n).fill(1),
    want = new Float32Array(n),
    sx = new Float32Array(n),
    sy = new Float32Array(n);
  const order = list
    .map((_, i) => i)
    .sort((a, b) => (list[b].priority ?? 1) - (list[a].priority ?? 1));
  const index = new Map(list.map((m, i) => [m.id, i]));
  let selected = -1,
    hovered = -1,
    rangeMul = 0.3,
    boost = 1,
    overlap = 0.78,
    shown = 0;

  function recalc() {
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      if (!pass[i]) continue;
      const g = groups.get(list[i].group);
      g ? g.n++ : groups.set(list[i].group, { n: 1, r2: list[i].range ** 2 });
    }
    const expect = (b) => {
      let s = 0;
      for (const g of groups.values()) s += g.n * Math.min(1, (Math.PI * g.r2 * b * b) / area);
      return s;
    };
    const target = TARGET * Math.max(1, (GROUP_REF / Math.max(1, groups.size)) ** 2);
    let lo = 1,
      hi = MAX_BOOST;
    if (expect(lo) >= target) hi = lo;
    else if (expect(hi) <= target) lo = hi;
    else
      for (let k = 0; k < 24; k++) {
        const mid = Math.sqrt(lo * hi);
        if (expect(mid) < target) lo = mid;
        else hi = mid;
      }
    boost = lo;
    overlap = 0.78 - 0.28 * Math.min(1, (boost - 1) / 3);
  }
  recalc();

  const pv = mat4.create(),
    grid = new Map();
  function update(camera, width, height, dt) {
    grid.clear();
    const e = mat4.multiply(pv, camera.projectionMatrix, camera.matrixWorldInverse),
      cp = camera.position;
    const step = SIZE * 0.8 * scale;
    const free = (i) => {
      const gx = Math.floor(sx[i] / step),
        gy = Math.floor(sy[i] / step),
        r = sizes[i] * overlap;
      for (let a = -1; a <= 1; a++)
        for (let b = -1; b <= 1; b++) {
          const c = grid.get((gx + a) * 4096 + gy + b);
          if (c)
            for (const j of c)
              if (Math.abs(sx[j] - sx[i]) < r && Math.abs(sy[j] - sy[i]) < r * 1.1) return false;
        }
      const k = gx * 4096 + gy,
        c = grid.get(k);
      c ? c.push(i) : grid.set(k, [i]);
      return true;
    };
    const consider = (i) => {
      const m = list[i];
      want[i] = 0;
      if (!pass[i] && i !== selected) return;
      const x = m.x,
        y = m.y + LIFT,
        z = m.z;
      if (i !== selected) {
        const dx = x - cp[0],
          dy = m.y - cp[1],
          dz = z - cp[2],
          r = m.range * boost * rangeMul;
        if (dx * dx + dy * dy + dz * dz > r * r) return;
      }
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w < 0.3) return;
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w,
        ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.3) return;
      sx[i] = (nx * 0.5 + 0.5) * width;
      sy[i] = (-ny * 0.5 + 0.5) * height - sizes[i] * (32 / CELL);
      if (i === selected || i === hovered || free(i))
        want[i] = i === selected ? 1.3 : i === hovered ? 1.15 : 1;
    };
    if (selected >= 0) consider(selected);
    if (hovered >= 0 && hovered !== selected) consider(hovered);
    for (const i of order) if (i !== selected && i !== hovered) consider(i);
    const k = Math.min(1, dt * 10);
    shown = 0;
    for (let i = 0; i < n; i++) {
      if (want[i] > 0) shown++;
      if (vis[i] === want[i]) continue;
      const v = vis[i] + (want[i] - vis[i]) * k;
      vis[i] = Math.abs(v - want[i]) < 0.01 ? want[i] : v;
    }
    if (layer.width !== width || layer.height !== height) {
      layer.width = width;
      layer.height = height;
    }
    draw.clearRect(0, 0, width, height);
    for (let i = 0; i < n; i++) {
      if (vis[i] < 0.01) continue;
      const px = sizes[i] * (0.75 + 0.25 * Math.min(vis[i], 1));
      const tile = cell[i];
      draw.globalAlpha = Math.min(vis[i], 1);
      draw.drawImage(
        canvas,
        (tile % COLS) * CELL,
        Math.floor(tile / COLS) * CELL,
        CELL,
        CELL,
        sx[i] - px / 2,
        sy[i] - (px * HEAD_Y) / CELL,
        px,
        px,
      );
    }
  }

  function pick(x, y, max = 20) {
    let best = -1,
      bd = max;
    for (let i = 0; i < n; i++) {
      if (want[i] <= 0 || vis[i] < 0.5) continue;
      const d = Math.hypot(sx[i] - x, sy[i] - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best >= 0 ? list[best] : null;
  }
  const at = (id) => (id == null ? -1 : (index.get(id) ?? -1));
  return {
    update,
    pick,
    select: (id) => {
      selected = at(id);
    },
    hover: (id) => {
      hovered = at(id);
    },

    screenOf: (id) => {
      const i = at(id);
      return i < 0 || want[i] <= 0
        ? null
        : { x: sx[i], y: sy[i], r: sizes[i] * (HEAD_R / CELL) * want[i] };
    },
    setFilter: (fn) => {
      for (let i = 0; i < n; i++) pass[i] = fn(list[i]) ? 1 : 0;
      recalc();
    },

    setOverview: (on) => {
      rangeMul = on ? 1 : 0.3;
    },
    setStyle: (s) => {
      if (s.xray !== undefined) xray.visible = s.xray;
      if (s.scale !== undefined && s.scale !== scale) {
        scale = s.scale;
        list.forEach((m, i) => {
          sizes[i] = sizeOf(m);
        });
      }
    },
    stats: () => ({ shown, boost: +boost.toFixed(2), rangeMul, icons: cells.size, iconsPending }),
    dispose: () => {
      layer.remove();
    },
  };
}
