<p align="center">
  <img width="220" alt="Recordly Logo" src="https://github.com/user-attachments/assets/414b8838-6731-45d4-a815-6e3c0aa1fe52" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Linux%20%C2%B7%20COSMIC%20Wayland-111827?style=for-the-badge" alt="Linux COSMIC Wayland" />
  <img src="https://img.shields.io/badge/open%20source-AGPL3.0-2563eb?style=for-the-badge" alt="AGPL 3.0 license" />
</p>

# Recordly for Linux

An offline screen recorder and editor for walkthroughs, demos and product videos, built for Linux on the COSMIC Wayland desktop.

This is a standalone fork of Recordly. It has no accounts, no sign-in, no cloud sharing, no telemetry and no remote feeds: recordings, projects and exports stay on your machine.

---

## Features

### Recording

- Native COSMIC Wayland capture (ext-image-copy-capture), including rotated monitors; "Pick screen" selects the monitor you click on
- Microphone and system audio through PulseAudio/PipeWire, kept in sync with the video
- Cursor position and clicks recorded through a native helper, so auto-zoom and the cursor overlay work on Wayland
- Webcam overlay recording
- Jump straight from recording into the editor

### Timeline and editing

- Drag-and-drop timeline editing
- Trims, manual zooms and automatic zoom suggestions from cursor activity
- Speed-up and slow-down regions
- Text, image and figure annotations
- Extra audio regions
- Crop and aspect-ratio presets
- Save and reopen `.recordly` project files

### Cursor

- Rendered cursor overlay with size, smoothing, motion blur, click bounce and sway
- Cursor loop mode for looping exports

### Webcam overlay

- Mirror, size, position presets or custom X/Y, margin, roundness and shadow
- Optional zoom-reactive scaling

### Frame styling

- Built-in and custom wallpapers, solid colors and gradients
- Padding, rounded corners, background blur and drop shadows

### Export

- MP4 and GIF export to a local file
- Quality, frame rate, GIF loop and size presets
- Reveal exported files in the file manager

<p>
  <img src="./docs/media/feature1.gif" width="450" alt="Recordly cursor and zoom demo">
</p>

<p>
  <img src="./docs/media/feature2.gif" width="450" alt="Recordly webcam overlay demo">
</p>

---

## Build from source

Prerequisites (Pop!_OS / Ubuntu):

```bash
sudo apt install build-essential cmake libwayland-dev pulseaudio-utils
```

Your user must be in the `input` group for click capture.

```bash
git clone https://github.com/jmarceno/Recordly-Linux.git recordly
cd recordly
npm install
npm run build:linux
```

The AppImage is written to `release/Recordly-linux-x64.AppImage`. Run `npm run dev` for a development build.

---

## Usage

1. Launch Recordly.
2. Pick the screen to record.
3. Choose microphone, system audio and webcam options.
4. Start recording; stop it to open the editor.
5. Edit, then export to MP4 or GIF.

Save your work anytime as a `.recordly` project.

---

## Network use

Recordly works fully offline. It only goes online when you ask it to:

- downloading the Whisper speech model for auto-captions;
- adding a custom font from Google Fonts.

---

## License

Recordly is licensed under the **AGPL 3.0**.

## Credits

Recordly was created by [@webadderall](https://github.com/webadderall/Recordly) and originally started as a fork of [OpenScreen](https://github.com/siddharthvaddem/openscreen). This Linux fork is maintained at https://github.com/jmarceno/Recordly-Linux.
