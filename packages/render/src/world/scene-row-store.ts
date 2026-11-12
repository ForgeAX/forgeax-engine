import type { SceneComposition, SceneStage } from '../scene/scene-composition';

/** One row-step consumer's position in the {@link RenderSceneRowStore} journal. */
export interface RowStepCursor {
  position: number;
}

/**
 * The composition's row store as one Render World resource: the shared rows,
 * material bindings and batch topology (`SceneStage.entry`) plus the journal
 * of their applied steps. `render-scene` appends each applied step; every
 * RenderPrepare row system holds its own cursor and consumes each step once,
 * in schedule order. The frame's one adoption failure gates every later
 * consumer; a cursor that skipped a step can no longer patch its derived
 * state, so the composition is dropped and re-derived in full from its
 * sources next frame.
 */
export class RenderSceneRowStore {
  private head: SceneStage | undefined;
  private position = 0;

  constructor(readonly composition: SceneComposition) {}

  /** A consumer that observes only the steps appended after now. */
  cursor(): RowStepCursor {
    return { position: this.position };
  }

  /** `render-scene`: append the frame's applied step; `undefined` applied nothing. */
  append(step: SceneStage | undefined): void {
    this.head = undefined;
    if (step === undefined) return;
    this.head = step;
    this.position += 1;
  }

  /**
   * The step `cursor` has not consumed, advancing it. `undefined` when the
   * consumer is current or the frame already failed. Throws after dropping
   * the composition when the consumer missed a step.
   */
  next(cursor: RowStepCursor, adoption: { readonly failure: unknown }): SceneStage | undefined {
    const behind = this.position - cursor.position;
    if (behind === 0) return undefined;
    cursor.position = this.position;
    if (adoption.failure !== undefined) return undefined;
    if (behind === 1 && this.head !== undefined) return this.head;
    this.composition.invalidate();
    throw new Error(
      'A scene row consumer missed an applied step; the composition re-derives from its sources',
    );
  }
}
