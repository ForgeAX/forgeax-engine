/**
 * Derive the semantic identity for an image producer output.
 *
 * The role is the producer-owned identity. Source path and sourceIndex are
 * locators only and must not be folded into this key.
 */
export interface ImageSourceKeyLocator {
  readonly sourcePath?: string;
  readonly sourceIndex?: number;
}

export function deriveImageSourceKey(
  role: string,
  _locator?: ImageSourceKeyLocator,
): string | undefined {
  const normalizedRole = role.trim();
  if (normalizedRole.length === 0) return undefined;
  return `image:${normalizedRole}`;
}
