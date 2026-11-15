import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SSR_SOURCE_LINEAGE = Object.freeze({
  developmentM0: '1a07a092da53ed1bdb363862615f687704a3a2cb',
  landingM0: 'b852c75bed156df1c855c8c9cba6e4d04497c696',
  landingM1: 'fc641abefb',
});

/** A real squash graph, without requiring the Engine repository's historical objects. */
export async function createSsrSquashFixture(root) {
  const git = (...args) => {
    const result = spawnSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=ForgeAX SSR Fixture',
        '-c',
        'user.email=ssr-fixture@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    return result.stdout.trim();
  };
  git('init', '--initial-branch=main');
  await writeFile(join(root, 'owner.json'), '{"stage":"base"}\n');
  git('add', 'owner.json');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'development-m0');
  await writeFile(
    join(root, 'owner.json'),
    JSON.stringify({
      stage: 'M0',
      contracts: ['identity-bound-live-receipts', 'format-eight-stages', 'successful-submit'],
    }),
  );
  git('add', 'owner.json');
  git('commit', '-m', 'develop M0 owners');
  const development = git('rev-parse', 'HEAD');
  git('checkout', 'main');
  git('merge', '--squash', 'development-m0');
  git('commit', '-m', 'land M0 owners');
  const landing = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'temporal.json'), '{"stage":"M1","submittedHistory":true}\n');
  git('add', 'temporal.json');
  git('commit', '-m', 'land M1 temporal consumer');
  return {
    base,
    development,
    landing,
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    git,
  };
}
