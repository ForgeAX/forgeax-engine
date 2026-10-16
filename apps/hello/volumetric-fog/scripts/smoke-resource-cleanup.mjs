export function createSmokeCleanup() {
  const releases = [];
  let disposed = false;

  return {
    own(cleanup) {
      if (disposed) throw new Error('smoke cleanup scope is already disposed');
      let active = true;
      const release = async () => {
        if (!active) return;
        active = false;
        const index = releases.indexOf(release);
        if (index >= 0) releases.splice(index, 1);
        await cleanup();
      };
      releases.push(release);
      return release;
    },

    async dispose() {
      if (disposed) return [];
      disposed = true;
      const errors = [];
      for (const release of [...releases].reverse()) {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      }
      releases.length = 0;
      return errors;
    },
  };
}

export function combineSmokeErrors(primaryFailure, cleanupErrors) {
  if (primaryFailure === undefined) {
    return cleanupErrors.length === 0
      ? undefined
      : new AggregateError(cleanupErrors, 'volumetric-fog smoke cleanup failed');
  }
  if (cleanupErrors.length === 0) return primaryFailure.error;
  return new AggregateError(
    [primaryFailure.error, ...cleanupErrors],
    'volumetric-fog smoke failed and cleanup reported errors',
    { cause: primaryFailure.error },
  );
}
