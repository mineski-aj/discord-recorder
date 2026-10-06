// Builds env.live1, env.live2, ... from recorders.csv (columns: Bot Name, channel_id, bot_token, App ID, invited to server?).
// Bots are split by CSV position, 10 per file: rows 1-10 -> env.live1, 11-20 -> env.live2, and so on.
// Rows with no channel_id, or not invited to the server, are skipped (their slot stays empty).
// Usage: node build-env.js [SERVER_ID]   (defaults to GUILD_ID already in env.live1 / env.live)
// Other settings (ANNOUNCE, OUTPUT_FORMAT, ...) are kept from the existing env.live1 / env.live.
const fs = require('fs');

const PER_ENV = 10;
const INSTANCES = 4;
const envFile = (n) => `env.live${n}`;
const existing = {};
const base = [envFile(1), 'env.live'].find((f) => fs.existsSync(f));
if (base) {
  for (const l of fs.readFileSync(base, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) existing[m[1]] = m[2];
  }
}

const guildId = (process.argv[2] || existing.GUILD_ID || '').trim();
if (!/^\d{17,20}$/.test(guildId)) {
  console.error('Usage: node build-env.js SERVER_ID   (server ID is 17-20 digits; not found in env.live1 / env.live)');
  process.exit(1);
}

const lines = fs.readFileSync('recorders.csv', 'utf8').split(/\r?\n/).filter((l) => l.trim());
const header = lines.shift().split(',').map((s) => s.trim().toLowerCase());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`recorders.csv is missing a "${name}" column`);
  return i;
};
const iName = col('bot name');
const iChannel = col('channel_id');
const iToken = col('bot_token');
const iInvited = col('invited to server?');

const rows = [];
const noChannel = [];
lines.forEach((l, n) => {
  const c = l.split(',').map((s) => s.trim());
  const group = Math.floor(n / PER_ENV) + 1;
  if (!c[iName] && !c[iToken]) return; // empty placeholder row
  const name = c[iName] || `row ${n + 1}`;
  if (!c[iChannel]) return noChannel.push(name);
  if (!/^yes$/i.test(c[iInvited] || '')) return console.log(`skip ${name}: not invited to server`);
  if (!/^\d{17,20}$/.test(c[iChannel])) throw new Error(`${name}: "${c[iChannel]}" is not a channel ID`);
  if (!c[iToken] || c[iToken].length < 50) throw new Error(`${name}: token missing or too short`);
  rows.push({ group, name, channel: c[iChannel], token: c[iToken] });
});

if (noChannel.length) console.log(`skipped ${noChannel.length} bots with no channel_id`);

const dup = (key) => rows.map((r) => r[key]).filter((v, i, a) => a.indexOf(v) !== i);
if (dup('channel').length) throw new Error(`Duplicate channel IDs: ${dup('channel').join(', ')}`);
if (dup('token').length) throw new Error('The same bot token is used twice; each channel needs its own bot.');
if (rows.length === 0) throw new Error('No usable rows in recorders.csv (need channel_id filled and invited = yes)');

const managed = new Set(['GUILD_ID', 'CHANNEL_IDS', 'BOT_TOKENS', 'BOT_NICKNAME']); // BOT_NICKNAME is no longer used
const defaults = { ANNOUNCE: 'true', OUTPUT_FORMAT: 'mp3' };
const rest = { ...defaults, ...Object.fromEntries(Object.entries(existing).filter(([k]) => !managed.has(k))) };

const groups = new Set(rows.map((r) => r.group));
if ([...groups].some((g) => g > INSTANCES)) throw new Error(`Rows beyond #${PER_ENV * INSTANCES} have a channel_id, but only ${INSTANCES} env files are supported`);

for (let g = 1; g <= INSTANCES; g++) {
  const mine = rows.filter((r) => r.group === g);
  const file = envFile(g);
  if (mine.length === 0) {
    if (fs.existsSync(file)) { fs.unlinkSync(file); console.log(`${file}: no bots, removed stale file`); }
    else console.log(`${file}: no bots, not written`);
    continue;
  }
  fs.writeFileSync(file, [
    `# Built from recorders.csv (rows ${(g - 1) * PER_ENV + 1}-${g * PER_ENV}): ${mine.map((r) => r.name).join(', ')}`,
    `GUILD_ID=${guildId}`,
    `CHANNEL_IDS=${mine.map((r) => r.channel).join(',')}`,
    `BOT_TOKENS=${mine.map((r) => r.token).join(',')}`,
    ...Object.entries(rest).map(([k, v]) => `${k}=${v}`),
    '',
  ].join('\n'));
  console.log(`${file} written: ${mine.length} channels.`);
}
