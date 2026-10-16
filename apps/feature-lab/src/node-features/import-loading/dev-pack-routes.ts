import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { HERO_GUID, MISSING_GUID, withPackDevServer } from './support/dev-server';

interface CatalogEntry {
  readonly guid?: string;
  readonly packageUrl?: string;
}

const errorOf = (body: unknown) => String((body as { error?: unknown } | null)?.error);

export default defineFeature({
  title: 'Development Pack routes',
  catalog: 'Development Pack routes',
  kind: 'headless',
  summary:
    'The dev server serves one generation-scoped runtime catalog: catalog.json, per-entry package URLs cooked on demand, and a POST-only lazy import route. Stale generations, unknown scopes, and the global unscoped routes answer with structured JSON errors.',
  expect:
    'A real Vite dev server with pluginPack serves an authoritative scoped catalog; the image package is cooked on demand; GET on the import route is 405, an undeclared GUID is meta-not-found, generation+1 is 410, another scope is 404, and global routes are disabled.',
  async run(checks) {
    const binding = createStandaloneRuntimeAssetBinding('fl-dev');
    await withPackDevServer(binding, async (server) => {
      const catalog = await server.fetch(binding.catalogUrl);
      const body = catalog.body as {
        authority?: string;
        generation?: number;
        entries?: readonly CatalogEntry[];
      };
      checks.equal('scoped catalog.json status', catalog.status, 200);
      checks.equal('catalog authority', body.authority, 'authoritative');
      checks.equal('catalog generation', body.generation, binding.generation);
      const entries = body.entries ?? [];
      checks.equal('catalog lists sampler + image rows', entries.length, 2);
      const hero = entries.find((entry) => entry.guid === HERO_GUID);
      checks.ok('meta-declared texture row is listed', hero !== undefined);

      if (hero?.packageUrl !== undefined) {
        const pkg = await server.fetch(hero.packageUrl);
        checks.equal('texture packageUrl status', pkg.status, 200);
        checks.equal(
          'texture package cooked on demand',
          (pkg.body as { kind?: string } | null)?.kind,
          'internal-text-package',
        );
      }

      const get = await server.fetch(`${binding.importUrlBase}/${HERO_GUID}`);
      checks.equal('GET import route is 405', get.status, 405);
      checks.equal('GET import error code', errorOf(get.body), 'method-not-allowed');

      const missing = await server.fetch(`${binding.importUrlBase}/${MISSING_GUID}`, {
        method: 'POST',
      });
      checks.equal('POST undeclared GUID status', missing.status, 404);
      checks.equal('POST undeclared GUID error', errorOf(missing.body), 'meta-not-found');

      const expired = await server.fetch(
        `/__pack/scopes/${binding.scopeId}/${binding.generation + 1}/catalog.json`,
      );
      checks.equal('next generation is 410', expired.status, 410);
      checks.equal(
        'expired generation error',
        errorOf(expired.body),
        'runtime-scope-generation-expired',
      );

      const other = await server.fetch(`/__pack/scopes/other/${binding.generation}/catalog.json`);
      checks.equal('unknown scope is 404', other.status, 404);
      checks.equal('unknown scope error', errorOf(other.body), 'runtime-scope-not-found');

      for (const path of ['/__pack/index', '/pack-index.json']) {
        const global = await server.fetch(path);
        checks.equal(
          `${path} disabled under a runtime binding`,
          errorOf(global.body),
          'global-runtime-scope-route-disabled',
        );
      }
    });
  },
});
