const opaqueResourceIdentities = new WeakMap<object, number>();
let nextOpaqueResourceIdentity = 1;

/** Stable detached identity for a renderer-owned opaque resource handle. */
export function getOpaqueResourceIdentity(resource: object): number {
  const existing = opaqueResourceIdentities.get(resource);
  if (existing !== undefined) return existing;
  const identity = nextOpaqueResourceIdentity++;
  opaqueResourceIdentities.set(resource, identity);
  return identity;
}
