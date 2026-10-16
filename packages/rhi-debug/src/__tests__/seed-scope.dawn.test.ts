import { it } from 'vitest';
import { verifySeedScope } from './seed-scope.fixture';

it('omits initial bytes of resources above the capture seed scope', verifySeedScope);
