// Uploads a recorded video to the AR backend, which stores it and returns a
// QR code linking to a mobile download page.
// Backend docs: https://github.com/Zihan231/AR_Backend
//   POST /api/videos/upload  (multipart/form-data, field "video", max 250 MB)
//   -> 201 { success, token, viewUrl, downloadUrl, qrCode (PNG data URL), ... }

/** Backend base URL; override with VITE_BACKEND_URL in a .env file. */
export const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || 'https://ar-backend-3duv.onrender.com').replace(/\/+$/, '');

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // generous: the free Render tier can take a minute to wake up

/**
 * Upload a video. Uses XMLHttpRequest (not fetch) for upload progress.
 * @param {Blob} blob
 * @param {string} filename
 * @param {{ onProgress?: (fraction: number) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ token: string, viewUrl: string, downloadUrl: string, qrCode: string }>}
 */
export function uploadVideo(blob, filename, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BACKEND_URL}/api/videos/upload`);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.responseType = 'json';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response ?? {};
      if (xhr.status >= 200 && xhr.status < 300 && body.success !== false && body.qrCode) {
        resolve(body);
      } else {
        const msg = Array.isArray(body.message) ? body.message.join(', ') : body.message;
        reject(new Error(msg || `Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error: check the internet connection'));
    xhr.ontimeout = () => reject(new Error('Upload timed out: the server took too long to respond'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append('video', blob, filename);
    xhr.send(form);
  });
}
