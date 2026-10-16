export interface EvidenceImportMetaEnv {
  readonly VITE_FORGEAX_COMMIT?: string;
  readonly VITE_GITHUB_SHA?: string;
}

const viteEnv = (import.meta as ImportMeta & { readonly env?: EvidenceImportMetaEnv }).env;

export function resolveEvidenceCommitIdentity(
  env: EvidenceImportMetaEnv | undefined = viteEnv,
): string {
  const commit = env?.VITE_FORGEAX_COMMIT ?? env?.VITE_GITHUB_SHA;
  return typeof commit === 'string' && commit.trim().length > 0 ? commit : 'working-tree';
}
