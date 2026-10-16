import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError } from '../errors';
import { EVENT_SEMANTICS, eventKinds } from './event-semantics';
import { type ResourceKind, TAPE_FORMAT_VERSION, type TapeStructure } from './types';

type TapeValidation = ReturnType<typeof createRhiDebugError<'tape-invalid'>>;

/** Structural validation; blob payload bytes are not read, so a streamed index validates too. */
export function validateTape<T extends TapeStructure>(tape: T): Result<T, TapeValidation> {
  if (tape.header.formatVersion !== TAPE_FORMAT_VERSION)
    return err(
      createRhiDebugError('tape-invalid', { stage: 'validate', cause: 'format version is not 7' }),
    );
  if (tape.header.eventCount !== tape.events.length || tape.header.blobCount !== tape.blobs.length)
    return err(
      createRhiDebugError('tape-invalid', {
        stage: 'validate',
        cause: 'header counts do not match payload counts',
      }),
    );
  const declared = new Set<string>();
  for (const resource of tape.bootstrap) {
    if (declared.has(resource.handleId))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `duplicate bootstrap handle ${resource.handleId}`,
        }),
      );
    if (!isResourceKind(resource.kind))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `unknown resource kind ${resource.kind}`,
        }),
      );
    if (
      resource.seed !== undefined &&
      (resource.seed !== 'omitted' || resource.initialData.length > 0)
    )
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `bootstrap ${resource.handleId} seed must be 'omitted' with no initialData`,
        }),
      );
    declared.add(resource.handleId);
  }
  const hashes = new Set<string>();
  for (const blob of tape.blobs) {
    if (hashes.has(blob.hash))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `duplicate blob hash ${blob.hash}`,
        }),
      );
    hashes.add(blob.hash);
  }
  for (let eventIndex = 0; eventIndex < tape.events.length; eventIndex++) {
    const event = tape.events[eventIndex];
    if (!event || !eventKinds.includes(event.kind))
      return err(
        createRhiDebugError('tape-invalid', {
          stage: 'validate',
          cause: `unknown event kind at ${eventIndex}`,
        }),
      );
    const semantics = EVENT_SEMANTICS[event.kind];
    for (const created of semantics.created(event)) {
      if (declared.has(created))
        return err(
          createRhiDebugError('tape-invalid', {
            stage: 'validate',
            cause: `duplicate handle ${created}`,
          }),
        );
      declared.add(created);
    }
    for (const read of semantics.read(event)) {
      if (!declared.has(read))
        return err(
          createRhiDebugError('tape-invalid', {
            stage: 'validate',
            cause: `create-before-use violated for ${read} at ${eventIndex}`,
          }),
        );
    }
    for (const destroyed of semantics.destroyed(event)) {
      if (!declared.has(destroyed))
        return err(
          createRhiDebugError('tape-invalid', {
            stage: 'validate',
            cause: `destroy-before-use violated for ${destroyed} at ${eventIndex}`,
          }),
        );
      declared.delete(destroyed);
    }
  }
  return ok(tape);
}

function isResourceKind(value: string): value is ResourceKind {
  return [
    'buffer',
    'texture',
    'query-set',
    'acceleration-structure',
    'texture-view',
    'sampler',
    'shader-module',
    'pipeline',
    'binding',
    'encoder',
  ].includes(value);
}
