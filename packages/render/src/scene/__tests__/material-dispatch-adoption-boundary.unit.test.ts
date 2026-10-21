import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { vec3 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import type { RenderableSnapshot } from '../../render-system-extract';
import { MaterialDispatch } from '../material-dispatch';
import { MeshFrame } from '../mesh-frame';

it('does not read any override group while adopting changed shared Mesh defaults', () => {
  const make = (materialHandle: number) =>
    new MaterialResource({
      materialHandle,
      baseColor: vec3.create(1, 1, 1),
      metallic: 0,
      roughness: 0.5,
      passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' } }],
    });
  const first = make(1),
    second = make(2);
  const mesh = { ...createPrimitiveMesh('cube').unwrap(), materialSlots: [{ slotName: 'body' }] };
  const owner = new MaterialDispatch();
  for (let entityKey = 0; entityKey < 1000; entityKey++) {
    const source: RenderableSnapshot = {
      worldId: 0,
      entityKey,
      assetHandle: 1,
      material: first,
      materials: [first],
      materialBindingSources: ['mesh-default'],
      materialOverrides: [undefined, make(1000 + entityKey)],
      transform: { world: new Float32Array(16) },
    };
    owner.bind(entityKey, source);
  }
  const initial = new MeshFrame().with(0, 1, mesh, [first]);
  owner.prepare(initial);
  const groups = (owner as unknown as { groups: Map<string, { source: object }> }).groups;
  expect(groups.size).toBe(1000);
  const restore: (() => void)[] = [];
  for (const group of groups.values()) {
    const descriptor = Object.getOwnPropertyDescriptor(group, 'source');
    if (descriptor === undefined) throw Error('Missing admitted group source');
    Object.defineProperty(group, 'source', {
      configurable: true,
      get() {
        throw Error('Shared Mesh adoption read an override group');
      },
    });
    restore.push(() => Object.defineProperty(group, 'source', descriptor));
  }
  try {
    owner.adopt(second);
    expect(() => owner.prepare(initial.with(0, 1, mesh, [second]))).not.toThrow();
  } finally {
    for (const callback of restore) callback();
  }
});
