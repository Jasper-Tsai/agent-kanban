import { serve } from '@hono/node-server';
import { assertConfig, loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { listBackups, runBackup, startBackupScheduler } from './backup.ts';

const config = loadConfig();
assertConfig(config);
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const handle = createApp({ config, log });
if (listBackups(config.backupsDir).length === 0) {
  try {
    runBackup(handle.db, config.backupsDir, new Date(), undefined, config.timezone);
    log('[backup] Created initial backup on first startup');
  } catch (e) {
    log(`[backup] Initial backup failed: ${(e as Error).message}`);
  }
}
const stopBackup = startBackupScheduler(handle.db, config.backupsDir, log, config.timezone);

const server = serve({ fetch: handle.app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  log(`agent-kanban ${config.version} listening on :${info.port}`);
});

function shutdown(sig: string) {
  log(`${sig} received, shutting down`);
  stopBackup();
  server.close(() => {
    handle.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
