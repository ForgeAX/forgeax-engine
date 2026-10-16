import { defineFeature } from '../../lab/feature';
import { code, forgeax } from './_shared/cli';

interface Leaf {
  readonly realm?: string;
  readonly errors?: readonly string[];
  readonly capabilities?: readonly string[];
}

async function leaf(path: readonly string[]): Promise<Leaf | undefined> {
  return (await forgeax(['help', ...path])).value?.leaf as Leaf | undefined;
}

export default defineFeature({
  title: 'Realm dispatch',
  catalog: 'Realm dispatch',
  kind: 'headless',
  summary:
    'Every CLI leaf declares the realm that owns it (build for project/asset authoring, host for live and preview work) plus the capabilities it needs; a host operation with no live owner fails with a structured code instead of guessing.',
  expect:
    'asset list / project root set / backend start are build; asset material preview and dev find are host; dev find requires live-instance + world-observation; dev find and engine run eval with nothing running fail as live-not-running with a "forgeax dev start" hint; the returned code is one the leaf declares.',
  async run(checks) {
    for (const [path, realm] of [
      [['asset', 'list'], 'build'],
      [['project', 'root', 'set'], 'build'],
      [['backend', 'start'], 'build'],
      [['asset', 'material', 'preview'], 'host'],
      [['dev', 'find'], 'host'],
    ] as const) {
      checks.equal(`${path.join(' ')} realm`, (await leaf(path))?.realm, realm);
    }
    const find = await leaf(['dev', 'find']);
    checks.equal(
      'dev find capabilities',
      [...(find?.capabilities ?? [])].sort().join(','),
      'live-instance,world-observation',
    );

    const status = await forgeax(['dev', 'status']);
    checks.equal('dev status without a session', status.value?.phase, 'stopped');
    const missing = await forgeax(['dev', 'find', '--name', 'Player']);
    checks.equal('dev find without owner', code(missing), 'live-not-running');
    checks.ok(
      'hint names the owner command',
      (missing.error?.hint ?? '').includes('forgeax dev start'),
      missing.error?.hint,
    );
    const evalMissing = await forgeax(['engine', 'run', 'eval', '--code', '1']);
    checks.equal('engine run eval without owner', code(evalMissing), 'live-not-running');
    checks.ok(
      'returned code is declared by the leaf',
      (find?.errors ?? []).includes(code(missing)),
      `declared ${JSON.stringify(find?.errors)}, returned ${code(missing)}`,
    );
  },
});
