#!/usr/bin/env node
// Create a consistent database backup with VACUUM INTO; no sqlite3 CLI is required.
// Usage: node scripts/backup-db.mjs [output-path]
// Default output: data/backups/pre-deploy-<UTC timestamp>.db
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.KANBAN_DATA_DIR || 'data');
const src = path.join(dataDir, 'kanban.db');
if (!fs.existsSync(src)) { console.error(`Database not found: ${src}`); process.exit(2); }
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
const out = path.resolve(process.argv[2] || path.join(dataDir, 'backups', `pre-deploy-${stamp}.db`));
fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) fs.rmSync(out);
const db = new DatabaseSync(src, { readOnly: false });
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(out);
