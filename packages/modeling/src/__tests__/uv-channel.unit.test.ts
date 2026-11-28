import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import type { NurbsSurface } from '../nurbs';
import { sel } from '../selectors';
import { type TrimRegion, trimSheet } from '../trim';
import { uvOverlapPairs } from '../uv-overlap';

function rect(x0: number, w: number, h: number): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [
        [x0, 0, 0],
        [x0, 0, h],
      ],
      [
        [x0 + w, 0, 0],
        [x0 + w, 0, h],
      ],
    ] as Tuple3[][],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/** Two disjoint quads whose uv0 both fill the same [0, 1] square (a tiling layout). */
function tiled(): Model {
  const m = model();
  for (const x of [0, 3]) {
    m.polygon({
      points: [
        [x, 0, 0],
        [x + 1, 0, 0],
        [x + 1, 1, 0],
        [x, 1, 0],
      ],
    });
  }
  const mesh = m.editMesh;
  for (const f of mesh.faces()) {
    mesh.faceHalves(f).forEach((h, k) => {
      mesh.setCorner('uv0', h, [k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0]);
    });
  }
  return m;
}

function patch(): Model {
  const m = model();
  m.surface({
    patches: [
      { surface: rect(0, 1, 1), name: 'a' },
      { surface: rect(5, 2, 1), name: 'b' },
    ],
    chord: 0.01,
  });
  return m;
}

const dump = (m: Model, channel: 'uv0' | 'uv1' | 'uv2') => {
  const mesh = m.editMesh;
  return mesh.faces().flatMap((f) =>
    mesh.faceHalves(f).map((h) => {
      const c = mesh.corner(channel, h);
      return c === undefined ? null : Array.from(c);
    }),
  );
};

const normals = (m: Model) => {
  const out = m.toMesh({ normals: { mode: 'surface' } });
  if (!out.ok) throw out.error;
  return Array.from(out.value.mesh.attributes.normal as Float32Array);
};

describe('uv.lightmap', () => {
  it('packs a unique unit-square uv1 from overlapping uv0 islands and leaves uv0 alone', () => {
    const m = tiled();
    const mesh = m.editMesh;
    expect(uvOverlapPairs(mesh, mesh.faces(), 'uv0').length).toBeGreaterThan(0);
    const before = dump(m, 'uv0');
    const r = m.uv.lightmap({ resolution: 256 });
    expect(r.status).toBe('ok');
    expect(dump(m, 'uv0')).toEqual(before);
    expect(uvOverlapPairs(mesh, mesh.faces(), 'uv1')).toEqual([]);
    for (const c of dump(m, 'uv1')) {
      for (const v of c as number[]) expect(v).toBeGreaterThanOrEqual(-1e-6);
      for (const v of c as number[]) expect(v).toBeLessThanOrEqual(1 + 1e-6);
    }
    const v = m.validate({ surface: { need: ['uv0', 'uv1'], uniqueUv1: true } });
    expect(v.issues.filter((i) => i.code === 'surface')).toEqual([]);
  });

  it('uv1-overlap reports a uv1 copied from overlapping uv0', () => {
    const m = tiled();
    m.uv.channel({ op: 'copy', from: 'uv0', to: 'uv1' });
    const v = m.validate({ surface: { need: ['uv0', 'uv1'], uniqueUv1: true } });
    expect(v.issues.filter((i) => i.code === 'surface').map((i) => i.detail.check)).toEqual([
      'uv1-overlap',
    ]);
    const off = m.validate({ surface: { need: ['uv0', 'uv1'] } });
    expect(off.issues.filter((i) => i.code === 'surface')).toEqual([]);
  });

  it('keeps separate islands apart by the mip-safe padding (no stacking of congruent islands)', () => {
    const m = tiled();
    const r = m.uv.lightmap({ resolution: 512 });
    expect(r.status).toBe('ok');
    const mesh = m.editMesh;
    const boxes = mesh.faces().map((f) => {
      const cs = mesh.faceHalves(f).map((h) => mesh.corner('uv1', h) as Float32Array);
      return [
        Math.min(...cs.map((c) => c[0] as number)),
        Math.max(...cs.map((c) => c[0] as number)),
        Math.min(...cs.map((c) => c[1] as number)),
        Math.max(...cs.map((c) => c[1] as number)),
      ];
    });
    const [a, b] = boxes as [number[], number[], ...number[][]];
    const apart =
      (a[1] as number) < (b[0] as number) ||
      (b[1] as number) < (a[0] as number) ||
      (a[3] as number) < (b[2] as number) ||
      (b[3] as number) < (a[2] as number);
    expect(apart).toBe(true);
  });

  it('normalizes islands to one texel density', () => {
    const m = model();
    for (const w of [1, 3]) {
      m.polygon({
        points: [
          [w * 10, 0, 0],
          [w * 10 + w, 0, 0],
          [w * 10 + w, 1, 0],
          [w * 10, 1, 0],
        ],
      });
    }
    const mesh = m.editMesh;
    for (const f of mesh.faces())
      mesh.faceHalves(f).forEach((h, k) => {
        mesh.setCorner('uv0', h, [k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0]);
      });
    expect(m.uv.lightmap({ resolution: 256 }).status).toBe('ok');
    const [small, big] = mesh.faces().map((f) => {
      const cs = mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv1', h) as Float32Array));
      const xs = cs.map((c) => c[0] as number);
      const ys = cs.map((c) => c[1] as number);
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    }) as [number, number];
    expect(big / small).toBeGreaterThan(2.5);
    expect(big / small).toBeLessThan(3.5);
  });

  it('the default padding follows the resolution: mips 3 at 1024, 7 at the 16384 ceiling, so the Math.min(10) cap never binds (L27)', () => {
    const mips = (resolution: number) => {
      const m = tiled();
      const r = m.uv.lightmap({ resolution });
      expect(r.status).toBe('ok');
      const info = r.diagnostics?.find((d) => d.severity === 'info' && d.detail?.padding);
      return (info?.detail as { padding: { mips: number } }).padding.mips;
    };
    expect(mips(128)).toBe(0);
    expect(mips(1024)).toBe(3);
    expect(mips(16384)).toBe(7);
  });

  it('a mesh without patches never trips the carrier refusal', () => {
    const m = tiled();
    m.uv.channel({ op: 'copy', from: 'uv0', to: 'uv1' });
    expect(m.uv.lightmap({ resolution: 128 }).status).toBe('ok');
  });

  it('rejects a bad resolution, from and domain', () => {
    for (const o of [
      { resolution: 0 },
      { resolution: Number.NaN },
      { resolution: 64, from: 'uv1' },
      { resolution: 64, domain: 'uv3' },
    ]) {
      const r = tiled().uv.lightmap(o as never);
      expect(r.status).toBe('failed');
      expect(r.error?.code).toBe('model-invalid-argument');
    }
  });

  it('needs uv0 on every face', () => {
    const m = model();
    m.plane({ width: 1, height: 1 });
    const r = m.uv.lightmap({ resolution: 64 });
    expect(r.error?.code).toBe('model-precondition');
    expect(JSON.stringify(r.error)).toContain('no-source-uv');
  });
});

describe('uv.lightmap on a patch mesh (domain carrier)', () => {
  it('refuses to overwrite a uv1 holding the patch domain and leaves the mesh unchanged', () => {
    const m = patch();
    m.uv.project({ mode: 'box', scale: 1 });
    const uv1 = dump(m, 'uv1');
    const bytes = m.snapshot();
    const r = m.uv.lightmap({ resolution: 256 });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    expect(JSON.stringify(r.error)).toContain('patch-domain-carrier');
    expect(dump(m, 'uv1')).toEqual(uv1);
    expect(m.snapshot()).toEqual(bytes);
  });

  it('copyTo-uv2 keeps the domain in uv2 and surface normals are identical afterwards', () => {
    const m = patch();
    m.uv.project({ mode: 'box', scale: 1 });
    const domain = dump(m, 'uv1');
    const before = normals(m);
    const r = m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    expect(r.status).toBe('ok');
    expect(dump(m, 'uv2')).toEqual(domain);
    expect(dump(m, 'uv1')).not.toEqual(domain);
    expect(normals(m)).toEqual(before);
    const mesh = m.editMesh;
    expect(uvOverlapPairs(mesh, mesh.faces(), 'uv1')).toEqual([]);
  });

  it('a normals read of the old carrier would differ: the export reads the recorded channel', () => {
    const m = patch();
    m.uv.project({ mode: 'box', scale: 1 });
    const out = m.toMesh({ normals: { mode: 'surface' } });
    if (!out.ok) throw out.error;
    const [hit, total] = out.value.report.exactNormals ?? [0, 0];
    expect(total).toBeGreaterThan(0);
    m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    const moved = m.toMesh({ normals: { mode: 'surface' } });
    if (!moved.ok) throw moved.error;
    expect(moved.value.report.exactNormals).toEqual([hit, total]);
  });

  it('uv.fromPatch on a moved carrier reads uv2 and writes the uv0 the unmoved session writes', () => {
    for (const mode of ['intrinsic', 'conformalScaled'] as const) {
      const plain = patch();
      expect(plain.uv.fromPatch({ mode }).status).toBe('ok');
      const m = patch();
      m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
      expect(m.uv.fromPatch({ mode }).status).toBe('ok');
      expect(dump(m, 'uv0')).toEqual(dump(plain, 'uv0'));
      expect(dump(m, 'uv2')).toEqual(dump(plain, 'uv1'));
    }
  });

  it('uv.fromPatch on faces the moved carrier does not cover fails with no-patch-domain and writes nothing', () => {
    const m = patch();
    m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    m.box({ size: [1, 1, 1] });
    m.uv.project({ mode: 'box', scale: 1 });
    const uv0 = dump(m, 'uv0');
    const r = m.uv.fromPatch({ mode: 'intrinsic' });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.error)).toContain('no-patch-domain');
    expect(JSON.stringify(r.error)).toContain('"carrier":"uv2"');
    expect(dump(m, 'uv0')).toEqual(uv0);
  });

  it('m.surface after the move writes the new patch domain to the recorded carrier', () => {
    const late = { patches: [{ surface: rect(10, 1, 1), name: 'late' }], chord: 0.01 };
    const control = patch();
    control.surface(late);
    const exact = control.toMesh({ normals: { mode: 'surface' } });
    if (!exact.ok) throw exact.error;

    const m = patch();
    m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    const r = m.surface(late);
    expect(r.status).toBe('ok');
    expect(JSON.stringify(r.diagnostics)).toContain('domain-carrier');
    expect(dump(m, 'uv2').every((c) => c !== null)).toBe(true);
    expect(dump(m, 'uv2')).toEqual(dump(control, 'uv1'));
    const out = m.toMesh({ normals: { mode: 'surface' } });
    if (!out.ok) throw out.error;
    expect(out.value.report.exactNormals).toEqual(exact.value.report.exactNormals);
    expect(out.value.report.normalDomain).toBe('uv2');
    expect(exact.value.report.normalDomain).toBeUndefined();
    expect(m.uv.fromPatch({ mode: 'intrinsic' }).status).toBe('ok');
    const lightmapped = m.uv.lightmap({ resolution: 256 });
    expect(lightmapped.status).toBe('ok');
    const mesh = m.editMesh;
    expect(uvOverlapPairs(mesh, mesh.faces(), 'uv1')).toEqual([]);
    expect(m.toMesh({ normals: { mode: 'surface' } }).ok).toBe(true);
  });

  it('a UV operator that overwrites the patch domain says so (warn, legacy behaviour kept)', () => {
    const made = trimSheet({
      key: 'kit',
      size: 512,
      density: 256,
      padding: 8,
      modules: [{ id: 'bolt', size: [0.125, 0.125] }],
    });
    if (!made.ok) throw made.error;
    const stub = made.value.regions.bolt as TrimRegion;
    const attempts: readonly ((m: Model) => ReturnType<Model['uv']['project']>)[] = [
      (m) => m.uv.project({ mode: 'box', scale: 1, channel: 'uv1' }),
      (m) => m.uv.project({ mode: 'box', scale: 1, channel: 'uv1', faces: sel.all() }),
      (m) => m.uv.unwrap({ channel: 'uv1' }),
      (m) => m.uv.pack({ resolution: 64, padding: 2, channel: 'uv1' }),
      (m) => m.uv.pack({ resolution: 64, padding: 2, channel: 'uv1', faces: sel.all() }),
      (m) => m.uv.auto({ resolution: 64, padding: 2, channel: 'uv1' }),
      (m) => m.uv.auto({ resolution: 64, padding: 2, channel: 'uv1', faces: sel.all() }),
      (m) =>
        m.uv.trim({ faces: sel.all(), region: stub, fit: { u: 'fit', v: 'fit' }, channel: 'uv1' }),
      (m) => m.uv.swatch({ faces: sel.all(), region: stub, channel: 'uv1' }),
    ];
    for (const attempt of attempts) {
      const m = patch();
      m.uv.project({ mode: 'box', scale: 1 });
      const r = attempt(m);
      expect(`${r.op} ${r.status} ${r.error?.message}`).toContain('ok');
      const w = (r.diagnostics ?? []).filter((d) => d.detail?.code === 'domain-overwritten');
      expect(w.length).toBe(1);
      expect(w[0]?.severity).toBe('warn');
      expect(w[0]?.detail?.channel).toBe('uv1');
    }
  });

  it('the overwrite note looks only at the selected faces', () => {
    const m = patch();
    m.box({ size: [1, 1, 1], label: 'cube' });
    const box = sel.createdBy('cube');
    expect(m.count(box)).toBeGreaterThan(0);
    const clean = m.uv.project({ mode: 'box', scale: 1, channel: 'uv1', faces: box });
    expect(clean.status).toBe('ok');
    expect(JSON.stringify(clean.diagnostics ?? [])).not.toContain('domain-overwritten');
    const r = m.uv.project({ mode: 'box', scale: 1, channel: 'uv1', faces: sel.tag('a') });
    expect(JSON.stringify(r.diagnostics)).toContain('domain-overwritten');
  });

  it('uv1 is free for UV operators once the carrier moved, and uv0 always is', () => {
    const m = patch();
    m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    const domain = dump(m, 'uv2');
    expect(m.uv.project({ mode: 'box', scale: 1, channel: 'uv1' }).status).toBe('ok');
    expect(dump(m, 'uv2')).toEqual(domain);
    expect(m.uv.project({ mode: 'box', scale: 1 }).status).toBe('ok');
  });

  it('uv2 holding data blocks the move', () => {
    const m = patch();
    m.uv.channel({ op: 'copy', from: 'uv0', to: 'uv2' });
    const r = m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    expect(JSON.stringify(r.error)).toContain('channel-occupied');
  });

  it('the carrier rolls back with try() and with a failed operation', () => {
    const m = patch();
    const kept = m.try((x) => {
      x.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
      x.box({ size: [Number.NaN, 1, 1] });
    });
    expect(kept.ok).toBe(false);
    expect(dump(m, 'uv2').every((c) => c === null)).toBe(true);
    expect(m.uv.fromPatch({ mode: 'intrinsic' }).status).toBe('ok');
    const done = m.try((x) => {
      x.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    });
    expect(done.ok).toBe(true);
    expect(JSON.stringify(m.uv.channel({ op: 'delete', to: 'uv2' }).error)).toContain(
      'channel-protected',
    );
  });

  it('a rolled-back try() keeps a carrier that was moved before it', () => {
    const m = patch();
    m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    const failed = m.try((x) => {
      x.box({ size: [Number.NaN, 1, 1] });
    });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(m.uv.channel({ op: 'delete', to: 'uv2' }).error)).toContain(
      'channel-protected',
    );
  });
});

describe('uv.channel', () => {
  it('copy then delete round-trips and swap is its own inverse', () => {
    const m = tiled();
    const uv0 = dump(m, 'uv0');
    expect(m.uv.channel({ op: 'copy', from: 'uv0', to: 'uv2' }).status).toBe('ok');
    expect(dump(m, 'uv2')).toEqual(uv0);
    m.uv.lightmap({ resolution: 128 });
    const uv1 = dump(m, 'uv1');
    expect(m.uv.channel({ op: 'swap', from: 'uv1', to: 'uv2' }).status).toBe('ok');
    expect(dump(m, 'uv1')).toEqual(uv0);
    expect(dump(m, 'uv2')).toEqual(uv1);
    m.uv.channel({ op: 'swap', from: 'uv1', to: 'uv2' });
    expect(dump(m, 'uv1')).toEqual(uv1);
    expect(dump(m, 'uv2')).toEqual(uv0);
    expect(m.uv.channel({ op: 'delete', to: 'uv2' }).status).toBe('ok');
    expect(m.editMesh.channels.has('uv2')).toBe(false);
    expect(dump(m, 'uv0')).toEqual(uv0);
  });

  it('swap moves an unset corner as unset', () => {
    const m = tiled();
    const mesh = m.editMesh;
    const [first, second] = mesh.faces() as [number, number];
    for (const h of mesh.faceHalves(first)) mesh.setCorner('uv2', h, [0.25, 0.75]);
    m.uv.channel({ op: 'swap', from: 'uv0', to: 'uv2' });
    const h0 = mesh.faceHalves(first)[0] as number;
    expect(Array.from(mesh.corner('uv0', h0) as Float32Array)).toEqual([0.25, 0.75]);
    for (const h of mesh.faceHalves(second)) expect(mesh.corner('uv0', h)).toBeUndefined();
  });

  it('delete uv0 is refused', () => {
    const m = tiled();
    const r = m.uv.channel({ op: 'delete', to: 'uv0' });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.error)).toContain('channel-protected');
    expect(m.editMesh.channels.has('uv0')).toBe(true);
  });

  it('copy, swap and delete onto the recorded carrier are refused', () => {
    for (const options of [
      { op: 'copy', from: 'uv0', to: 'uv1' },
      { op: 'swap', from: 'uv0', to: 'uv1' },
      { op: 'swap', from: 'uv1', to: 'uv0' },
      { op: 'delete', to: 'uv1' },
    ] as const) {
      const m = patch();
      m.uv.project({ mode: 'box', scale: 1 });
      const bytes = m.snapshot();
      const r = m.uv.channel(options);
      expect(r.status).toBe('failed');
      expect(JSON.stringify(r.error)).toContain('channel-protected');
      expect(m.snapshot()).toEqual(bytes);
    }
  });

  it('a moved carrier is protected at uv2, and uv1 is free again', () => {
    const moved = () => {
      const m = patch();
      m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
      return m;
    };
    expect(JSON.stringify(moved().uv.channel({ op: 'delete', to: 'uv2' }).error)).toContain(
      'channel-protected',
    );
    expect(moved().uv.channel({ op: 'delete', to: 'uv1' }).status).toBe('ok');
  });

  it('the carrier protection looks only at the faces the operation selects (L33)', () => {
    const mixed = () => {
      const m = patch();
      m.box({ size: [1, 1, 1], center: [0, 4, 0], label: 'cube' });
      return m;
    };
    const cube = sel.createdBy('cube');
    const blocked = mixed();
    const bytes = blocked.snapshot();
    const onPatch = blocked.uv.channel({ op: 'delete', to: 'uv1', faces: sel.tag('a') });
    expect(onPatch.status).toBe('failed');
    expect(JSON.stringify(onPatch.error)).toContain('channel-protected');
    expect(blocked.snapshot()).toEqual(bytes);

    const m = mixed();
    const patchUv1 = dump(m, 'uv1').filter((c) => c !== null);
    expect(patchUv1.length).toBeGreaterThan(0);
    const onCube = m.uv.channel({ op: 'delete', to: 'uv1', faces: cube });
    expect(onCube.status).toBe('ok');
    expect(dump(m, 'uv1').filter((c) => c !== null)).toEqual(patchUv1);
    expect(m.uv.channel({ op: 'copy', from: 'uv0', to: 'uv1', faces: cube }).status).toBe('ok');

    const swapped = mixed();
    const r = swapped.uv.channel({ op: 'swap', from: 'uv0', to: 'uv1', faces: sel.tag('a') });
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.error)).toContain('channel-protected');
  });

  it('copy from a channel the mesh lacks is a precondition error', () => {
    const r = tiled().uv.channel({ op: 'copy', from: 'uv5', to: 'uv6' });
    expect(r.error?.code).toBe('model-precondition');
    expect(JSON.stringify(r.error)).toContain('channel-missing');
  });

  it('rejects malformed arguments', () => {
    for (const o of [
      { op: 'bogus', from: 'uv0', to: 'uv1' },
      { op: 'copy', from: 'uv0' },
      { op: 'copy', from: 'uv0', to: 'uv0' },
      { op: 'copy', from: 'uv0', to: 'color' },
      { op: 'delete' },
    ]) {
      const r = tiled().uv.channel(o as never);
      expect(r.status).toBe('failed');
      expect(r.error?.code).toBe('model-invalid-argument');
    }
  });
});

describe('m.append with the patch-domain carrier', () => {
  const one = (x: number, name: string, move: boolean) => {
    const m = model();
    m.surface({ patches: [{ surface: rect(x, 1, 1), name }], chord: 0.01 });
    if (move) m.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' });
    return m;
  };
  const exact = (m: Model) => {
    const out = m.toMesh({ normals: { mode: 'surface' } });
    if (!out.ok) throw out.error;
    return out.value.report;
  };

  it('two sessions with the same carrier keep exact surface normals, whichever is the host', () => {
    for (const move of [false, true]) {
      for (const flip of [false, true]) {
        const a = one(0, 'a', move);
        const b = one(5, 'b', move);
        const host = flip ? b : a;
        expect(host.append(flip ? a : b).status).toBe('ok');
        const report = exact(host);
        expect(report.exactNormals).toEqual([4, 8]);
        expect(report.normalDomain).toBe(move ? 'uv2' : undefined);
      }
    }
  });

  it('a moved carrier survives the append for a later lightmap', () => {
    const a = one(0, 'a', true);
    a.append(one(5, 'b', true));
    expect(a.uv.lightmap({ resolution: 256 }).status).toBe('ok');
    expect(exact(a).exactNormals).toEqual([4, 8]);
  });

  it('a mixed-carrier append is refused at append, in both directions and both host orders', () => {
    for (const hostMoved of [false, true]) {
      for (const swapped of [false, true]) {
        const a = one(0, 'a', hostMoved);
        const b = one(5, 'b', !hostMoved);
        const host = swapped ? b : a;
        const operand = swapped ? a : b;
        const bytes = host.snapshot();
        const r = host.append(operand);
        expect(r.status).toBe('failed');
        expect(r.error?.code).toBe('model-precondition');
        const detail = r.error?.detail as { code: string; host: string; operand: string };
        expect(detail.code).toBe('carrier-mismatch');
        expect(detail.host).not.toBe(detail.operand);
        expect(new Set([detail.host, detail.operand])).toEqual(new Set(['uv1', 'uv2']));
        expect(host.snapshot()).toEqual(bytes);
      }
    }
  });

  it('the refusal names the carrier of each side and survives try()', () => {
    const host = one(0, 'a', true);
    const operand = one(5, 'b', false);
    const attempt = host.try((m) => {
      m.append(operand);
    });
    expect(attempt.ok).toBe(false);
    expect(JSON.stringify(attempt)).toContain('"host":"uv2"');
    expect(JSON.stringify(attempt)).toContain('"operand":"uv1"');
    expect(host.append(one(9, 'c', true)).status).toBe('ok');
    expect(exact(host).exactNormals).toEqual([4, 8]);
  });

  const mismatch = (r: { status: string; error?: { code: string; detail?: unknown } }) => {
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    return r.error?.detail as { code: string; host: string; operand: string; derived?: boolean };
  };

  it('every session-joining path refuses a mixed carrier and leaves the host unchanged', () => {
    const paths: [string, (host: Model, operand: Model | Uint8Array) => { status: string }][] = [
      ['append', (h, o) => h.append(o)],
      ['array', (h, o) => h.array(o, { linear: { count: 2, offset: [0, 5, 0] } })],
      ['union', (h, o) => h.union(o)],
      ['difference', (h, o) => h.difference(o)],
      ['intersection', (h, o) => h.intersection(o)],
      ['splitBy', (h, o) => h.splitBy(o)],
    ];
    for (const [name, join] of paths) {
      for (const snapshot of [false, true]) {
        const host = one(0, 'a', true);
        const operand = one(5, 'b', false);
        const bytes = host.snapshot();
        const r = join(host, snapshot ? operand.snapshot() : operand);
        const detail = mismatch(r as never);
        expect(detail.code, name).toBe('carrier-mismatch');
        expect(detail.host, name).toBe('uv2');
        expect(detail.operand, name).toBe('uv1');
        expect(detail.derived === true, name).toBe(snapshot);
        expect(host.snapshot(), name).toEqual(bytes);
      }
    }
  });

  it('a snapshot of a moved session joins a moved host and is refused by an unmoved one', () => {
    const moved = one(5, 'b', true).snapshot();
    expect(one(0, 'a', true).append(moved).status).toBe('ok');
    expect(mismatch(one(0, 'a', false).append(moved) as never).operand).toBe('uv2');
  });

  it('sessions that hold no patch domain join in any order without a carrier question', () => {
    const lightmapped = () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.uv.project({ mode: 'box', scale: 1 });
      m.uv.lightmap({ resolution: 64 });
      return m;
    };
    const bare = () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      return m;
    };
    expect(model().append(lightmapped()).status).toBe('ok');
    expect(model().append(lightmapped().snapshot()).status).toBe('ok');
    expect(one(0, 'a', true).append(bare()).status).toBe('ok');
    expect(one(0, 'a', false).append(bare()).status).toBe('ok');
    expect(one(0, 'a', true).append(bare().snapshot()).status).toBe('ok');
    expect(bare().append(one(5, 'b', true)).status).toBe('ok');
    expect(bare().append(one(5, 'b', false)).status).toBe('ok');
    expect(lightmapped().append(one(5, 'b', true)).status).toBe('ok');
    expect(model().array(bare(), { linear: { count: 2, offset: [3, 0, 0] } }).status).toBe('ok');
  });

  it('an empty host takes the carrier of the patched operand it joins', () => {
    const host = model();
    expect(host.append(one(5, 'b', true)).status).toBe('ok');
    expect(
      host.surface({ patches: [{ surface: rect(0, 1, 1), name: 'a' }], chord: 0.01 }).status,
    ).toBe('ok');
    expect(host.uv.lightmap({ resolution: 256 }).status).toBe('ok');
  });

  describe('an adopted carrier makes the session patch-holding (carrier-mismatch Medium)', () => {
    /** The join is refused with a carrier-mismatch; try() rolls the refusal back, so the host stays usable. */
    const refused = (
      host: Model,
      join: (m: Model) => { status: string; error?: { detail?: unknown } },
    ) => {
      let report: { status: string; error?: { detail?: unknown } } | undefined;
      expect(
        host.try((m) => {
          report = join(m);
        }).ok,
      ).toBe(false);
      expect(report?.status).toBe('failed');
      expect((report?.error?.detail as { code: string }).code).toBe('carrier-mismatch');
    };

    it('an empty host that adopted a moved Model refuses an unmoved Model', () => {
      const host = model();
      expect(host.append(one(0, 'a', true)).status).toBe('ok');
      refused(host, (m) => m.append(one(5, 'b', false)));
      expect(() => exact(host)).not.toThrow();
    });

    it('an empty host that adopted an unmoved Model refuses a moved Model and keeps its carrier', () => {
      const host = model();
      expect(host.append(one(0, 'a', false)).status).toBe('ok');
      refused(host, (m) => m.append(one(5, 'b', true)));
      expect(() => exact(host)).not.toThrow();
    });

    it('an empty host given an array of a moved Model refuses an unmoved Model', () => {
      const host = model();
      expect(
        host.array(one(0, 'a', true), { linear: { count: 2, offset: [3, 0, 0] } }).status,
      ).toBe('ok');
      refused(host, (m) => m.append(one(9, 'c', false)));
      expect(() => exact(host)).not.toThrow();
    });

    it('an empty host given a moved snapshot refuses an unmoved Model', () => {
      const host = model();
      expect(host.append(one(0, 'a', true).snapshot()).status).toBe('ok');
      refused(host, (m) => m.append(one(5, 'b', false)));
      expect(() => exact(host)).not.toThrow();
    });

    it('a rolled-back adoption leaves the host free to adopt a different carrier', () => {
      const host = model();
      const attempt = host.try((m) => {
        m.append(one(0, 'a', true));
        m.box({ size: [-1, 1, 1] });
      });
      expect(attempt.ok).toBe(false);
      expect(host.append(one(5, 'b', false)).status).toBe('ok');
      expect(() => exact(host)).not.toThrow();
    });

    it('a carrier-free join does not make the host patch-holding', () => {
      const host = model();
      const plain = model();
      plain.box({ size: [1, 1, 1] });
      expect(host.append(plain).status).toBe('ok');
      expect(host.append(one(5, 'b', true)).status).toBe('ok');
      expect(host.append(one(9, 'c', true)).status).toBe('ok');
    });

    it('an operand whose patch faces were all deleted still counts as patch-holding', () => {
      const operand = one(5, 'b', true);
      operand.delete(sel.all());
      refused(one(0, 'a', false), (m) => m.append(operand));
    });

    describe('an operand session that only adopted a carrier (carrier-mismatch Medium 2)', () => {
      /** A scratch kit: a free session that appended one patched Model, so it records no surface itself. */
      const kit = (x: number, name: string, move: boolean) => {
        const scratch = model();
        expect(scratch.append(one(x, name, move)).status).toBe('ok');
        return scratch;
      };

      it('a host with the other carrier refuses the adopted kit, by append, array and boolean', () => {
        refused(one(0, 'a', false), (m) => m.append(kit(5, 'b', true)));
        refused(one(0, 'a', true), (m) => m.append(kit(5, 'b', false)));
        refused(one(0, 'a', false), (m) =>
          m.array(kit(5, 'b', true), { linear: { count: 2, offset: [0, 0, 3] } }),
        );
        refused(one(0, 'a', false), (m) => m.union(kit(5, 'b', true)));
      });

      it('a host with the same carrier takes the adopted kit and exports exact normals', () => {
        for (const move of [false, true]) {
          const host = one(0, 'a', move);
          expect(host.append(kit(5, 'b', move)).status).toBe('ok');
          expect(exact(host).exactNormals).toEqual([4, 8]);
        }
      });

      it('a free host adopts the kit and then refuses the other carrier', () => {
        const host = model();
        expect(host.append(kit(0, 'a', true)).status).toBe('ok');
        refused(host, (m) => m.append(one(5, 'b', false)));
        expect(() => exact(host)).not.toThrow();
      });

      it('a free kit that adopted nothing stays carrier-free as an operand', () => {
        const plain = model();
        plain.box({ size: [1, 1, 1] });
        const emptyKit = model();
        expect(emptyKit.append(plain).status).toBe('ok');
        const host = one(0, 'a', true);
        expect(host.append(emptyKit).status).toBe('ok');
      });
    });

    describe('a snapshot adopts only a derived uv2 carrier (carrier-mismatch Low 1)', () => {
      const lightmapped = () => {
        const m = model();
        m.box({ size: [1, 1, 1], center: [20, 0, 0] });
        m.uv.project({ mode: 'box', scale: 1 });
        expect(m.uv.lightmap({ resolution: 64 }).status).toBe('ok');
        return m;
      };

      it('a uv1-only snapshot never marks a free host, so a moved patch Model still joins', () => {
        const host = model();
        expect(host.append(lightmapped().snapshot()).status).toBe('ok');
        expect(host.append(one(0, 'a', true)).status).toBe('ok');
        const boxed = model();
        boxed.box({ size: [1, 1, 1] });
        expect(boxed.append(lightmapped().snapshot()).status).toBe('ok');
        expect(boxed.append(one(5, 'b', true)).status).toBe('ok');
      });

      it('a uv1-only snapshot is still compared against a host that holds patch data on uv2', () => {
        refused(one(0, 'a', true), (m) => m.append(lightmapped().snapshot()));
      });

      it('a snapshot with uv2 is treated as a moved patch domain: it marks a free host', () => {
        const host = model();
        expect(host.append(one(0, 'a', true).snapshot()).status).toBe('ok');
        refused(host, (m) => m.append(one(5, 'b', false)));
      });
    });

    describe('guards see adopted patches (carrier-mismatch Low 2)', () => {
      it('uv.lightmap on a host that adopted uv1 patches refuses to overwrite the domain', () => {
        const host = model();
        expect(host.append(one(0, 'a', false)).status).toBe('ok');
        expect(host.uv.project({ mode: 'box', scale: 1 }).status).toBe('ok');
        const r = host.uv.lightmap({ resolution: 64 });
        expect(r.status).toBe('failed');
        expect(JSON.stringify(r.error)).toContain('patch-domain-carrier');
      });

      it('copyTo-uv2 on that host moves the domain and the export stays exact', () => {
        const host = model();
        expect(host.append(one(0, 'a', false)).status).toBe('ok');
        expect(host.uv.lightmap({ resolution: 256, domain: 'copyTo-uv2' }).status).toBe('ok');
        expect(exact(host).normalDomain).toBe('uv2');
        expect(host.append(one(5, 'b', true)).status).toBe('ok');
      });

      it('uv.channel delete of the adopted carrier is protected', () => {
        const host = model();
        expect(host.append(one(0, 'a', false)).status).toBe('ok');
        const r = host.uv.channel({ op: 'delete', to: 'uv1' });
        expect(r.status).toBe('failed');
        expect(JSON.stringify(r.error)).toContain('channel-protected');
      });

      it('adopted patch names roll back with try()', () => {
        const host = model();
        host.try((m) => {
          m.append(one(0, 'a', false));
          m.box({ size: [-1, 1, 1] });
        });
        expect(host.uv.channel({ op: 'delete', to: 'uv1' }).status).not.toBe('failed');
      });
    });
  });
});
