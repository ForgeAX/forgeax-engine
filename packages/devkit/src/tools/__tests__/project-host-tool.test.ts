import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolClient } from '../client.js';
import type { ProjectToolBinding } from '../project-tools.js';

const runHost = vi.fn();
vi.mock('../../backend-process.js', () => ({ runDevKitBackendTool: runHost }));

const contribution = defineTool(
  {
    id: 'fixture.host',
    path: ['fixture', 'host'],
    title: 'Host fixture',
    summary: 'Host fixture',
    realm: 'host',
    argsSchema: toolJsonSchema({ type: 'object' }),
    resultSchema: toolJsonSchema({ type: 'object' }),
    evidence: [],
  },
  () => ({ local: true }),
);
const binding: ProjectToolBinding = {
  contribution,
  assetGuid: '0467d2d6-ae37-51a5-9450-d9dce432473b',
  sourceRevision: 'source',
  contractDigest: 'sha256:contract',
  moduleName: 'fixture',
  realm: 'host',
  declaration: {
    id: 'fixture.host',
    realm: 'host',
    title: 'Host fixture',
    summary: 'Host fixture',
  },
};

beforeEach(() => runHost.mockReset());

describe('project host tool dispatch', () => {
  it('routes a discovered host command to the resident backend provider', async () => {
    runHost.mockResolvedValue({ outcome: 'succeeded', result: { remote: true }, artifacts: [] });
    const client = await createToolClient({
      projectRoot: process.cwd(),
      baseContributions: [],
      projectDiscovery: async () => [binding],
    });
    try {
      expect(client.help('fixture host')).toBeDefined();
      expect(await client.runPath('fixture host', {})).toMatchObject({
        outcome: 'succeeded',
        result: { remote: true },
      });
      expect(runHost).toHaveBeenCalledWith(process.cwd(), 'fixture.host', {}, undefined);
    } finally {
      await client.dispose?.();
    }
  });

  it('preserves a backend failure terminal', async () => {
    runHost.mockResolvedValue({
      outcome: 'failed',
      failure: {
        code: 'tool-capability-unavailable',
        expected: 'installed host provider',
        hint: 'Start the backend.',
        detail: { capability: 'tool:fixture.host', realm: 'host' },
      },
      artifacts: [],
    });
    const client = await createToolClient({
      projectRoot: process.cwd(),
      baseContributions: [],
      projectDiscovery: async () => [binding],
    });
    try {
      expect(await client.run('fixture.host', {})).toMatchObject({
        outcome: 'failed',
        failure: { code: 'tool-capability-unavailable', hint: 'Start the backend.' },
      });
    } finally {
      await client.dispose?.();
    }
  });
});
