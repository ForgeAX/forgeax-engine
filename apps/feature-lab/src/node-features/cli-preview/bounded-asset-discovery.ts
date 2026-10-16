import { defineFeature } from '../../lab/feature';
import { code, emptyProject, forgeax } from './_shared/cli';

interface Page {
  readonly cursor?: number;
  readonly limit?: number;
  readonly total?: number;
}

export default defineFeature({
  title: 'Bounded asset discovery and verification',
  catalog: 'Bounded asset discovery and verification',
  kind: 'headless',
  summary:
    'asset list pages imported assets and Pack sources with --limit 1..256 and an integer --cursor; asset verify returns a bounded asset-verification-v1 report; asset inspect resolves one subject by GUID with its sourceKey.',
  expect:
    'limit 1 returns the scene-owner Pack source with page {cursor 0, limit 1, total 1}; cursor 1 is an empty page with the same total; limit 0 and a non-integer cursor are cli-parse-error; verify reports asset-verification-v1 with the unproduced scriptable output; inspect returns kind scene and sourceKey world/empty.',
  async run(checks) {
    const fixture = emptyProject();
    try {
      const first = await forgeax(['asset', 'list', '--root', fixture.root, '--limit', '1']);
      const sources = (first.value?.sources ?? []) as { sourcePath?: string }[];
      checks.equal('first page source', sources[0]?.sourcePath, 'assets/scene-owner.pack.ts');
      const page = first.value?.page as Page | undefined;
      checks.equal('first page window', `${page?.cursor}/${page?.limit}/${page?.total}`, '0/1/1');
      const next = await forgeax([
        'asset',
        'list',
        '--root',
        fixture.root,
        '--limit',
        '1',
        '--cursor',
        '1',
      ]);
      const nextPage = next.value?.page as Page | undefined;
      checks.ok(
        'cursor past the end is an empty page',
        ((next.value?.sources ?? []) as unknown[]).length === 0 && nextPage?.total === 1,
        JSON.stringify(nextPage),
      );
      checks.equal(
        'limit 0',
        code(await forgeax(['asset', 'list', '--root', fixture.root, '--limit', '0'])),
        'cli-parse-error',
      );
      checks.equal(
        'opaque cursor rejected',
        code(await forgeax(['asset', 'list', '--root', fixture.root, '--cursor', 'zzz'])),
        'cli-parse-error',
      );

      const verify = await forgeax(['asset', 'verify', '--root', fixture.root]);
      checks.equal('verify schema', verify.value?.schemaVersion, 'asset-verification-v1');
      checks.ok(
        'verify reports unproduced output',
        JSON.stringify(verify.value).includes('producer-not-run'),
        code(verify),
      );

      const inspect = await forgeax([
        'asset',
        'inspect',
        '--root',
        fixture.root,
        '--subject',
        '019fb7ce-1000-7000-8000-000000000001',
      ]);
      const text = JSON.stringify(inspect.value);
      checks.ok(
        'inspect scene subject',
        text.includes('"scene"') && text.includes('world/empty'),
        `${code(inspect)} ${text.slice(0, 160)}`,
      );
    } finally {
      fixture.dispose();
    }
  },
});
