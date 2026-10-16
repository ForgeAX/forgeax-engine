export interface MaterialSourceProvider {
  readonly read: (path: string) => Promise<string>;
}

export function createMaterialSourceProvider(
  read: (path: string) => Promise<string>,
): MaterialSourceProvider {
  return { read };
}
