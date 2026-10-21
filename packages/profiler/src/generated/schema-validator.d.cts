import type { ValidateFunction } from 'ajv';
import type { ProfileCapture } from './profile-capture.js';

declare const validate: ValidateFunction<ProfileCapture>;
export = validate;
