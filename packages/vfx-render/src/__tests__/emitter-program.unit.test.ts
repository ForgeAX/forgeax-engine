import { ownRenderFeatureProgramData } from '@forgeax/engine-render/internal';
import { expect, it, vi } from 'vitest';
import { createVfxEmitterProgramOwner } from '../feature/emitter-program';

type Emitter = Parameters<ReturnType<typeof createVfxEmitterProgramOwner>>[0];
function source() {
  return {
    id: 'emitter',
    wgsl: 'compute-source',
    reflection: {
      entryPoints: ['spawn', 'project'],
      bindings: [{ group: 0, entries: [{ binding: 0, buffer: { type: 'storage' } }] }],
      dataInterfaces: [
        { token: 'accepted', binding: 0 },
        { token: 'unbound', binding: 9 },
      ],
    },
  };
}
function setup() {
  const immutable = new WeakSet<object>();
  const compile = vi.fn((emitter: Emitter) => ({
    wgsl: emitter.wgsl,
    entryPoints: emitter.reflection.entryPoints,
    bindings: emitter.reflection.bindings,
  }));
  return { immutable, compile, owner: createVfxEmitterProgramOwner(immutable, compile) };
}
function published(input = source()): Emitter {
  return ownRenderFeatureProgramData(input) as unknown as Emitter;
}

it('derives the program, entry-point membership and reflected requirements once per immutable owner', () => {
  const { immutable, compile, owner } = setup();
  const emitter = published();
  immutable.add(emitter);
  const first = owner(emitter);
  expect(first).toBeDefined();
  for (let frame = 0; frame < 10; frame++) expect(owner(emitter)).toBe(first);
  expect(compile).toHaveBeenCalledTimes(1);
  expect([...(first?.entryPoints ?? [])]).toEqual(['spawn', 'project']);
  expect(first?.requirements.map((requirement) => requirement.token)).toEqual(['accepted']);
  expect(first?.program).toEqual(compile.mock.results[0]?.value);
});

it('treats a replacement emitter as a new owner even when its authored id stays equal', () => {
  const { immutable, compile, owner } = setup();
  const first = published();
  const replacementSource = source();
  replacementSource.reflection.entryPoints = ['replacement'];
  replacementSource.reflection.bindings[0]?.entries.push({
    binding: 9,
    buffer: { type: 'storage' },
  });
  const replacement = published(replacementSource);
  immutable.add(first);
  immutable.add(replacement);
  expect(owner(replacement)).not.toBe(owner(first));
  expect([...(owner(replacement)?.entryPoints ?? [])]).toEqual(['replacement']);
  expect(owner(replacement)?.requirements).toHaveLength(2);
  expect(compile).toHaveBeenCalledTimes(2);
});

it('never inspects or retains raw/custom mutable sources, including after a previously owned emitter', () => {
  const { immutable, compile, owner } = setup();
  const emitter = published();
  immutable.add(emitter);
  owner(emitter);
  const read = vi.fn(() => {
    throw new Error('ordinary mutable path owns this read');
  });
  const raw = Object.defineProperty({}, 'reflection', { get: read }) as Emitter;
  expect(owner(raw)).toBeUndefined();
  expect(owner(raw)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  expect(compile).toHaveBeenCalledTimes(1);
});

it('does not turn device recovery, aborted plans or queued double ticks into GPU resource ownership', () => {
  const { immutable, compile, owner } = setup();
  const emitter = published();
  immutable.add(emitter);
  const before = owner(emitter);
  // This owner has no device/frame/ACK state. Each caller must still perform
  // current resource admission, uploads, pass planning and submission.
  const [aborted, nextDevice, firstTick, secondTick] = Array.from({ length: 4 }, () =>
    owner(emitter),
  );
  expect([aborted, nextDevice, firstTick, secondTick]).toEqual([before, before, before, before]);
  expect(Object.keys(before ?? {}).sort()).toEqual(['entryPoints', 'program', 'requirements']);
  expect(compile).toHaveBeenCalledTimes(1);
});
