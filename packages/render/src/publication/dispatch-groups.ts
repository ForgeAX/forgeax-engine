import type { DispatchEntry, ExtractedFrame } from '../render-system-extract';

interface PublicationDispatchGroups {
  readonly groups: readonly (readonly DispatchEntry[])[];
}

const publications = new WeakMap<readonly DispatchEntry[], PublicationDispatchGroups>();
const arrayIterator = Array.prototype[Symbol.iterator];

/** Finish only the receiver's newly detached readonly dispatch projection. */
export function retainPublicationDispatchGroups(
  dispatch: readonly DispatchEntry[],
  groups: readonly (readonly DispatchEntry[])[],
): void {
  for (const entry of dispatch) Object.freeze(entry);
  Object.freeze(dispatch);
  publications.set(dispatch, { groups });
}

/** Borrowed arrays or changed membership keep the original observation path. */
export function publicationDispatchGroups(
  frame: Pick<ExtractedFrame, 'dispatch'>,
): readonly (readonly DispatchEntry[])[] | undefined {
  const dispatch = frame.dispatch;
  const published = publications.get(dispatch);
  if (
    published === undefined ||
    Object.getPrototypeOf(dispatch) !== Array.prototype ||
    Object.hasOwn(dispatch, Symbol.iterator) ||
    Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)?.value !== arrayIterator
  )
    return undefined;
  return published.groups;
}
