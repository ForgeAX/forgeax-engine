// @forgeax/engine-input -- exclusive host-owned canvas input boundary.
//
// A physical canvas has one DOM acquisition backend. Hosts with two worlds (for
// example editor + transient Play) route that one producer through these two
// InputBackend views. This is exclusive ownership, deliberately separate from
// synthetic/replay input composition.

import {
  createEmptyInputBackendSample,
  type InputBackend,
  type InputBackendSample,
} from './input-snapshot';
import { isUiOwnedEvent } from './ui-ownership';

export interface CanvasInputBoundary {
  readonly editor: InputBackend;
  readonly game: InputBackend;
  owner(): 'editor' | 'game';
  grantGame(): void;
  revokeGame(): void;
  /** Clear the active consumer when an event originated in the host UI. */
  handleUiEvent(event: Event, host: Node): boolean;
  detach(): void;
}

type CanvasInputOwner = ReturnType<CanvasInputBoundary['owner']>;

export function createCanvasInputBoundary(source: InputBackend): CanvasInputBoundary {
  let active: CanvasInputOwner = 'editor';
  let gamePointerLockAllowed = false;
  let editorInputAllowed = true;
  let gameInputAllowed = true;
  source.setPointerLockAllowed?.(false);

  const empty = (): InputBackendSample => createEmptyInputBackendSample();

  const clear = (): void => {
    source.clear?.();
    source.setPointerLockAllowed?.(false);
  };

  const routed = (consumer: CanvasInputOwner): InputBackend => ({
    sample: () => (consumer === active ? source.sample() : empty()),
    setPointerLockAllowed: (allowed) => {
      if (consumer === 'game') {
        gamePointerLockAllowed = allowed;
        source.setPointerLockAllowed?.(active === 'game' && allowed);
      } else {
        source.setPointerLockAllowed?.(false);
      }
    },
    setInputAllowed: (allowed) => {
      if (consumer === 'game') gameInputAllowed = allowed;
      else editorInputAllowed = allowed;
      source.setInputAllowed?.(active === 'game' ? gameInputAllowed : editorInputAllowed);
    },
    clear: () => {
      if (consumer === active) clear();
    },
    detach: () => source.detach(),
  });

  const grantGame = (): void => {
    if (active === 'game') return;
    clear();
    active = 'game';
    source.setPointerLockAllowed?.(gamePointerLockAllowed);
    source.setInputAllowed?.(gameInputAllowed);
  };

  const revokeGame = (): void => {
    clear();
    active = 'editor';
    source.setInputAllowed?.(editorInputAllowed);
  };

  return {
    editor: routed('editor'),
    game: routed('game'),
    owner: () => active,
    grantGame,
    revokeGame,
    handleUiEvent: (event, host) => {
      if (!isUiOwnedEvent(event, host)) return false;
      clear();
      return true;
    },
    detach: () => source.detach(),
  };
}
