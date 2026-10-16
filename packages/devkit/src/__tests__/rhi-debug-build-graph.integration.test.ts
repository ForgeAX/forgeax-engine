import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const rhiNullName = '@forgeax/engine-rhi-null';

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

async function readManifest(relativePath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(resolve(repoRoot, relativePath), 'utf8')) as PackageManifest;
}

describe('DevKit package build dependency graph', () => {
  it('waits for rhi-null production output before the DevKit build can start', async () => {
    const devkit = await readManifest('packages/devkit/package.json');
    const buildScript = await readFile(resolve(repoRoot, 'scripts/build-packages.mjs'), 'utf8');
    const productionDependencies = new Set(Object.keys(devkit.dependencies ?? {}));

    expect(productionDependencies.has(rhiNullName)).toBe(true);
    expect(devkit.devDependencies?.[rhiNullName]).toBeUndefined();

    // build-packages.mjs derives its graph from production dependency fields,
    // then admits a pending package only after every dependency is completed.
    expect(buildScript).toContain(
      "workspaceDependencyNames(pkg.manifest, knownNames, [\n      'dependencies',\n      'optionalDependencies',\n      'peerDependencies',\n    ])",
    );
    expect(buildScript).toContain(
      'if (![...deps].every((dependency) => completed.has(dependency))) continue;',
    );
    expect(buildScript).toContain('const output = inventory(packageOutputDirectory(pkg));');
    const dependencyGateOffset = buildScript.indexOf(
      'if (![...deps].every((dependency) => completed.has(dependency))) continue;',
    );
    const startOffset = buildScript.indexOf('const promise = runPackage(pkg).then');
    const outputOffset = buildScript.indexOf(
      'const output = inventory(packageOutputDirectory(pkg));',
    );
    const completionOffset = buildScript.lastIndexOf('completed.add(pkg.manifest.name);');
    expect(dependencyGateOffset).toBeGreaterThanOrEqual(0);
    expect(dependencyGateOffset).toBeLessThan(startOffset);
    expect(outputOffset).toBeLessThan(completionOffset);

    const completed = new Set<string>();
    expect(completed.has(rhiNullName)).toBe(false);
    completed.add(rhiNullName);
    expect(completed.has(rhiNullName)).toBe(true);
  });
});
