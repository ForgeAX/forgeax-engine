/** Card geometry, owner/state, and the two in-place directory/link words. */
export const CARD_LOOKUP_PROJECTION_BYTES = 80;
export const CARD_OWNER_EMPTY = 0xffffffff;

/** Uses the directory already stored in Card.ids.z; no atlas-order assumption. */
export const CARD_OWNER_LOOKUP_WGSL = `
fn firstOwnerCard(instanceId: u32, count: u32) -> u32 {
 var lo=0u;var hi=count;
 while(lo<hi){
  let mid=lo+(hi-lo)/2u;let head=cards[mid].ids.z;
  if(head==0u){hi=mid;continue;}
  if(head>count){return 0u;}
  if(cards[head-1u].ids.x<instanceId){lo=mid+1u;}else{hi=mid;}
 }
 if(lo>=count){return 0u;}
 let head=cards[lo].ids.z;
 if(head==0u||head>count){return 0u;}
 return select(0u,head,cards[head-1u].ids.x==instanceId&&instanceId!=0xffffffffu);
}
`;

/**
 * Keeps physical atlas tiles unchanged. ids.z contains the owner-sorted head
 * directory (one-based tile, zero suffix); ids.w links that owner's tiles in
 * physical order. State is deliberately irrelevant: stale/pending rows belong
 * to their owner until that owner explicitly frees the slot with ids.x = -1u.
 */
export function rebuildCardOwnerIndex(bytes: Uint8Array, cardCount: number): void {
  if (
    bytes.byteLength % CARD_LOOKUP_PROJECTION_BYTES !== 0 ||
    !Number.isInteger(cardCount) ||
    cardCount < 0 ||
    cardCount > bytes.byteLength / CARD_LOOKUP_PROJECTION_BYTES ||
    cardCount > CARD_OWNER_EMPTY
  )
    throw new Error('Card owner index requires complete rows and an admitted tile count');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const owners = new Map<number, { first: number; last: number }>();
  for (let tile = 0; tile < bytes.byteLength / CARD_LOOKUP_PROJECTION_BYTES; tile++) {
    const row = tile * CARD_LOOKUP_PROJECTION_BYTES;
    view.setUint32(row + 72, 0, true);
    view.setUint32(row + 76, 0, true);
    if (tile >= cardCount) continue;
    const owner = view.getUint32(row + 64, true);
    if (owner === CARD_OWNER_EMPTY) continue;
    const prior = owners.get(owner);
    if (prior === undefined) owners.set(owner, { first: tile, last: tile });
    else {
      view.setUint32(prior.last * CARD_LOOKUP_PROJECTION_BYTES + 76, tile + 1, true);
      prior.last = tile;
    }
  }
  const sorted = [...owners].sort(([a], [b]) => a - b);
  for (let rank = 0; rank < sorted.length; rank++)
    view.setUint32(
      rank * CARD_LOOKUP_PROJECTION_BYTES + 72,
      (sorted[rank]?.[1].first ?? 0) + 1,
      true,
    );
}

/** Geometry/state edits preserve the resident table's directory and chain. */
export function updateCardProjectionRows(image: Uint8Array, first: number, rows: Uint8Array): void {
  const offset = first * CARD_LOOKUP_PROJECTION_BYTES;
  if (
    image.byteLength % CARD_LOOKUP_PROJECTION_BYTES !== 0 ||
    !Number.isSafeInteger(first) ||
    first < 0 ||
    rows.byteLength % CARD_LOOKUP_PROJECTION_BYTES !== 0 ||
    offset + rows.byteLength > image.byteLength
  )
    throw new Error('Card projection write must name complete owned slots');
  for (let row = 0; row < rows.byteLength; row += CARD_LOOKUP_PROJECTION_BYTES)
    rows.set(image.subarray(offset + row + 72, offset + row + 80), row + 72);
  image.set(rows, offset);
}
