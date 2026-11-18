import deferred from './core-validation-deferred.json' with { type: 'json' };

// Only workflow callers opt in. Local and full-profile runs retain every owner.
export function coreDeferredFiles(environment = process.env) {
  return environment.FORGEAX_CI_CORE_VALIDATION === '1' ? deferred.map(({ file }) => file) : [];
}

export function coreValidationFiles(files, environment = process.env) {
  const excluded = new Set(coreDeferredFiles(environment));
  return files.filter((file) => !excluded.has(file));
}

// Browser and Dawn already own their separate profiles. Unit/integration files
// in the same reviewed list are deferred only by the coverage caller.
export function coreDeferredCoverageFiles(environment = process.env) {
  return coreDeferredFiles(environment).filter(
    (file) => !/\.(?:browser|dawn)\.test\.ts$/.test(file),
  );
}
