#!/usr/bin/env node
// Print the Codex hook trust setting for matching hooks without writing a file.
// Usage: node scripts/hooks/print-codex-hook-trust.mjs [~/.codex/hooks.json]
// Codex requires trusted hook definitions to run hooks from hooks.json.
// trusted_hash is SHA-256 of compact JSON with sorted keys. The default timeout is 600 and async defaults to false.
// The setting key format is [hooks.state."<hooks.json path>:<event>:<group index>:<handler index>"].
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.resolve(process.argv[2] || path.join(os.homedir(), '.codex', 'hooks.json'));
const snake = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
let n = 0;
for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
  groups.forEach((g, gi) => {
    g.hooks.forEach((h, hi) => {
      if (h.type !== 'command' || !/kanban-inbox-hook/.test(h.command)) return;
      const handler = { async: h.async ?? false, command: h.command, timeout: h.timeout ?? 600, type: 'command' };
      const identity = { event_name: snake(event), hooks: [handler] };
      if (g.matcher != null) identity.matcher = g.matcher;
      const hash = crypto.createHash('sha256').update(JSON.stringify(sortKeys(identity))).digest('hex');
      console.log(`[hooks.state."${file}:${snake(event)}:${gi}:${hi}"]\ntrusted_hash = "sha256:${hash}"\n`);
      n++;
    });
  });
}
if (!n) console.error(`No kanban-inbox-hook entries found in ${file}`);
