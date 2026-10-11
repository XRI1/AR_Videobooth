// Background H.264 encoder for phones whose hardware H.264 encoder doesn't
// work. Uses h264-mp4-encoder (MIT, WebAssembly) to make a standard H.264 MP4
// that WhatsApp and every gallery accept.
//
// Messages in:
//   { type: 'init', width, height, fps, kbps }
//   { type: 'frame', bitmap: ImageBitmap, t: ms since the take started }
//   { type: 'finish' }
// Messages out:
//   { type: 'ready' } | { type: 'ack' } | { type: 'done', buffer } | { type: 'error', message }
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

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      fps = msg.fps;
      enc = await HME.createH264MP4Encoder();
      enc.width = msg.width;
      enc.height = msg.height;
      enc.frameRate = fps;
      enc.kbps = msg.kbps;
      enc.speed = 10; // fastest: must keep up live on a phone
      enc.groupOfPictures = fps * 2;
      enc.initialize();
      canvas = new OffscreenCanvas(msg.width, msg.height);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
      written = 0;
      lastRgba = null;
      self.postMessage({ type: 'ready' });
    } else if (msg.type === 'frame') {
      ctx.drawImage(msg.bitmap, 0, 0);
      msg.bitmap.close();
      lastRgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      // write this frame as many times as needed to reach its timestamp
      const due = Math.floor((msg.t / 1000) * fps) + 1;
      while (written < due) {
        enc.addFrameRgba(lastRgba);
        written++;
      }
      self.postMessage({ type: 'ack' });
    } else if (msg.type === 'finish') {
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
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
