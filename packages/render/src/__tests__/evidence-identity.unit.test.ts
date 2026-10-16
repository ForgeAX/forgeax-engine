import { describe, expect, it } from 'vitest';
import { resolveEvidenceCommitIdentity } from './evidence-identity';

describe('evidence commit identity', () => {
  it('prefers the ForgeaX Vite commit injection', () => {
    expect(
      resolveEvidenceCommitIdentity({
        VITE_FORGEAX_COMMIT: 'forgeax-commit',
        VITE_GITHUB_SHA: 'github-commit',
      }),
    ).toBe('forgeax-commit');
  });

  it('accepts the GitHub Vite injection when the ForgeaX value is absent', () => {
    expect(resolveEvidenceCommitIdentity({ VITE_GITHUB_SHA: 'github-commit' })).toBe(
      'github-commit',
    );
  });

  it('uses a stable local identity when no build identity is injected', () => {
    expect(resolveEvidenceCommitIdentity(undefined)).toBe('working-tree');
    expect(resolveEvidenceCommitIdentity({ VITE_FORGEAX_COMMIT: '  ' })).toBe('working-tree');
  });
});
