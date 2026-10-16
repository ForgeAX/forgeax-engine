export type FbxTextureResolutionStrategy = 'exact' | 'case-folded' | 'suffix' | 'basename';

export interface FbxTexturePathRequest {
  readonly declaredRelativePath?: string;
  readonly declaredFilename?: string;
  readonly declaredAbsolutePath?: string;
}

export interface FbxTextureCandidate {
  /** Candidate path relative to the FBX source file's directory. */
  readonly relativePath: string;
}

export type FbxTextureResolution =
  | {
      readonly ok: true;
      readonly relativePath: string;
      /** URI passed to ImportContext.readSibling from the FBX source. */
      readonly readUri: string;
      readonly strategy: FbxTextureResolutionStrategy;
    }
  | {
      readonly ok: false;
      readonly code: 'fbx-external-texture-missing' | 'fbx-external-texture-ambiguous';
      readonly requestedPath: string;
      readonly candidates: readonly string[];
    };

function normalizeSourceRelativePath(raw: string): string | undefined {
  const value = raw.replaceAll('\\', '/');
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.startsWith('//'))
    return undefined;
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.at(-1) !== undefined && parts.at(-1) !== '..') parts.pop();
      else parts.push('..');
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function requestSegments(raw: string): string[] {
  const value = raw
    .replaceAll('\\', '/')
    .replace(/^[A-Za-z]:\//, '')
    .replace(/^\/+/, '');
  return value.split('/').filter((part) => part !== '' && part !== '.');
}

function uniqueMatches(paths: readonly string[], predicate: (path: string) => boolean): string[] {
  return [...new Set(paths.filter(predicate))];
}

function longestSuffixLength(request: readonly string[], candidate: readonly string[]): number {
  let count = 0;
  while (
    count < request.length &&
    count < candidate.length &&
    request[request.length - 1 - count]?.toLowerCase() ===
      candidate[candidate.length - 1 - count]?.toLowerCase()
  ) {
    count++;
  }
  return count;
}

/** Resolve an FBX-declared texture against a caller-authorized candidate tree. */
export function resolveFbxTexturePath(
  sourcePath: string,
  request: FbxTexturePathRequest,
  candidates: readonly FbxTextureCandidate[],
): FbxTextureResolution {
  const candidatePaths = candidates.flatMap((candidate) => {
    const normalized = normalizeSourceRelativePath(candidate.relativePath);
    return normalized === undefined || normalized.length === 0 ? [] : [normalized];
  });
  const requestedPath =
    request.declaredRelativePath ?? request.declaredFilename ?? request.declaredAbsolutePath ?? '';
  void sourcePath;

  const choose = (
    matches: readonly string[],
    strategy: FbxTextureResolutionStrategy,
  ): FbxTextureResolution | undefined => {
    const unique = [...new Set(matches)];
    if (unique.length === 1) {
      const relativePath = unique[0];
      if (relativePath === undefined) return undefined;
      return {
        ok: true,
        relativePath,
        readUri: relativePath,
        strategy,
      };
    }
    if (unique.length > 1) {
      return {
        ok: false,
        code: 'fbx-external-texture-ambiguous',
        requestedPath,
        candidates: unique,
      };
    }
    return undefined;
  };

  const relativeRequest = request.declaredRelativePath ?? request.declaredFilename;
  if (relativeRequest !== undefined && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(relativeRequest)) {
    const normalizedRequest = normalizeSourceRelativePath(relativeRequest);
    if (normalizedRequest !== undefined) {
      const scopeExact = choose(
        uniqueMatches(candidatePaths, (path) => path === normalizedRequest),
        'exact',
      );
      if (scopeExact !== undefined) return scopeExact;
      const scopeFolded = choose(
        uniqueMatches(
          candidatePaths,
          (path) => path.toLowerCase() === normalizedRequest.toLowerCase(),
        ),
        'case-folded',
      );
      if (scopeFolded !== undefined) return scopeFolded;
    }
  }

  const requestedSegments = requestSegments(requestedPath);
  if (requestedSegments.length > 0) {
    const scored = candidatePaths.map((path) => ({
      path,
      score: longestSuffixLength(requestedSegments, path.split('/')),
    }));
    const bestScore = Math.max(0, ...scored.map((entry) => entry.score));
    if (bestScore > 0) {
      const best = scored.filter((entry) => entry.score === bestScore).map((entry) => entry.path);
      const strategy: FbxTextureResolutionStrategy = bestScore === 1 ? 'basename' : 'suffix';
      const suffix = choose(best, strategy);
      if (suffix !== undefined) return suffix;
    }
  }

  return {
    ok: false,
    code: 'fbx-external-texture-missing',
    requestedPath,
    candidates: candidatePaths,
  };
}
