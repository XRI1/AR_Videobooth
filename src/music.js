// Background music for recordings (public/music/background.mp3).
//
// The song starts with the take: it plays out loud on the phone, and the same
// audio is put into the video file:
//  - WebCodecs takes: encoded straight from the decoded song (AAC, or Opus if
//    the browser can't encode AAC) and added to the MP4 when the take stops.
//    Encoding from the file, not a live capture, keeps it perfectly in sync.
//  - Takes converted to H.264 by the software encoder (which makes silent
//    video): remuxed with the music into a new MP4, see addMusicToMp4().
//  - MediaRecorder takes: the playing song is captured live as an audio track.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const SAMPLE_RATE = 48000; // decode at 48 kHz: both AAC and Opus encoders accept it
const BITRATE = 128_000;
const FADE_OUT_S = 0.6; // fade at the end of the take
const BLOCK = 4096; // frames per AudioData sent to the encoder

export class BackgroundMusic {
  constructor(url) {
    this.url = url;
    this.buffer = null; // AudioBuffer at SAMPLE_RATE
    this.encoderConfig = null; // { config, muxCodec } or null if the browser can't encode audio
    this.volume = 0.8; // loudness of the speaker playback (the file always gets full volume)
    this._ctx = null;
    this._source = null;
    this._dest = null;
  }

  /** Download + decode the song and find an audio encoder. Safe to call more than once. */
  load() {
    this._loading ??= (async () => {
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`music not found (${res.status})`);
      const data = await res.arrayBuffer();
      const off = new OfflineAudioContext(2, 1, SAMPLE_RATE);
      this.buffer = await off.decodeAudioData(data);
      this.encoderConfig = await pickEncoder(Math.min(2, this.buffer.numberOfChannels));
    })();
    return this._loading;
  }

  get ready() {
    return !!this.buffer;
  }

  /** Call from a tap (browsers only allow sound after a user gesture). */
  unlock() {
    this._ctx ??= new AudioContext();
    if (this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
  }

  /** A live audio track of the song (for MediaRecorder takes). */
  streamTrack() {
    this.unlock();
    this._dest ??= this._ctx.createMediaStreamDestination();
    return this._dest.stream.getAudioTracks()[0];
  }

  /** Start the song from the beginning (speaker + live track). */
  play() {
    if (!this.buffer) return;
    this.unlock();
    this.stop();
    const src = this._ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    const gain = this._ctx.createGain();
    gain.gain.value = this.volume;
    src.connect(gain).connect(this._ctx.destination);
    if (this._dest) src.connect(this._dest);
    src.start();
    this._source = src;
  }

  stop() {
    try {
      this._source?.stop();
    } catch {
      /* already stopped */
    }
    this._source = null;
  }

  /**
   * Encode `durationS` seconds of the song (looping if needed), starting
   * `offsetS` into it, fading out at the end. Returns { chunks, meta, ...config }
   * ready for mp4-muxer's addAudioChunkRaw, or null if audio can't be encoded.
   */
  async encode(durationS, offsetS = 0) {
    if (!this.buffer || !this.encoderConfig || durationS <= 0) return null;
    const { config, muxCodec } = this.encoderConfig;
    const ch = config.numberOfChannels;
    const total = Math.round(durationS * SAMPLE_RATE);
    const offset = Math.round(offsetS * SAMPLE_RATE);
    const len = this.buffer.length;
    const src = Array.from({ length: ch }, (_, c) => this.buffer.getChannelData(Math.min(c, this.buffer.numberOfChannels - 1)));
    const fadeFrames = Math.min(total, Math.round(FADE_OUT_S * SAMPLE_RATE));
    const chunks = [];
    let meta = null;
    let error = null;
    const enc = new AudioEncoder({
      output: (chunk, m) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push({ data, type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? 0 });
        if (m?.decoderConfig && !meta) meta = m;
      },
      error: (e) => (error = e),
    });
    enc.configure(config);
    for (let start = 0; start < total && !error; start += BLOCK) {
      const n = Math.min(BLOCK, total - start);
      const planar = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) {
        const s = src[c];
        for (let i = 0; i < n; i++) {
          const f = start + i;
          let v = s[(offset + f) % len];
          const left = total - f;
          if (left < fadeFrames) v *= left / fadeFrames;
          planar[c * n + i] = v;
        }
      }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((start / SAMPLE_RATE) * 1e6), data: planar });
      enc.encode(ad);
      ad.close();
      if (enc.encodeQueueSize > 32) await new Promise((r) => setTimeout(r, 0));
    }
    await enc.flush();
    enc.close();
    if (error || !chunks.length) return null;
    return { chunks, meta, muxCodec, sampleRate: SAMPLE_RATE, numberOfChannels: ch };
  }

  /** mp4-muxer `audio` option for files that will get this music. */
  get muxerAudio() {
    if (!this.encoderConfig) return undefined;
    const { config, muxCodec } = this.encoderConfig;
    return { codec: muxCodec, sampleRate: config.sampleRate, numberOfChannels: config.numberOfChannels };
  }
}

/** AAC first (plays everywhere, WhatsApp included); Opus if AAC encoding isn't available. */
async function pickEncoder(numberOfChannels) {
  if (!('AudioEncoder' in window)) return null;
  for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate: SAMPLE_RATE, numberOfChannels, bitrate: BITRATE };
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, muxCodec };
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Add encoded music chunks to an mp4-muxer Muxer that was created with `music.muxerAudio`. */
export function addMusicChunks(muxer, audio) {
  audio.chunks.forEach((c, i) => muxer.addAudioChunkRaw(c.data, c.type, c.timestamp, c.duration, i === 0 ? audio.meta ?? undefined : undefined));
}

/* ----------------------- remux: silent H.264 MP4 + music ----------------------- */

/**
 * Take a silent H.264 MP4 (from the software encoder) and the encoded music,
 * and write a new MP4 with both tracks. Returns an ArrayBuffer.
 */
export function addMusicToMp4(mp4Buffer, audio) {
  const v = parseMp4Video(new Uint8Array(mp4Buffer));
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: v.width, height: v.height },
    audio: { codec: audio.muxCodec, sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });
  const codec = `avc1.${[...v.avcC.slice(1, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  v.samples.forEach((s, i) => {
    muxer.addVideoChunkRaw(
      s.data,
      s.key ? 'key' : 'delta',
      s.timestamp,
      s.duration,
      i === 0 ? { decoderConfig: { codec, codedWidth: v.width, codedHeight: v.height, description: v.avcC } } : undefined,
    );
  });
  addMusicChunks(muxer, audio);
  muxer.finalize();
  return target.buffer;
}

/** Minimal MP4 reader for a single H.264 video track: avcC, size and samples (timestamps in µs). */
function parseMp4Video(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);
  const boxes = {};
  const type = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  const walk = (start, end) => {
    for (let o = start; o + 8 <= end; ) {
      let size = dv.getUint32(o);
      const t = type(o + 4);
      let header = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(o + 8));
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header) break;
      if (CONTAINERS.has(t)) walk(o + header, o + size);
      else if (!(t in boxes)) boxes[t] = { start: o + header, end: o + size };
      o += size;
    }
  };
  walk(0, bytes.length);
  for (const need of ['stsd', 'stsz', 'stsc', 'stts', 'mdhd']) if (!boxes[need]) throw new Error(`MP4 without ${need}`);
  if (!boxes.stco && !boxes.co64) throw new Error('MP4 without chunk offsets');

  // sample entry (avc1): 8-byte box header + 78 bytes of fields, then child boxes incl. avcC
  const stsd = boxes.stsd.start;
  const entry = stsd + 8;
  const width = dv.getUint16(entry + 8 + 24);
  const height = dv.getUint16(entry + 8 + 26);
  let avcC = null;
  for (let o = entry + 8 + 78, end = entry + dv.getUint32(entry); o + 8 <= end; ) {
    const size = dv.getUint32(o);
    if (type(o + 4) === 'avcC') avcC = bytes.slice(o + 8, o + size);
    if (size < 8) break;
    o += size;
  }
  if (!avcC) throw new Error('MP4 without avcC');

  const mdhd = boxes.mdhd.start;
  const timescale = bytes[mdhd] === 1 ? dv.getUint32(mdhd + 20) : dv.getUint32(mdhd + 12);

  // sample sizes
  const stsz = boxes.stsz.start;
  const fixed = dv.getUint32(stsz + 4);
  const count = dv.getUint32(stsz + 8);
  const sizes = Array.from({ length: count }, (_, i) => fixed || dv.getUint32(stsz + 12 + i * 4));
  // chunk offsets
  const offsets = [];
  if (boxes.stco) {
    const p = boxes.stco.start;
    for (let i = 0, n = dv.getUint32(p + 4); i < n; i++) offsets.push(dv.getUint32(p + 8 + i * 4));
  } else {
    const p = boxes.co64.start;
    for (let i = 0, n = dv.getUint32(p + 4); i < n; i++) offsets.push(Number(dv.getBigUint64(p + 8 + i * 8)));
  }
  // samples per chunk
  const stsc = boxes.stsc.start;
  const runs = [];
  for (let i = 0, n = dv.getUint32(stsc + 4); i < n; i++) runs.push({ first: dv.getUint32(stsc + 8 + i * 12), per: dv.getUint32(stsc + 12 + i * 12) });
  // durations
  const stts = boxes.stts.start;
  const deltas = [];
  for (let i = 0, n = dv.getUint32(stts + 4); i < n; i++) {
    const c = dv.getUint32(stts + 8 + i * 8);
    const d = dv.getUint32(stts + 12 + i * 8);
    for (let k = 0; k < c; k++) deltas.push(d);
  }
  // key frames (no stss = every frame is a key frame)
  let keys = null;
  if (boxes.stss) {
    const p = boxes.stss.start;
    keys = new Set();
    for (let i = 0, n = dv.getUint32(p + 4); i < n; i++) keys.add(dv.getUint32(p + 8 + i * 4) - 1);
  }

  const samples = [];
  let s = 0;
  let t = 0;
  for (let c = 0; c < offsets.length && s < count; c++) {
    const run = runs.filter((r) => r.first <= c + 1).pop();
    let pos = offsets[c];
    for (let k = 0; k < (run?.per ?? 1) && s < count; k++, s++) {
      const d = deltas[s] ?? deltas[deltas.length - 1] ?? 0;
      samples.push({
        data: bytes.subarray(pos, pos + sizes[s]),
        key: keys ? keys.has(s) : true,
        timestamp: Math.round((t / timescale) * 1e6),
        duration: Math.round((d / timescale) * 1e6),
      });
      pos += sizes[s];
      t += d;
    }
  }
  return { width, height, avcC, samples };
}
