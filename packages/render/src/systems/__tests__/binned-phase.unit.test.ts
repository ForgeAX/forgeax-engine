import { expect, it } from 'vitest';
import { type BinnedItem, BinnedPhase, type BinPlacement } from '../binned-phase';

interface Item extends BinnedItem {
  readonly name: string;
}

const at = (key: number, member: number, rank = member): BinPlacement<Item> => ({
  key,
  major: key,
  minor: 0,
  item: { rank, member, name: `${key}:${member}` },
});

const names = (phase: BinnedPhase<Item>) =>
  phase.orderedBins().map((bin) => bin.items.map((item) => item.name));

it('orders bins by (major, minor) and items by (rank, member)', () => {
  const phase = new BinnedPhase<Item>();
  phase.queue(3, [at(20, 3)]);
  phase.queue(1, [at(10, 1, 5)]);
  phase.queue(2, [at(10, 2, 4)]);
  expect(names(phase)).toEqual([['10:2', '10:1'], ['20:3']]);
  expect(phase.ordinalOf(20)).toBe(1);
});

it('dequeues a member from its old bin before enqueueing it into the new one', () => {
  const phase = new BinnedPhase<Item>();
  for (let member = 0; member < 100; member++) phase.queue(member, [at(member % 2, member)]);
  const before = { ...phase.work };
  phase.queue(4, [at(1, 4)]);
  expect(phase.work.dequeued - before.dequeued).toBe(1);
  expect(phase.work.enqueued - before.enqueued).toBe(1);
  expect(phase.orderedBins()[0]?.items.some((item) => item.member === 4)).toBe(false);
  expect(phase.orderedBins()[1]?.items.some((item) => item.member === 4)).toBe(true);
});

it('retires an emptied bin and moves later ordinals', () => {
  const phase = new BinnedPhase<Item>();
  phase.queue(1, [at(1, 1)]);
  phase.queue(2, [at(2, 2)]);
  const bins = phase.binRevision;
  phase.dequeue(1);
  expect(phase.binRevision).toBeGreaterThan(bins);
  expect(phase.ordinalOf(2)).toBe(0);
  expect(phase.ordinalOf(1)).toBe(-1);
});

it('applies bulk replacements equivalently to single queues', () => {
  const single = new BinnedPhase<Item>();
  const bulk = new BinnedPhase<Item>();
  const placements = (member: number, round: number) => [
    at((member + round) % 5, member, (member * 7919) % 101),
  ];
  for (let member = 0; member < 400; member++) {
    single.queue(member, placements(member, 0));
  }
  bulk.queueMany(Array.from({ length: 400 }, (_, member) => [member, placements(member, 0)]));
  expect(names(bulk)).toEqual(names(single));
  const moved = Array.from({ length: 300 }, (_, index) => index * 2 - (index % 3));
  for (const member of moved) single.queue(member, member % 7 === 0 ? [] : placements(member, 1));
  bulk.queueMany(moved.map((member) => [member, member % 7 === 0 ? [] : placements(member, 1)]));
  expect(names(bulk)).toEqual(names(single));
  expect(bulk.size).toBe(single.size);
});
