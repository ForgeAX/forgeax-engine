import { defineFeature } from '../../lab/feature';
import { code, emptyProject, forgeax } from './_shared/cli';

const LIFECYCLE = [
  ['sdk', 'install'],
  ['project', 'new'],
  ['project', 'init'],
  ['project', 'check'],
  ['project', 'test'],
  ['project', 'build'],
  ['project', 'package'],
  ['project', 'preview'],
  ['dev', 'start'],
] as const;

export default defineFeature({
  title: 'Project lifecycle commands',
  catalog: 'Project lifecycle commands',
  kind: 'headless',
  summary:
    'The lifecycle verbs are sdk install, project new/init/check/test/build/package/preview and dev start; each refuses a wrong context with an owner-specific structured code instead of guessing a project or SDK.',
  expect:
    'every lifecycle leaf has help with a build or host realm; project engine status on a template copy is healthy in sdk mode; project new without an SDK root is sdk-context-missing; project check on an unpublished template copy is project-local-dependency; project init --dry-run over existing scripts is project-script-conflict.',
  async run(checks) {
    for (const path of LIFECYCLE) {
      const help = await forgeax(['help', ...path]);
      const realm = (help.value?.leaf as { realm?: string } | undefined)?.realm;
      checks.ok(`${path.join(' ')} is discoverable`, realm === 'build' || realm === 'host', realm);
    }
    const fixture = emptyProject();
    try {
      const status = await forgeax(['project', 'engine', 'status', '--root', fixture.root]);
      checks.ok(
        'engine status healthy',
        status.value?.healthy === true && status.value.mode === 'sdk',
        `${code(status)} mode=${String(status.value?.mode)}`,
      );
      const created = await forgeax([
        'project',
        'new',
        '--root',
        `${fixture.root}-new`,
        '--template',
        'empty',
        '--dry-run',
      ]);
      checks.equal('new outside an SDK', code(created), 'sdk-context-missing');
      const check = await forgeax(['project', 'check', '--root', fixture.root]);
      checks.ok(
        'check names the local dependency',
        code(check) === 'project-local-dependency' &&
          JSON.stringify(check.error?.detail).includes('@forgeax/engine'),
        `${code(check)} ${JSON.stringify(check.error?.detail)}`,
      );
      const init = await forgeax(['project', 'init', '--root', fixture.root, '--dry-run']);
      checks.equal('init refuses script overwrite', code(init), 'project-script-conflict');
    } finally {
      fixture.dispose();
    }
  },
});
