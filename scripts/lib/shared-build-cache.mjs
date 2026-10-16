import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hashFiles, hashText, walkFiles } from '../build-task-cache.mjs';

// One input identity for local and transferred shader outputs. Generated release
// profiles are outputs, so publishing them cannot invalidate the next lookup.
export function sharedShaderInputFingerprint(root, engineEntries) {
  const packages = new Map(
    readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json')),
      )
      .map((entry) => {
        const directory = join(root, 'packages', entry.name);
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
        return [manifest.name, { directory, manifest }];
      }),
  );
  const closure = new Set();
  const visit = (name) => {
    if (closure.has(name)) return;
    const owner = packages.get(name);
    if (!owner) throw new Error(`shared shader compiler dependency is missing: ${name}`);
    closure.add(name);
    for (const [dependency, version] of Object.entries({
      ...owner.manifest.dependencies,
      ...owner.manifest.optionalDependencies,
      ...owner.manifest.peerDependencies,
    })) {
      // This edge resolves the VFX manifest and reads WGSL, never its runtime.
      // Other compiler consumers of VFX retain their executable dependencies.
      if (
        name === '@forgeax/engine-vite-plugin-shader' &&
        dependency === '@forgeax/engine-vfx-render'
      )
        continue;
      if (packages.has(dependency) || version.startsWith('workspace:')) visit(dependency);
    }
  };
  visit('@forgeax/engine-vite-plugin-shader');
  const packageInputs = [...closure]
    .flatMap((name) => {
      const { directory } = packages.get(name);
      return [join(directory, 'package.json'), ...walkFiles(join(directory, 'dist'))];
    })
    .filter((path) => /\.(?:[cm]?js|json|wasm|wgsl)$/.test(path))
    // Release profiles are this producer's output, not compiler implementation.
    .filter(
      (path) => !path.startsWith(join(root, 'packages/vite-plugin-shader/dist/engine-inputs/')),
    );
  return hashText(
    JSON.stringify({
      bytes: hashFiles(root, [
        ...packageInputs,
        // Naga's compiler binary is owned by wgpu-wasm. Runtime codec payloads
        // can differ between producer and consumer without changing shaders.
        // wasm-pack emits .gitignore, docs and declarations which Actions
        // intentionally omits from archives or which do not execute. Bind the
        // actual compiler binary/glue and module mode, not packaging metadata.
        ...walkFiles(join(root, 'packages/wgpu-wasm/pkg')).filter(
          (path) =>
            /\.(?:[cm]?js|wasm)$/.test(path) ||
            path === join(root, 'packages/wgpu-wasm/pkg/package.json'),
        ),
        ...walkFiles(join(root, 'packages/shader/src')),
        join(root, 'packages/vfx-render/package.json'),
        ...walkFiles(join(root, 'packages/vfx-render/src/shaders')),
        join(root, 'package.json'),
        join(root, 'pnpm-lock.yaml'),
        join(root, 'scripts/build-shared-inputs.mjs'),
        join(root, 'scripts/ci/build-shared-app-inputs.mjs'),
        join(root, 'scripts/lib/shared-build-cache.mjs'),
        join(root, 'scripts/build-task-cache.mjs'),
      ]),
      node: process.version,
      engineEntries,
    }),
  );
}

// Bind the transferable shader manifest to the same source/compiler/profile
// identity as local reuse, without adding a second shader payload to artifacts.
export function sharedShaderReceipt(root, manifestPath, inputFingerprint) {
  return { inputFingerprint, outputFingerprint: hashFiles(root, [manifestPath]) };
}

export function reusableSharedShader(root, sharedManifestPath, inputFingerprint, onMiss) {
  const miss = (reason) => {
    onMiss?.(reason);
    return null;
  };
  try {
    const manifest = JSON.parse(readFileSync(sharedManifestPath, 'utf8'));
    if (!['repo-build-inputs', 'shared-app-inputs'].includes(manifest.producer))
      return miss(`unsupported shared producer: ${manifest.producer}`);
    if (!manifest.shaderBuild)
      return miss('missing shaderBuild receipt; regenerate with the current producer');
    if (manifest.shaderBuild.inputFingerprint !== inputFingerprint)
      return miss(
        `compiler/source/profile identity mismatch: expected=${inputFingerprint} observed=${manifest.shaderBuild.inputFingerprint}`,
      );
    const shaderPath = resolve(root, manifest.payload.engineShaderManifest);
    const expectedPath = resolve(dirname(sharedManifestPath), 'shaders/manifest.json');
    if (realpathSync(shaderPath) !== realpathSync(expectedPath))
      return miss(`shader payload path mismatch: expected=${expectedPath} observed=${shaderPath}`);
    const observed = hashFiles(root, [shaderPath]);
    if (manifest.shaderBuild.outputFingerprint !== observed)
      return miss(
        `shader payload digest mismatch: expected=${manifest.shaderBuild.outputFingerprint} observed=${observed} path=${shaderPath}`,
      );
    return shaderPath;
  } catch (error) {
    return miss(
      `cannot read shared shader input ${sharedManifestPath}: ${error.code ?? error.name}: ${error.message}`,
    );
  }
}
