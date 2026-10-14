#!/usr/bin/env node
// Generate an API token for an agent.
// Usage: node scripts/gen-token.mjs <codex|claude>
// Output includes the secret token for a local config file and its SHA-256 entry for KANBAN_API_TOKENS.
// Do not commit or share the plaintext token.
import crypto from 'node:crypto';

const actor = process.argv[2];
if (!['codex', 'claude'].includes(actor)) {
  console.error('Usage: node scripts/gen-token.mjs <codex|claude>');
  process.exit(1);
}
const plain = `kbt_${crypto.randomBytes(24).toString('base64url')}`;
const hash = crypto.createHash('sha256').update(plain).digest('hex');
console.log(`actor        : ${actor}`);
console.log(`Plaintext token: ${plain} (save in ~/.config/agent-kanban/config.json under tokens.${actor})`);
console.log(`KANBAN_API_TOKENS entry: ${actor}:${hash}`);
