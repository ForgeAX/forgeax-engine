import { MeshoptDecoder } from 'meshoptimizer';

export const DATA = '/data';

export const MAPS = [
  { id: 'looty-bay', name: 'Looty Bay', note: 'City' },
  { id: 'sales-center', name: 'Sales Center', note: 'Desert hangar' },
  { id: 'lennys-motel', name: "Lenny's Motel", note: 'Starting point' },
  { id: 'prison', name: 'Prison', note: 'Prison interior' },
];
const wanted =
  typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('map');
export const MAP_INFO = MAPS.find((m) => m.id === wanted) ?? MAPS[0];
export const MAP_ID = MAP_INFO.id;
const MAP = `${DATA}/${MAP_ID}/`;

export async function decode(scene, packedInstances, bundles) {
  await MeshoptDecoder.ready;

  const n = scene.instances.n;
  const raw = new Uint8Array(n * 32);
  MeshoptDecoder.decodeVertexBuffer(raw, n, 32, packedInstances);
  const dv = new DataView(raw.buffer);
  const pos = new Float32Array(n * 3),
    quat = new Float32Array(n * 4),
    scl = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = dv.getFloat32(o + k * 4, true);
      scl[i * 3 + k] = dv.getFloat32(o + 20 + k * 4, true);
    }
    let l = 0;
    for (let k = 0; k < 4; k++) {
      const q = dv.getInt16(o + 12 + k * 2, true) / 32767;
      quat[i * 4 + k] = q;
      l += q * q;
    }
    l = Math.sqrt(l) || 1;
    for (let k = 0; k < 4; k++) quat[i * 4 + k] /= l;
  }

  const geos = scene.geos.map(([b, vo, vb, io, ib, vc, ic, stride, wide]) => {
    const v = new Uint8Array(vc * stride);
    MeshoptDecoder.decodeVertexBuffer(v, vc, stride, new Uint8Array(bundles[b], vo, vb));
    const isz = wide ? 4 : 2;
    const ix = new Uint8Array(ic * isz);
    MeshoptDecoder.decodeIndexBuffer(ix, ic, isz, new Uint8Array(bundles[b], io, ib));
    return {
      vc,
      stride,
      i16: new Int16Array(v.buffer),
      i8: new Int8Array(v.buffer),
      f32: new Float32Array(v.buffer),
      index: wide ? new Uint32Array(ix.buffer) : new Uint16Array(ix.buffer),
    };
  });

  return { scene, geos, inst: { n, pos, quat, scl } };
}

export async function loadData(onProgress = () => {}) {
  const [scene, texIndex] = await Promise.all([
    fetch(`${MAP}scene.json`).then((r) => r.json()),
    fetch(`${DATA}/tex/index.json`).then((r) => r.json()),
  ]);
  const packed = fetch(MAP + scene.instances.f).then((r) => r.arrayBuffer());
  const total = scene.bundles.length;
  const bundles = new Array(total);
  let next = 0,
    done = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < total) {
        const i = next++;
        bundles[i] = await (await fetch(MAP + scene.bundles[i].f)).arrayBuffer();
        onProgress(++done, total);
      }
    }),
  );
  const data = await decode(scene, new Uint8Array(await packed), bundles);
  return { ...data, texIndex };
}
