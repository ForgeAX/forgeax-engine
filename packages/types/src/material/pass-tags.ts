import type { MaterialPass } from './asset.js';

/** Pass tags are the explicit domain authority. Names never imply a domain. */
export function materialPassTags(
  pass: Pick<MaterialPass, 'renderState'>,
): Readonly<Record<string, string>> {
  const tags = pass.renderState?.tags;
  if (tags === undefined) return EMPTY_TAGS;
  if (
    tags === null ||
    typeof tags !== 'object' ||
    Array.isArray(tags) ||
    !Object.values(tags).every((value) => typeof value === 'string')
  ) {
    throw new TypeError('Material pass renderState.tags must contain only string values');
  }
  return tags as Readonly<Record<string, string>>;
}

export function materialPassLightMode(pass: Pick<MaterialPass, 'renderState'>): string | undefined {
  return materialPassTags(pass).LightMode;
}

const EMPTY_TAGS: Readonly<Record<string, string>> = Object.freeze({});
