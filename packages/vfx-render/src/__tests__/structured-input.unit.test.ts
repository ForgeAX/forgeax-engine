import {
  createVfxStructuredInputBank,
  type VfxDataInterfaceRequirement,
  type VfxGpuTickIntent,
} from '@forgeax/engine-vfx';
import { expect, it } from 'vitest';
import { preparedDataInterfaceResource } from '../feature/plan-declarations';
import { resolveDataInterfaces } from '../feature/provider-resolution';
import {
  createStructuredInputProvider,
  createVfxDataInterfaceRegistry,
} from '../host/data-interface-providers';

const requirement: VfxDataInterfaceRequirement = {
  token: 'vfx:structured-input',
  kind: 'structured-input',
  binding: 26,
  bindingType: 'read-only-storage',
  lifetime: 'generation',
};
it('publishes detached bounded source bytes and declares native storage upload, not an external GPU handle', () => {
  const bank = createVfxStructuredInputBank({ recordStrideBytes: 16, capacity: 4 }).unwrap();
  const record = new Uint8Array(16);
  record[0] = 99;
  bank.write(2, record).unwrap();
  const captured: number[] = [];
  const provider = createStructuredInputProvider({
    snapshot: (_generation, context) => {
      captured.push(context?.frameNumber ?? -1);
      return bank.snapshot();
    },
  });
  const registry = createVfxDataInterfaceRegistry([provider]);
  const resource = registry.resolve([requirement], 7, { frameNumber: 13 }).unwrap().resources[0];
  expect(captured).toEqual([13]);
  expect(resource?.generation).toBe(7);
  if (!resource?.resource) throw new Error('missing source snapshot');
  const portable = structuredClone(resource);
  bank.clear().unwrap();
  bank.dispose();
  if (!portable.resource) throw new Error('missing portable snapshot');
  const plan = preparedDataInterfaceResource('observations', portable.resource);
  expect(plan).toMatchObject({
    kind: 'buffer',
    name: 'observations',
    size: 64,
    usage: ['storage'],
  });
  expect(plan?.kind === 'buffer' && plan.data).toEqual(
    new Uint8Array([...new Uint8Array(32), 99, ...new Uint8Array(31)]),
  );
  expect(registry.resolve([requirement], 8).ok).toBe(false);
});
it('reconstructs an exact old submitted input without querying the new live provider', () => {
  const oldBytes = new Uint8Array(16);
  oldBytes[0] = 42;
  const historical = {
    token: 'vfx:structured-input' as const,
    kind: 'structured-input' as const,
    bindingType: 'read-only-storage' as const,
    generation: 3,
    resource: { kind: 'storage-data' as const, value: oldBytes },
  };
  const intent = {
    instanceGeneration: 3,
    recovering: true,
    emitter: {
      reflection: {
        entryPoints: ['forgeax_vfx_pool_allocate_main'],
        dataInterfaces: [requirement],
      },
    },
    recoveryContext: {
      frameNumber: 11,
      localToWorld: new Float32Array(16),
      dataInterfaces: [historical],
    },
  } as unknown as VfxGpuTickIntent;
  const resolved = resolveDataInterfaces(intent, undefined);
  expect(resolved?.get('vfx:structured-input')?.resource?.value).toEqual(oldBytes);
  const resource = resolved?.get('vfx:structured-input')?.resource;
  if (!resource) throw new Error('missing historical snapshot');
  expect(preparedDataInterfaceResource('old', resource)).toMatchObject({
    kind: 'buffer',
    data: oldBytes,
    usage: ['storage'],
  });
});
it.each([
  new Uint8Array(0),
  new Uint8Array(17),
  new Uint8Array(65552),
])('rejects malformed structured upload', (bytes) => {
  const provider = createStructuredInputProvider({ snapshot: () => bytes });
  expect(createVfxDataInterfaceRegistry([provider]).resolve([requirement], 1).ok).toBe(false);
  expect(
    preparedDataInterfaceResource('bad', { kind: 'storage-data', value: bytes }),
  ).toBeUndefined();
});
