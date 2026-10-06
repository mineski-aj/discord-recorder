// Builds .env.a ... .env.d from recorders.csv (one "channel_id,bot_token" per row).
// Usage: node build-env.js YOUR_SERVER_ID
const fs = require('fs');

const guildId = (process.argv[2] || '').trim();
if (!/^\d{17,20}$/.test(guildId)) {
  console.error('Usage: node build-env.js YOUR_SERVER_ID   (server ID is 17-20 digits)');
  process.exit(1);
}

const rows = fs.readFileSync('recorders.csv', 'utf8')
  .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  .filter((l) => !/^channel_id/i.test(l))
  .map((l, i) => {
    const [channel, token] = l.split(',').map((s) => (s || '').trim());
    if (!/^\d{17,20}$/.test(channel)) throw new Error(`Row ${i + 1}: "${channel}" is not a channel ID`);
    if (!token || token.length < 50) throw new Error(`Row ${i + 1}: token missing or too short`);
    return { channel, token };
  });

const dup = (key) => rows.map((r) => r[key]).filter((v, i, a) => a.indexOf(v) !== i);
if (dup('channel').length) throw new Error(`Duplicate channel IDs: ${dup('channel').join(', ')}`);
if (dup('token').length) throw new Error('The same bot token is used twice; each channel needs its own bot.');
if (rows.length === 0) throw new Error('recorders.csv has no rows');

const groups = ['a', 'b', 'c', 'd'];
const size = Math.ceil(rows.length / groups.length);
groups.forEach((g, gi) => {
  const part = rows.slice(gi * size, (gi + 1) * size);
  if (part.length === 0) return;
  fs.writeFileSync(`.env.${g}`, [
    `GUILD_ID=${guildId}`,
    `CHANNEL_IDS=${part.map((r) => r.channel).join(',')}`,
    `BOT_TOKENS=${part.map((r) => r.token).join(',')}`,
    'ANNOUNCE=true',
    'BOT_NICKNAME=🔴 Recording',
    'OUTPUT_FORMAT=mp3',
    '',
  ].join('\n'));
  console.log(`.env.${g}: ${part.length} channels`);
});
console.log(`Done: ${rows.length} channels total.`);
