import { captureGame3dHeap } from './capture_game3d_retained.mjs';
/** Public project-play adapter; real Worker counters, GC controls and live movement. */
export default async function captureGame3dCounts(play) {
  return captureGame3dHeap(play, true);
}
