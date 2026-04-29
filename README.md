# Per-Frame Deepfake Analysis Viewer

An interactive browser-based viewer for inspecting per-frame deepfake detection outputs. Browse samples by category/generator, scrub through frames, view prediction timelines, and compare feature visualizations side-by-side.

## Quick Start

### 1. Serve the data with any static HTTP server

The viewer expects your analysis output folder to be served at `../perframe_analysis_output/` relative to the viewer directory. There are two common setups:

#### Standalone (recommended for sharing)

```
my_analysis/
├── perframe_analysis_output/    ← your data
│   ├── manifest.json
│   └── samples/
│       └── ...
└── viewer/                      ← copy this folder here
    ├── index.html
    ├── app.js
    └── style.css
```

```bash
cd my_analysis
python -m http.server 8000
```

Open [http://localhost:8000/viewer/](http://localhost:8000/viewer/)

#### Inside a larger project (e.g. this repo)

If the viewer lives at `external/viewer/`, place your data at `external/perframe_analysis_output/`:

```
project_root/
├── external/
│   ├── perframe_analysis_output/   ← your data
│   │   ├── manifest.json
│   │   └── samples/
│   └── viewer/                     ← this folder
│       ├── index.html
│       ├── app.js
│       └── style.css
```

```bash
cd project_root
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000)

### 2. Or load a local folder

If you can't run a server, just open `index.html` directly. The auto-load will fail and a file picker will appear — click it and select your data folder. This uses the browser's local file API.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `←` / `→` | Previous / next frame |
| `Space` | Play / pause |

## Data Format

The viewer reads a `manifest.json` and per-sample `metadata.json` files. See the `example_data/` folder for a complete reference.

### `manifest.json` (top-level)

```json
{
    "total_samples": 2,
    "model_names": ["resnet50_seg", "convnext_tiny"],
    "samples": [
        {
            "sample_id": "fake__FaceSwap__video_001",
            "category": "fake",
            "generator": "FaceSwap",
            "label_str": "fake"
        }
    ]
}
```

### `samples/<sample_id>/metadata.json`

```json
{
    "sample_id": "fake__FaceSwap__video_001",
    "label_str": "fake",
    "num_frames": 5,
    "num_windows": 2,
    "model_names": ["resnet50_seg", "convnext_tiny"],

    "frames":              ["frames/frame_0000.jpg", "..."],
    "flow_vis":            ["flow/flow_0000.jpg", "..."],
    "accel_vis":           ["accel/accel_0000.jpg", "..."],
    "killing_energy_vis":  ["killing_energy/ke_0000.jpg", "..."],
    "seg_vis":             ["seg/seg_0000.png", "..."],

    "gradcam_vis": {
        "resnet50_seg":  ["gradcam/resnet50_seg/gcam_win0.jpg", "..."],
        "convnext_tiny": ["gradcam/convnext_tiny/gcam_win0.jpg", "..."]
    },

    "predictions": {
        "resnet50_seg": [
            {
                "window_idx": 0,
                "center_frame": 1,
                "frame_range": [0, 2],
                "logit": 2.15,
                "prob": 0.896
            }
        ]
    }
}
```

All image paths are **relative to the sample folder**. Images can be `.jpg` or `.png`.

### Folder structure per sample

```
samples/<sample_id>/
├── metadata.json
├── frames/          ← original video frames (one per frame)
│   ├── frame_0000.jpg
│   └── ...
├── flow/            ← optical flow visualizations
│   └── flow_0000.jpg
├── accel/           ← acceleration visualizations
│   └── accel_0000.jpg
├── killing_energy/  ← killing energy field visualizations
│   └── ke_0000.jpg
├── seg/             ← semantic segmentation maps (ADE20K palette)
│   └── seg_0000.png
└── gradcam/         ← per-model Grad-CAM overlays (one per prediction window)
    ├── resnet50_seg/
    │   └── gcam_win0.jpg
    └── convnext_tiny/
        └── gcam_win0.jpg
```

## Configurable Panels

Each of the 6 visualization panels has a dropdown selector. You can change what any panel displays at runtime — choose from Original Frame, Optical Flow, Acceleration, Killing Energy, Segmentation, Grad-CAM, Window Prediction, or None.

## Adding New Features

To add a new visualization type (e.g., warp error, divergence, depth maps):

1. **Generate the images** — save them in a subfolder under each sample (e.g., `warp_error/warp_0000.jpg`).

2. **Add the paths to `metadata.json`** — add a new array field:
   ```json
   "warp_error_vis": ["warp_error/warp_0000.jpg", "warp_error/warp_0001.jpg"]
   ```

3. **Register it in `app.js`** — add an entry to the `FEATURE_REGISTRY` array at the top of the file:
   ```js
   {
       id: "warp_error",
       label: "Warp Error",
       resolve: (meta, frameIdx) => {
           const vis = meta.warp_error_vis || [];
           if (!vis.length) return null;
           const idx = Math.min(frameIdx, vis.length - 1);
           return { url: vis[idx], subtitle: `(frame ${idx})` };
       },
   },
   ```

That's it — the dropdown will automatically include the new option.

## Using with Different Models

The viewer supports multiple models out of the box. Just include `model_names` in your manifest and structure `predictions` and `gradcam_vis` as objects keyed by model name (see the data format above). A model selector dropdown appears automatically when multiple models are present.
