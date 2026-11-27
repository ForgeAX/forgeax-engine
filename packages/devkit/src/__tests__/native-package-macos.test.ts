import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { planNativePackage } from '../native-package.js';
import {
  macosInfoPlist,
  nativeMacosLauncherSource,
  planMacosNativePackage,
} from '../native-package-macos.js';
import type { PackageOptions } from '../types.js';

const facts = {
  root: resolve('fixtures/game'),
  id: 'game',
  name: 'Game & Demo',
  packageJson: { version: '1.2.3' },
};
const options = {
  format: 'native',
  platform: 'macos',
  bundleId: 'com.example.game',
  nodeDist: 'runtime',
} as const;

it('keeps a stable bundle identity and plans an arm64 DMG', () => {
  const plan = planMacosNativePackage(facts, options);
  expect(plan).toMatchObject({
    ok: true,
    value: {
      bundleId: 'com.example.game',
      version: '1.2.3',
      output: resolve(facts.root, 'release/com.example.game-1.2.3-macos-arm64.dmg'),
      nodeDist: resolve(facts.root, 'runtime'),
    },
  });
  expect(
    macosInfoPlist({ ...facts, bundleId: 'com.example.game', version: '1.2.3' }, '13.5'),
  ).toContain('Game &amp; Demo');
  expect(nativeMacosLauncherSource('com.example.game')).toContain(
    'Library/Logs/ForgeaX/com.example.game/launcher.log',
  );
});

it('rejects mixed platform settings, mismatched output and an invalid notarization request', () => {
  const invalid: readonly [Partial<PackageOptions>, string][] = [
    [{ arch: 'x64' }, 'native-package-target-invalid'],
    [{ vcRuntime: 'redist' }, 'native-package-target-invalid'],
    [{ version: '1.2.3-pre' }, 'native-package-identity-invalid'],
    [{ bundleId: 'bad/name' }, 'native-package-identity-invalid'],
    [{ output: 'dist/game.dmg' }, 'native-package-output-invalid'],
    [{ output: 'release/game.msi' }, 'native-package-output-invalid'],
    [{ nodeDist: ' ' }, 'native-package-runtime-missing'],
    [{ notaryKeychainProfile: 'CI' }, 'native-package-signing-invalid'],
    [{ signIdentity: '-' }, 'native-package-signing-invalid'],
  ];
  for (const [override, code] of invalid) {
    expect(planMacosNativePackage(facts, { ...options, ...override })).toMatchObject({
      ok: false,
      error: { code },
    });
  }
  expect(planNativePackage(facts, { ...options, platform: 'windows' })).toMatchObject({
    ok: false,
    error: { code: 'native-package-target-invalid' },
  });
});

it('plans Developer ID signing and a configured keychain profile', () => {
  expect(
    planMacosNativePackage(facts, {
      ...options,
      signIdentity: 'Developer ID Application: Example',
      notaryKeychainProfile: 'forgeax-ci',
    }),
  ).toMatchObject({
    ok: true,
    value: {
      signIdentity: 'Developer ID Application: Example',
      notaryProfile: 'forgeax-ci',
    },
  });
});
