import { defineFeature } from '../../lab/feature';
import { code, forgeax } from './_shared/cli';

interface TreeNode {
  readonly name?: string;
}

export default defineFeature({
  title: 'forgeax CLI front door',
  catalog: '`forgeax` CLI front door',
  kind: 'headless',
  summary:
    'runUnifiedCli is the in-process dispatch behind the forgeax bin: one command tree with progressive help, strict flag/schema validation and one JSON envelope {ok, command, value | error{code, expected, hint, detail}}.',
  expect:
    'help --tree lists the asset/backend/debug/dev/engine/help/project/sdk groups; help on a leaf returns its realm, inputSchema, outputSchema and error codes; an unknown command is tool-command-not-found with candidates; an unknown flag and an out-of-range value are cli-parse-error.',
  async run(checks) {
    const tree = await forgeax(['help', '--tree']);
    const groups = ((tree.value?.nodes ?? []) as TreeNode[]).map((node) => node.name).sort();
    checks.equal(
      'top-level groups',
      groups.join(','),
      'asset,backend,debug,dev,engine,help,project,sdk',
    );

    const leaf = await forgeax(['help', 'asset', 'list']);
    const detail = leaf.value?.leaf as
      | {
          realm?: string;
          inputSchema?: { properties?: Record<string, unknown> };
          outputSchema?: unknown;
        }
      | undefined;
    checks.equal('leaf realm', detail?.realm, 'build');
    checks.equal(
      'leaf input schema',
      Object.keys(detail?.inputSchema?.properties ?? {}).join(','),
      'root,type,limit,cursor,json',
    );
    checks.ok('leaf output schema', detail?.outputSchema !== undefined);
    const live = await forgeax(['help', 'dev', 'find']);
    const liveLeaf = live.value?.leaf as { errors?: string[]; capabilities?: string[] } | undefined;
    checks.ok(
      'leaf declares error codes',
      (liveLeaf?.errors ?? []).includes('live-not-ready'),
      JSON.stringify(liveLeaf?.errors),
    );

    const group = await forgeax(['help', 'debug']);
    const debugNodes = ((group.value?.nodes ?? []) as TreeNode[]).map((node) => node.name).sort();
    checks.equal('progressive group help', debugNodes.join(','), 'preview,profile,rhi');

    const unknown = await forgeax(['bogus', 'cmd']);
    checks.equal('unknown command', code(unknown), 'tool-command-not-found');
    checks.ok('unknown carries candidates', Array.isArray(unknown.error?.detail?.candidates));
    const flag = await forgeax(['asset', 'list', '--bogus']);
    checks.equal('unknown flag', code(flag), 'cli-parse-error');
    const range = await forgeax(['asset', 'list', '--limit', '0']);
    checks.ok(
      'schema range check',
      code(range) === 'cli-parse-error' && JSON.stringify(range.error).includes('$.limit'),
      range.error?.hint ?? range.error?.expected,
    );
  },
});
