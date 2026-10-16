import type { Resource } from 'i18next';

/** i18next JSON v4 resources, embedded in the owning UI payload. */
export interface UiLocalization {
  readonly fallbackLng: string;
  readonly defaultNS: string;
  readonly resources: Resource;
}

/** Validate untrusted producer/runtime input before i18next adopts it. */
export function isUiLocalization(value: unknown): value is UiLocalization {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  let entries = 0;
  const tree = (v: unknown, depth: number): boolean => {
    if (++entries > 100_000 || depth > 16) return false;
    if (typeof v === 'string') return true;
    if (!object(v) && !Array.isArray(v)) return false;
    return Object.entries(v).every(
      ([key, child]) =>
        !['__proto__', 'prototype', 'constructor'].includes(key) && tree(child, depth + 1),
    );
  };
  if (
    typeof data.fallbackLng !== 'string' ||
    !data.fallbackLng ||
    typeof data.defaultNS !== 'string' ||
    !data.defaultNS ||
    !object(data.resources)
  )
    return false;
  const fallback = data.resources[data.fallbackLng];
  return (
    object(fallback) &&
    object(fallback[data.defaultNS]) &&
    Object.entries(data.resources).every(
      ([lng, namespaces]) =>
        lng.length > 0 &&
        object(namespaces) &&
        Object.entries(namespaces).every(([ns, bundle]) => ns.length > 0 && object(bundle)),
    ) &&
    tree(data.resources, 0)
  );
}
