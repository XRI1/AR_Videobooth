# AR 360 Video Booth (WebAR)

A browser-based AR video booth. Point a phone at a person and curved 3D text, fireworks and sparklers appear around them, with the person correctly cut out so effects can pass behind their body. Press **Lock** to pin everything to a real spot in the room, walk the phone around the person, record, then download or share the video. No app install needed.

Current version: **1.9**. It's shown at the top of **Settings → Camera & tracking**; check it to confirm a phone has the latest code.

## Features

- **Curved 3D text.** Extruded, bevelled text ("GUT GUARDIAN" by default) gently curved around the front of the person. You can set its text, colours, italic, height on the body, distance from the body, size and font. A second text ring and orbiting logo badges are available in settings but off by default.
- **Real occlusion.** A person segmentation mask cuts the person out of the video, so anything behind them is hidden by their body.
- **Smooth body tracking.** Pose tracking keeps the text on the person's torso and scales it with their size. One Euro filtering removes jitter, and the text glides at 60 fps between 30 fps detections. It pops in when a person appears and shrinks away if they leave the frame.
- **Lock button.** Pins the text and effects in the real room (see below). It uses ARCore surface tracking on supported Android phones and a motion-sensor fallback elsewhere.
- **3D light stream:** glowing blue ribbons spiral diagonally around the person, with glossy glass **capsules**, blue and lime-green **cubes** and spheres flowing along them, light pulses and sparkles. It passes behind the body (hidden by the cut-out) and in front, and follows Lock like the text. Choose capsules, cubes or both in **Settings → Effects**.
- **FX:** fireworks behind the person (rockets, peony, ring and willow bursts), sparkler fountains at their feet, and twinkling glitter.
- **Recording as MP4:** captures the composited AR canvas plus microphone audio as a standard **MP4 (H.264 video + AAC audio)** that every phone, gallery and messaging app plays. It uses the phone's hardware encoder through WebCodecs plus [mp4-muxer](https://github.com/Vanilagy/mp4-muxer), which works in Chrome on Android, where the built-in recorder only makes WebM. It falls back to the browser's own MP4 recorder (Safari/iOS), and only then to WebM. Also has photo capture, download and native share on phones. Recording keeps running through Lock and Unlock.
- **Offline-friendly:** settings are saved per device, and the ML models and runtime are self-hosted, so nothing loads from third-party CDNs at the venue.

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

## Using it at an event

1. Tap **Start AR Camera** and allow camera, microphone and (on iOS) motion access.
2. Frame the person from about 2–4 m away with their **full body, including feet**, in view. The pill at the top reads **Person locked** once tracking has them.
3. Tap the **padlock** to lock the text in place (see below).
4. Press **record** and walk slowly around the person, keeping them roughly in frame. Recording stops automatically at 60 s.
5. **Download** or **Share** the clip. Tap the padlock again to unlock for the next person.

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
2. **Back half** of the content and the background fireworks. A clipping plane through the person's body axis, facing the camera, removes the near half.
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
| [src/rings.js](src/rings.js) | Curved 3D text, badges, glitter |
| [src/stream.js](src/stream.js) | 3D light stream: glowing ribbons + flowing glass capsules/cubes |
| [src/fireworks.js](src/fireworks.js) | Particle rockets, bursts, fountains |
| [src/tracker.js](src/tracker.js) | MediaPipe pose + segmentation |
| [src/filters.js](src/filters.js) | One Euro filter and easing helpers |
| [src/gyro.js](src/gyro.js) | Device-orientation heading/pitch |
| [src/recorder.js](src/recorder.js) | MP4 recording (WebCodecs + mp4-muxer, MediaRecorder fallback) |
| [src/settings.js](src/settings.js) | Defaults, persistence and one-time settings migrations |

## Limitations

- **True room tracking needs ARCore.** iPhones (no WebXR AR in any iOS browser) and phones without working ARCore get the sensor lock, which follows the person rather than truly tracking the room.
- **AR mode depends on Chrome's WebXR camera-access feature.** If a Chrome version refuses it, Lock falls back to the sensor lock and says so.
- **Estimated distance can be off.** Without a floor hit, the distance assumes an average torso length (about 0.5 m), so a very tall or short person can be placed roughly 15% too near or far.
- **Fonts are Latin-only.** The 3D fonts are Latin typefaces. For other scripts, convert a TTF with facetype.js and drop the JSON into `public/fonts/`.
- **WebM only on old browsers.** Browsers with neither WebCodecs nor MP4 MediaRecorder support (rare, older browsers) still record WebM.
