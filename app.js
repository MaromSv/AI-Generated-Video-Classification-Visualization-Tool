/**
 * Per-Frame Deepfake Analysis Viewer
 *
 * An interactive viewer for per-frame deepfake analysis outputs.
 * Renders prediction timelines, frame-by-frame sliders, and
 * configurable side-by-side feature visualizations.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// Feature Registry  —  THE MAIN EXTENSION POINT
// ═══════════════════════════════════════════════════════════════════════════
//
// Each entry describes one type of visualization that can be shown in a panel.
//
//   id       – unique key used internally and in panel state
//   label    – human-readable name shown in the panel dropdown
//   resolve(meta, frameIdx, currentModel)
//       Returns { url, subtitle } for a given frame, or null when unavailable.
//       `meta`   – the loaded sample metadata object
//       `url`    – *relative* asset path (resolved via assetURL())
//       `subtitle` – optional extra text shown beside the dropdown
//   isSegmentation – if true, the panel gets a hover-to-identify ADE20K tooltip

const FEATURE_REGISTRY = [
    {
        id: "frame",
        label: "Original Frame",
        resolve: (meta, f) => {
            if (!meta.frames?.[f]) return null;
            return { url: meta.frames[f], subtitle: "" };
        },
    },
    {
        id: "flow",
        label: "Optical Flow",
        resolve: (meta, f) => {
            if (!meta.flow_vis?.length) return null;
            const idx = Math.min(f, meta.flow_vis.length - 1);
            return { url: meta.flow_vis[idx], subtitle: `(${idx}\u2192${idx + 1})` };
        },
    },
    {
        id: "accel",
        label: "Acceleration",
        resolve: (meta, f) => {
            if (!meta.accel_vis?.length) return null;
            const idx = Math.min(f, meta.accel_vis.length - 1);
            return { url: meta.accel_vis[idx], subtitle: `(window ${idx})` };
        },
    },
    {
        id: "killing_energy",
        label: "Killing Energy",
        resolve: (meta, f) => {
            const vis = meta.killing_energy_vis || [];
            if (!vis.length) return null;
            const idx = Math.min(f, vis.length - 1);
            return { url: vis[idx], subtitle: `(flow ${idx})` };
        },
    },
    {
        id: "segmentation",
        label: "Segmentation",
        isSegmentation: true,
        resolve: (meta, f) => {
            if (!meta.seg_vis?.[f]) return null;
            return { url: meta.seg_vis[f], subtitle: "" };
        },
    },
    {
        id: "gradcam",
        label: "Grad-CAM",
        resolve: (meta, f, model) => {
            const raw = meta.gradcam_vis;
            if (!raw) return null;
            const list = Array.isArray(raw) ? raw : (raw[model] || []);
            const win = State.getWindowForFrame(f);
            if (!win || !list[win.window_idx]) return null;
            return { url: list[win.window_idx], subtitle: `(window ${win.window_idx})` };
        },
    },

    // ─── ADD NEW FEATURES HERE ───────────────────────────────────────
    // Copy this template and fill in the fields:
    //
    // {
    //     id: "my_new_feature",
    //     label: "My New Feature",
    //     resolve: (meta, frameIdx, currentModel) => {
    //         const vis = meta.my_new_feature_vis || [];
    //         if (!vis.length) return null;
    //         const idx = Math.min(frameIdx, vis.length - 1);
    //         return { url: vis[idx], subtitle: `(frame ${idx})` };
    //     },
    // },
];

// Default layout: which feature each of the 6 panels shows initially.
// Change these or reorder them to set a different default view.
const DEFAULT_PANEL_FEATURES = [
    "frame",
    "flow",
    "accel",
    "killing_energy",
    "segmentation",
    "gradcam",
];

const NUM_PANELS = 6;

// ═══════════════════════════════════════════════════════════════════════════
// Application State
// ═══════════════════════════════════════════════════════════════════════════

const State = {
    dataBase: "",
    manifest: null,
    currentMeta: null,
    currentFrame: 0,
    currentModel: "",
    playInterval: null,
    rafId: null,
    imageCache: new Map(),
    panelFeatures: [...DEFAULT_PANEL_FEATURES],
    controlsInitialized: false,

    /** Predictions for the currently selected model. */
    getPredsForCurrentModel() {
        const p = this.currentMeta?.predictions;
        if (!p) return [];
        if (Array.isArray(p)) return p;          // legacy single-model
        return p[this.currentModel] || [];
    },

    /** P(fake) of the prediction closest to frameIdx. */
    getClosestPred(frameIdx) {
        const preds = this.getPredsForCurrentModel();
        if (!preds.length) return 0.5;
        let best = preds[0], bestD = Math.abs(preds[0].center_frame - frameIdx);
        for (const p of preds) {
            const d = Math.abs(p.center_frame - frameIdx);
            if (d < bestD) { best = p; bestD = d; }
        }
        return best.prob;
    },

    /** Full prediction-window object closest to frameIdx. */
    getWindowForFrame(frameIdx) {
        const preds = this.getPredsForCurrentModel();
        if (!preds.length) return null;
        let best = null, bestD = Infinity;
        for (const p of preds) {
            const d = Math.abs(p.center_frame - frameIdx);
            if (d < bestD) { best = p; bestD = d; }
        }
        return best;
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);

function fillSelect(selector, options, labeler) {
    const el = $(selector);
    el.innerHTML = "";
    for (const val of options) {
        const o = document.createElement("option");
        o.value = val;
        o.textContent = labeler ? labeler(val) : val;
        el.appendChild(o);
    }
}

/** Resolve a relative asset path to a fetchable URL. */
function assetURL(sampleId, relativePath) {
    const full = `samples/${sampleId}/${relativePath}`;
    if (State.dataBase === "__local__/") {
        const file = window.__localFileMap?.get(full);
        return file ? URL.createObjectURL(file) : "";
    }
    return State.dataBase + full;
}

// ═══════════════════════════════════════════════════════════════════════════
// Data Loading
// ═══════════════════════════════════════════════════════════════════════════

async function loadManifestFromURL(baseUrl) {
    if (!baseUrl.endsWith("/")) baseUrl += "/";
    State.dataBase = baseUrl;

    const status = $("#load-status");
    status.className = "status";
    status.textContent = "Loading manifest\u2026";

    try {
        const resp = await fetch(baseUrl + "manifest.json");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        State.manifest = await resp.json();
        const models = State.manifest.model_names || [State.manifest.model || "unknown"];
        status.className = "status ok";
        status.textContent = `Loaded ${State.manifest.total_samples} samples (models: ${models.join(", ")})`;
        initControls();
    } catch (_) {
        // Silent fail — the file picker fallback will be shown instead
        status.textContent = "";
    }
}

async function loadFromFileInput(files) {
    const status = $("#load-status");
    status.className = "status";
    status.textContent = "Reading files\u2026";

    const fileMap = new Map();
    let manifestFile = null;
    for (const f of files) {
        const parts = f.webkitRelativePath.split("/");
        const inner = parts.slice(1).join("/");
        fileMap.set(inner, f);
        if (inner === "manifest.json") manifestFile = f;
    }

    if (!manifestFile) {
        status.className = "status error";
        status.textContent = "No manifest.json found in selected folder.";
        return;
    }

    State.manifest = JSON.parse(await manifestFile.text());
    State.dataBase = "__local__/";
    window.__localFileMap = fileMap;

    const models = State.manifest.model_names || [State.manifest.model || "unknown"];
    status.className = "status ok";
    status.textContent = `Loaded ${State.manifest.total_samples} samples (models: ${models.join(", ")})`;
    initControls();
}

async function fetchSampleMeta(sampleId) {
    const path = `samples/${sampleId}/metadata.json`;
    if (State.dataBase === "__local__/") {
        const file = window.__localFileMap.get(path);
        if (!file) throw new Error("metadata.json not found for " + sampleId);
        return JSON.parse(await file.text());
    }
    const resp = await fetch(State.dataBase + path);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// Controls  (Category / Generator / Sample / Model)
// ═══════════════════════════════════════════════════════════════════════════

function initControls() {
    $("#controls").classList.remove("hidden");
    $("#loader")?.classList.add("hidden");

    const cats = [...new Set(State.manifest.samples.map(s => s.category))].sort();
    fillSelect("#sel-category", cats);

    const models = State.manifest.model_names || [State.manifest.model || "default"];
    fillSelect("#sel-model", models);
    State.currentModel = models[0];

    updateGenerators();

    if (!State.controlsInitialized) {
        State.controlsInitialized = true;
        $("#sel-category").addEventListener("change", updateGenerators);
        $("#sel-generator").addEventListener("change", updateSamples);
        $("#sel-sample").addEventListener("change", loadSample);
        $("#sel-model").addEventListener("change", () => {
            State.currentModel = $("#sel-model").value;
            if (State.currentMeta) { renderPredictionChart(); updateFrameDisplay(); }
        });
    }

    if (cats.length) loadSample();
}

function updateGenerators() {
    const cat = $("#sel-category").value;
    const gens = [...new Set(
        State.manifest.samples.filter(s => s.category === cat).map(s => s.generator)
    )].sort();
    fillSelect("#sel-generator", gens);
    updateSamples();
}

function updateSamples() {
    const cat = $("#sel-category").value;
    const gen = $("#sel-generator").value;
    const samples = State.manifest.samples.filter(
        s => s.category === cat && s.generator === gen
    );
    fillSelect("#sel-sample", samples.map(s => s.sample_id), (id) => {
        const s = samples.find(x => x.sample_id === id);
        return `${s.label_str} \u2014 ${id.split("__").slice(1).join("/")}`;
    });
    loadSample();
}

// ═══════════════════════════════════════════════════════════════════════════
// Sample Loading
// ═══════════════════════════════════════════════════════════════════════════

async function loadSample() {
    const sampleId = $("#sel-sample").value;
    if (!sampleId) return;

    try {
        State.currentMeta = await fetchSampleMeta(sampleId);
    } catch (err) {
        console.error("Failed to load sample:", err);
        return;
    }

    $("#viewer").classList.remove("hidden");

    const badge = $("#label-badge");
    badge.textContent = State.currentMeta.label_str;
    badge.className = "badge " + State.currentMeta.label_str;
    $("#info-text").textContent =
        `${State.currentMeta.num_frames} frames \u00b7 ${State.currentMeta.num_windows} windows`;

    const slider = $("#frame-slider");
    slider.max = State.currentMeta.num_frames - 1;
    slider.value = 0;
    State.currentFrame = 0;

    preloadSampleImages(State.currentMeta);
    renderPredictionChart();
    updateFrameDisplay();
}

// ═══════════════════════════════════════════════════════════════════════════
// Prediction Chart  (Plotly)
// ═══════════════════════════════════════════════════════════════════════════

const MODEL_COLORS = [
    "#58a6ff", "#f0883e", "#a371f7", "#3fb950", "#f778ba",
    "#79c0ff", "#d29922", "#56d4dd", "#e6edf3", "#da3633",
];

function renderPredictionChart() {
    const meta = State.currentMeta;
    const allPreds = meta.predictions;
    const isMulti = allPreds && !Array.isArray(allPreds);
    const models = meta.model_names || (State.manifest.model_names || [State.currentModel]);

    const traces = [];

    if (isMulti) {
        models.forEach((name, i) => {
            const preds = allPreds[name];
            if (!preds?.length) return;
            const active = name === State.currentModel;
            const c = MODEL_COLORS[i % MODEL_COLORS.length];
            traces.push({
                x: preds.map(p => p.center_frame),
                y: preds.map(p => p.prob),
                type: "scatter", mode: "lines+markers", name,
                line: { color: c, width: active ? 3 : 1.5, dash: active ? "solid" : "dot" },
                marker: { color: c, size: active ? 8 : 4 },
                hovertemplate: `${name}<br>Frame %{x}<br>P(fake) = %{y:.3f}<extra></extra>`,
                fill: active ? "tozeroy" : undefined,
                fillcolor: active ? c.replace(")", ",0.08)").replace("rgb", "rgba") : undefined,
                opacity: active ? 1 : 0.6,
            });
        });
    } else {
        const preds = Array.isArray(allPreds) ? allPreds : [];
        if (!preds.length) { Plotly.purge("prediction-chart"); return; }
        traces.push({
            x: preds.map(p => p.center_frame),
            y: preds.map(p => p.prob),
            type: "scatter", mode: "lines+markers",
            name: State.currentModel,
            line: { color: "#58a6ff", width: 2 },
            marker: { color: "#58a6ff", size: 8 },
            hovertemplate: "Frame %{x}<br>P(fake) = %{y:.3f}<extra></extra>",
            fill: "tozeroy", fillcolor: "rgba(88,166,255,0.08)",
        });
    }

    if (!traces.length) { Plotly.purge("prediction-chart"); return; }

    const allX = traces.flatMap(t => t.x);
    // Threshold line
    traces.push({
        x: [Math.min(...allX), Math.max(...allX)], y: [0.5, 0.5],
        type: "scatter", mode: "lines",
        line: { color: "#8b949e", width: 1, dash: "dash" },
        hoverinfo: "skip", showlegend: false,
    });
    // Current-frame diamond
    traces.push({
        x: [State.currentFrame], y: [State.getClosestPred(State.currentFrame)],
        type: "scatter", mode: "markers",
        marker: { color: "#f0f6fc", size: 14, symbol: "diamond",
                  line: { color: "#58a6ff", width: 2 } },
        hoverinfo: "skip", showlegend: false,
    });

    Plotly.newPlot("prediction-chart", traces, {
        paper_bgcolor: "transparent", plot_bgcolor: "transparent",
        margin: { t: 10, b: 40, l: 50, r: 20 },
        xaxis: { title: { text: "Frame", font: { color: "#8b949e", size: 12 } },
                 color: "#8b949e", gridcolor: "#21262d" },
        yaxis: { title: { text: "P(fake)", font: { color: "#8b949e", size: 12 } },
                 color: "#8b949e", gridcolor: "#21262d", range: [0, 1.05] },
        font: { color: "#e6edf3" }, hovermode: "closest",
        showlegend: models.length > 1,
        legend: { orientation: "h", y: 1.12, font: { color: "#e6edf3" } },
    }, { responsive: true, displayModeBar: false });

    document.getElementById("prediction-chart")
        .on("plotly_click", d => { if (d.points?.length) setFrame(d.points[0].x); });
}

function updateChartMarker() {
    const el = document.getElementById("prediction-chart");
    if (!el?.data || el.data.length < 2) return;
    try {
        Plotly.restyle("prediction-chart", {
            x: [[State.currentFrame]], y: [[State.getClosestPred(State.currentFrame)]],
        }, [el.data.length - 1]);
    } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature Panels  —  Dynamic grid with per-panel dropdowns
// ═══════════════════════════════════════════════════════════════════════════

function buildFeaturePanels() {
    const grid = $("#features-grid");
    grid.innerHTML = "";

    for (let i = 0; i < NUM_PANELS; i++) {
        const featureId = State.panelFeatures[i] || "__none__";
        const featureDef = FEATURE_REGISTRY.find(f => f.id === featureId);
        const card = document.createElement("div");
        card.className = "feature-card";
        card.dataset.panelIndex = i;

        // ── Header: dropdown + subtitle ──
        const header = document.createElement("div");
        header.className = "feature-card-header";

        const sel = document.createElement("select");
        sel.className = "panel-feature-select";
        sel.dataset.panelIndex = i;

        const none = document.createElement("option");
        none.value = "__none__";
        none.textContent = "\u2014 None \u2014";
        sel.appendChild(none);

        for (const feat of FEATURE_REGISTRY) {
            const o = document.createElement("option");
            o.value = feat.id;
            o.textContent = feat.label;
            sel.appendChild(o);
        }

        const wp = document.createElement("option");
        wp.value = "__window_prediction__";
        wp.textContent = "Window Prediction";
        sel.appendChild(wp);

        sel.value = featureId;

        const sub = document.createElement("span");
        sub.className = "feat-sub";
        sub.id = `panel-sub-${i}`;

        header.appendChild(sel);
        header.appendChild(sub);
        card.appendChild(header);

        // ── Content area ──
        if (featureId === "__window_prediction__") {
            const box = document.createElement("div");
            box.id = `window-info-${i}`;
            box.className = "window-info-box";
            box.innerHTML = "<p>Select a frame to see prediction details</p>";
            card.appendChild(box);
        } else if (featureDef?.isSegmentation) {
            const wrap = document.createElement("div");
            wrap.className = "seg-hover-container";
            wrap.innerHTML = `
                <img id="panel-img-${i}" class="feature-img" alt="${featureDef.label}">
                <canvas id="panel-canvas-${i}" class="seg-canvas-overlay"></canvas>
                <div id="panel-tooltip-${i}" class="seg-tooltip hidden"></div>`;
            card.appendChild(wrap);
        } else {
            const img = document.createElement("img");
            img.id = `panel-img-${i}`;
            img.className = "feature-img";
            img.alt = featureDef?.label || "";
            card.appendChild(img);
        }

        sel.addEventListener("change", (e) => {
            State.panelFeatures[parseInt(e.target.dataset.panelIndex)] = e.target.value;
            buildFeaturePanels();
            if (State.currentMeta) updateFrameDisplay();
        });

        grid.appendChild(card);
    }

    initAllSegHovers();
}

function updateFrameDisplay() {
    const meta = State.currentMeta;
    const f = State.currentFrame;
    const sid = meta.sample_id;

    $("#frame-counter").textContent = `${f} / ${meta.num_frames - 1}`;

    for (let i = 0; i < NUM_PANELS; i++) {
        const fid = State.panelFeatures[i];

        if (fid === "__window_prediction__") {
            const box = document.getElementById(`window-info-${i}`);
            if (box) renderWindowInfo(box, State.getWindowForFrame(f));
            continue;
        }
        if (fid === "__none__") {
            const img = document.getElementById(`panel-img-${i}`);
            if (img) img.removeAttribute("src");
            const sub = document.getElementById(`panel-sub-${i}`);
            if (sub) sub.textContent = "";
            continue;
        }

        const def = FEATURE_REGISTRY.find(fd => fd.id === fid);
        if (!def) continue;

        const result = def.resolve(meta, f, State.currentModel);
        const img = document.getElementById(`panel-img-${i}`);
        const sub = document.getElementById(`panel-sub-${i}`);

        if (!result?.url) {
            if (img) img.removeAttribute("src");
            if (sub) sub.textContent = "";
            continue;
        }

        const url = assetURL(sid, result.url);
        if (sub) sub.textContent = result.subtitle || "";
        if (img) {
            const cached = State.imageCache.get(url);
            if (cached?.complete && cached.naturalWidth > 0) {
                if (img.src !== cached.src) img.src = cached.src;
            } else {
                if (img.src !== url) img.src = url;
            }
        }

        if (def.isSegmentation && img) {
            const loadCb = () => { updateSegCanvas(i); img.removeEventListener("load", loadCb); };
            if (img.complete && img.naturalWidth) updateSegCanvas(i);
            else img.addEventListener("load", loadCb);
        }
    }
}

function renderWindowInfo(box, win) {
    if (!win) { box.innerHTML = "<p>No prediction window for this frame</p>"; return; }
    const p = win.prob;
    const verdict = p > 0.5 ? "FAKE" : "REAL";
    const vColor = p > 0.5 ? "#da3633" : "#238636";
    const bar = p > 0.7 ? "high" : p > 0.4 ? "mid" : "low";
    box.innerHTML = `
        <table>
            <tr><td>Window</td><td>Frames [${win.frame_range.join(", ")}]</td></tr>
            <tr><td>Center frame</td><td>${win.center_frame}</td></tr>
            <tr><td>Logit</td><td>${win.logit.toFixed(4)}</td></tr>
            <tr><td>P(fake)</td><td><strong>${(p * 100).toFixed(1)}%</strong></td></tr>
            <tr><td>Verdict</td><td style="color:${vColor};font-weight:600">${verdict}</td></tr>
        </table>
        <div class="prob-bar-container">
            <div class="prob-bar ${bar}" style="width:${Math.max(p * 100, 3)}%">
                ${(p * 100).toFixed(1)}%
            </div>
        </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Frame Navigation & Playback
// ═══════════════════════════════════════════════════════════════════════════

function setFrame(idx) {
    if (!State.currentMeta) return;
    idx = Math.max(0, Math.min(idx, State.currentMeta.num_frames - 1));
    State.currentFrame = idx;
    $("#frame-slider").value = idx;
    if (State.rafId) cancelAnimationFrame(State.rafId);
    State.rafId = requestAnimationFrame(() => {
        State.rafId = null;
        updateFrameDisplay();
        updateChartMarker();
    });
}

function togglePlay() {
    if (State.playInterval) {
        clearInterval(State.playInterval);
        State.playInterval = null;
        $("#btn-play").textContent = "\u25B6";
    } else {
        const speed = parseInt($("#playback-speed").value);
        State.playInterval = setInterval(() => {
            const next = State.currentFrame >= State.currentMeta.num_frames - 1
                ? 0 : State.currentFrame + 1;
            setFrame(next);
        }, speed);
        $("#btn-play").textContent = "\u23F8";
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Image Preloading
// ═══════════════════════════════════════════════════════════════════════════

function preloadSampleImages(meta) {
    State.imageCache.clear();
    const sid = meta.sample_id;

    let gcam = [];
    if (meta.gradcam_vis) {
        if (Array.isArray(meta.gradcam_vis)) gcam = meta.gradcam_vis;
        else for (const k of Object.keys(meta.gradcam_vis)) gcam.push(...(meta.gradcam_vis[k] || []));
    }

    const all = [
        ...(meta.frames || []),
        ...(meta.flow_vis || []),
        ...(meta.accel_vis || []),
        ...(meta.killing_energy_vis || []),
        ...(meta.seg_vis || []),
        ...gcam,
    ];

    let i = 0;
    const BATCH = 20;
    (function next() {
        const end = Math.min(i + BATCH, all.length);
        for (; i < end; i++) {
            if (!all[i]) continue;
            const url = assetURL(sid, all[i]);
            if (State.imageCache.has(url)) continue;
            const img = new Image();
            img.src = url;
            State.imageCache.set(url, img);
        }
        if (i < all.length) setTimeout(next, 50);
    })();
}

// ═══════════════════════════════════════════════════════════════════════════
// ADE20K Segmentation Hover
// ═══════════════════════════════════════════════════════════════════════════

const SEG_LABELS = {
    0:"wall",1:"building",2:"sky",3:"floor",4:"tree",5:"ceiling",6:"road",7:"bed",
    8:"windowpane",9:"grass",10:"cabinet",11:"sidewalk",12:"person",13:"earth",14:"door",
    15:"table",16:"mountain",17:"plant",18:"curtain",19:"chair",20:"car",21:"water",
    22:"painting",23:"sofa",24:"shelf",25:"house",26:"sea",27:"mirror",28:"rug",29:"field",
    30:"armchair",31:"seat",32:"fence",33:"desk",34:"rock",35:"wardrobe",36:"lamp",
    37:"bathtub",38:"railing",39:"cushion",40:"base",41:"box",42:"column",43:"signboard",
    44:"chest of drawers",45:"counter",46:"sand",47:"sink",48:"skyscraper",49:"fireplace",
    50:"refrigerator",51:"grandstand",52:"path",53:"stairs",54:"runway",55:"case",
    56:"pool table",57:"pillow",58:"screen door",59:"stairway",60:"river",61:"bridge",
    62:"bookcase",63:"blind",64:"coffee table",65:"toilet",66:"flower",67:"book",68:"hill",
    69:"bench",70:"countertop",71:"stove",72:"palm",73:"kitchen island",74:"computer",
    75:"swivel chair",76:"boat",77:"bar",78:"arcade machine",79:"hovel",80:"bus",81:"towel",
    82:"light",83:"truck",84:"tower",85:"chandelier",86:"awning",87:"streetlight",88:"booth",
    89:"television",90:"airplane",91:"dirt track",92:"apparel",93:"pole",94:"land",
    95:"bannister",96:"escalator",97:"ottoman",98:"bottle",99:"buffet",100:"poster",
    101:"stage",102:"van",103:"ship",104:"fountain",105:"conveyer belt",106:"canopy",
    107:"washer",108:"plaything",109:"swimming pool",110:"stool",111:"barrel",112:"basket",
    113:"waterfall",114:"tent",115:"bag",116:"minibike",117:"cradle",118:"oven",119:"ball",
    120:"food",121:"step",122:"tank",123:"trade name",124:"microwave",125:"pot",126:"animal",
    127:"bicycle",128:"lake",129:"dishwasher",130:"screen",131:"blanket",132:"sculpture",
    133:"hood",134:"sconce",135:"vase",136:"traffic light",137:"tray",138:"ashcan",139:"fan",
    140:"pier",141:"crt screen",142:"plate",143:"monitor",144:"bulletin board",145:"shower",
    146:"radiator",147:"glass",148:"clock",149:"flag"
};

const _ade20kRGB = new Map();

function _buildColorLookup() {
    if (_ade20kRGB.size) return;
    for (let i = 0; i < 256; i++) {
        let lab = i, r = 0, g = 0, b = 0, bit = 0;
        while (lab) {
            r |= ((lab >> 0) & 1) << (7 - bit);
            g |= ((lab >> 1) & 1) << (7 - bit);
            b |= ((lab >> 2) & 1) << (7 - bit);
            bit++; lab >>= 3;
        }
        _ade20kRGB.set(`${r},${g},${b}`, i);
    }
}

function ade20kColor(idx) {
    let lab = idx, r = 0, g = 0, b = 0, i = 0;
    while (lab) {
        r |= ((lab >> 0) & 1) << (7 - i);
        g |= ((lab >> 1) & 1) << (7 - i);
        b |= ((lab >> 2) & 1) << (7 - i);
        i++; lab >>= 3;
    }
    return `rgb(${r},${g},${b})`;
}

function rgbToSegLabel(r, g, b) {
    const exact = _ade20kRGB.get(`${r},${g},${b}`);
    if (exact !== undefined && exact < 150) return exact;
    let best = 0, bestD = Infinity;
    for (const [k, idx] of _ade20kRGB) {
        if (idx >= 150) continue;
        const [cr, cg, cb] = k.split(",").map(Number);
        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (d < bestD) { bestD = d; best = idx; }
    }
    return best;
}

function updateSegCanvas(panelIdx) {
    const img = document.getElementById(`panel-img-${panelIdx}`);
    const cvs = document.getElementById(`panel-canvas-${panelIdx}`);
    if (!img || !cvs || !img.complete || !img.naturalWidth) return;
    cvs.width = img.naturalWidth;
    cvs.height = img.naturalHeight;
    cvs.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
    cvs._ready = true;
}

function initAllSegHovers() {
    _buildColorLookup();
    for (let i = 0; i < NUM_PANELS; i++) {
        const def = FEATURE_REGISTRY.find(f => f.id === State.panelFeatures[i]);
        if (!def?.isSegmentation) continue;

        const wrap = document.querySelector(`.feature-card[data-panel-index="${i}"] .seg-hover-container`);
        const cvs = document.getElementById(`panel-canvas-${i}`);
        const tip = document.getElementById(`panel-tooltip-${i}`);
        if (!wrap || !cvs || !tip) continue;

        wrap.addEventListener("mousemove", (e) => {
            if (!cvs._ready) return;
            const img = document.getElementById(`panel-img-${i}`);
            const r = img.getBoundingClientRect();
            const px = Math.floor((e.clientX - r.left) * (cvs.width / r.width));
            const py = Math.floor((e.clientY - r.top) * (cvs.height / r.height));
            if (px < 0 || py < 0 || px >= cvs.width || py >= cvs.height) { tip.classList.add("hidden"); return; }

            const d = cvs.getContext("2d", { willReadFrequently: true }).getImageData(px, py, 1, 1).data;
            const li = rgbToSegLabel(d[0], d[1], d[2]);
            tip.innerHTML = `<span class="seg-swatch" style="background:${ade20kColor(li)}"></span><strong>${li}</strong> ${SEG_LABELS[li] || "class_" + li}`;
            tip.classList.remove("hidden");

            const cr = wrap.getBoundingClientRect();
            let tx = e.clientX - cr.left + 12, ty = e.clientY - cr.top - 28;
            if (tx + 160 > cr.width) tx -= 170;
            if (ty < 0) ty = e.clientY - cr.top + 16;
            tip.style.left = tx + "px";
            tip.style.top = ty + "px";
        });

        wrap.addEventListener("mouseleave", () => tip.classList.add("hidden"));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
    buildFeaturePanels();

    $("#manifest-file")?.addEventListener("change", (e) => {
        if (e.target.files.length) loadFromFileInput(e.target.files);
    });

    $("#frame-slider").addEventListener("input", (e) => setFrame(parseInt(e.target.value)));
    $("#btn-prev").addEventListener("click", () => setFrame(State.currentFrame - 1));
    $("#btn-next").addEventListener("click", () => setFrame(State.currentFrame + 1));
    $("#btn-play").addEventListener("click", togglePlay);

    document.addEventListener("keydown", (e) => {
        if (!State.currentMeta) return;
        if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
        switch (e.key) {
            case "ArrowLeft":  e.preventDefault(); setFrame(State.currentFrame - 1); break;
            case "ArrowRight": e.preventDefault(); setFrame(State.currentFrame + 1); break;
            case " ":          e.preventDefault(); togglePlay(); break;
        }
    });

    loadManifestFromURL("../perframe_analysis_output/").then(() => {
        if (!State.manifest) $("#loader")?.classList.remove("hidden");
    });
});
