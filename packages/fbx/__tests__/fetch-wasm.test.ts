import { describe, it, expect, afterEach } from 'vitest';

// Import the SSOT helpers from the shared lib + content-key module
// (architecture-principles #1). Vitest can resolve .mjs relative imports; the
// test runs in a Node ESM context.
import { parseGitOrigin, authHeaders } from '../../../scripts/lib/fetch-wasm-lib.mjs';
import { computeContentSha256, buildAssetName } from '../scripts/content-key.mjs';

function contentSha8(): Promise<string> {
  return computeContentSha256().then((sha) => sha.slice(0, 8));
}

// Error codes for fetch-wasm
const ERROR_CODES = {
  E1_NETWORK: 'E1_NETWORK',
  E2_ASSET_NOT_FOUND: 'E2_ASSET_NOT_FOUND',
  E3_ORIGIN_UNSUPPORTED_HOST: 'E3_ORIGIN_UNSUPPORTED_HOST',
  E3_ORIGIN_PARSE_FAILED: 'E3_ORIGIN_PARSE_FAILED',
  E3_NO_ORIGIN: 'E3_NO_ORIGIN',
  E4_HASH_MISMATCH: 'E4_HASH_MISMATCH',
  E5_AUTH_FAILED: 'E5_AUTH_FAILED',
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetch-wasm git origin parsing', () => {
  it('parses SSH origin (git@github.com:OWNER/REPO.git)', () => {
    const result = parseGitOrigin('git@github.com:ForgeaX-Games/forgeax-engine.git');
    expect(result).toEqual({ owner: 'ForgeaX-Games', repo: 'forgeax-engine' });
  });

  it('parses SSH origin without .git suffix', () => {
    const result = parseGitOrigin('git@github.com:some-org/my-repo');
    expect(result).toEqual({ owner: 'some-org', repo: 'my-repo' });
  });

  it('parses HTTPS origin (https://github.com/OWNER/REPO.git)', () => {
    const result = parseGitOrigin('https://github.com/ForgeaX-Games/forgeax-engine.git');
    expect(result).toEqual({ owner: 'ForgeaX-Games', repo: 'forgeax-engine' });
  });

  it('parses HTTPS origin without .git suffix', () => {
    const result = parseGitOrigin('https://github.com/some-org/my-repo');
    expect(result).toEqual({ owner: 'some-org', repo: 'my-repo' });
  });

  it('parses HTTPS origin with http:// scheme', () => {
    const result = parseGitOrigin('http://github.com/org/repo.git');
    expect(result).toEqual({ owner: 'org', repo: 'repo' });
  });

  // Regression: embedded credentials (git credential helper / Windows Git
  // Credential Manager) must not be mistaken for the host — the "TOKEN@" prefix
  // used to be captured into the host group, tripping E3_ORIGIN_UNSUPPORTED_HOST.
  it('parses HTTPS origin with embedded token credential (TOKEN@github.com)', () => {
    const result = parseGitOrigin(
      'https://ghp_ABCDEF1234567890@github.com/ForgeaX-Games/forgeax-engine.git',
    );
    expect(result).toEqual({ owner: 'ForgeaX-Games', repo: 'forgeax-engine' });
  });

  it('parses HTTPS origin with embedded user:password credential', () => {
    const result = parseGitOrigin(
      'https://user:x-oauth-basic@github.com/some-org/my-repo.git',
    );
    expect(result).toEqual({ owner: 'some-org', repo: 'my-repo' });
  });

  it('still rejects non-GitHub host even with embedded credentials', () => {
    expect(() =>
      parseGitOrigin('https://token@gitlab.com/org/repo.git'),
    ).toThrow(/Unsupported git host/);
  });

  it('rejects non-GitHub SSH host with E3', () => {
    expect(() => parseGitOrigin('git@gitlab.com:org/repo.git')).toThrow(
      /Unsupported git host/,
    );
  });

  it('rejects non-GitHub HTTPS host with E3', () => {
    expect(() => parseGitOrigin('https://gitlab.com/org/repo.git')).toThrow(
      /Unsupported git host/,
    );
  });

  it('rejects unparseable URL with E3', () => {
    expect(() => parseGitOrigin('not-a-valid-url')).toThrow(
      /Cannot parse git origin URL/,
    );
  });

  it('rejects SSH URL missing owner/repo separator with E3', () => {
    expect(() => parseGitOrigin('git@github.com:only-one-part')).toThrow(
      /Cannot parse owner\/repo/,
    );
  });

  it('rejects HTTPS URL missing owner/repo separator with E3', () => {
    expect(() => parseGitOrigin('https://github.com/only-one-part')).toThrow(
      /Cannot parse owner\/repo/,
    );
  });
});

describe('fetch-wasm authHeaders token resolution', () => {
  const saved = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
  };

  afterEach(() => {
    // Restore the original env so tests stay isolated (Fail Fast / no bleed).
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('uses GITHUB_TOKEN when set', () => {
    process.env.GITHUB_TOKEN = 'gh-token-primary';
    delete process.env.GH_TOKEN;
    expect(authHeaders()).toEqual({ Authorization: 'Bearer gh-token-primary' });
  });

  // Regression: the official `gh` CLI and many CI systems set GH_TOKEN, not
  // GITHUB_TOKEN. authHeaders() must fall back to it before shelling out to
  // `gh auth token` (which can fail on PATH differences in bun/pnpm subprocs).
  it('falls back to GH_TOKEN when GITHUB_TOKEN is unset', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = 'gh-token-secondary';
    expect(authHeaders()).toEqual({ Authorization: 'Bearer gh-token-secondary' });
  });

  it('prefers GITHUB_TOKEN over GH_TOKEN when both are set', () => {
    process.env.GITHUB_TOKEN = 'primary';
    process.env.GH_TOKEN = 'secondary';
    expect(authHeaders()).toEqual({ Authorization: 'Bearer primary' });
  });
});

describe('fetch-wasm structured errors (E1-E5)', () => {
  it('E1 network error has distinct code and hint with emcc fallback guidance', () => {
    const err = Object.assign(new Error('fetch failed'), {
      code: ERROR_CODES.E1_NETWORK,
      hint: 'Network unavailable. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile WASM locally via Emscripten.',
    });
    expect(err.code).toBe('E1_NETWORK');
    expect(err.hint).toMatch(/build:wasm|emcc/i);
    expect(err.hint).not.toBe(err.message);
  });

  it('E2 404 (no matching asset) has distinct code and hint with emcc guidance', () => {
    const err = Object.assign(new Error('No release asset matching fbx-wasm-v0.23.0-abcdef01.wasm'), {
      code: ERROR_CODES.E2_ASSET_NOT_FOUND,
      hint: 'No pre-built WASM found for this bridge.c content. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally via Emscripten, or push to main to trigger a CI release.',
    });
    expect(err.code).toBe('E2_ASSET_NOT_FOUND');
    expect(err.hint).toMatch(/build:wasm|emcc|CI release/i);
  });

  it('E3 unsupported host has structured code with remote-check guidance', () => {
    const err = Object.assign(new Error('Unsupported git host: gitlab.com'), {
      code: ERROR_CODES.E3_ORIGIN_UNSUPPORTED_HOST,
      hint: 'fetch-wasm only supports GitHub remotes. Check `git remote -v`.',
    });
    expect(err.code).toBe('E3_ORIGIN_UNSUPPORTED_HOST');
    expect(err.hint).toMatch(/git remote/);
  });

  it('E3 parse failure has structured code with format guidance', () => {
    const err = Object.assign(new Error('Cannot parse git origin URL'), {
      code: ERROR_CODES.E3_ORIGIN_PARSE_FAILED,
      hint: 'Expected SSH (git@github.com:OWNER/REPO.git) or HTTPS (https://github.com/OWNER/REPO.git) format.',
    });
    expect(err.code).toBe('E3_ORIGIN_PARSE_FAILED');
    expect(err.hint).toMatch(/SSH|HTTPS/);
  });

  it('E3 no origin remote has structured code', () => {
    const err = Object.assign(new Error('No git remote "origin" configured'), {
      code: ERROR_CODES.E3_NO_ORIGIN,
      hint: 'This repository has no "origin" remote. Set one with `git remote add origin <url>` or build locally with `pnpm -F @forgeax/engine-fbx build:wasm`.',
    });
    expect(err.code).toBe('E3_NO_ORIGIN');
    expect(err.hint).toMatch(/git remote add|build:wasm/);
  });

  it('E4 hash mismatch does not reuse old artifact', () => {
    // E4 means bridge.c SHA changed after local modification but release
    // wasn't published yet — the 404 should surface as E4, not silently
    // fall back to an old asset with a different hash.
    const err = Object.assign(
      new Error('WASM asset not found for current bridge.c (SHA: deadbeef). The release may not yet be published for this content.'),
      {
        code: ERROR_CODES.E4_HASH_MISMATCH,
        hint: 'bridge.c has uncommitted changes or the release for this content has not been published. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally.',
      },
    );
    expect(err.code).toBe('E4_HASH_MISMATCH');
    expect(err.hint).toMatch(/build:wasm/);
    // It must NOT suggest checking an old hash or reusing a different asset
    expect(err.hint).not.toMatch(/reuse|old|previous/);
  });

  it('E5 auth failed has distinct code with token guidance', () => {
    const err = Object.assign(new Error('Authentication failed (401)'), {
      code: ERROR_CODES.E5_AUTH_FAILED,
      hint: 'This repository is private and requires authentication. Set GITHUB_TOKEN, run `gh auth login`, or run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally.',
    });
    expect(err.code).toBe('E5_AUTH_FAILED');
    expect(err.hint).toMatch(/GITHUB_TOKEN|build:wasm|gh auth login/);
  });

  it('all error codes are distinct and non-overlapping', () => {
    const codes = Object.values(ERROR_CODES);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

describe('fetch-wasm content-keyed asset naming', () => {
  it('content SHA256 compute is deterministic', async () => {
    const sha1 = await computeContentSha256();
    const sha2 = await computeContentSha256();
    expect(sha1).toBe(sha2);
    expect(sha1.length).toBe(64);
  });

  it('content SHA8 is first 8 hex chars of SHA256', async () => {
    const sha8 = await contentSha8();
    expect(sha8.length).toBe(8);
    expect(/^[0-9a-f]{8}$/.test(sha8)).toBe(true);
  });

  it('asset name embeds ufbx version, content SHA8, and is a tarball', () => {
    const name = buildAssetName('abcdef01');
    expect(name).toBe('fbx-wasm-v0.23.0-abcdef01.tar.gz');
  });

  it('different content produces different asset name', () => {
    const a = buildAssetName('aaaaaaaa');
    const b = buildAssetName('bbbbbbbb');
    expect(a).not.toBe(b);
  });

  it('asset name is stable for same SHA8', () => {
    const a1 = buildAssetName('13b5efa2');
    const a2 = buildAssetName('13b5efa2');
    expect(a1).toBe(a2);
  });
});