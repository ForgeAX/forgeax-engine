import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  createRenderFeatureGpuWorkOwner,
  ownRenderFeatureProgramData,
} from '../features/prepared-gpu-work';

const descriptor = () => ({
  wgsl: '@compute @workgroup_size(1) fn main() {}',
  entryPoints: ['main'],
  bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
});
async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: descriptor().wgsl })).unwrap();
  const factory = vi.fn(() => ok(shader));
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: factory }),
  });
  return { owner, factory, session: owner.beginFeature('alias', 0) };
}
it('keeps the admitted owned alias descriptor instead of walking another recipe every warm frame', async () => {
  const { owner, factory, session } = await fixture();
  const a = ownRenderFeatureProgramData(descriptor()),
    b = ownRenderFeatureProgramData(descriptor());
  expect(a).not.toBe(b);
  session.prepareProgram('first-recipe', a).unwrap();
  const alias = session.prepareProgram('second-recipe', b).unwrap();
  for (const lease of session.commitFrame()) lease.release().unwrap();
  session.beginFrame();
  const keys = vi.spyOn(Object, 'keys');
  let reads = -1;
  try {
    expect(session.prepareProgram('second-recipe', b).unwrap()).toBe(alias);
    reads = keys.mock.calls.filter(([value]) => value === b).length;
  } finally {
    keys.mockRestore();
  }
  expect(reads).toBe(0);
  expect(factory).toHaveBeenCalledTimes(1);
  session.abortFrame().unwrap();
  owner.dispose().unwrap();
});
it('still observes same-count raw mutations and restores the accepted owned alias after abort', async () => {
  const { owner, session } = await fixture();
  session.prepareProgram('first-recipe', ownRenderFeatureProgramData(descriptor())).unwrap();
  const accepted = session
    .prepareProgram('second-recipe', ownRenderFeatureProgramData(descriptor()))
    .unwrap();
  for (const lease of session.commitFrame()) lease.release().unwrap();
  session.beginFrame();
  const mutable = descriptor();
  mutable.wgsl = mutable.wgsl.replace('main()', 'main() /* changed */');
  const replacement = session.prepareProgram('second-recipe', mutable).unwrap();
  expect(replacement).not.toBe(accepted);
  session.abortFrame().unwrap();
  session.beginFrame();
  expect(session.prepareProgram('second-recipe', descriptor()).unwrap()).toBe(accepted);
  session.abortFrame().unwrap();
  owner.dispose().unwrap();
});
it('does not carry an owned alias proof into a new device generation', async () => {
  const { owner, factory, session } = await fixture();
  const a = ownRenderFeatureProgramData(descriptor()),
    b = ownRenderFeatureProgramData(descriptor());
  session.prepareProgram('first-recipe', a).unwrap();
  const prior = session.prepareProgram('second-recipe', b).unwrap();
  for (const lease of session.commitFrame()) lease.release().unwrap();
  const next = owner.beginFeature('alias', 1);
  const replacement = next.prepareProgram('second-recipe', b).unwrap();
  expect(replacement).not.toBe(prior);
  expect(replacement.generation).toBe(1);
  expect(factory).toHaveBeenCalledTimes(2);
  for (const lease of next.commitFrame()) lease.release().unwrap();
  owner.dispose().unwrap();
});
