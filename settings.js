// Recording settings shared by dashboard.js (edits + saves them) and record.js (applies them).
const FORMATS = ['mp3', 'wav', 'ogg'];
const MODES = ['both', 'mix', 'tracks']; // both = full mix + per-speaker tracks; mix = full mix only; tracks = per-speaker only

const DEFAULTS = {
  format: 'mp3',
  mode: 'both',
  announce: true, // post "recording started/paused/ended" in each voice channel's chat
  outputDir: './recordings', // parent folder; each recording gets its own sub-folder
  staggerMs: 1500, // delay between bot logins, to stay clear of rate limits
  bitrates: { mp3: { track: 32, mix: 48 }, ogg: { track: 64, mix: 96 } }, // kbps
};

const int = (v, lo, hi, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

function normalize(s = {}) {
  const b = s.bitrates || {};
  const br = (f) => ({
    track: int(b[f]?.track, 8, 320, DEFAULTS.bitrates[f].track),
    mix: int(b[f]?.mix, 8, 320, DEFAULTS.bitrates[f].mix),
  });
  return {
    format: FORMATS.includes(s.format) ? s.format : DEFAULTS.format,
    mode: MODES.includes(s.mode) ? s.mode : DEFAULTS.mode,
    announce: !(s.announce === false || s.announce === 'false'),
    outputDir: typeof s.outputDir === 'string' && s.outputDir.trim() ? s.outputDir.trim() : DEFAULTS.outputDir,
    staggerMs: int(s.staggerMs, 300, 10000, DEFAULTS.staggerMs),
    bitrates: { mp3: br('mp3'), ogg: br('ogg') },
  };
}

// ffmpeg output arguments for a per-speaker track and for the full mix.
function outFormat(s) {
  const { mp3, ogg } = s.bitrates;
  if (s.format === 'wav') {
    const a = ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'];
    return { ext: 'wav', track: a, mix: a };
  }
  if (s.format === 'ogg') {
    return {
      ext: 'ogg',
      track: ['-ac', '1', '-c:a', 'libopus', '-b:a', `${ogg.track}k`],
      mix: ['-c:a', 'libopus', '-b:a', `${ogg.mix}k`],
    };
  }
  return {
    ext: 'mp3',
    track: ['-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', `${mp3.track}k`],
    mix: ['-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', `${mp3.mix}k`],
  };
}

module.exports = { FORMATS, MODES, DEFAULTS, normalize, outFormat };
