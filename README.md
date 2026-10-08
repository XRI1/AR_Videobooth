# Gut Synbio · AR 360 Video Booth (WebAR)

A browser-based AR video booth. Point a phone at a person and the 3D brand logo, rising glass capsules and cubes, sparklers and glitter appear around them, with the person correctly cut out so effects can pass behind their body. Press **Lock** to pin everything to a real spot in the room, walk the phone around the person and record. Tap **Submit** to upload the video, and a **QR code** appears so the guest can scan it and download the clip to their own phone. No app install needed.

Current version: **4.2**. It's shown at the top of **Settings → Camera & tracking**; check it to confirm a phone has the latest code.

## Features

- **3D brand logo "gut SYNBIO".** The front face is the real logo artwork ([public/brand/logo.webp](public/brand/logo.webp), with the small tagline cropped off), so colours, shapes and outline match the brand exactly. A solid navy body is extruded behind it from the logo's outline, so it looks like a thick 3D sign as you walk around. It is gently curved in front of the person. Replace `logo.webp` to change it. Untick **Brand 3D lettering** in settings to use your own 3D text instead (text, colours, italic, height, distance, size, font).
- **3D icons beside the logo:** real 3D models (not pictures), built in code to match the brand artwork. Glass objects stream out from a point next to the logo, fanning out and growing as they sweep up to the top outer corner, each trailing a short glowing tail. On the left, the **probiotic** icon uses glossy glass **capsules** (they point along their path); on the right, the **prebiotic** icon uses tumbling blue and lime glass **cubes**. Both add small glass bubbles. They have real depth, so they look right as you walk around, sit on the same curve as the logo and face the camera. The group shrinks slightly if needed to fit the portrait frame. The look is set in `createFlowIcon` in [src/rings.js](src/rings.js).
- **Real occlusion.** A person segmentation mask cuts the person out of the video, so anything behind them is hidden by their body.
- **Smooth body tracking.** Pose tracking keeps the text on the person's torso and scales it with their size. One Euro filtering removes jitter, and the text glides at 60 fps between 30 fps detections. It pops in when a person appears and shrinks away if they leave the frame.
- **Lock button.** Pins the text and effects in the real room (see below). It uses ARCore surface tracking on supported Android phones and a motion-sensor fallback elsewhere.
- **3D objects rising around the person:** glossy glass **capsules**, blue and lime-green **cubes** and spheres rise straight up out of the floor at spots all around the person (a new random spot each time they rise again; they never move around the body), then fade out between the hips and chest (never reaching the head). They keep the same distance from the body as the 3D logo but never come closer than the body and arms, stay inside the portrait frame, freeze when you press Lock (no jump), and pass behind the body (hidden by the cut-out). Untick **Show rising 3D objects** at the top of the settings panel to hide just these (the logo stays); choose capsules, cubes or both in **Settings → Effects**.
- **FX:** sparkler fountains at the person's feet and twinkling glitter. (The firework bursts that shot up and exploded were removed in 3.1.)
- **Recording as MP4:** captures the composited AR canvas as a standard **MP4 (H.264 video)**. Videos are silent by default (no microphone permission asked); tick **Record sound with the video** in settings to add AAC audio that every phone, gallery and messaging app plays. It uses the phone's hardware encoder through WebCodecs plus [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), which works in Chrome on Android, where the built-in recorder only makes WebM. It falls back to the browser's own MP4 recorder (Safari/iOS), and only then to WebM. Also has photo capture, download and native share on phones. Recording keeps running through Lock and Unlock.
- **Submit + QR download:** after recording, the result screen shows **Submit**, **Download** and **Retake**. **Submit** uploads the MP4 to the [AR backend](https://github.com/Zihan231/AR_Backend) with a live progress bar. When it finishes, a QR code appears next to the video; the guest scans it to open a download page on their own phone. If the upload fails, the reason is shown and the button changes to **Retry submit**. **Retake** discards the clip and cancels any upload still running. Nothing is uploaded unless you tap Submit, and photos are never uploaded.
- **2D logo banner:** a flat brand banner ([public/brand/overlay.webp](public/brand/overlay.webp): probiotic stream, gut SYNBIO logo with tagline, prebiotic stream) can be drawn edge to edge along the bottom of the frame; the record and capture buttons move up above it while it's shown. It's part of the AR canvas, so when it's on it's always in the recorded video and photos, even while locked or in AR mode. It's **hidden by default**; tick **Show 2D logo banner** at the top of the settings panel to show it. Replace the file to change it (transparent margins are trimmed automatically).
- **3D switches:** at the top of the settings panel, **Show 3D elements** hides the 3D logo, side icons, sparkles and fountains, and **Show rising 3D objects** separately controls the capsules, cubes and bubbles rising from the floor. So you can show only the rising objects, only the logo, both or neither. The camera image (and the 2D banner, if on) is always shown and recorded.
- **Offline-friendly:** settings are saved per device, and the ML models and runtime are self-hosted, so nothing loads from third-party CDNs at the venue.

## Brand design

The UI follows the **Gut Synbio** identity (logo + key visual in [public/brand/](public/brand/)): deep royal-blue backgrounds with the glowing portal horizon, cyan neon glow, glossy rounded type (Fredoka + Nunito, self-hosted via @fontsource so they work offline) and lime-green accents for active states. Colours and fonts are CSS variables at the top of [src/style.css](src/style.css). Phones and tablets held upright use `background-portrait.webp` (9:16); wide screens use `background.webp`. Replace those files and `logo.webp` to rebrand.

## Run it

```bash
npm install
npm run dev
```

The `dev` server uses HTTPS, which phones require for camera, motion sensors and AR, and is exposed on your LAN. Open the `Network:` URL it prints (e.g. `https://192.168.1.20:5173`) on your phone and accept the self-signed certificate warning.

For desktop testing on the same machine (webcam, plain `http://localhost:5174`):

```bash
npm run dev:local
```

You can also tap **"or use a video file"** on the start screen to run the effect on pre-recorded footage. Lock uses the sensor mode in that case.

## Deploy

```bash
npm run build
```

Upload the `dist/` folder to any static HTTPS host (Vercel, Netlify, GitHub Pages, Cloudflare Pages, S3 + CloudFront). It uses relative paths, so it works from a sub-folder too. **Redeploy after every code change.** A phone opening the hosted link only gets the new version once it's deployed; check the version number in settings.

## Video upload backend

Recorded videos are sent to `POST {BACKEND_URL}/api/videos/upload` as `multipart/form-data` (field `video`, max 250 MB). The response includes `qrCode` (a PNG data URL), which the result screen shows, and `viewUrl`, which the QR points to. See [src/uploader.js](src/uploader.js).

The default backend is `https://ar-backend-3duv.onrender.com`. To use a different one, create a `.env` file (or set the variable in Vercel → Project → Settings → Environment Variables) and rebuild:

```bash
VITE_BACKEND_URL=https://your-backend.example.com
```

The backend runs on Render's free tier, which sleeps when idle. The first upload after a quiet period can take up to a minute while it wakes up; the app shows "Waking up the server…" during that time. Opening the backend URL in a browser a minute before the event starts avoids the wait.

## Using it at an event

1. Tap **Start AR Camera** and allow camera, microphone and (on iOS) motion access.
2. Frame the person from about 2–4 m away with their **full body, including feet**, in view. The pill at the top reads **Person locked** once tracking has them.
3. Tap the **padlock** to lock the text in place (see below).
4. Press **record** and walk slowly around the person, keeping them roughly in frame. Recording stops automatically at 60 s.
5. Tap **Submit**, wait for the QR code, and let the guest scan it to download the clip on their phone (or tap **Download** to save it on the booth phone). Tap **Retake**, then the padlock again to unlock for the next person.

Tips: good lighting improves the cut-out edges. On older phones, set **Body tracking model = Lite** and **Cut-out quality = Fast**.

## Lock button

The padlock appears once a person is detected. Pressing it pins the text and effects to the person's spot **in the room**, so walking around or panning the phone makes them behave like real objects. Tap it again to unlock and go back to following the body.

### AR world lock (Android + Chrome + ARCore)

When the phone supports ARCore, Lock switches Chrome into WebXR AR mode:

1. ARCore starts tracking the phone's position and rotation in the room.
2. The person is found again in the AR camera image. A ray through their feet is hit-tested against the floor to measure their real distance; if no floor is found, the distance is estimated from torso size.
3. The content is placed so it looks **exactly as it did before locking**: same size, shape and screen position. Internally, the pre-lock layout is corrected for the AR camera's wider lens and for the phone's tilt.
4. It's attached to an **ARCore anchor on the floor**. ARCore refines anchors as it maps the room, and the app eases those corrections in so they never jump.

The pill shows e.g. `AR locked · 2.5 m · anchored`. `(est.)` means no floor was found and the distance was estimated. If it stays on **Placing…**, move the phone gently side to side for a second so ARCore can find the floor.

Requirements: an [ARCore-supported phone](https://developers.google.com/ar/devices) with **Google Play Services for AR** installed, Chrome, and the page opened over `https://`. The camera image comes from WebXR camera-access and everything is drawn on the app's own canvas (shown through Chrome's DOM overlay), so the person cut-out and recording keep working in AR mode.

### Sensor lock (fallback)

On phones without working ARCore, Lock uses the motion sensor instead. The text stays centred on the person, keeps a fixed facing in the room as you orbit them (using the compass heading), and its size, distance and lean are frozen at lock time. The pill shows `Sensor lock · 37°`, with the number counting as you walk around. If the text turns the wrong way, enable **Invert 360° gyro direction**. This mode follows the person rather than truly tracking the room.

When Lock falls back, a message says **why** AR lock wasn't available, and the reason also stays next to the version in settings.

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Google Play services keeps stopping" popup | Google's AR service is crashing on that phone. Update **Google Play services**, **Google Play Services for AR** and **Chrome** from the Play Store, clear the AR service's storage, and restart the phone. To avoid the popup entirely, untick **Settings → Lock uses AR world lock**. The app never checks AR support until Lock is tapped. |
| Pill says `Sensor lock …` on an Android phone | Read the fallback message; it names the cause (no `https://`, no ARCore, camera access refused…). |
| Settings show an old version number | The phone has cached old code: close the tab, redeploy if needed, and reopen the link. |

## How it works

Each frame is composited in four layers ([src/arScene.js](src/arScene.js)):

1. Camera image, full-screen with "cover" fit. In AR mode this is the WebXR camera-access image instead.
2. **Back half** of the content. A clipping plane through the person's body axis, facing the camera, removes the near half.
3. **The person**, cut out of the same image with the segmentation mask. This covers anything behind them.
4. **Front half** of the content (the clipping plane is flipped) and the foreground sparklers.

Tracking ([src/tracker.js](src/tracker.js)) runs two MediaPipe tasks on the GPU:

- **PoseLandmarker** finds the shoulders, hips and ankles. These give the content centre, the scale (torso length), the body's up-vector and the floor level.
- **ImageSegmenter** (`selfie_segmenter`, or `selfie_multiclass` for high quality) produces the person mask. MediaPipe draws the mask as 8-bit RGB on its own GL context, and it's blitted into a 2D canvas that Three.js uploads. This avoids float-texture readback, which returns zeros on many GPUs. The mask is blended over time to stop edge flicker.

All content lives under one root group. Normally it sits in camera space. In AR mode the root is pinned to the room: it's placed with a non-uniform scale that matches the virtual lens to the real one, then attached to an ARCore anchor.

| File | Purpose |
| --- | --- |
| [src/main.js](src/main.js) | App flow, UI, settings wiring, render loop, Lock/Unlock |
| [src/arScene.js](src/arScene.js) | Three.js compositor, body anchoring, clipping, AR placement |
| [src/xrLock.js](src/xrLock.js) | WebXR/ARCore session: camera image, floor hit-test, anchors |
| [src/rings.js](src/rings.js) | Curved 3D text, 3D brand logo + side icons, glitter |
| [src/stream.js](src/stream.js) | 3D glass capsules/cubes/spheres rising around the person |
| [src/fireworks.js](src/fireworks.js) | Sparkler fountain particles |
| [src/tracker.js](src/tracker.js) | MediaPipe pose + segmentation |
| [src/filters.js](src/filters.js) | One Euro filter and easing helpers |
| [src/gyro.js](src/gyro.js) | Device-orientation heading/pitch |
| [src/recorder.js](src/recorder.js) | MP4 recording (WebCodecs + mp4-muxer, MediaRecorder fallback) |
| [src/uploader.js](src/uploader.js) | Uploads the video to the backend and returns the QR code |
| [src/settings.js](src/settings.js) | Defaults, persistence and one-time settings migrations |

## Limitations

- **True room tracking needs ARCore.** iPhones (no WebXR AR in any iOS browser) and phones without working ARCore get the sensor lock, which follows the person rather than truly tracking the room.
- **AR mode depends on Chrome's WebXR camera-access feature.** If a Chrome version refuses it, Lock falls back to the sensor lock and says so.
- **Estimated distance can be off.** Without a floor hit, the distance assumes an average torso length (about 0.5 m), so a very tall or short person can be placed roughly 15% too near or far.
- **Fonts are Latin-only.** The 3D fonts are Latin typefaces. For other scripts, convert a TTF with facetype.js and drop the JSON into `public/fonts/`.
- **Uploads need internet.** The booth still records offline, but the QR code only appears once the upload succeeds; use **Download** or **Retry submit** otherwise.
- **WebM only on old browsers.** Browsers with neither WebCodecs nor MP4 MediaRecorder support (rare, older browsers) still record WebM.
