import { mat4, vec3 } from '@forgeax/engine/math';
import { MAP_ID } from './data.js';
import { createMarkers } from './markers.js';

const PRIORITY = { events: 3 };
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export async function createOverlay({ sceneData, renderer, camera, player, teleport }) {
  const canvas = renderer.domElement;
  const res = await fetch(`/data/${MAP_ID}/markers.json`);
  const md = res.ok ? await res.json() : { categories: [], markers: [], labels: [], lootTypes: {} };
  const cats = new Map(md.categories.map((c) => [c.key, c]));
  const subs = new Map(
    md.categories.flatMap((c) => c.subs.map((s) => [`${c.key}:${s.key}`, { ...s, cat: c }])),
  );
  const list = md.markers.map((m) => ({
    ...m,
    group: `${m.c}:${m.s}`,
    range: cats.get(m.c).range,
    priority: PRIORITY[m.c] ?? 1,
  }));
  const iconOf = (m) => {
    const s = subs.get(m.group);
    return { url: `/data/${s.icon}`, bg: s.cat.color, variant: s.cat.variant, scale: s.cat.scale };
  };
  const nameOf = (m) => m.name ?? subs.get(m.group).name;
  const markers = createMarkers(list, iconOf);

  let zipCount = 0;
  function setZiplines(data) {
    zipCount = data.length;
    renderer.setZiplines(data);
  }
  setZiplines(sceneData.ziplines ?? []);

  const on = new Map([...subs].map(([k, s]) => [k, s.active]));
  const boxes = new Map(),
    catBoxes = new Map();
  let visible = true;
  function apply() {
    markers.setFilter((m) => visible && on.get(m.group));
    for (const [k, b] of boxes) b.checked = on.get(k);
    for (const [k, b] of catBoxes) {
      const st = cats.get(k).subs.map((s) => on.get(`${k}:${s.key}`));
      b.checked = st.every(Boolean);
      b.indeterminate = !b.checked && st.some(Boolean);
    }
  }
  const setAll = (fn) => {
    for (const [k, s] of subs) on.set(k, fn(s));
    apply();
  };
  {
    const panel = $('filters'),
      head = el('div', 'f-head');
    const btn = (text, fn) => {
      const b = el('button', null, text);
      b.onclick = () => {
        fn();
        b.blur();
      };
      return b;
    };
    head.append(
      el('b', null, `Map markers ${list.length}`),
      btn('All', () => setAll(() => true)),
      btn('None', () => setAll(() => false)),
      btn('Default', () => setAll((s) => s.active)),
    );
    panel.append(head);
    const check = (fn) => {
      const b = el('input');
      b.type = 'checkbox';
      b.onchange = () => {
        fn(b.checked);
        b.blur();
        apply();
      };
      return b;
    };
    for (const c of md.categories) {
      const row = el('label', 'f-cat'),
        sw = el('i');
      sw.style.background = c.color;
      const cb = check((v) => {
        for (const s of c.subs) on.set(`${c.key}:${s.key}`, v);
      });
      catBoxes.set(c.key, cb);
      row.append(
        cb,
        sw,
        el('span', null, c.name),
        el(
          'em',
          null,
          c.subs.reduce((a, s) => a + s.count, 0),
        ),
      );
      panel.append(row);
      for (const s of c.subs) {
        const k = `${c.key}:${s.key}`,
          r = el('label', 'f-sub'),
          img = el('img');
        img.src = `/data/${s.icon}`;
        if (c.variant === 'pin') img.style.background = c.color;
        const b = check((v) => on.set(k, v));
        boxes.set(k, b);
        r.append(b, img, el('span', null, s.name), el('em', null, s.count));
        panel.append(r);
      }
    }
    if (!list.length)
      panel.append(el('div', 'dim', 'Missing markers.json; run the original marker producer'));
  }
  apply();

  const labels = md.labels.map((l) => {
    let top = 0;
    for (const m of list) if (Math.hypot(m.x - l.x, m.z - l.z) < 120) top = Math.max(top, m.y);
    const e = el('div', 'district', l.text.toUpperCase());
    $('labels').append(e);
    return { e, p: vec3.create(l.x, top + 35, l.z), text: l.text };
  });

  let selected = null,
    hover = null,
    mouse = null;
  const distEl = el('span');
  const items = (a) =>
    a
      .map(
        (i) =>
          (i.name ?? JSON.stringify(i)) +
          (i.min != null ? ` ×${i.min === i.max ? i.min : `${i.min}–${i.max}`}` : '') +
          (i.sell ? `（Price ${i.sell}）` : ''),
      )
      .join('、');
  function renderCard() {
    const card = $('card');
    card.replaceChildren();
    card.hidden = !selected;
    if (!selected) return;
    const m = selected,
      s = subs.get(m.group),
      r = m.r ?? {};
    const head = el('div', 'c-head'),
      img = el('img');
    img.src = `/data/${s.icon}`;
    if (s.cat.variant === 'pin') img.style.background = s.cat.color;
    head.append(img, el('b', null, nameOf(m)));
    card.append(head, el('div', 'dim', `${s.cat.name} · ${s.name}`));
    if (m.desc) card.append(el('p', null, m.desc));
    const line = (k, v) => {
      const d = el('div', 'kv');
      d.append(el('span', 'dim', k), v instanceof Node ? v : el('span', null, v));
      card.append(d);
    };
    if (r.building) line('Building', r.building);
    if (r.inside)
      line(
        'Inside',
        Object.entries(r.inside)
          .map(([k, v]) => `${k} ${v}`)
          .join(' · '),
      );
    if (r.found?.length) line('Found', items(r.found));
    if (r.keys?.length) line('Keys', items(r.keys));
    if (r.charge?.length) line('charge', items(r.charge));
    if (r.loot?.length) line('Loot', items(r.loot));
    if (r.requires?.length) line('Requires', items(r.requires));
    if (r.unlockSec != null) line('Unlock time', `${r.unlockSec} seconds`);
    if (r.drill) line('Drill', `${r.drill.sec} seconds（${r.drill.item}）`);
    if (r.randomGroup) line('randomGroup', 'Yes');
    const pool = md.lootTypes[m.s];
    if (!r.loot && pool?.length)
      line(
        `Items ${pool.length} types`,
        pool
          .slice(0, 6)
          .map((i) => i.name)
          .join('、') + (pool.length > 6 ? ' …' : ''),
      );
    line('Position', distEl);
    card.append(el('div', 'c-foot', 'T teleport here / E close'));
  }
  function select(m) {
    selected = m ?? null;
    markers.select(selected?.id ?? null);
    renderCard();
  }

  canvas.addEventListener('mousemove', (e) => {
    mouse = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('mouseleave', () => {
    mouse = null;
  });
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyM') {
      const p = $('filters');
      p.hidden = !p.hidden;
      if (!p.hidden) document.exitPointerLock?.();
    }
    if (e.code === 'KeyN') {
      visible = !visible;
      apply();
    }
    if (e.code === 'KeyE') select(hover && hover !== selected ? hover : null);
    if (e.code === 'KeyT' && selected) teleport(selected.x, selected.y + 0.1, selected.z);
  });

  const v = vec3.create();
  function update(dt) {
    const w = innerWidth,
      h = innerHeight,
      locked = document.pointerLockElement === canvas;
    markers.setOverview(player.fly);
    markers.update(camera, w, h, dt);

    const at = locked ? { x: w / 2, y: h / 2 } : mouse;
    hover = at ? markers.pick(at.x, at.y, locked ? 28 : 20) : null;
    markers.hover(hover?.id ?? null);
    $('cross').hidden = !locked;
    const tip = $('tip'),
      sp = hover && hover !== selected ? markers.screenOf(hover.id) : null;
    tip.hidden = !sp;
    if (sp) {
      tip.textContent = `${nameOf(hover)}  ${Math.hypot(hover.x - player.pos[0], hover.y - player.pos[1], hover.z - player.pos[2]).toFixed(0)} m`;
      tip.style.transform = `translate(-50%, -100%) translate(${sp.x.toFixed(1)}px, ${(sp.y - sp.r - 8).toFixed(1)}px)`;
    }
    if (selected) {
      const d = Math.hypot(
        selected.x - player.pos[0],
        selected.y - player.pos[1],
        selected.z - player.pos[2],
      );
      distEl.textContent = `${selected.x.toFixed(1)}, ${selected.y.toFixed(1)}, ${selected.z.toFixed(1)}（distance ${d.toFixed(0)} m）`;
    }
    for (const L of labels) {
      mat4.transformVec3(v, camera.matrixWorldInverse, L.p);
      const depth = -v[2];
      mat4.transformVec3(v, camera.projectionMatrix, v);
      const show = visible && depth > 1 && Math.abs(v[0]) < 1.2 && Math.abs(v[1]) < 1.2;
      L.e.hidden = !show;
      if (!show) continue;
      L.e.style.opacity = Math.min(1, depth / 120).toFixed(2);
      L.e.style.transform = `translate(-50%, -50%) translate(${((v[0] * 0.5 + 0.5) * w).toFixed(1)}px, ${((-v[1] * 0.5 + 0.5) * h).toFixed(1)}px)`;
    }
  }

  return {
    update,
    select,
    list,
    setZiplines,
    labels: md.labels,
    source: md.source ?? null,

    click: () => {
      if (!hover) return false;
      select(hover === selected ? null : hover);
      return true;
    },
    selectId: (id) => select(list.find((m) => m.id === id)),
    setSub: (key, v) => {
      on.set(key, v);
      apply();
    },
    setAll: (v) => setAll(() => v),
    screenOf: (id) => markers.screenOf(id),
    stats: () => ({
      ...markers.stats(),
      total: list.length,
      enabled: list.reduce((a, m) => a + (visible && on.get(m.group) ? 1 : 0), 0),
      ziplines: zipCount,
      districts: labels.length,
      hover: hover?.id ?? null,
      selected: selected?.id ?? null,
    }),
  };
}
