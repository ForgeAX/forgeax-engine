import { it } from 'vitest';
import { renderTrimmedFaces } from '../render';

it('renders the trimmed-face sheet', () => {
  renderTrimmedFaces('/tmp/trimface/render');
});
