import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DDC_LAYOUT_VERSION, type DdcServeOptions, resolveDdcLayout } from '../layout.js';

describe('DDC v2 layout contract', () => {
  it('normalizes both explicitly injected roots without consulting cwd or roots[0]', () => {
    const result = resolveDdcLayout({
      buildCacheRoot: `${resolve('/tmp/forgeax/cache')}/../cache`,
      projectDdcRoot: `${resolve('/tmp/forgeax/game/.forgeax/ddc/v2')}/./`,
    } satisfies DdcServeOptions);

    expect(result).toMatchObject({
      ok: true,
      value: {
        version: DDC_LAYOUT_VERSION,
        buildCacheRoot: resolve('/tmp/forgeax/cache'),
        projectDdcRoot: resolve('/tmp/forgeax/game/.forgeax/ddc/v2'),
      },
    });
  });

  it('fails closed when serve/publication has no project root', () => {
    const result = resolveDdcLayout({ buildCacheRoot: '/tmp/forgeax/cache' });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'ddc-project-root-required' },
    });
  });

  it('has one canonical v2 child layout and cannot derive a root from asset inputs', () => {
    const result = resolveDdcLayout({
      buildCacheRoot: resolve('/tmp/cache'),
      projectDdcRoot: resolve('/tmp/game/.forgeax/ddc/v2'),
    });

    if (!result.ok) throw result.error;
    expect(result.value.build).toEqual({
      objects: `${resolve('/tmp/cache')}/objects`,
      staging: `${resolve('/tmp/cache')}/staging`,
    });
    expect(result.value.project).toEqual({
      root: resolve('/tmp/game/.forgeax/ddc/v2'),
      scope: `${resolve('/tmp/game/.forgeax/ddc/v2')}/scope.json`,
      heads: `${resolve('/tmp/game/.forgeax/ddc/v2')}/heads`,
      generations: `${resolve('/tmp/game/.forgeax/ddc/v2')}/generations`,
      leases: `${resolve('/tmp/game/.forgeax/ddc/v2')}/leases`,
      staging: `${resolve('/tmp/game/.forgeax/ddc/v2')}/staging`,
    });
  });
});
