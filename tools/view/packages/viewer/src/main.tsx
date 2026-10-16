import { mountViewApplication } from './application';
import { createBrowserFrontendPlatform } from '@forgeax/engine-host/platform';

mountViewApplication(createBrowserFrontendPlatform());
