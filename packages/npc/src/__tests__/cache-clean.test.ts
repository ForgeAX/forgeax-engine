import { describe, expect, test } from 'vitest';
import packageJson from '../../package.json';

describe('@forgeax/engine-npc cache isolation', () => {
  test('package-local build and test scripts never invoke a package downloader', () => {
    expect(packageJson.scripts.build).toBe('tsup');
    expect(packageJson.scripts.test).toBe('vitest run');
    expect(`${packageJson.scripts.build} ${packageJson.scripts.test}`).not.toMatch(
      /\b(?:npm|npx|pnpm dlx)\b/,
    );
  });
});
