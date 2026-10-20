// Manage who can sign in to Operation Macro.
//   node scripts/invite.mjs add someone@example.com      -> prints a new invite code (replaces any old one)
//   node scripts/invite.mjs remove someone@example.com   -> they're locked out next time the app opens online
//   node scripts/invite.mjs check someone@example.com    -> is this email invited?
// invites.json only stores one-way fingerprints, never emails or codes, because the repo is public.
// Must match the settings in app.js (INVITE_ITER, salts).
import { pbkdf2Sync, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = process.env.INVITES_FILE || new URL('../invites.json', import.meta.url);
const ITER = 200000;
const normEmail = e => String(e || '').trim().toLowerCase();
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hex = (secret, salt) => pbkdf2Sync(secret, salt, ITER, 32, 'sha256').toString('hex');
const idOf = email => hex(normEmail(email), 'opmacro-id').slice(0, 16);
const hashOf = (email, code) => hex(normCode(code), 'opmacro:' + normEmail(email));

// No 0/O, 1/I/L: easy to read off a text message.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('').replace(/^(.{4})/, '$1-');

const [cmd, email] = process.argv.slice(2);
if (!['add', 'remove', 'check'].includes(cmd) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail(email))) {
  console.error('Usage: node scripts/invite.mjs add|remove|check someone@example.com');
  process.exit(1);
}
const data = JSON.parse(readFileSync(FILE, 'utf8'));
const id = idOf(email);
const others = data.invites.filter(i => i.id !== id);
if (cmd === 'check') {
  console.log(others.length < data.invites.length ? `${normEmail(email)} is invited.` : `${normEmail(email)} is NOT invited.`);
} else if (cmd === 'remove') {
  if (others.length === data.invites.length) { console.log(`${normEmail(email)} wasn't invited.`); process.exit(0); }
  data.invites = others;
  writeFileSync(FILE, JSON.stringify(data, null, 1) + '\n');
  console.log(`Removed ${normEmail(email)}.`);
} else {
  const code = newCode();
  data.invites = [...others, { id, h: hashOf(email, code), added: new Date().toISOString().slice(0, 10) }];
  writeFileSync(FILE, JSON.stringify(data, null, 1) + '\n');
  console.log(`${normEmail(email)} invite code: ${code}`);
}
