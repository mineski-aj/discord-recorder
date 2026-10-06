// Records up to N voice channels in one Discord server at the same time,
// using one bot account per channel. Each speaker gets their own time-aligned
// track, plus a full mix per channel when you stop (Ctrl+C).
// Usage: node record.js [path-to-env-file]   (defaults to .env)
require('dotenv').config({ path: process.argv[2] || '.env' });
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');

// ---------- config ----------
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKENS = list(process.env.BOT_TOKENS);
const CHANNEL_IDS = list(process.env.CHANNEL_IDS);
const GUILD_ID = process.env.GUILD_ID;
const OUTPUT_DIR = process.env.OUTPUT_DIR || './recordings';
const ANNOUNCE = process.env.ANNOUNCE !== 'false';
const NICKNAME = process.env.BOT_NICKNAME || '🔴 Recording';

if (!GUILD_ID || CHANNEL_IDS.length === 0) {
  console.error('Set GUILD_ID and CHANNEL_IDS in .env');
  process.exit(1);
}
if (TOKENS.length < CHANNEL_IDS.length) {
  console.error(`Need one bot token per channel: got ${TOKENS.length} tokens for ${CHANNEL_IDS.length} channels.`);
  process.exit(1);
}

const BYTES_PER_MS = (48000 * 2 * 2) / 1000; // 48 kHz, stereo, 16-bit PCM = 192 bytes/ms
const SILENCE = Buffer.alloc(BYTES_PER_MS * 1000); // 1 s of silence
const SESSION_DIR = path.join(OUTPUT_DIR, new Date().toISOString().replace(/[:.]/g, '-'));

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (s) => (s || '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'unnamed';

// Write with backpressure so long silences never pile up in memory.
function writeAsync(stream, buf) {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) return resolve();
    if (stream.write(buf)) return resolve();
    const done = () => { stream.off('drain', done); stream.off('close', done); resolve(); };
    stream.once('drain', done);
    stream.once('close', done);
  });
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code !== 0) console.error(`ffmpeg failed:\n${err.slice(-1500)}`);
      resolve(code === 0);
    });
  });
}

// ---------- one bot = one channel ----------
class ChannelRecorder {
  constructor(token, channelId) {
    this.token = token;
    this.channelId = channelId;
    this.tracks = new Map(); // userId -> track
  }

  log(msg) { console.log(`[${this.label || this.channelId}] ${msg}`); }

  async start() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    const ready = new Promise((r) => this.client.once(Events.ClientReady, r));
    await this.client.login(this.token);
    await ready;

    this.guild = await this.client.guilds.fetch(GUILD_ID);
    const channel = await this.guild.channels.fetch(this.channelId);
    if (!channel?.isVoiceBased()) throw new Error(`${this.channelId} is not a voice channel`);
    this.label = channel.name;
    this.dir = path.join(SESSION_DIR, `${safeName(channel.name)}_${channel.id}`);
    fs.mkdirSync(this.dir, { recursive: true });

    await this.guild.members.me.setNickname(NICKNAME).catch(() => {});

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      group: this.client.user.id, // required so several bots can share one guild in one process
    });
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);

    this.startTime = Date.now();
    this.connection.receiver.speaking.on('start', (userId) => this.subscribe(userId));
    this.connection.on(VoiceConnectionStatus.Disconnected, () => this.handleDisconnect());

    if (ANNOUNCE) await channel.send('🔴 This voice channel is now being recorded.').catch(() => {});
    this.log(`recording as ${this.client.user.tag}`);
  }

  async handleDisconnect() {
    if (this.stopping) return;
    try {
      await Promise.race([
        entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      this.log('reconnecting...');
    } catch {
      this.log('disconnected, rejoining');
      this.connection.rejoin();
    }
  }

  // One encoder per speaker. Leading silence is added by ffmpeg (adelay),
  // gaps between speech are filled in writeAligned(), so all tracks line up.
  getTrack(userId) {
    let t = this.tracks.get(userId);
    if (t) return t;

    const offsetMs = Date.now() - this.startTime;
    const file = path.join(this.dir, `${userId}.ogg`);
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-af', `adelay=delays=${offsetMs}:all=1`,
      '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', '-y', file,
    ], { stdio: ['pipe', 'ignore', 'inherit'], detached: true, windowsHide: true }); // detached: Ctrl+C won't kill encoders mid-write
    ff.stdin.on('error', (e) => this.log(`encoder error (${userId}): ${e.message}`));

    t = {
      userId, file, ff, offsetMs,
      written: 0,
      chain: Promise.resolve(),
      listening: false,
      done: new Promise((r) => ff.on('close', r)),
    };
    this.tracks.set(userId, t);
    this.client.users.fetch(userId).then((u) => { t.name = u.username; }).catch(() => {});
    return t;
  }

  subscribe(userId) {
    if (this.stopping) return;
    const track = this.getTrack(userId);
    if (track.listening) return;
    track.listening = true;

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    decoder.on('data', (pcm) => {
      const arrived = Date.now();
      track.chain = track.chain.then(() => this.writeAligned(track, pcm, arrived));
    });
    decoder.on('error', (e) => {
      this.log(`decode error (${userId}): ${e.message}`);
      track.listening = false;
      opus.destroy();
    });
    opus.on('error', (e) => this.log(`stream error (${userId}): ${e.message}`));
    opus.once('end', () => { track.listening = false; });
    opus.once('close', () => { track.listening = false; });
    opus.pipe(decoder);
  }

  async writeAligned(track, pcm, arrived) {
    const stdin = track.ff.stdin;
    if (stdin.destroyed || stdin.writableEnded) return;
    const expected = Math.floor((arrived - this.startTime - track.offsetMs) * BYTES_PER_MS);
    let gap = expected - pcm.length - track.written;
    gap -= gap % 4; // keep sample alignment
    if (gap > BYTES_PER_MS * 60) { // more than 60 ms behind real time: fill with silence
      while (gap > 0) {
        const n = Math.min(gap, SILENCE.length);
        await writeAsync(stdin, SILENCE.subarray(0, n));
        track.written += n;
        gap -= n;
      }
    }
    await writeAsync(stdin, pcm);
    track.written += pcm.length;
  }

  async stop() {
    this.stopping = true;
    if (!this.startTime) { this.client?.destroy(); return; }
    this.connection?.destroy();

    await Promise.all([...this.tracks.values()].map(async (t) => {
      await t.chain;
      t.ff.stdin.end();
      await t.done;
      if (t.name && fs.existsSync(t.file)) {
        const named = path.join(this.dir, `${safeName(t.name)}_${t.userId}.ogg`);
        fs.renameSync(t.file, named);
        t.file = named;
      }
    }));

    await this.mix();
    this.client?.destroy();
  }

  async mix() {
    const files = [...this.tracks.values()].map((t) => t.file).filter((f) => fs.existsSync(f));
    if (files.length === 0) { this.log('no audio captured'); return; }
    const args = ['-hide_banner', '-loglevel', 'error'];
    files.forEach((f) => args.push('-i', f));
    if (files.length > 1) {
      args.push('-filter_complex',
        `amix=inputs=${files.length}:duration=longest:dropout_transition=0:normalize=0`);
    }
    args.push('-c:a', 'libopus', '-b:a', '96k', '-y', path.join(this.dir, '_full_mix.ogg'));
    if (await runFfmpeg(args)) this.log(`saved ${files.length} speaker track(s) + full mix`);
  }
}

// ---------- main ----------
const recorders = CHANNEL_IDS.map((id, i) => new ChannelRecorder(TOKENS[i], id));

(async () => {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  for (const r of recorders) {
    try { await r.start(); } catch (e) { console.error(`[${r.channelId}] failed to start: ${e.message}`); }
    await sleep(1500); // stagger joins to stay clear of rate limits
  }
  const live = recorders.filter((r) => r.startTime).length;
  console.log(`\nRecording ${live}/${recorders.length} channels into ${SESSION_DIR}\nPress Ctrl+C to stop.\n`);
})();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping and finalizing files (this can take a moment)...');
  await Promise.all(recorders.map((r) => r.stop().catch((e) => console.error(e))));
  console.log('Done.');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
