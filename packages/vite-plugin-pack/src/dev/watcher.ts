export type {
  DevWatcherOptions,
  DevWatchFactory,
  DevWatchListener,
  RevisionObserver,
  RevisionObserverOptions,
  WatchBatch,
  WatchedChange,
} from './revision-observer.js';
export {
  classifyWatchedPath,
  createRevisionObserver,
  watchDevRoots,
} from './revision-observer.js';
