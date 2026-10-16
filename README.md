# Gut Synbio · AR 360 Video Booth (WebAR)

A browser-based AR video booth. Point a phone at a person and the 3D brand logo, rising glass capsules and cubes, sparklers and glitter appear around them, with the person correctly cut out so effects can pass behind their body. Press **Lock** to pin everything to a real spot in the room, walk the phone around the person and record. Tap **Submit** to upload the video, and a **QR code** appears so the guest can scan it and download the clip to their own phone. No app install needed.

Current version: **6.9**. It's shown at the top of **Settings → Camera & tracking**; check it to confirm a phone has the latest code.

## Features

- **3D brand logo "gut SYNBIO".** The front face is the real logo artwork ([public/brand/logo.webp](public/brand/logo.webp), with the small tagline cropped off), so colours, shapes and outline match the brand exactly. A solid navy body is extruded behind it from the logo's outline, so it looks like a thick 3D sign as you walk around, and a soft **glowing border** runs around the lettering with colours sweeping lime → cyan → white → blue. It is gently curved in front of the person. Replace `logo.webp` to change it. Untick **Brand 3D lettering** in settings to use your own 3D text instead (text, colours, italic, height, distance, size, font).
- **Hidden from behind:** the logo and side icons stand in front of the person, so when you walk around behind them (more than about 100°) they disappear, as the body would hide them. They reappear as you come back round. The rising objects all around the body stay visible.
- **3D icons beside the logo:** the **L. reuteri** icon (glass capsules) on the left and the **GOS** icon (blue and lime cubes) on the right, from [public/brand/icon-lreuteri.webp](public/brand/icon-lreuteri.webp) and [public/brand/icon-gos.webp](public/brand/icon-gos.webp). Each is a thick 3D sign (the artwork with its own darkened colours extruded behind it) that floats gently and sways from side to side, so you see its depth. They sit on the same curve as the logo and face the camera; the group shrinks slightly if needed to fit the portrait frame. On top of that, **moving 3D icons** stream out of each sign: glass capsules with short tails rise out of the L. reuteri sign and blue / lime cubes out of the GOS sign, fanning up and outward toward the frame edges (**Reverse icon movement** in settings makes them flow back in). Replace the two files to change the signs; if both are missing, only the moving icons are shown, streaming out from the logo. The moving icons are set in `createFlowIcon` in [src/rings.js](src/rings.js).
- **Real occlusion.** A person segmentation mask cuts the person out of the video, so anything behind them is hidden by their body.
- **Smooth body tracking.** Pose tracking keeps the text on the person's torso and scales it with their size. One Euro filtering removes jitter, and the text glides at 60 fps between 30 fps detections. It pops in when a person appears and shrinks away if they leave the frame.
- **Lock button.** Pins the text and effects in the real room (see below). It uses ARCore surface tracking on supported Android phones and a motion-sensor fallback elsewhere.
- **3D objects rising around the person:** glossy glass **capsules**, blue and lime-green **cubes** and spheres rise straight up out of the floor at spots all around the person (a new random spot each time they rise again; they never move around the body), then fade out between the hips and chest (never reaching the head). They keep the same distance from the body as the 3D logo but never come closer than the body and arms, stay inside the portrait frame, freeze when you press Lock (no jump), and pass behind the body (hidden by the cut-out). Untick **Show rising 3D objects** at the top of the settings panel to hide just these (the logo stays); choose capsules, cubes or both in **Settings → Effects**.
- **FX:** sparkler fountains at the person's feet and twinkling glitter. (The firework bursts that shot up and exploded were removed in 3.1.)
- **Countdown + background music:** pressing record shows a big **5 4 3 2 1** countdown (tap record again to cancel), then recording starts together with the **background music** ([public/music/background.mp3](public/music/background.mp3)). The song plays out loud and the same audio is saved in the video (perfectly in sync, encoded straight from the file, fading out at the end; it loops if the take is longer than the song). It also works on phones whose videos are converted to H.264: the music is remuxed into the converted MP4 ([src/music.js](src/music.js)). After saving, the result screen says whether the music made it into the file (e.g. *music ✓ AAC*, or the reason it didn't). Some phones' AAC encoders leave out the setup bytes MP4 needs or add ADTS headers; the app fixes both. Untick **Background music** in settings for silent videos (or the mic, if enabled). Replace the file to change the song.
- **Recording as MP4:** captures the composited AR canvas as a standard **MP4 (H.264 video)**. Videos are silent by default (no microphone permission asked); tick **Record sound with the video** in settings to add AAC audio that every phone, gallery and messaging app plays. It uses the phone's hardware encoder through WebCodecs plus [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), which works in Chrome on Android, where the built-in recorder only makes WebM. Before recording it finds an encoder setup that really works on that phone: it tries the screen size, then 16-aligned and slightly smaller sizes, several H.264 profiles and hardware/software encoding, and test-encodes a frame (some Android encoders claim support and then fail). If the phone's hardware H.264 encoder is missing or broken, it records smoothly with **VP9** and **converts it to H.264 in the background while you record**, so after you press stop only the last few seconds are left ("Saving video… 90%"). The conversion uses a WebAssembly H.264 encoder in a background worker ([public/h264-worker.js](public/h264-worker.js), MIT-licensed [h264-mp4-encoder](https://github.com/TrevorSundberg/h264-mp4-encoder) in `public/vendor/`) and keeps every frame, so the result is smooth and a standard H.264 MP4 that **WhatsApp** and every gallery accept. The converted video is 800 px on the long edge (WhatsApp shrinks videos to about 850 px anyway) and has no sound. If converting fails, the VP9 MP4 is kept (plays in galleries and Chrome, but not WhatsApp). If none works it uses the browser's own MP4 recorder (Safari/iOS, Chrome 126+), and only then WebM, in which case a message says why. Saving can never hang: every encoder step has a time limit, a phone encoder that stalls during the first seconds is swapped for the browser's recorder mid-take, and whatever was already encoded is kept if the encoder breaks later. Also has photo capture, download and native share on phones. Recording keeps running through Lock and Unlock.
- **Submit + QR download:** after recording, the result screen shows **Submit**, **Download** and **Retake**. **Submit** uploads the MP4 to the [AR backend](https://github.com/Zihan231/AR_Backend) with a live progress bar. When it finishes, a QR code appears next to the video; the guest scans it to open a download page on their own phone. If the upload fails, the reason is shown and the button changes to **Retry submit**. **Retake** discards the clip and cancels any upload still running. Nothing is uploaded unless you tap Submit, and photos are never uploaded.
- **2D photo-booth frame:** a branded frame around the whole video, drawn by the app at the exact screen size ([src/frame.js](src/frame.js)): a glowing cyan → royal → lime border with a white inner line and a navy band outside it, glass capsules down the left side and blue / lime glass cubes down the right (like the 3D icons), molecule networks, tech corner brackets, glowing energy dashes, light streams, sparkles and bubbles, the 2D **gut SYNBIO logo** ([public/brand/overlay-logo.webp](public/brand/overlay-logo.webp)) at the top and a glossy plaque with *ACTIVATING GROWTH THROUGH* **SYNBIOTIC SCIENCE** at the bottom. The record and capture buttons sit just above the plaque. It's part of the AR canvas, so it's in every recorded video and photo, even while locked or in AR mode. **On by default**; untick **Show 2D frame** in settings to hide it. Colours, decorations and text are set in `drawBoothFrame()`.
- **Clean top bar:** the status shows only a dot just below the settings button (orange = looking for a person, green = found / locked; the words are kept as a tooltip). The **Lock**, **360° compass** and **full-screen** buttons are hidden by default; switch them on under **Settings → Top-bar buttons**.
- **Full screen + Home:** the full-screen button (top right of the start screen, and in the top bar) switches the browser to full screen (and back); the 2D frame redraws to fit the new size. Full screen is remembered: when the browser drops it (the camera permission prompt, or Home, which reloads the page), the next tap anywhere puts it back; it's hidden where the browser can't do it, e.g. iPhone Safari. The home button (bottom right) goes back to the start screen for a fresh start; it's blocked while recording.
- **Two frame styles:** pick **Frame style** at the top of the settings panel. *Frame 1* is the drawn frame (border, decorations, 2D logo, tagline plaque). *Frame 2* is the light-stream artwork frame ([public/brand/frame-2.webp](public/brand/frame-2.webp)), which has its own logo, so Frame 1 and its logo aren't shown then. Frame 2's border lines are found in the picture automatically and lined up with the screen edges; its top (logo) and bottom (light streams) keep their true shape and only the plain border between them stretches to fit the screen. Replace the file to use another frame of the same kind.
- **Rising objects dodge your hands:** when the person moves a hand near the rising capsules and cubes, they're pushed away from it and then drift back to their path (wrists and index fingers from body tracking; not in AR world-lock mode).
- **Start-up defaults:** the app opens with the **2D frame** and the **rising 3D objects** on, and the **3D logo + side icons off** (tick **Show 3D elements** to bring them in).
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

## Android app (APK)

The booth is also packaged as an Android app: a **Trusted Web Activity** that opens `https://ar-videobooth-khaki.vercel.app/` full-screen in Chrome. The app code is unchanged, and AR lock, camera, recording and upload work exactly as in Chrome. Because the app loads the live site, **every Vercel deploy updates the app too**; no reinstall needed.

- Web side (in this repo): [public/manifest.webmanifest](public/manifest.webmanifest), the icons in [public/icons/](public/icons/), and [public/.well-known/assetlinks.json](public/.well-known/assetlinks.json). The last one proves the app owns the site, so Android hides Chrome's address bar. It contains the signing key's SHA-256 fingerprint; if the key ever changes, update it.
- Android project: `Desktop\GutSynbio_APK` (outside this repo), made with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap). Package id `com.gutsynbio.arbooth`.
  - `1-create-signing-key.bat` creates `android.keystore` (done once).
  - `2-build-apk.bat` builds `app-release-signed.apk` (install on phones) and `app-release-bundle.aab` (for Google Play).
- **Keep `android.keystore` and its password safe and backed up.** Every update must be signed with the same key, or phones refuse to install it over the old app.
- To release a new app version (only needed if the app shell changes, e.g. name or icon), raise `appVersionCode` and `appVersion` in `twa-manifest.json`, then run `npx bubblewrap update` and `2-build-apk.bat`.

## Video upload backend

Recorded videos are sent to `POST {BACKEND_URL}/api/videos/upload` as `multipart/form-data` (field `video`, max 250 MB). The response includes `qrCode` (a PNG data URL), which the result screen shows, and `viewUrl`, which the QR points to. See [src/uploader.js](src/uploader.js).

The default backend is `https://api-videobooth.gutsynbio.space`. To use a different one, create a `.env` file (or set the variable in Vercel → Project → Settings → Environment Variables) and rebuild:

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

The pill shows e.g. `AR locked · 2.5 m · anchored`. `(est.)` means no floor was found and the distance was estimated. While it shows **Finding the floor…**, move the phone gently side to side with the person's feet in view; it waits up to 5 seconds for ARCore to find the floor before falling back to an estimate (`(est.)`, less accurate).

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
