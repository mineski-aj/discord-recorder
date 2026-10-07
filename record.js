// Records up to N voice channels in one Discord server at the same time,
// using one bot account per channel. Each speaker can get their own time-aligned
// track, and/or a live full mix per channel (see settings.js).
// Usage: node record.js [path-to-env-file]   (defaults to .env)
// Normally started by dashboard.js, which controls it over IPC (connect, record, pause, cut, stop).
// Run standalone it connects, records straight away, and finalizes on Ctrl+C.
require('dotenv').config({ path: process.argv[2] || '.env' });
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
  joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { normalize, outFormat } = require('./settings');
const { LiveMixer, writeAsync, BYTES_PER_MS } = require('./mixer');

// ---------- config ----------
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const TOKENS = list(process.env.BOT_TOKENS);
const CHANNEL_IDS = list(process.env.CHANNEL_IDS);
const GUILD_ID = process.env.GUILD_ID;
const STAGGER_MS = parseInt(process.env.JOIN_STAGGER_MS, 10) || 1500;

if (!GUILD_ID || CHANNEL_IDS.length === 0) {
  console.error('Set GUILD_ID and CHANNEL_IDS in .env');
  process.exit(1);
}
if (TOKENS.length < CHANNEL_IDS.length) {
  console.error(`Need one bot token per channel: got ${TOKENS.length} tokens for ${CHANNEL_IDS.length} channels.`);
  process.exit(1);
}

const SILENCE = Buffer.alloc(BYTES_PER_MS * 1000); // 1 s of silence
const MIX_LATENCY_MS = 1500; // the live mix lags real time by this much, so late packets still land in place

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeName = (s) => (s || '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'unnamed';

// destroy() throws if the connection is already destroyed (e.g. after an aborted join).
function destroyConnection(c) {
  if (c && c.state.status !== VoiceConnectionStatus.Destroyed) c.destroy();
}

// Recorded time of one recording so far (excludes paused time).
const recMs = (rec) => (rec.endMs ?? ((rec.pausedAt ?? Date.now()) - rec.startTime - rec.pausedTotal));

function fileSize(f) {
  try { return fs.statSync(f).size; } catch { return 0; }
}

// ---------- one bot = one channel ----------
// Two layers: the connection (bot is logged in and sitting in the voice channel) and the
// recording (rec: one start-to-cut take). The bot can stay connected between recordings.
class ChannelRecorder {
  constructor(token, channelId) {
    this.token = token;
    this.channelId = channelId;
    this.online = false; // in the voice channel
    this.connectedOnce = false;
    this.reconnecting = false;
    this.speaking = new Set();
    this.names = new Map(); // userId -> username
    this.phase = null; // 'failed' | 'stopping' | 'stopped'
    this.error = null;
    this.busy = false;
    this.rec = null; // current recording, if any
    this.finalizing = false;
  }

  log(msg) { console.log(`[${this.label || this.channelId}] ${msg}`); }

  status() {
    let state = this.phase;
    if (!state) {
      if (!this.online) state = 'connecting';
      else if (this.reconnecting) state = 'reconnecting';
      else if (this.finalizing) state = 'finalizing';
      else if (!this.rec) state = 'standby';
      else state = this.rec.pausedAt ? 'paused' : 'recording';
    }
    let bytes = 0;
    if (this.rec) {
      for (const t of this.rec.tracks.values()) if (t.file) bytes += fileSize(t.file);
      if (this.rec.mixer) bytes += fileSize(this.rec.mixer.file);
    }
    return {
      id: this.channelId,
      label: this.label || null,
      tag: this.client?.user?.tag || null,
      state,
      recMs: this.rec ? recMs(this.rec) : 0,
      speaking: [...this.speaking].map((id) => this.names.get(id) || id),
      tracks: this.rec ? this.rec.tracks.size : 0,
      bytes,
      error: this.error,
    };
  }

  // ----- connection -----

  async connect() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    const ready = new Promise((r) => this.client.once(Events.ClientReady, r));
    await this.client.login(this.token);
    await ready;
    if (this.stopping) { this.client.destroy(); return; }

    this.guild = await this.client.guilds.fetch(GUILD_ID);
    const channel = await this.guild.channels.fetch(this.channelId);
    if (!channel?.isVoiceBased()) throw new Error(`${this.channelId} is not a voice channel`);
    this.channel = channel;
    this.label = channel.name;

    await this.join();
    if (this.online) this.log(`connected as ${this.client.user.tag}`);
  }

  // Join (or re-join) the voice channel. A running recording keeps its tracks and clock across a
  // re-join, so time spent disconnected becomes silence and everything stays aligned.
  async join() {
    const connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      group: this.client.user.id, // required so several bots can share one guild in one process
    });
    this.connection = connection;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (e) {
      if (this.connection === connection) destroyConnection(connection);
      throw e;
    }
    if (this.stopping || this.connection !== connection) return;

    this.online = true;
    this.connectedOnce = true;
    this.reconnecting = false;
    connection.receiver.speaking.on('start', (userId) => {
      this.speaking.add(userId);
      if (!this.names.has(userId)) {
        this.client.users.fetch(userId).then((u) => this.names.set(userId, u.username)).catch(() => {});
      }
      if (this.rec && !this.rec.closed) this.subscribe(this.rec, userId);
    });
    connection.receiver.speaking.on('end', (userId) => this.speaking.delete(userId));
    connection.on(VoiceConnectionStatus.Ready, () => { this.reconnecting = false; });
    connection.on(VoiceConnectionStatus.Disconnected, () => this.handleDisconnect(connection));
  }

  async handleDisconnect(connection) {
    if (this.stopping || connection !== this.connection) return;
    this.reconnecting = true;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      this.log('reconnecting...');
    } catch {
      this.log('disconnected, rejoining');
      connection.rejoin();
    }
  }

  // Manual "force reconnect" from the dashboard, for one bot.
  async reconnect() {
    if (this.stopping || this.busy || this.finalizing) return;
    this.busy = true;
    this.log('manual reconnect requested');
    try {
      this.error = null;
      if (!this.connectedOnce) {
        // Never got in (e.g. the first connection was aborted): start from scratch.
        destroyConnection(this.connection);
        this.client?.destroy();
        this.phase = null;
        await this.connect();
        if (session) this.beginRecording(session);
      } else {
        this.reconnecting = true;
        destroyConnection(this.connection);
        await this.join();
        this.log('reconnected');
      }
    } catch (e) {
      this.error = e.message;
      if (!this.connectedOnce) this.phase = 'failed';
      this.log(`reconnect failed: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }

  // ----- recording -----

  beginRecording({ dir, settings }) {
    if (this.rec || this.finalizing || !this.online || this.stopping) return;
    const out = outFormat(settings);
    const folder = path.join(dir, `${safeName(this.label)}_${this.channelId}`);
    fs.mkdirSync(folder, { recursive: true });

    const rec = {
      dir: folder, settings, out,
      startTime: Date.now(), pausedAt: null, pausedTotal: 0, endMs: null,
      tracks: new Map(), // userId -> track
      streams: new Set(), // open opus streams
      mixer: null, timer: null, closed: false,
    };
    if (settings.mode !== 'tracks') {
      // e.g. ADMT_MAIN_full_mix_groupstage_game_1.mp3 (channel name, _full_mix_, recording folder name)
      const tag = (x) => safeName(x).replace(/^_+|_+$/g, '') || 'unnamed';
      const mixFile = `${tag(this.label || this.channelId)}_full_mix_${tag(path.basename(dir))}.${out.ext}`;
      rec.mixer = new LiveMixer(path.join(folder, mixFile), out.mix, (m) => this.log(m));
      rec.timer = setInterval(() => rec.mixer.flushTo((recMs(rec) - MIX_LATENCY_MS) * BYTES_PER_MS), 250);
    }
    this.rec = rec;
    if (paused) this.pause();
    for (const id of this.speaking) this.subscribe(rec, id); // already talking when recording began

    if (settings.announce) this.channel?.send('🔴 This voice channel is now being recorded.').catch(() => {});
    this.log(`recording (${settings.mode === 'both' ? 'mix + tracks' : settings.mode === 'mix' ? 'full mix only' : 'speaker tracks only'}, ${settings.format})`);
  }

  pause() {
    const rec = this.rec;
    if (!rec || rec.pausedAt || rec.closed) return;
    rec.pausedAt = Date.now();
    this.log('paused');
    if (rec.settings.announce) this.channel?.send('⏸️ Recording paused.').catch(() => {});
  }

  resume() {
    const rec = this.rec;
    if (!rec?.pausedAt) return;
    rec.pausedTotal += Date.now() - rec.pausedAt;
    rec.pausedAt = null;
    this.log('resumed');
    if (rec.settings.announce) this.channel?.send('🔴 Recording resumed.').catch(() => {});
  }

  // One encoder per speaker (unless mix-only). Leading silence is added by ffmpeg (adelay),
  // gaps between speech are filled in writeAligned(), so all tracks line up.
  getTrack(rec, userId) {
    let t = rec.tracks.get(userId);
    if (t) return t;

    const offsetMs = recMs(rec);
    t = { userId, offsetMs, written: 0, chain: Promise.resolve(), listening: false, ff: null, file: null, done: Promise.resolve() };
    if (rec.settings.mode !== 'mix') {
      t.file = path.join(rec.dir, `${userId}.${rec.out.ext}`);
      t.ff = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
        '-af', `adelay=delays=${offsetMs}:all=1`,
        ...rec.out.track, '-y', t.file,
      ], { stdio: ['pipe', 'ignore', 'inherit'], detached: true, windowsHide: true }); // detached: Ctrl+C won't kill encoders mid-write
      t.ff.stdin.on('error', (e) => this.log(`encoder error (${userId}): ${e.message}`));
      t.done = new Promise((r) => t.ff.on('close', r));
    }
    rec.tracks.set(userId, t);
    return t;
  }

  subscribe(rec, userId) {
    if (rec.closed) return;
    const track = this.getTrack(rec, userId);
    if (track.listening) return;
    track.listening = true;

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    rec.streams.add(opus);
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

    decoder.on('data', (pcm) => {
      if (rec.closed || rec.pausedAt) return; // paused: stay connected, drop audio
      const arrived = Date.now();
      const pausedTotal = rec.pausedTotal;
      track.chain = track.chain.then(() => this.writeAligned(rec, track, pcm, arrived, pausedTotal));
    });
    decoder.on('error', (e) => {
      this.log(`decode error (${userId}): ${e.message}`);
      track.listening = false;
      opus.destroy();
    });
    opus.on('error', (e) => this.log(`stream error (${userId}): ${e.message}`));
    const ended = () => { track.listening = false; rec.streams.delete(opus); };
    opus.once('end', ended);
    opus.once('close', ended);
    opus.pipe(decoder);
  }

  async writeAligned(rec, track, pcm, arrived, pausedTotal) {
    const stdin = track.ff?.stdin;
    if (stdin && (stdin.destroyed || stdin.writableEnded)) return;
    const expected = Math.floor((arrived - rec.startTime - pausedTotal - track.offsetMs) * BYTES_PER_MS);
    let gap = expected - pcm.length - track.written;
    gap -= gap % 4; // keep sample alignment
    if (gap > BYTES_PER_MS * 60) { // more than 60 ms behind real time: skip ahead (silence)
      if (stdin) {
        for (let left = gap; left > 0;) {
          const n = Math.min(left, SILENCE.length);
          await writeAsync(stdin, SILENCE.subarray(0, n));
          left -= n;
        }
      }
      track.written += gap;
    }
    if (stdin) await writeAsync(stdin, pcm);
    rec.mixer?.add(track.offsetMs * BYTES_PER_MS + track.written, pcm);
    track.written += pcm.length;
  }

  // Phase 1 of ending a recording: stop capturing. Returns the recording to finalize.
  async closeRecording() {
    const rec = this.rec;
    if (!rec || rec.closed) return null;
    this.finalizing = true;
    rec.endMs = recMs(rec);
    rec.closed = true;
    clearInterval(rec.timer);
    for (const s of rec.streams) s.destroy();
    if (rec.settings.announce) await this.channel?.send('⏹️ Recording ended.').catch(() => {});
    return rec;
  }

  // Phase 2: flush and close the encoders, name the files.
  async finalizeRecording(rec) {
    try {
      await Promise.all([...rec.tracks.values()].map(async (t) => {
        await t.chain;
        if (!t.ff) return;
        t.ff.stdin.end();
        await t.done;
        const name = this.names.get(t.userId);
        if (name && fs.existsSync(t.file)) {
          const named = path.join(rec.dir, `${safeName(name)}_${t.userId}.${rec.out.ext}`);
          fs.renameSync(t.file, named);
          t.file = named;
        }
      }));
      if (rec.mixer) await rec.mixer.finish(rec.endMs * BYTES_PER_MS);
      const parts = [];
      if (rec.settings.mode !== 'mix') parts.push(`${rec.tracks.size} speaker track(s)`);
      if (rec.mixer) parts.push('full mix');
      this.log(`saved ${parts.join(' + ')}`);
    } finally {
      this.rec = null;
      this.finalizing = false;
    }
  }

  // End the current recording; the bot stays in the voice channel.
  async cut() {
    const rec = await this.closeRecording();
    if (rec) await this.finalizeRecording(rec);
  }

  // Leave the channel (right away), then finish writing files.
  async stop() {
    this.stopping = true;
    this.phase = 'stopping';
    const rec = await this.closeRecording();
    destroyConnection(this.connection);
    if (rec) await this.finalizeRecording(rec);
    this.client?.destroy();
    this.phase = 'stopped';
  }
}

// ---------- main ----------
const recorders = CHANNEL_IDS.map((id, i) => new ChannelRecorder(TOKENS[i], id));
let shuttingDown = false;
let paused = false;
let session = null; // { dir, settings } while a recording is wanted; bots that connect later join it

if (!process.send) { // standalone: record straight away, like the original script
  session = {
    dir: process.env.SESSION_DIR || path.join(process.env.OUTPUT_DIR || './recordings', new Date().toISOString().replace(/[:.]/g, '-')),
    settings: normalize({
      format: (process.env.OUTPUT_FORMAT || 'mp3').toLowerCase(),
      mode: process.env.OUTPUT_MODE,
      announce: process.env.ANNOUNCE,
      bitrates: { mp3: { track: process.env.MP3_TRACK_KBPS, mix: process.env.MP3_MIX_KBPS } },
    }),
  };
}

(async () => {
  for (const r of recorders) {
    if (shuttingDown) break;
    try {
      await r.connect();
      if (session) r.beginRecording(session);
    } catch (e) {
      if (!r.stopping) { r.phase = 'failed'; r.error = e.message; }
      console.error(`[${r.channelId}] failed to connect: ${e.message}`);
    }
    await sleep(STAGGER_MS); // stagger joins to stay clear of rate limits
  }
  const live = recorders.filter((r) => r.online).length;
  console.log(`\n${live}/${recorders.length} bots connected${process.send ? '' : `, recording into ${session.dir}\nPress Ctrl+C to stop.`}\n`);
})();

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

// ---------- dashboard control (only when started by dashboard.js, which forks this file) ----------
if (process.send) {
  process.on('message', async (m) => {
    switch (m?.cmd) {
      case 'record':
        if (session || shuttingDown) break;
        paused = false;
        session = { dir: m.dir, settings: normalize(m.settings) };
        recorders.forEach((r) => r.beginRecording(session));
        break;
      case 'pause': paused = true; recorders.forEach((r) => r.pause()); break;
      case 'resume': paused = false; recorders.forEach((r) => r.resume()); break;
      case 'cut':
        session = null;
        paused = false;
        await Promise.all(recorders.map((r) => r.cut().catch((e) => console.error(e))));
        if (process.connected) process.send({ type: 'cut-done' });
        break;
      case 'reconnect': recorders.find((r) => r.channelId === m.id)?.reconnect(); break;
      case 'stop': shutdown(); break;
    }
  });
  process.on('disconnect', shutdown); // dashboard died: still leave channels and finalize files
  setInterval(() => {
    if (process.connected) process.send({ type: 'status', recorders: recorders.map((r) => r.status()) });
  }, 1000);
}
