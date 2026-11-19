import { describe, expect, it, vi } from 'vitest';

describe('component definition identity', () => {
  it('still rejects a corrupt Entity identity at the root entry', async () => {
    vi.resetModules();
    const { componentDefinition } = await import('../component');
    const { Entity } = await import('../entity');
    const original = componentDefinition(Entity);
    const registry = Reflect.get(globalThis, Symbol.for('forgeax.ecs.componentRegistry.v3')) as {
      definitions: WeakMap<object, object>;
    };
    registry.definitions.set(Entity, Object.freeze({ ...original, id: 17 }));
    try {
      await expect(import('../index')).rejects.toThrow('expected id=0, got 17');
    } finally {
      registry.definitions.set(Entity, original);
    }
  });

  it('preserves relationship ownership when a session World receives canonical component tokens', async () => {
    const indexPath = '../../dist/index.mjs';
    const sessionPath = `${indexPath}?forgeax-program-session=relationship-identity`;
    const [canonical, session] = await Promise.all([import(indexPath), import(sessionPath)]);
    expect(session.World).not.toBe(canonical.World);
    const { source, target } = canonical.defineRelationship({
      sourceName: 'SessionIdentityChildOf',
      sourceField: 'parent',
      targetName: 'SessionIdentityChildren',
      targetField: 'entities',
      linkedSpawn: true,
    });
    const world = new session.World();
    const first = world.spawn().unwrap();
    const second = world.spawn().unwrap();
    const child = world.spawn({ component: source, data: { parent: first } }).unwrap();

    expect(Array.from(world.get(first, target).unwrap().entities)).toEqual([child]);
    world.set(child, source, { parent: second }).unwrap();
    expect(Array.from(world.get(first, target).unwrap().entities)).toEqual([]);
    expect(Array.from(world.get(second, target).unwrap().entities)).toEqual([child]);
    expect(world.set(second, target, { entities: [] }).ok).toBe(false);
    world.despawn(second).unwrap();
    expect(world.get(child, source).ok).toBe(false);
  });

  it('shares token reflection between root and externalization bundles', async () => {
    const indexPath = '../../dist/index.mjs';
    const externalizationPath = '../../dist/externalization/index.mjs';
    const [
      { componentDefinition, defineComponent },
      { classifyEntityField, projectComponentData },
    ] = await Promise.all([import(indexPath), import(externalizationPath)]);
    const Probe = defineComponent('ComponentDefinitionIdentityProbe', {
      target: 'entity',
      targets: 'array<entity>',
    });

    expect(componentDefinition(Probe).fields.target?.type).toBe('entity');
    expect(classifyEntityField(Probe, 'target')).toEqual({ kind: 'entity', isArray: false });
    expect(classifyEntityField(Probe, 'targets')).toEqual({ kind: 'entity', isArray: true });
    expect(projectComponentData(Probe, { target: 7, targets: [8, 9] })).toEqual({
      target: 7,
      targets: [8, 9],
    });
  });
});

it('isolates the component registry layout from earlier bundle versions', async () => {
  const { execFileSync } = await import('node:child_process');
  const entry = new URL('../../dist/index.mjs', import.meta.url).href;
  const script = `
    globalThis[Symbol.for('forgeax.ecs.componentRegistry')] = {
      definitions: new WeakMap(), relationships: new WeakMap()
    };
    const ecs = await import(${JSON.stringify(entry)});
    const component = ecs.defineComponent('RegistryLayoutProbe', { value: 'u32' });
    const definition = ecs.componentDefinition(component);
    if (!Number.isSafeInteger(definition.id)) throw new Error('invalid component identity');
    const world = new ecs.World();
    const entity = world.spawn({ component, data: { value: 7 } }).unwrap();
    if (world.get(entity, component).unwrap().value !== 7) throw new Error('invalid row');
  `;
  expect(() =>
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      stdio: 'pipe',
    }),
  ).not.toThrow();
});
