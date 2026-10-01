# AR 360 Video Booth (WebAR)

A browser-based AR video booth: point a phone at a person and 3D text rings, logo badges, fireworks and sparklers orbit **around** them. The text passes behind their body and comes back in front. Walk the phone around the person, record, then download or share the video. No app install needed.

## Features

- **Curved 3D text rings.** The text is extruded and bevelled, then bent around the person. There are two independent rings, each with its own text, colours, italic, height, radius, size and spin.
- **Real occlusion.** A person segmentation mask cuts the person out of the video. The back half of each ring is drawn behind them and the front half in front.
- **Body anchoring.** Pose tracking keeps the rings centred on the person's torso and scales them with the person's size. The rings also follow body lean and phone roll.
- **360° gyro lock** (compass button). Uses the phone's motion sensors so the rings stay fixed in the room while you walk around the person.
- **Orbiting logo/badge.** The default is a "20 YEARS" medallion, or you can upload your own PNG.
- **FX:** fireworks behind the person (rockets, peony, ring and willow bursts), sparkler fountains at their feet, and twinkling glitter.
- **Recording:** captures the composited AR canvas plus microphone audio. MP4 (H.264) where supported, WebM otherwise. Also has photo capture, download and native share on phones.
- Settings are saved per device. The ML models and runtime are self-hosted, so nothing loads from third-party CDNs at the venue.

## Run it

```bash
npm install
npm run dev
```

The `dev` server uses HTTPS, which phones require for camera and motion sensors, and is exposed on your LAN. Open the `Network:` URL it prints (e.g. `https://192.168.1.20:5173`) on your phone and accept the self-signed certificate warning.

For desktop testing on the same machine (webcam, plain `http://localhost:5174`):

```bash
npm run dev:local
```

You can also tap **"or use a video file"** on the start screen to run the effect on pre-recorded footage.

## Deploy

```bash
npm run build
```

Upload the `dist/` folder to any static HTTPS host (Netlify, Vercel, GitHub Pages, Cloudflare Pages, S3 + CloudFront). It uses relative paths, so it works from a sub-folder too.

## Using it at an event

1. Tap **Start AR Camera** and allow camera, microphone and (on iOS) motion access.
2. Frame the person from about 2–4 m away, with the full body or at least head to hips in view. The pill at the top reads **Person locked** once tracking has them.
3. Optionally tap the **compass** to turn on 360° lock.
4. Press **record** and walk slowly around the person. Recording stops automatically at 60 s.
5. **Download** or **Share** the clip.

Tips: good lighting improves the cut-out edges. On older phones, set **Body tracking model = Lite** and **Cut-out quality = Fast**. If the ring spins the wrong way when you walk around with 360° lock on, enable **Invert 360° gyro direction**.

## Lock button (world-lock AR)

Once a person is detected, the padlock button pins the text, badges and effects to the person's spot **in the room**. After that, walking around or panning the phone makes them behave like real objects.

- **Android + Chrome with ARCore** (Google Play Services for AR installed): Lock switches into WebXR AR mode. ARCore tracks the phone's position and rotation. The text is placed at the person's real distance, measured by hit-testing the floor at their feet, or estimated from torso size if no floor is found. The pill shows the measured distance, e.g. `AR locked · 2.5 m`. Recording continues through the switch.
- **Other phones:** falls back to a motion-sensor lock. The text keeps a fixed facing in the room while you orbit the person.
- **Tap again to unlock:** returns to body-following mode with the normal camera.

Tips: press Lock while the person's full body, including their feet, is in view. If ARCore needs to find the floor first, move the phone slightly side to side for a second.

## How it works

Each frame is composited in four layers ([src/arScene.js](src/arScene.js)):

1. Camera video, full-screen with "cover" fit.
2. **Back half** of every ring and the background fireworks. A clipping plane through the person's body axis, facing the camera, removes the near half.
3. **The person**, cut out of the same video with the segmentation mask. This covers anything behind them.
4. **Front half** of every ring (the clipping plane is flipped) and the foreground sparklers.

Tracking ([src/tracker.js](src/tracker.js)) runs two MediaPipe tasks on the GPU:

- **PoseLandmarker** finds the shoulders, hips and ankles. These give the ring centre, the scale (torso length), the body's up-vector and the floor level.
- **ImageSegmenter** (`selfie_segmenter`, or `selfie_multiclass` for high quality) produces the person mask. The mask is drawn as 8-bit RGB by MediaPipe on its own GL context and blitted into a 2D canvas that Three.js uploads. This avoids float-texture readback, which returns zeros on many GPUs.

| File | Purpose |
| --- | --- |
| [src/main.js](src/main.js) | App flow, UI, settings wiring, render loop |
| [src/arScene.js](src/arScene.js) | Three.js compositor, anchoring, clipping |
| [src/rings.js](src/rings.js) | Curved 3D text, badges, glitter |
| [src/fireworks.js](src/fireworks.js) | Particle rockets, bursts, fountains |
| [src/tracker.js](src/tracker.js) | MediaPipe pose + segmentation |
| [src/gyro.js](src/gyro.js) | Device-orientation heading/pitch |
| [src/recorder.js](src/recorder.js) | MediaRecorder capture |
| [src/settings.js](src/settings.js) | Defaults and persistence |

## Limitations

- This is not full 6-DoF SLAM. Rings are anchored to the tracked body, and the gyro adds world-locked rotation. Walking around the person works because the person stays centred in frame.
- The 3D fonts are Latin-only typefaces. For other scripts, convert a TTF with facetype.js and drop the JSON into `public/fonts/`.
- iOS Safari records MP4. Some Android browsers record WebM, which plays in browsers and most apps.
