// Background H.264 encoder for phones whose hardware H.264 encoder doesn't
// work. Uses h264-mp4-encoder (MIT, WebAssembly) to make a standard H.264 MP4
// that WhatsApp and every gallery accept.
//
// Two ways to feed it:
//  a) Live frames:   { type: 'init', width, height, fps, kbps }
//                    { type: 'frame', bitmap: ImageBitmap, t: ms since start }  -> 'ack' per frame
//  b) Transcoding encoded video (e.g. VP9) while it is being recorded:
//                    { type: 'initTranscode', decoderConfig, width, height, fps, kbps }
//                    { type: 'chunk', chunkType, timestamp, duration, data: ArrayBuffer }
//     Chunks are decoded and re-encoded in the background as they arrive, so
//     when the take stops only the last few seconds are left to convert.
//     -> 'progress' { encoded, received } now and then
// Both:              { type: 'finish' }  -> { type: 'done', buffer, frames }
// Errors:            { type: 'error', message }
//
// The output has a constant frame rate: frames are repeated or skipped by their
// timestamps, so the video plays at real speed even if frames arrive unevenly.

/* global HME */
importScripts('vendor/h264-mp4-encoder.web.js');

let enc = null;
let canvas = null;
let ctx = null;
let fps = 30;
let written = 0; // frames written to the video
let lastRgba = null;

// transcoding state
let decoder = null;
let ready = false;
let finishing = false;
let flushing = false;
let chunks = []; // encoded chunks waiting to be decoded
let frames = []; // decoded frames waiting to be encoded
let received = 0;
let encoded = 0;
let t0 = null;
let pumpQueued = false;

async function createEncoder(msg) {
  fps = msg.fps;
  enc = await HME.createH264MP4Encoder();
  enc.width = msg.width;
  enc.height = msg.height;
  enc.frameRate = fps;
  enc.kbps = msg.kbps;
  enc.speed = 10; // fastest
  enc.groupOfPictures = fps * 2;
  enc.initialize();
  canvas = new OffscreenCanvas(msg.width, msg.height);
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  written = 0;
  lastRgba = null;
}

/** Draw an image into the output size and write it until its timestamp (ms) is reached. */
function writeImage(image, tMs) {
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  lastRgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const due = Math.floor((tMs / 1000) * fps) + 1;
  while (written < due) {
    enc.addFrameRgba(lastRgba);
    written++;
  }
}

function finalize() {
  if (written === 0 && lastRgba) {
    enc.addFrameRgba(lastRgba);
    written++;
  }
  enc.finalize();
  const data = enc.FS.readFile(enc.outputFilename);
  enc.FS.unlink(enc.outputFilename);
  enc.delete();
  enc = null;
  self.postMessage({ type: 'done', buffer: data.buffer, frames: written }, [data.buffer]);
}

function fail(err) {
  self.postMessage({ type: 'error', message: err?.message || String(err) });
}

function schedulePump() {
  if (pumpQueued) return;
  pumpQueued = true;
  setTimeout(pump, 0);
}

/** Transcoding loop: encode decoded frames, keep the decoder fed (but never far ahead). */
function pump() {
  pumpQueued = false;
  if (!ready) return;
  try {
    while (frames.length) {
      const f = frames.shift();
      const t = (f.timestamp - t0) / 1000;
      writeImage(f, t);
      f.close();
      encoded++;
      if (encoded % 10 === 0) self.postMessage({ type: 'progress', encoded, received });
    }
    // only a few decoded frames in memory at a time
    while (chunks.length && decoder.decodeQueueSize + frames.length < 3) {
      const c = chunks.shift();
      decoder.decode(new EncodedVideoChunk(c));
    }
    if (finishing && !chunks.length && !flushing) {
      flushing = true;
      decoder
        .flush()
        .then(() => {
          for (const f of frames) {
            writeImage(f, (f.timestamp - t0) / 1000);
            f.close();
            encoded++;
          }
          frames = [];
          decoder.close();
          self.postMessage({ type: 'progress', encoded, received });
          finalize();
        })
        .catch(fail);
    }
  } catch (err) {
    fail(err);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await createEncoder(msg);
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'frame') {
      writeImage(msg.bitmap, msg.t);
      msg.bitmap.close();
      self.postMessage({ type: 'ack' });
    } else if (msg.type === 'initTranscode') {
      decoder = new VideoDecoder({
        output: (f) => {
          frames.push(f);
          schedulePump();
        },
        error: fail,
      });
      decoder.configure(msg.decoderConfig);
      await createEncoder(msg);
      ready = true;
      self.postMessage({ type: 'ready' });
      schedulePump();
    } else if (msg.type === 'chunk') {
      if (t0 === null) t0 = msg.timestamp;
      chunks.push({ type: msg.chunkType, timestamp: msg.timestamp, duration: msg.duration, data: msg.data });
      received++;
      schedulePump();
    } else if (msg.type === 'finish') {
      if (decoder) {
        finishing = true;
        schedulePump();
      } else {
        finalize();
      }
    }
  } catch (err) {
    fail(err);
  }
};
