#!/usr/bin/env node
// Generate KANBAN_PASSWORD_HASH (scrypt$N$r$p$saltHex$hashHex).
// Usage:
//   node scripts/hash-password.mjs              # Prompt without echoing the password.
//   node scripts/hash-password.mjs '<password>' # Pass directly; the value may enter shell history.
// Set KANBAN_PASSWORD_HASH in the environment. Quote the value so Compose does not expand '$'.
import crypto from 'node:crypto';
import readline from 'node:readline';

const N = 16384, r = 8, p = 1;

function hash(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(password, salt, 32, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${h.toString('hex')}`;
}

async function promptHidden(label) {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) { rl.close(); return line; }
    return '';
  }
  process.stderr.write(label);
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(buf);
        }
        if (c === '\u0003') { process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    process.stdin.on('data', onData);
  });
}

let pw = process.argv[2];
if (pw === undefined) {
  pw = await promptHidden('New password: ');
  if (process.stdin.isTTY) {
    const again = await promptHidden('Enter again: ');
    if (again !== pw) { console.error('The entries do not match.'); process.exit(1); }
  }
}
if (!pw || pw.length < 8) { console.error('Password must contain at least 8 characters.'); process.exit(1); }
console.log(hash(pw));
