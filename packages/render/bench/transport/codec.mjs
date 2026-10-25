// The only protocol-specific part of the transport bench: how one accepted
// publication becomes a Worker message and how the receiver returns storage.
import { serialize } from 'node:v8';
import { renderPublicationAssetTransfers, renderPublicationBytes, renderPublicationTransfers } from '@forgeax/engine-render';

export const PROTOCOL = 'record-v4';

/** Message, transfer list and logical/transferred byte counts. */
export function publicationMessage(candidate, envelope) {
  const publication = candidate.message;
  const transfers = [...renderPublicationTransfers(publication), ...renderPublicationAssetTransfers(publication)];
  const transferred = transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  return { message: { kind: 'draw', ...envelope, publication }, transfers,
    bytes: { columnBytes: renderPublicationBytes(publication).columns, transferredBytes: transferred, transferCount: transfers.length } };
}

/** Serialized size of the message without its transferred record (the structured-clone part). */
export function structuredBytes(message) {
  const p = message.publication;
  const top = {};
  for (const [key, value] of Object.entries(p.side ?? {})) top[key] = serialize(value ?? null).byteLength;
  const metadata = {};
  for (const [key, value] of Object.entries(p.side?.metadata ?? {})) metadata[key] = serialize(value ?? null).byteLength;
  return { total: serialize({ ...message, publication: { ...p, record: new ArrayBuffer(0) } }).byteLength, top, metadata };
}

export const receivedPublication = (message) => message.publication;
export const returnedStorage = (message) => renderPublicationTransfers(message.publication);
