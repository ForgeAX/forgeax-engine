import { describe, expect, it } from 'vitest';
import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline.js';
import { shadowShaderMap } from '../record/shadow-pass.js';
import type { DispatchEntry } from '../render-system-extract.js';

function present<T>(value: T | undefined): T {
  if (value === undefined) throw Error('Missing required test fixture field');
  return value;
}

function dispatch(materialHandle: number, passIndex = 0, renderableIndex = 4): DispatchEntry {
  return {
    entityIndex: renderableIndex,
    renderableIndex,
    materialHandle,
    passIndex,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'ShadowCaster' },
    materialShaderId: 'forgeax::default-standard-pbr',
    renderState: { cullMode: 'none' },
    defines: undefined,
    vertexEntry: 'vs_custom',
    fragmentEntry: 'fs_cutout',
    paramSnapshot: { alphaCutoff: 0.4 },
  };
}
function context(handles: number[], entries: DispatchEntry[], indices = handles.map((_, i) => i)) {
  return {
    dispatch: entries,
    validatedOrdered: [{ renderableIndex: 4 }],
    materialSlotIndices: [indices],
    materialSlots: handles.map((materialHandle) => ({ materialHandle })),
  };
}
function mapped(c: ReturnType<typeof context>) {
  return shadowShaderMap(c as unknown as Parameters<typeof shadowShaderMap>[0]);
}
function slots(c: ReturnType<typeof context>) {
  return [...(mapped(c).get(4)?.values() ?? [])].flatMap((entries) =>
    entries.map((entry) => entry.materialSlot),
  );
}

describe('shadow dispatch material slot indexing', () => {
  it('preserves first slot in roster order, pass order and authored shader facts', () => {
    const entries = [dispatch(42, 7), dispatch(11, 2), dispatch(42, 3)];
    const c = context([11, 42, 42], entries, [2, 0, 1]);
    const map = mapped(c);
    expect(slots(c)).toEqual([2, 2, 0]);
    const first = map.get(4)?.get(42)?.[0];
    expect(first).toEqual({
      materialHandle: 42,
      passIndex: 7,
      vertexEntry: 'vs_custom',
      fragmentEntry: 'fs_cutout',
      materialShaderId: SHADOW_CASTER_SHADER_ID,
      renderState: entries[0]?.renderState,
      materialSlot: 2,
      paramSnapshot: entries[0]?.paramSnapshot,
    });
    expect(first?.paramSnapshot).toBe(entries[0]?.paramSnapshot);
    expect(first?.renderState).toBe(entries[0]?.renderState);
    expect(
      map
        .get(4)
        ?.get(42)
        ?.map((entry) => entry.passIndex),
    ).toEqual([7, 3]);
  });

  it('keeps undefined slots, non-shadow and missing shader admission semantics', () => {
    const c = context(
      [2],
      [
        dispatch(90),
        { ...dispatch(2), tags: { LightMode: 'Forward' } },
        { ...dispatch(2), materialShaderId: undefined },
        dispatch(2, 4, 99),
      ],
      [20, 0],
    );
    expect(mapped(c).get(4)?.get(90)?.[0]?.materialSlot).toBeUndefined();
    expect(mapped(c).get(4)?.has(2)).toBe(false);
    expect(mapped(c).get(99)?.get(2)?.[0]?.materialSlot).toBeUndefined();
    expect(
      slots(context([NaN, -0, Infinity], [dispatch(NaN), dispatch(0), dispatch(Infinity)])),
    ).toEqual([undefined, 1, 2]);
  });

  it('observes in-place roster, slot and material publication changes on each invocation', () => {
    const c = context([1, 2, 1], [dispatch(1)]);
    const before = mapped(c);
    present(c.materialSlots[0]).materialHandle = 9;
    present(c.materialSlotIndices[0]).splice(0, 3, 1, 2, 0);
    c.dispatch.push(dispatch(2, 3));
    expect(slots(c)).toEqual([2, 1]);
    expect(before.get(4)?.get(1)?.[0]?.materialSlot).toBe(0);
    c.dispatch.splice(0, 2, dispatch(9));
    expect(slots(c)).toEqual([0]);
    expect(
      mapped(context([7], [dispatch(7)]))
        .get(4)
        ?.get(7)?.[0]?.materialSlot,
    ).toBe(0);
  });

  it.each([
    'directional',
    'point',
    'spot',
  ])('keeps %s view layouts and retained-shadow base isolated', () => {
    const c = context([11, 22, 11], [dispatch(11)], [0]);
    const retained = {
      ...c,
      shadowValidatedOrdered: [{ renderableIndex: 4 }],
      shadowDispatch: [dispatch(11), dispatch(22)],
      materialSlotIndices: [[0], [2, 1]],
    };
    const viewA = shadowShaderMap(retained as unknown as Parameters<typeof shadowShaderMap>[0]);
    expect(viewA.get(4)?.get(11)?.[0]?.materialSlot).toBe(2);
    present(retained.materialSlotIndices[1]).reverse();
    present(retained.materialSlots[2]).materialHandle = 33;
    const viewB = shadowShaderMap(retained as unknown as Parameters<typeof shadowShaderMap>[0]);
    expect(viewB.get(4)?.get(11)?.[0]?.materialSlot).toBeUndefined();
    expect(viewB.get(4)?.get(22)?.[0]?.materialSlot).toBe(1);
    expect(viewA.get(4)?.get(11)?.[0]?.materialSlot).toBe(2);
  });

  it('reduces adversarial repeated and distinct dispatch slot reads from D*S to at most 2S', () => {
    for (const handles of [Array.from({ length: 64 }, (_, i) => i), Array(64).fill(63)]) {
      const c = context(
        Array.from({ length: 64 }, (_, i) => i),
        handles.map((handle, index) => dispatch(handle, index)),
      );
      let reads = 0;
      c.materialSlots = c.materialSlots.map((material) => ({
        get materialHandle() {
          reads++;
          return material.materialHandle;
        },
      }));
      const expected = c.dispatch.map((entry) =>
        present(c.materialSlotIndices[0]).find(
          (slot) => c.materialSlots[slot]?.materialHandle === entry.materialHandle,
        ),
      );
      const oldReads = reads;
      reads = 0;
      const map = mapped(c);
      const actual = c.dispatch.map(
        (entry) => map.get(4)?.get(entry.materialHandle)?.[0]?.materialSlot,
      );
      expect(actual).toEqual(expected);
      expect(reads).toBe(handles[0] === 63 ? 64 : 65);
      expect(oldReads).toBe(handles[0] === 63 ? 4096 : 2080);
    }
  });

  it('does not scan an unused slot suffix or slots for inadmissible dispatches', () => {
    const c = context(
      Array.from({ length: 1024 }, (_, i) => i),
      [dispatch(0)],
    );
    let reads = 0;
    c.materialSlots = c.materialSlots.map((material) => ({
      get materialHandle() {
        reads++;
        return material.materialHandle;
      },
    }));
    expect(slots(c)).toEqual([0]);
    expect(reads).toBe(1);
    c.dispatch = [{ ...dispatch(999), tags: { LightMode: 'Forward' } }];
    reads = 0;
    expect(mapped(c).size).toBe(0);
    expect(reads).toBe(0);
  });

  it('keeps the last row for a duplicate renderable index as before', () => {
    const c = context([1, 2], [dispatch(2)]);
    c.validatedOrdered.push({ renderableIndex: 4 });
    c.materialSlotIndices.push([1]);
    expect(slots(c)).toEqual([1]);
  });
});
