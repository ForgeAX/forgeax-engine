import { it } from 'vitest';
import { renderSolids } from '../solids.ts';

it('renders the E2 solid gallery', () => {
  const dir = process.env.OFFSET_SOLIDS_OUT ?? '/tmp/offset-solids';
  renderSolids(dir);
}, 120000);
