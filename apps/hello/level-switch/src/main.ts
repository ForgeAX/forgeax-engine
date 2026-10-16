// apps/hello/level-switch/src/main.ts -- browser entry (self-call bootstrap).
//
// Imports and self-calls bootstrap from index.ts.

import { bootstrap } from './index.ts';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
if (!canvas) throw new Error('canvas element not found');

void bootstrap(canvas);