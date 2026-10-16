import { defineTool, type ToolContribution, type ToolRealm } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import { createRealmDispatch, type ToolRealmOwner } from '../catalog.js';

const schema = { parse: (value: unknown) => ({ ok: true as const, value }) };

function contribution(id: string, realm: ToolRealm): ToolContribution {
  return defineTool(
    {
      id,
      title: id,
      summary: `Physical ${realm} consumer`,
      realm,
      argsSchema: schema,
      resultSchema: schema,
      evidence: [],
    },
    async () => ({ realm, id }),
  );
}

describe('DevKit physical realm dispatch', () => {
  it('uses one descriptor source for build, backend, frontend and engine consumers', async () => {
    const build = contribution('project.build', 'build');
    const host = contribution('preview.host', 'host');
    const engine = contribution('preview.engine', 'engine');
    const frontend = contribution('preview.frontend', 'frontend');
    const all = [build, host, engine, frontend];
    const owners: ToolRealmOwner[] = [
      { realm: 'build', contributions: [build] },
      { realm: 'host', contributions: [host] },
      { realm: 'engine', contributions: [engine] },
      { realm: 'frontend', contributions: [frontend] },
    ];
    const dispatch = createRealmDispatch(all, owners);

    expect(dispatch.list().map((descriptor) => descriptor.id)).toEqual([
      'project.build',
      'preview.host',
      'preview.engine',
      'preview.frontend',
    ]);
    for (const item of all) {
      expect(dispatch.describe(item.descriptor.id)).toBe(item.descriptor);
      await expect(dispatch.run(item.descriptor.id, {})).resolves.toMatchObject({
        outcome: 'succeeded',
        result: { id: item.descriptor.id, realm: item.descriptor.realm },
      });
    }
    await dispatch.dispose();
  });

  it('fails closed when a declared realm has no owner', async () => {
    const engine = contribution('preview.engine-unavailable', 'engine');
    const dispatch = createRealmDispatch([engine], [{ realm: 'host', contributions: [] }]);

    await expect(dispatch.run(engine.descriptor.id, {})).resolves.toMatchObject({
      outcome: 'failed',
      failure: {
        code: 'tool-capability-unavailable',
        detail: { capability: 'realm:engine:tool:preview.engine-unavailable', realm: 'engine' },
      },
    });
    await dispatch.dispose();
  });

  it('rejects a consumer that declares a different realm than its owner', () => {
    const engine = contribution('preview.engine-mismatch', 'engine');
    expect(() =>
      createRealmDispatch([engine], [{ realm: 'host', contributions: [engine] }]),
    ).toThrow('declares engine but owner is host');
  });

  it('requires an explicit source and provider for same-realm owners', async () => {
    const first = contribution('preview.shared', 'host');
    const second = contribution('preview.shared', 'host');
    const dispatch = createRealmDispatch(
      [first, second],
      [
        { realm: 'host', contributions: [first], sourceId: 'browser-a', providerId: 'host-a' },
        { realm: 'host', contributions: [second], sourceId: 'browser-b', providerId: 'host-b' },
      ],
    );

    expect(dispatch.describe('preview.shared')).toBeUndefined();
    await expect(dispatch.run('preview.shared', {})).resolves.toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-domain-failed', detail: { code: 'api-provider-route-required' } },
    });
    await expect(
      dispatch.run('preview.shared', {}, { sourceId: 'browser-b', providerId: 'host-b' }),
    ).resolves.toMatchObject({
      outcome: 'succeeded',
      result: { id: 'preview.shared', realm: 'host' },
    });
    await dispatch.dispose();
  });
});
