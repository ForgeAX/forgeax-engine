import { decodeSnapshot, type EditMesh, type Model, model, sel } from '@forgeax/engine-modeling';
import { FROZEN_STATES } from './frozen-states.ts';

/**
 * Decoded FXEM states by name: former example builds frozen as kernel-owned data, so example
 * design work never moves a kernel golden.
 */
export type FrozenStates = Readonly<Record<string, Uint8Array>>;

/** Decodes every frozen state; Web streams keep it usable in Node, its Workers and Chromium. */
export async function loadFrozenStates(): Promise<FrozenStates> {
  const states: Record<string, Uint8Array> = {};
  for (const [name, base64] of Object.entries(FROZEN_STATES)) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    states[name] = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return states;
}

/**
 * A session holding exactly the frozen state. `append` would re-intern tag, label, role and
 * material names in first-use order, so the decoded mesh is installed instead.
 */
export function restored(states: FrozenStates, name: string): Model {
  const bytes = states[name];
  if (bytes === undefined) throw new Error(`no frozen state '${name}'`);
  return installed(bytes, name);
}

/** A session holding the decoded FXEM `bytes` of the frozen fixture `name`. */
export function installed(bytes: Uint8Array, name: string): Model {
  const decoded = decodeSnapshot(bytes);
  if (!decoded.ok) {
    throw new Error(
      `frozen fixture '${name}' no longer decodes (${decoded.error.code}); FXEM changed, so ` +
        'regenerate all frozen states with the freeze-kernel-fixtures script beside the example builds',
      { cause: decoded.error },
    );
  }
  const m = model();
  (m as unknown as { mesh: EditMesh }).mesh = decoded.value;
  return m;
}

/**
 * C-014 pauldron from its low-poly plate: creased subdivision, then lattice, taper and bend
 * to the shoulder. Most states cannot be replayed exactly (FXEM keeps neither free slots nor
 * the session's element order), so the other former example builds are frozen final; this
 * replay reproduces the original bytes, which the golden proves.
 */
export function pauldron(states: FrozenStates): Model {
  const half = 0.7 / 2;
  const [sx, sy, sz] = [0.833, 4.539083, 0];
  const m = restored(states, 'pauldron');
  m.subdivide(undefined, { levels: 2 });
  m.lattice(sel.all(), {
    resolution: [3, 2, 3],
    offsets: [
      { index: [1, 0, 1], offset: [0, 0.07, 0] },
      { index: [1, 1, 1], offset: [0, 0.07, 0] },
    ],
  });
  m.taper(sel.all(), { axis: 'x', factor: 0.72, axes: ['z'] });
  m.bend(sel.all(), { axis: 'x', toward: '-y', angle: 105, range: [-half + 0.1, half] });
  m.translate(sel.all(), [sx + 0.06, sy + 0.34, sz]);
  const mount = restored(states, 'mount');
  mount.subdivide(undefined, { levels: 2 });
  m.append(mount);
  m.assign(sel.tag('pauldron'), 'paint');
  m.assign(sel.createdBy('spine'), 'trim');
  m.assign(sel.createdBy('recess', 'top'), 'panel');
  m.assign(sel.tag('collar'), 'steel');
  m.uv.project({ mode: 'box', scale: 0.25 });
  return m;
}
