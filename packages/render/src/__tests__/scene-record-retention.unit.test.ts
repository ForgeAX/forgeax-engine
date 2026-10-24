import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { derivedRenderState } from '../material-render-state';
import { variantSetFromDefines } from '../record/helpers';
import { selectedMaterialPasses } from '../record/main-pass-geometry';
import { type ScenePassRequest, selectRequestDispatch } from '../record/scene-pass-work';
import type { DispatchEntry, DispatchList } from '../render-system-extract';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

async function collect(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();
}

function entry(renderableIndex: number, materialHandle = 1): DispatchEntry {
  return {
    renderableIndex,
    materialHandle,
    tags: { LightMode: 'Forward' },
    queue: 2000,
  } as unknown as DispatchEntry;
}

it('keeps derived render states and variant keys only while their authored records live', async () => {
  let state: MaterialRenderState | undefined = { cullMode: 'back' };
  let defines: Record<string, string> | undefined = { A: '1' };
  const derived = new WeakRef(derivedRenderState(state, 'retention', (s) => ({ ...s })));
  expect(variantSetFromDefines(defines)).toBe('A=1');
  const authored = new WeakRef(state);
  const record = new WeakRef(defines);
  state = undefined;
  defines = undefined;
  await collect();
  expect(authored.deref()).toBeUndefined();
  expect(derived.deref()).toBeUndefined();
  expect(record.deref()).toBeUndefined();
});

it('keeps material passes only for live dispatch lists and selections only for the latest projection', async () => {
  const [released, releasedPasses] = (() => {
    const dispatch = [entry(0), entry(1)];
    const passes = selectedMaterialPasses(dispatch, false);
    expect(selectedMaterialPasses(dispatch, false)).toBe(passes);
    expect(passes.get(1)?.get(1)).toBe(dispatch[1]);
    return [new WeakRef(dispatch), new WeakRef(passes)] as const;
  })();

  const request = { selector: { LightMode: ['Forward'] } } as unknown as ScenePassRequest;
  let first: DispatchList | undefined = [entry(0)];
  const selected = selectRequestDispatch(request, first);
  expect(selectRequestDispatch(request, first)).toBe(selected);
  const releasedFirst = new WeakRef(first);
  first = undefined;
  const second: DispatchList = [entry(0), entry(1)];
  expect(selectRequestDispatch(request, second)).toHaveLength(2);
  await collect();
  expect(released.deref()).toBeUndefined();
  expect(releasedPasses.deref()).toBeUndefined();
  expect(releasedFirst.deref()).toBeUndefined();
});
