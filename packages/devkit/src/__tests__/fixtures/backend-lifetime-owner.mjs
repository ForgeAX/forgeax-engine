import { retainBackendLifetime } from '../../backend-lifetime.ts';

await retainBackendLifetime(process.argv[2]);
process.send('retained');
setInterval(() => {}, 1000);
