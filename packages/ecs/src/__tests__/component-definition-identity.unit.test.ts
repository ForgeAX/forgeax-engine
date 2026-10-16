import { describe, expect, it } from 'vitest';

describe('component definition identity', () => {
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
