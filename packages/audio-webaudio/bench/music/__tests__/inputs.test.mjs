import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sourceHashes } from '../inputs.mjs';

describe('Music source input hashes', () => {
  it('keeps tracked source inputs when optional generated outputs are absent', async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-music-inputs-'));
    const source = resolve(temporaryRoot, 'packages/audio/src/index.ts');

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: temporaryRoot });
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, 'export const source = true;\n');
      execFileSync('git', ['add', '--', 'packages/audio/src/index.ts'], { cwd: temporaryRoot });

      const hashes = await sourceHashes(temporaryRoot);

      expect(Object.keys(hashes)).toEqual(['packages/audio/src/index.ts']);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('does not let retained evidence outputs invalidate a prepared source epoch', async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-music-inputs-evidence-'));
    const inputs = new Map([
      ['packages/audio/src/index.ts', 'export const source = true;\n'],
      ['packages/audio-webaudio/src/music-transport.ts', 'export const transport = true;\n'],
      ['packages/audio/dist/index.mjs', 'export const built = true;\n'],
      ['packages/wgpu-wasm/pkg/provenance.json', '{"sourceContentKey":"fixture"}\n'],
      [
        'packages/vite-plugin-shader/dist/engine-inputs/base-ssao/manifest.json',
        '{"profile":"base-ssao"}\n',
      ],
      [
        'packages/vite-plugin-shader/dist/engine-inputs/point-ssao/fragment.wgsl',
        '// point profile fixture\n',
      ],
    ]);
    const evidence = resolve(
      temporaryRoot,
      'packages/audio-webaudio/bench/music/evidence/current11/output.json',
    );

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: temporaryRoot });
      for (const [path, bytes] of inputs) {
        const file = resolve(temporaryRoot, path);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, bytes);
      }
      await mkdir(dirname(evidence), { recursive: true });
      await writeFile(evidence, JSON.stringify({ outputOnly: true, revision: 1 }));
      // A tracked output must be excluded even without a workspace .gitignore.
      execFileSync(
        'git',
        [
          'add',
          '--',
          'packages/audio/src/index.ts',
          'packages/audio-webaudio/src/music-transport.ts',
          'packages/audio-webaudio/bench/music/evidence/current11/output.json',
        ],
        { cwd: temporaryRoot },
      );
      const expected = Object.fromEntries(
        [...inputs].map(([path, bytes]) => [
          path,
          createHash('sha256').update(bytes).digest('hex'),
        ]),
      );
      const before = await sourceHashes(temporaryRoot);
      expect(before).toEqual(expected);

      await writeFile(evidence, JSON.stringify({ outputOnly: true, revision: 2 }));
      await writeFile(
        resolve(dirname(evidence), '.input-probe.json'),
        JSON.stringify({ untrackedOutput: true }),
      );
      const after = await sourceHashes(temporaryRoot);
      expect(after).toEqual(before);
      expect(
        Object.keys(after).some((path) =>
          path.startsWith('packages/audio-webaudio/bench/music/evidence/'),
        ),
      ).toBe(false);

      const changedSource = 'export const transport = false;\n';
      await writeFile(
        resolve(temporaryRoot, 'packages/audio-webaudio/src/music-transport.ts'),
        changedSource,
      );
      const changed = await sourceHashes(temporaryRoot);
      expect(changed).toEqual({
        ...expected,
        'packages/audio-webaudio/src/music-transport.ts': createHash('sha256')
          .update(changedSource)
          .digest('hex'),
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
