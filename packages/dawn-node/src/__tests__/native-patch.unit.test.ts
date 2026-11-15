import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('pinned native source patch', () => {
  it('parses every shipped hunk before native source preparation', () => {
    const patch = fileURLToPath(new URL('../../patches/native-workarounds.patch', import.meta.url));
    const parsed = spawnSync('git', ['apply', '--numstat', patch], {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
    expect(parsed.stdout).toContain('1\t0\tsrc/dawn/node/CMakeLists.txt');
  });
});
