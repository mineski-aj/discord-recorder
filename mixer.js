// Live full-mix encoder: sums every speaker's audio into ONE ffmpeg process per channel while recording,
// instead of keeping one encoder per speaker and mixing afterwards. Uses far less RAM/CPU/disk.
// Audio is 48 kHz stereo 16-bit PCM; positions are byte offsets on the recording timeline.
const { spawn } = require('child_process');

const BYTES_PER_MS = (48000 * 2 * 2) / 1000;
const CHUNK = BYTES_PER_MS * 1000; // flush at most 1 s at a time

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

class LiveMixer {
  constructor(file, outArgs, log = () => {}) {
    this.file = file;
    this.base = 0; // timeline bytes already sent to ffmpeg
    this.acc = new Int32Array(48000 * 2 * 4); // sample accumulator for the not-yet-flushed window
    this.high = 0; // samples (from base) that hold data
    this.chain = Promise.resolve();
    this.ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      ...outArgs, '-y', file,
    ], { stdio: ['pipe', 'ignore', 'inherit'], detached: true, windowsHide: true }); // detached: Ctrl+C won't kill it mid-write
    this.ff.stdin.on('error', (e) => log(`mix encoder error: ${e.message}`));
    this.done = new Promise((r) => this.ff.on('close', r));
  }

  // Add pcm so that it starts at timeline byte `pos`. Overlapping audio is summed.
  add(pos, pcm) {
    let off = pos - this.base;
    let start = 0;
    if (off < 0) { // arrived after that part of the timeline was already flushed
      start = -off;
      off = 0;
      if (start >= pcm.length) return;
    }
    const s0 = off >> 1;
    const n = (pcm.length - start) >> 1;
    if (s0 + n > this.acc.length) {
      const bigger = new Int32Array(Math.max(s0 + n, this.acc.length * 2));
      bigger.set(this.acc.subarray(0, this.high));
      this.acc = bigger;
    }
    for (let i = 0; i < n; i++) this.acc[s0 + i] += pcm.readInt16LE(start + 2 * i);
    if (s0 + n > this.high) this.high = s0 + n;
  }

  // Send everything up to timeline byte `upTo` to ffmpeg (silence where nobody spoke).
  flushTo(upTo) {
    this.chain = this.chain.then(() => this._flush(upTo));
    return this.chain;
  }

  async _flush(upTo) {
    while (upTo - this.base > 0) {
      const bytes = Math.min(upTo - this.base, CHUNK);
      const nS = bytes >> 1;
      const out = Buffer.alloc(bytes);
      const m = Math.min(nS, this.high);
      for (let i = 0; i < m; i++) {
        const v = this.acc[i];
        out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, 2 * i);
      }
      if (nS >= this.high) {
        this.acc.fill(0, 0, this.high);
        this.high = 0;
      } else {
        this.acc.copyWithin(0, nS, this.high);
        this.acc.fill(0, this.high - nS, this.high);
        this.high -= nS;
      }
      this.base += bytes;
      await writeAsync(this.ff.stdin, out);
    }
  }

  async finish(upTo) {
    await this.flushTo(upTo);
    this.ff.stdin.end();
    await this.done;
  }
}

module.exports = { LiveMixer, writeAsync, BYTES_PER_MS };
