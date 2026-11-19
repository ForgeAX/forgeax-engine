import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDefaultSystemFont, resolveSystemFont, systemFontDirs } from '../cli-font.js';

describe('resolveSystemFont', () => {
  it('matches an installed TrueType name with or without suffix, ignoring case and separators', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sysfont-'));
    await writeFile(join(dir, 'DIN Condensed Bold.ttf'), 'x');
    await writeFile(join(dir, 'Arial_Narrow-Bold.ttf'), 'x');
    expect(await resolveSystemFont('DIN Condensed Bold', [dir])).toBe(
      join(dir, 'DIN Condensed Bold.ttf'),
    );
    expect(await resolveSystemFont('din condensed bold.ttf', [dir])).toBe(
      join(dir, 'DIN Condensed Bold.ttf'),
    );
    expect(await resolveSystemFont('Arial Narrow Bold', [dir])).toBe(
      join(dir, 'Arial_Narrow-Bold.ttf'),
    );
  });

  it('returns undefined for a missing font or a missing folder', async () => {
    expect(await resolveSystemFont('No Such Font', ['/nonexistent-dir'])).toBeUndefined();
  });

  it('lists the standard font folders for each platform', () => {
    expect(systemFontDirs('darwin')).toContain('/System/Library/Fonts');
    expect(systemFontDirs('win32').some((d) => /Fonts$/.test(d))).toBe(true);
    expect(systemFontDirs('linux')).toContain('/usr/share/fonts');
  });

  it('asks the OS for the default font on the current platform and reports none for unknown ones', async () => {
    expect(await resolveDefaultSystemFont('freebsd' as NodeJS.Platform)).toBeUndefined();
    if (process.platform === 'darwin') {
      expect(await resolveDefaultSystemFont()).toBe('/System/Library/Fonts/SFNS.ttf');
    }
  }, 150_000);
});
