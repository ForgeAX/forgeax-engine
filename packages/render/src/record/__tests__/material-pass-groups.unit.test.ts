import type { EntityHandle } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import type { DispatchEntry } from '../../render-system-extract';
import { MemberMaterialPasses } from '../material-pass-groups';

function entry(passIndex: number, lightMode = 'Forward'): DispatchEntry {
  return {
    entityIndex: 1 as EntityHandle,
    renderableIndex: 0,
    materialHandle: 2,
    passIndex,
    queue: 2000,
    layer: 0,
    tags: { LightMode: lightMode },
    materialShaderId: 'forgeax::default-standard-pbr',
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
  };
}

it('retains equal emitted sequences and replaces reordered groups without mutating prior results', () => {
  const member = new MemberMaterialPasses();
  const first = entry(0),
    second = entry(1);
  member.append(first, 1);
  member.append(second, 1);
  const original = member.finish(1, false);
  expect(original?.get(2)).toEqual([first, second]);
  member.append(first, 2);
  member.append(second, 2);
  expect(member.finish(2, false)).toBe(original);
  member.append(second, 3);
  member.append(first, 3);
  const reordered = member.finish(3, false);
  expect(reordered).not.toBe(original);
  expect(reordered?.get(2)).toEqual([second, first]);
  expect(original?.get(2)).toEqual([first, second]);
  member.append(second, 4);
  expect(member.finish(4, false)?.get(2)).toBe(second);
  expect(member.finish(5, false)).toBeUndefined();
});

it('deduplicates only equivalent opaque temporal draws and retains every color pass', () => {
  const member = new MemberMaterialPasses();
  const forward = entry(0),
    deferred = entry(1, 'Deferred');
  const stencil = { ...forward, stencilReference: 1 };
  const blend = { ...forward, renderState: { blend: {} as GPUBlendState } };
  for (const draw of [forward, deferred, stencil, blend]) member.append(draw, 1);
  expect(member.finish(1, false)?.get(2)).toEqual([forward, deferred, stencil, blend]);
  expect(member.finish(1, true)?.get(2)).toEqual([forward, stencil, blend]);
});

it('keeps distinct material handles independent within one emitted member', () => {
  const member = new MemberMaterialPasses();
  const first = entry(0),
    other = { ...entry(1), materialHandle: 3 };
  member.append(first, 1);
  member.append(other, 1);
  const groups = member.finish(1, false);
  expect(groups?.get(2)).toBe(first);
  expect(groups?.get(3)).toBe(other);
});
