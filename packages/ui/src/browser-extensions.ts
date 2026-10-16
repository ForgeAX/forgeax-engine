/** Explicit browser requirements; these never widen the portable native profile. */
export const UI_BROWSER_EXTENSIONS = ['css', 'backdrop-filter'] as const;
export type UiBrowserExtension = (typeof UI_BROWSER_EXTENSIONS)[number];

export function isUiBrowserExtensions(value: unknown): value is readonly UiBrowserExtension[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => UI_BROWSER_EXTENSIONS.includes(entry)) &&
    new Set(value).size === value.length
  );
}
