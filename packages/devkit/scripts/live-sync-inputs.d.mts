/** Copy a selected producer's immutable publication into a disposable project. */
export function prepareLiveSyncSharedInputs(input: {
  readonly sourceRoot: string;
  readonly projectRoot: string;
  readonly manifestPath: string;
  readonly temporaryRoot?: string;
}): Promise<string>;

export function createLiveSyncProjectDirectory(prefix: string, sourceRoot: string, manifestPath?: string): Promise<{
  readonly root: string;
  readonly temporaryRoot: string;
}>;
