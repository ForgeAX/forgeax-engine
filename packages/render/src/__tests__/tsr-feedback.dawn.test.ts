import { describe } from 'vitest';
import { registerTsrFeedbackCases } from './tsr-feedback-cases.fixture';

registerTsrFeedbackCases();

describe('raster TSR', () => registerTsrFeedbackCases(undefined, 'raster'));
