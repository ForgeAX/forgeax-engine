import { type MeshSourceStage, StagedMeshSourceError } from '../scene/staged-mesh-source';
import { isObsoleteSourceViewFailure, type SourceViewPreparation } from './source-view-preparation';

/** Advance the same scene and View owners used by local Levels at an idle render turn. */
export class PublishedLevelPreparation {
  private view: SourceViewPreparation | undefined;
  private stopping = false;
  private complete = false;

  constructor(
    private readonly source: MeshSourceStage,
    private readonly prepareViews: (source: MeshSourceStage) => SourceViewPreparation,
  ) {}

  step(): boolean | Promise<void> {
    if (this.complete) {
      if (this.isCurrent()) return true;
      if (!this.source.isCurrent()) throw new StagedMeshSourceError({ reason: 'source' });
      return this.releaseView() ?? false;
    }
    const state = this.source.step().unwrap();
    if (state.phase !== 'resident-input') return state.pending ?? false;
    if (this.source.hasRasterRows) return this.advanceView();
    this.complete = true;
    return true;
  }

  private advanceView(): boolean | Promise<void> {
    this.view ??= this.prepareViews(this.source);
    const view = this.view;
    try {
      const next = view.next();
      if (!next.done) return next.value ?? false;
    } catch (cause) {
      if (isObsoleteSourceViewFailure(view, cause)) return this.releaseView() ?? false;
      throw cause;
    }
    if (view.isCurrent()) {
      this.complete = true;
      return true;
    }
    if (view.isObsolete()) return this.releaseView() ?? false;
    throw new StagedMeshSourceError({ reason: 'source' });
  }

  private releaseView(): Promise<void> | undefined {
    this.complete = false;
    const view = this.view;
    return view?.retire().then((result) => {
      result.unwrap();
      this.view = undefined;
    });
  }

  isCurrent(): boolean {
    return (
      this.complete &&
      this.source.isCurrent() &&
      (!this.source.hasRasterRows || this.view?.isCurrent() === true)
    );
  }

  select(active: boolean): () => void {
    if (active && !this.complete) throw new StagedMeshSourceError({ reason: 'source' });
    if (active && this.source.hasRasterRows && !this.view?.isCurrent())
      throw new StagedMeshSourceError({ reason: 'view-obsolete' });
    const previous = this.source.isActive();
    this.source.setActive(active).unwrap();
    return () => this.source.setActive(previous).unwrap();
  }

  retireStep(): boolean | Promise<void> {
    this.complete = false;
    if (!this.stopping) {
      this.source.setActive(false).unwrap();
      this.stopping = true;
    }
    const view = this.releaseView();
    if (view !== undefined) return view;
    const state = this.source.retireStep().unwrap();
    return state.phase === 'retired' ? true : (state.pending ?? false);
  }
}
