import { afterAll, beforeAll, describe, it } from 'vitest';
import { type AuthoredShadowJourney, createAuthoredShadowJourney } from './shadow.fixture';

describe.sequential('projects the authored directional shadow and filter', () => {
  let journey: AuthoredShadowJourney;
  beforeAll(() => {
    journey = createAuthoredShadowJourney('directional');
  });
  afterAll(async () => journey.dispose(), 120000);

  it('checks baseline shadow state and camera movement', { timeout: 240000 }, async () => {
    await journey.verifyBaseline();
  });
  it('checks authored directional shadow maps and filters', { timeout: 240000 }, async () => {
    await journey.verifyAuthoredFilters();
  });
  it('checks directional shadow layers and variance controls', { timeout: 240000 }, async () => {
    await journey.verifyLayersAndVariance();
  });
});
