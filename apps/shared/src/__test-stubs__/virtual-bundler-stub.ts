// virtual-bundler-stub.ts -- vitest-only resolution target for
// `virtual:forgeax/bundler` (feat-20260608-create-app-param-surface-trim M3).
//
// In production, the import is satisfied by the `forgeaxShader` plugin's
// resolveId/load hooks; vitest does not run the plugin chain so we point
// the alias at this file instead. It returns the same minimal shape the
// runtime adapter does: `{ shaderManifestUrl: string }`. Tests under
// apps/shared/src/__tests__/ only exercise the pure math helpers and never
// invoke `createFirstPersonControls`, so the `importTransport` field is
// left absent (matches the production adapter signature).
export function forgeaxBundlerAdapter(): {
  readonly shaderManifestUrl: string;
  readonly importTransport?: undefined;
} {
  return { shaderManifestUrl: '/shaders/manifest.json' };
}
