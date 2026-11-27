import { Context, createToolApiPlugin } from '@forgeax/engine-plugin';
import { defineTool, type ToolContribution, type ToolRealm } from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import { mountToolProviders } from '../execution.js';

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

describe('DevKit Tool API provider mounting', () => {
  it.each([
    { realms: ['host', 'host'], failure: 'duplicate Tool API operation id' },
    { realms: ['engine'], failure: 'declares engine but provider is host' },
  ] satisfies {
    realms: ToolRealm[];
    failure: string;
  }[])('rolls back every added Fiber on $failure', async ({ realms, failure }) => {
    const context = new Context();
    try {
      await context.plugin(createToolApiPlugin());
      const api = context.get('toolApi', true);
      if (api === undefined) throw new Error('Expected the borrowed ToolApi');
      const tool = contribution('rollback.test', 'host');
      const provider = {
        realm: 'host' as const,
        sourceId: 'rollback-fixture',
        providerId: 'accepted',
      };
      const activeBefore = activeFibers();
      await expect(
        mountToolProviders(
          context,
          [
            { ...provider, name: 'mount-test/accepted', tools: [tool] },
            {
              ...provider,
              name: 'mount-test/rejected',
              providerId: 'invalid',
              tools: realms.map((realm) => contribution(tool.descriptor.id, realm)),
            },
          ],
          false,
        ),
      ).rejects.toThrow(failure);
      expect(activeFibers()).toEqual(activeBefore);
      expect(api.describe(tool.descriptor.id).some((row) => row.callable)).toBe(false);
      expect(context.get('toolApi', true)).toBe(api);
    } finally {
      await context.fiber.dispose();
    }

    function activeFibers() {
      return [...context.registry.values()].flatMap((runtime) =>
        [...runtime.fibers].flatMap((fiber) => (fiber.uid === null ? [] : [fiber.uid])),
      );
    }
  });
});
