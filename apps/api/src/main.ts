import { LOGGER_OPTIONS, buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { InstanceLockError, acquireInstanceLock } from './instance-lock.js';

// Loopback only: the panel is exposed exclusively through Tailscale Funnel.
const host = process.env['HOST'] ?? '127.0.0.1';
const port = Number(process.env['PORT'] ?? 3000);

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : 'Invalid configuration');
  process.exit(1);
}

let releaseLock: () => void;
try {
  releaseLock = acquireInstanceLock(config.dataDir);
} catch (error) {
  console.error(
    error instanceof InstanceLockError ? error.message : 'Could not take the instance lock',
  );
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    releaseLock();
    process.exit(0);
  });
}
process.on('exit', releaseLock);

const db = openDatabase(`${config.dataDir}/panel.sqlite`);
const app = buildApp({ config, db }, { logger: LOGGER_OPTIONS });

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
