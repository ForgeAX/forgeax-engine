import type { ShadowViewIdentity } from '../inspection-types';

/** Frozen identities own their key; borrowed identities are always read live. */
class OwnedShadowViewIdentity implements ShadowViewIdentity {
  readonly kind: ShadowViewIdentity['kind'];
  readonly index: number;
  readonly face?: number;
  readonly layer?: 'static';
  readonly terrainReceiver?: NonNullable<ShadowViewIdentity['terrainReceiver']>;
  readonly #key: string;
  #staticLayer: ShadowViewIdentity | undefined;

  constructor(source: ShadowViewIdentity) {
    const { kind, index, face, layer, terrainReceiver } = source;
    this.kind = kind;
    this.index = index;
    if (face !== undefined) this.face = face;
    if (layer !== undefined) this.layer = layer;
    if (terrainReceiver !== undefined) this.terrainReceiver = Object.freeze({ ...terrainReceiver });
    this.#key = serializeIdentityKey(this);
    Object.freeze(this);
  }

  static capture(identity: ShadowViewIdentity): ShadowViewIdentity {
    return #key in identity ? identity : new OwnedShadowViewIdentity(identity);
  }

  static layer(identity: ShadowViewIdentity): ShadowViewIdentity {
    // Borrowed declarations keep their ordinary property/spread observations.
    if (!(#key in identity)) return { ...identity, layer: 'static' };
    if (identity.layer === 'static') return identity;
    identity.#staticLayer ??= new OwnedShadowViewIdentity({ ...identity, layer: 'static' });
    return identity.#staticLayer;
  }

  static key(identity: ShadowViewIdentity): string | undefined {
    return #key in identity ? identity.#key : undefined;
  }
}

export function shadowViewIdentityKey(identity: ShadowViewIdentity): string {
  return OwnedShadowViewIdentity.key(identity) ?? serializeIdentityKey(identity);
}

function serializeIdentityKey(identity: ShadowViewIdentity): string {
  return `${identity.kind}:${identity.index}:${identity.face ?? ''}${
    identity.layer === undefined ? '' : `:${identity.layer}`
  }${identity.terrainReceiver === undefined ? '' : `:terrain:${identity.terrainReceiver.worldId}:${identity.terrainReceiver.entityKey}`}`;
}

/** Capture a detached logical value at its producer, never a submission capability. */
export function captureShadowViewIdentity(identity: ShadowViewIdentity): ShadowViewIdentity {
  return OwnedShadowViewIdentity.capture(identity);
}

/** The static child shares only immutable logical identity with its final view. */
export function staticShadowViewIdentity(identity: ShadowViewIdentity): ShadowViewIdentity {
  return OwnedShadowViewIdentity.layer(identity);
}

// Directional cascades have a closed four-slot ABI, independent of scene lifetime.
const directional = [0, 1, 2, 3].map((index) =>
  captureShadowViewIdentity({ kind: 'directional', index }),
);

export function directionalShadowViewIdentity(index: number): ShadowViewIdentity {
  return directional[index] ?? captureShadowViewIdentity({ kind: 'directional', index });
}
