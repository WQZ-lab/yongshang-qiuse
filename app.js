/* =====================================================================
 * 甬上秋色 · 手势画册
 * 右手张合显色 / 拇指食指捏合放大 / 左手挥动翻页
 * MediaPipe HandLandmarker + Canvas 2D + Web Audio
 * ===================================================================== */

/* ---------------- 可调参数 ---------------- */
const CONFIG = {
  spring: { k: 30, d: 9.4 },          // 秋色显影的软弹簧
  open: { min: 1.02, max: 1.72 },     // 指尖伸展比映射区间
  pinch: { near: 0.18, far: 0.64 },   // 捏合程度
  photo: { maxZoom: 1.85, ratio: 1.5 },
  swipe: { minOpen: 0.52, dist: 0.17, windowMs: 900, cooldownMs: 1050 },
  hands: { swap: false },
  camera: { width: { ideal: 1280 }, height: { ideal: 720 } },
  mp: {
    bundle:    "./vendor/mediapipe/vision_bundle.js",
    bundleAlt: "./vendor/mediapipe/vision_bundle.mjs",
    wasm:      "./vendor/mediapipe/wasm",
    model:     "./vendor/models/hand_landmarker.task",
  },
  transitionDur: 1.05,
  handAway: { holdMs: 1300, revealRest: 0.85 },
  music: {
    url: "assets/music/yongshang-video-loop.mp3",
    gain: 0.22,
    fadeIn: 6,
  },
};

/* ---------------- 小工具 ---------------- */
const clamp01 = v => Math.min(1, Math.max(0, v));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = v => { v = clamp01(v); return v * v * (3 - 2 * v); };
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const TAU = Math.PI * 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const params = new URLSearchParams(location.search);
const STILL = params.get("still") === "1";
const DEMO_START = params.get("demo") === "1";
const lockReveal = (() => {
  const v = parseFloat(params.get("reveal"));
  return Number.isFinite(v) ? clamp01(v) : null;
})();
const lockZoom = (() => {
  const v = parseFloat(params.get("z"));
  return Number.isFinite(v) ? clamp(v, 1, CONFIG.photo.maxZoom) : null;
})();

/* ---------------- 九帧宁波秋色 ---------------- */
const PHOTOS = [
  { src: "assets/photos/01_east_new_city.jpg",      place: "东部新城",   caption: "楼群尚在远处，秋色已经进城",   px: 0.50, py: 0.50 },
  { src: "assets/photos/02_bridge_water.jpg",       place: "水岸桥影",   caption: "一桥横水，把秋分成两半",       px: 0.50, py: 0.52 },
  { src: "assets/photos/03_lake_autumn.jpg",        place: "湖心秋林",   caption: "树环着水，水映着树",           px: 0.50, py: 0.50 },
  { src: "assets/photos/04_skyline.jpg",            place: "新城天际",   caption: "玻璃幕墙，也接住了一层秋光",   px: 0.52, py: 0.50 },
  { src: "assets/photos/05_lakeside.jpg",           place: "湖畔疏影",   caption: "芦花低垂，城影入水",           px: 0.50, py: 0.52 },
  { src: "assets/photos/06_green_axis.jpg",         place: "绿轴晚照",   caption: "园在城中，秋在园心",           px: 0.50, py: 0.50 },
  { src: "assets/photos/07_bridge_reflection.jpg",  place: "杉影桥韵",   caption: "杉列成行，桥影成环",           px: 0.50, py: 0.53 },
  { src: "assets/photos/08_metasequoia_avenue.jpg", place: "金色杉道",   caption: "两列水杉，一路鎏金",           px: 0.50, py: 0.46 },
  { src: "assets/photos/09_rockery.jpg",            place: "石语秋光",   caption: "石上生秋，城下成林",           px: 0.48, py: 0.50 },
];

/* ---------------- 全局状态 ---------------- */
const state = {
  time: 0,
  reveal: 0.88,
  revealVel: 0,
  manualReveal: 0.88,
  index: 0,
  transition: null,
  zoom: 1,
  zoomTarget: 1,
  focusX: PHOTOS[0].px,
  focusY: PHOTOS[0].py,
  focusTX: PHOTOS[0].px,
  focusTY: PHOTOS[0].py,
  lastHandAt: 0,
  particles: [],
  burst: [],
  partAcc: 0,
  hands: { right: null, left: null },
  handSeen: { right: -1e9, left: -1e9 },
  handCount: 0,
  mode: "loading",
  libraryError: "",
  demo: false,
  still: STILL,
  started: false,
  noHandSince: 0,
};

/* ---------------- DOM ---------------- */
const stage   = document.getElementById("stage");
const ctx     = stage.getContext("2d");
const video   = document.getElementById("cam");
const skel    = document.getElementById("skel");
const skelCtx = skel.getContext("2d");
const el = {
  brandTitle: document.getElementById("brandTitle"),
  chapter:    document.getElementById("chapter"),
  idxNow:     document.getElementById("idxNow"),
  placeName:  document.getElementById("placeName"),
  caption:    document.getElementById("caption"),
  ticks:      document.getElementById("ticks"),
  camWrap:    document.getElementById("camWrap"),
  toast:      document.getElementById("toast"),
  hint:       document.getElementById("hint"),
  gate:       document.getElementById("gate"),
  startBtn:   document.getElementById("startBtn"),
  soundBtn:   document.getElementById("soundBtn"),
  muteGlyph:  document.getElementById("muteGlyph"),
  reveal:     document.getElementById("reveal"),
  blackout:   document.getElementById("blackout"),
  errDetail:  document.getElementById("errDetail"),
  tagLeft:    document.getElementById("tagLeft"),
  tagRight:   document.getElementById("tagRight"),
};

/* ---------------- 画布与版式 ---------------- */
let W = 0, H = 0, DPR = 1;
let L = {};
let backdrop = null;
let backdropCtx = null;

function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  stage.width = Math.round(W * DPR);
  stage.height = Math.round(H * DPR);
  stage.style.width = W + "px";
  stage.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingQuality = "high";
  L = computeLayout();
  buildBackdrop();
  updateChapterPosition();
}

function computeLayout() {
  const portrait = W / H < 1.05;
  document.body.classList.toggle("portrait", portrait);
  let area;
  if (portrait) {
    const mx = Math.max(16, W * 0.055);
    area = { x: mx, y: H * 0.185, w: W - mx * 2, h: H * 0.34 };
  } else {
    const left = Math.min(Math.max(W * 0.245, 246), 440);
    const gap = Math.max(18, W * 0.012);
    const padTop = Math.max(44, H * 0.068);
    const padRight = Math.max(28, W * 0.028);
    area = {
      x: left + gap,
      y: padTop,
      w: W - left - gap - padRight,
      h: H - padTop * 2,
    };
  }
  const ar = CONFIG.photo.ratio;
  let pw = area.w, ph = pw / ar;
  if (ph > area.h) { ph = area.h; pw = ph * ar; }
  const print = {
    x: area.x + (area.w - pw) / 2,
    y: area.y + (area.h - ph) / 2,
    w: pw, h: ph,
  };
  const border = Math.max(7, Math.min(14, Math.min(W, H) * 0.0115));
  const inner = {
    x: print.x + border, y: print.y + border,
    w: print.w - border * 2, h: print.h - border * 2,
  };
  return { portrait, area, print, inner, border };
}

function updateChapterPosition() {
  if (!el.chapter) return;
  if (L.portrait) {
    el.chapter.style.top = Math.round(L.print.y + L.print.h + Math.max(24, H * 0.042)) + "px";
  } else {
    el.chapter.style.top = "";
  }
}

/* ---------------- 纸面底图（一次生成） ---------------- */
function softEllipseOn(c, cx, cy, rx, ry, color, alpha) {
  if (alpha <= 0.001) return;
  c.save();
  c.translate(cx, cy);
  c.scale(Math.max(1, rx), Math.max(1, ry));
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.55, rgba(color, alpha * 0.36));
  g.addColorStop(1, rgba(color, 0));
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill();
  c.restore();
}

function buildBackdrop() {
  if (!backdrop) {
    backdrop = document.createElement("canvas");
    backdropCtx = backdrop.getContext("2d");
  }
  backdrop.width = Math.round(W * DPR);
  backdrop.height = Math.round(H * DPR);
  const c = backdropCtx;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, W, H);

  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#f3ebda");
  g.addColorStop(0.52, "#eee4d1");
  g.addColorStop(1, "#e6dac3");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);

  // 左上暖光、纸面淡淡墨气
  const lg = c.createRadialGradient(W * 0.18, H * 0.10, 0, W * 0.18, H * 0.10, Math.max(W, H) * 0.92);
  lg.addColorStop(0, "rgba(255, 244, 219, 0.62)");
  lg.addColorStop(0.5, "rgba(255, 238, 206, 0.18)");
  lg.addColorStop(1, "rgba(255, 238, 206, 0)");
  c.fillStyle = lg;
  c.fillRect(0, 0, W, H);

  softEllipseOn(c, W * 0.05, H * 1.02, W * 0.34, H * 0.22, [122, 98, 66], 0.05);
  softEllipseOn(c, W * 0.98, H * 0.05, W * 0.28, H * 0.18, [150, 128, 96], 0.035);

  // 照片的落纸柔影
  const pr = L.print;
  c.save();
  c.shadowColor = "rgba(66, 48, 26, 0.24)";
  c.shadowBlur = Math.min(62, Math.min(W, H) * 0.048);
  c.shadowOffsetY = Math.min(18, H * 0.017);
  c.fillStyle = "#f7f0e1";
  c.fillRect(pr.x, pr.y, pr.w, pr.h);
  c.restore();

  // 纸纤维与斑点
  if (paperTex) {
    c.save();
    c.globalCompositeOperation = "multiply";
    c.globalAlpha = 0.62;
    const pat = c.createPattern(paperTex, "repeat");
    if (pat) {
      c.fillStyle = pat;
      c.fillRect(0, 0, W, H);
    }
    c.restore();
  }

  // 四缘极淡的收边
  const vg = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.max(W, H) * 0.78);
  vg.addColorStop(0, "rgba(74, 58, 36, 0)");
  vg.addColorStop(1, "rgba(74, 58, 36, 0.055)");
  c.fillStyle = vg;
  c.fillRect(0, 0, W, H);
}

/* ---------------- 纸纹与颗粒 ---------------- */
let grainPat = null, paperTex = null;

function makeTextures() {
  const g = document.createElement("canvas");
  g.width = g.height = 128;
  const gc = g.getContext("2d");
  const id = gc.createImageData(128, 128);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = 128 + ((Math.random() * 80 - 40) | 0);
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  gc.putImageData(id, 0, 0);
  grainPat = ctx.createPattern(g, "repeat");

  const p = document.createElement("canvas");
  p.width = p.height = 256;
  const pc = p.getContext("2d");
  pc.fillStyle = "#f4eee1";
  pc.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    pc.fillStyle = `rgba(${176 + Math.random() * 46 | 0},${164 + Math.random() * 46 | 0},${140 + Math.random() * 46 | 0},${0.035 + Math.random() * 0.04})`;
    pc.beginPath();
    pc.arc(Math.random() * 256, Math.random() * 256, 0.8 + Math.random() * 6, 0, TAU);
    pc.fill();
  }
  pc.strokeStyle = "rgba(116, 100, 76, 0.035)";
  pc.lineWidth = 0.7;
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * 256, y = Math.random() * 256;
    const a = Math.random() * TAU, l = 3 + Math.random() * 13;
    pc.beginPath();
    pc.moveTo(x, y);
    pc.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    pc.stroke();
  }
  paperTex = p;
}

/* ---------------- Web Audio ---------------- */
const audio = {
  ok: false, ctx: null, silent: false, source: null, buffer: null, gain: null, master: null,
  async init() {
    if (this.ctx) {
      this.ok = true;
      if (!this.source) this.load();
      return true;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const c = (this.ctx = new AC());
      this.master = c.createGain();
      this.master.gain.value = 0.9;
      const comp = c.createDynamicsCompressor();
      this.master.connect(comp);
      comp.connect(c.destination);
      this.gain = c.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.master);
      this.ok = true;
      await this.load();
      return true;
    } catch (e) {
      this.ok = false;
      console.warn("音频初始化失败：", e);
      return false;
    }
  },
  async load() {
    if (!this.ctx || this.source) return;
    try {
      const res = await fetch(CONFIG.music.url, { cache: "force-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.arrayBuffer();
      this.buffer = await this.ctx.decodeAudioData(arr);
      this.start();
    } catch (e) {
      console.warn("背景音乐未加载：", e);
    }
  },
  start() {
    const c = this.ctx;
    if (!c || !this.buffer || this.source) return;
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = this.buffer.duration;
    src.connect(this.gain);
    src.start();
    this.source = src;
    if (this.silent) return;
    const t = c.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(0, t);
    this.gain.gain.linearRampToValueAtTime(CONFIG.music.gain, t + CONFIG.music.fadeIn);
  },
  setSilent(s) {
    this.silent = s;
    if (!this.ok) return;
    if (s) {
      if (this.ctx.state === "running") this.ctx.suspend();
    } else if (!document.hidden && this.ctx.state === "suspended") {
      this.ctx.resume();
      if (this.source) {
        this.gain.gain.setTargetAtTime(CONFIG.music.gain, this.ctx.currentTime, 1.4);
      }
    }
  },
  pageSuspend() {
    if (this.ok && this.ctx.state === "running") this.ctx.suspend();
  },
  pageResume() {
    if (this.ok && !this.silent && !document.hidden && this.ctx.state === "suspended") this.ctx.resume();
  },
};

/* ---------------- 照片预载 ---------------- */
for (const p of PHOTOS) {
  p.ready = false;
  p.img = new Image();
  p.img.onload = () => { p.ready = true; };
  p.img.onerror = () => console.warn("照片加载失败：", p.src);
  p.img.src = p.src;
}

/* ---------------- HUD ---------------- */
function buildTicks() {
  if (!el.ticks) return;
  el.ticks.innerHTML = "";
  PHOTOS.forEach(() => {
    const s = document.createElement("span");
    el.ticks.appendChild(s);
  });
}

function updateHUD(animate) {
  const p = PHOTOS[state.index];
  if (!p) return;
  if (el.idxNow) el.idxNow.textContent = String(state.index + 1).padStart(2, "0");
  if (el.placeName) el.placeName.textContent = p.place;
  if (el.caption) el.caption.textContent = p.caption;
  if (el.ticks) {
    [...el.ticks.children].forEach((t, i) => t.classList.toggle("on", i === state.index));
  }
  if (animate && el.placeName && el.placeName.animate) {
    const common = { duration: 760, easing: "cubic-bezier(0.22, 0.9, 0.24, 1)", fill: "both" };
    el.placeName.animate([
      { opacity: 0, transform: "translateY(8px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], common);
    if (el.caption) {
      el.caption.animate([
        { opacity: 0, transform: "translateY(7px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], { ...common, duration: 920 });
    }
    if (el.idxNow) {
      el.idxNow.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 620, easing: "ease-out" });
    }
  }
}

/* ---------------- 换页 ---------------- */
function switchPhoto(dir) {
  if (state.transition) return;
  const from = state.index;
  state.index = (state.index + dir + PHOTOS.length) % PHOTOS.length;
  state.transition = { t: 0, from };
  state.focusTX = PHOTOS[state.index].px;
  state.focusTY = PHOTOS[state.index].py;
  spawnBurst();
  updateHUD(true);
}

/* ---------------- 飘叶 ---------------- */
const LEAF_COLS = [[200, 133, 63], [185, 113, 47], [217, 162, 82], [143, 90, 43]];

function spawnLeaf(prewarm) {
  const xMin = L.portrait ? 0.02 : 0.30;
  state.particles.push({
    x: xMin + Math.random() * (1.04 - xMin),
    y: prewarm ? Math.random() * 0.9 : -0.06,
    vx: 0.010 + Math.random() * 0.030,
    vy: 0.020 + Math.random() * 0.030,
    s: 4 + Math.random() * 7,
    rot: Math.random() * TAU,
    vr: (Math.random() * 2 - 1) * 0.9,
    ph: Math.random() * TAU,
    sway: 0.010 + Math.random() * 0.018,
    age: prewarm ? Math.random() * 6 : 0,
    life: 8 + Math.random() * 6,
    col: LEAF_COLS[(Math.random() * LEAF_COLS.length) | 0],
    a: 0.16 + Math.random() * 0.26,
  });
}

function prewarmLeaves(n) {
  for (let i = 0; i < n && state.particles.length < 40; i++) spawnLeaf(true);
}

function spawnBurst() {
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * TAU;
    const sp = 0.010 + Math.random() * 0.035;
    state.burst.push({
      x: 0.5, y: 0.5,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 0.006,
      s: 3.5 + Math.random() * 5,
      rot: Math.random() * TAU,
      vr: (Math.random() * 2 - 1) * 2.6,
      t: 0,
      life: 1.2 + Math.random() * 0.7,
      col: LEAF_COLS[(Math.random() * LEAF_COLS.length) | 0],
    });
  }
}

function updateParticles(dt) {
  state.partAcc += dt * 1.15;
  while (state.partAcc >= 1) {
    state.partAcc -= 1;
    if (state.particles.length < 36) spawnLeaf(false);
  }
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.age += dt;
    p.x += (p.vx + Math.sin(state.time * 0.8 + p.ph) * p.sway) * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    if (p.age > p.life || p.y > 1.10 || p.x > 1.10) state.particles.splice(i, 1);
  }
  for (let i = state.burst.length - 1; i >= 0; i--) {
    const p = state.burst[i];
    p.t += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 0.0035 * dt;
    p.vx *= 0.996;
    p.rot += p.vr * dt;
    if (p.t > p.life) state.burst.splice(i, 1);
  }
}

function ginkgoPath(c, s) {
  c.beginPath();
  c.moveTo(0, s * 0.55);
  c.quadraticCurveTo(-s * 0.80, s * 0.06, -s * 0.60, -s * 0.47);
  c.quadraticCurveTo(-s * 0.32, -s * 0.58, -s * 0.11, -s * 0.43);
  c.quadraticCurveTo(-s * 0.03, -s * 0.37, 0, -s * 0.41);
  c.quadraticCurveTo(s * 0.03, -s * 0.37, s * 0.11, -s * 0.43);
  c.quadraticCurveTo(s * 0.32, -s * 0.58, s * 0.60, -s * 0.47);
  c.quadraticCurveTo(s * 0.80, s * 0.06, 0, s * 0.55);
  c.closePath();
}

function drawLeaves() {
  const leavesA = 0.2 + 0.8 * state.reveal;
  for (const p of state.particles) {
    const fadeIn = Math.min(1, p.age / 1.4);
    const fadeOut = Math.min(1, (p.life - p.age) / 1.6);
    const a = p.a * fadeIn * fadeOut * leavesA;
    if (a <= 0.008) continue;
    ctx.save();
    ctx.translate(p.x * W, p.y * H);
    ctx.rotate(p.rot);
    ctx.globalAlpha = a;
    ctx.fillStyle = rgba(p.col, 1);
    ginkgoPath(ctx, p.s);
    ctx.fill();
    ctx.globalAlpha = a * 0.55;
    ctx.strokeStyle = rgba([247, 232, 200], 1);
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, p.s * 0.5);
    ctx.lineTo(0, -p.s * 0.22);
    ctx.stroke();
    ctx.restore();
  }

  for (const p of state.burst) {
    const a = Math.max(0, 1 - p.t / p.life);
    ctx.save();
    ctx.translate((L.inner.x + p.x * L.inner.w), (L.inner.y + p.y * L.inner.h));
    ctx.rotate(p.rot);
    ctx.globalAlpha = a * 0.42 * (0.3 + 0.7 * state.reveal);
    ctx.fillStyle = rgba(p.col, 1);
    ginkgoPath(ctx, p.s);
    ctx.fill();
    ctx.restore();
  }
}

/* =====================================================================
 * 手势识别 —— MediaPipe HandLandmarker
 * =================================================================== */
let landmarker = null, camReady = false, lastDetect = 0, camStream = null;
let visionLib = null, visionFileset = null;

const HAND_LINKS = [
  [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8], [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16], [13,17],[17,18],[18,19],[19,20], [0,17],
];

async function loadVisionLibrary() {
  const candidates = [CONFIG.mp.bundle, CONFIG.mp.bundleAlt].filter(Boolean);
  const problems = [];
  let lib = null;

  for (const url of candidates) {
    try {
      lib = await import(/* @vite-ignore */ url);
      break;
    } catch (e) {
      const line = `import("${url}") → ${e.name}: ${e.message}`;
      problems.push(line);
      console.error("[手势库]", line, e);
    }
  }

  if (!lib) {
    visionLib = null; visionFileset = null;
    state.libraryError = problems.join(" ｜ ");
    showErrorDetail(state.libraryError);
    return false;
  }
  if (!lib.FilesetResolver) {
    visionLib = null; visionFileset = null;
    state.libraryError = "模块已加载，但缺少 FilesetResolver 导出";
    showErrorDetail(state.libraryError);
    return false;
  }

  visionLib = lib;
  try {
    visionFileset = await lib.FilesetResolver.forVisionTasks(CONFIG.mp.wasm);
  } catch (e) {
    visionLib = null; visionFileset = null;
    state.libraryError = `FilesetResolver.forVisionTasks("${CONFIG.mp.wasm}") → ${e.name}: ${e.message}`;
    console.error("[手势库 wasm]", state.libraryError, e);
    showErrorDetail(state.libraryError);
    return false;
  }

  state.libraryError = "";
  hideErrorDetail();
  return true;
}

async function loadHandModel() {
  try {
    if (!visionLib || !visionFileset) return false;
    landmarker = await visionLib.HandLandmarker.createFromOptions(visionFileset, {
      baseOptions: { modelAssetPath: CONFIG.mp.model, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    hideErrorDetail();
    return true;
  } catch (e) {
    const line = `HandLandmarker.createFromOptions("${CONFIG.mp.model}") → ${e.name}: ${e.message}`;
    state.libraryError = line;
    showErrorDetail(line);
    console.error("[模型]", line, e);
    landmarker = null;
    return false;
  }
}

async function initCamera() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return "unsupported";
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: CONFIG.camera.width, height: CONFIG.camera.height, facingMode: "user" },
      audio: false,
    });
    video.srcObject = stream;
    camStream = stream;
    await video.play();
    camReady = true;
    el.camWrap.classList.remove("hidden");
    return "ok";
  } catch (e) {
    console.warn("摄像头不可用：", e);
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "denied";
    if (n === "NotFoundError" || n === "OverconstrainedError") return "notfound";
    return "error";
  }
}

function stopCamera() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  video.srcObject = null;
  camReady = false;
  if (el.camWrap) el.camWrap.classList.add("hidden");
  state.hands.right = null;
  state.hands.left = null;
  state.handCount = 0;
  skelCtx.clearRect(0, 0, skel.width, skel.height);
}

async function resumeCamera() {
  if (state.mode !== "camera" || camReady || document.hidden) return;
  showToast("正在重新请求摄像头…", 0);
  const r = await initCamera();
  if (r === "ok") showToast("把手伸进画面", 4200);
  else showToast(camFailMessage(r).text, 5200);
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(res => setTimeout(() => res(false), ms))]);
}

const camFailMessage = reason => ({
  denied:      { text: "摄像头不可用 / 被拒绝", tip: "请在浏览器地址栏左侧的摄像头图标里改为「允许」，然后刷新页面。" },
  notfound:    { text: "摄像头不可用 · 未找到设备", tip: "请确认摄像头已连接且未被其他程序独占，然后重试。" },
  unsupported: { text: "摄像头不可用 · 当前环境不支持", tip: "请用 localhost 或 HTTPS 访问，并换用新版 Chrome。" },
  error:       { text: "摄像头不可用 · 取流失败", tip: "请关闭占用摄像头的其他程序后按 C 重新开启。" },
}[reason] || { text: "摄像头不可用", tip: "请检查设备与浏览器权限后重试。" });

function handMetrics(lm) {
  const wrist = lm[0];
  const handSize = dist(lm[0], lm[9]) + 1e-6;
  const tips = [8, 12, 16, 20], mcps = [5, 9, 13, 17];
  let sum = 0;
  for (let k = 0; k < 4; k++) sum += dist(lm[tips[k]], wrist) / dist(lm[mcps[k]], wrist);
  const open = clamp01((sum / 4 - CONFIG.open.min) / (CONFIG.open.max - CONFIG.open.min));
  const pinch = dist(lm[4], lm[8]) / handSize;
  return {
    open,
    pinch,
    x: 1 - lm[0].x,
    y: lm[0].y,
    pinchX: 1 - (lm[4].x + lm[8].x) / 2,
    pinchY: (lm[4].y + lm[8].y) / 2,
    t: performance.now(),
  };
}

const swipe = {
  points: [], cooldownUntil: 0,
  update(x, open, now) {
    if (now < this.cooldownUntil || open < CONFIG.swipe.minOpen) {
      this.points.length = 0;
      return 0;
    }
    this.points.push({ x, t: now });
    while (this.points.length && now - this.points[0].t > CONFIG.swipe.windowMs) this.points.shift();
    if (this.points.length >= 3) {
      const dx = this.points[this.points.length - 1].x - this.points[0].x;
      if (Math.abs(dx) > CONFIG.swipe.dist) {
        this.cooldownUntil = now + CONFIG.swipe.cooldownMs;
        this.points.length = 0;
        return dx > 0 ? -1 : 1;
      }
    }
    return 0;
  },
};

function drawSkeleton(lm, color) {
  const w = skel.width, h = skel.height;
  skelCtx.strokeStyle = color;
  skelCtx.fillStyle = color;
  skelCtx.lineWidth = 4;
  skelCtx.lineCap = "round";
  skelCtx.globalAlpha = 0.9;
  for (const [a, b] of HAND_LINKS) {
    skelCtx.beginPath();
    skelCtx.moveTo((1 - lm[a].x) * w, lm[a].y * h);
    skelCtx.lineTo((1 - lm[b].x) * w, lm[b].y * h);
    skelCtx.stroke();
  }
  for (const p of lm) {
    skelCtx.beginPath();
    skelCtx.arc((1 - p.x) * w, p.y * h, 6, 0, TAU);
    skelCtx.fill();
  }
  skelCtx.globalAlpha = 1;
}

const swapHands = params.get("swap") === "1" ? true : CONFIG.hands.swap;

function detect(now) {
  if (!landmarker || !camReady || video.readyState < 2 || now - lastDetect < 33) return;
  lastDetect = now;
  let res;
  try { res = landmarker.detectForVideo(video, now); } catch (e) { return; }

  state.hands.right = null;
  state.hands.left = null;
  state.handCount = 0;
  skelCtx.clearRect(0, 0, skel.width, skel.height);

  const lms = res.landmarks || [];
  const hds = res.handedness || [];
  const labelOf = i => {
    let l = hds[i] && hds[i][0] ? hds[i][0].categoryName : "Right";
    if (swapHands) l = l === "Left" ? "Right" : "Left";
    return l;
  };

  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i];
    const label = labelOf(i);
    const hand = handMetrics(lm);
    state.handCount++;
    if (label === "Left") {
      state.hands.left = hand;
      state.handSeen.left = now;
      const dir = swipe.update(hand.x, hand.open, now);
      if (dir) switchPhoto(dir);
      drawSkeleton(lm, "#7f9a86");
    } else {
      state.hands.right = hand;
      state.handSeen.right = now;
      drawSkeleton(lm, "#c8873f");
    }
  }
}

/* ---------------- 屏幕点 → 图片归一化坐标 ---------------- */
function screenToImagePoint(sx, sy) {
  const p = PHOTOS[state.index];
  if (!p || !p.ready) return null;
  const inner = L.inner;
  const iw = p.img.naturalWidth, ih = p.img.naturalHeight;
  const s = Math.max(inner.w / iw, inner.h / ih);
  const ox = inner.x + (inner.w - iw * s) / 2;
  const oy = inner.y + (inner.h - ih * s) / 2;
  const u = (sx - ox) / (iw * s);
  const v = (sy - oy) / (ih * s);
  if (u < -0.04 || u > 1.04 || v < -0.04 || v > 1.04) return null;
  return { x: clamp(u, 0.06, 0.94), y: clamp(v, 0.06, 0.94) };
}

/* =====================================================================
 * 照片绘制
 * =================================================================== */
let filterOK = null;
function supportsFilter() {
  if (filterOK == null) filterOK = typeof ctx.filter === "string";
  return filterOK;
}

function drawCovered(img, inner, zoom, fx, fy, alpha, reveal) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) return;
  const innerAspect = inner.w / inner.h;
  let cw, ch;
  if (iw / ih > innerAspect) {
    ch = ih;
    cw = ih * innerAspect;
  } else {
    cw = iw;
    ch = iw / innerAspect;
  }
  const z = Math.max(1, zoom);
  cw /= z;
  ch /= z;
  const cx = clamp(fx * iw, cw / 2, iw - cw / 2);
  const cy = clamp(fy * ih, ch / 2, ih - ch / 2);

  ctx.save();
  ctx.beginPath();
  ctx.rect(inner.x, inner.y, inner.w, inner.h);
  ctx.clip();
  ctx.globalAlpha = alpha;
  if (supportsFilter()) {
    const r = reveal;
    const sat = 0.12 + 0.88 * r;
    const con = 1.06 - 0.11 * (1 - r);
    const sep = 0.24 * (1 - r);
    const bri = 1.04 - 0.03 * r;
    ctx.filter = `saturate(${sat}) contrast(${con}) sepia(${sep}) brightness(${bri})`;
  }
  ctx.drawImage(img, cx - cw / 2, cy - ch / 2, cw, ch, inner.x, inner.y, inner.w, inner.h);
  if (supportsFilter()) ctx.filter = "none";
  ctx.restore();
}

function drawPhotoAtmosphere(reveal, transitionK) {
  const inner = L.inner;
  ctx.save();
  ctx.beginPath();
  ctx.rect(inner.x, inner.y, inner.w, inner.h);
  ctx.clip();

  // 显影不足时的一层纸色薄雾（墨影感）
  const ink = (1 - reveal);
  if (ink > 0.01) {
    const wash = ctx.createLinearGradient(inner.x, inner.y, inner.x + inner.w, inner.y + inner.h);
    wash.addColorStop(0, `rgba(243, 235, 218, ${ink * 0.46})`);
    wash.addColorStop(0.55, `rgba(240, 231, 213, ${ink * 0.34})`);
    wash.addColorStop(1, `rgba(236, 226, 207, ${ink * 0.44})`);
    ctx.fillStyle = wash;
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
    softEllipseOn(ctx, inner.x + inner.w * 0.28, inner.y + inner.h * 0.52, inner.w * 0.42, inner.h * 0.30,
      [255, 250, 238], ink * 0.16);
    softEllipseOn(ctx, inner.x + inner.w * 0.76, inner.y + inner.h * 0.72, inner.w * 0.34, inner.h * 0.24,
      [246, 236, 216], ink * 0.12);
  }

  // 秋日斜光
  const lg = ctx.createRadialGradient(
    inner.x + inner.w * 0.20, inner.y + inner.h * 0.14, 0,
    inner.x + inner.w * 0.20, inner.y + inner.h * 0.14, inner.w * 0.95
  );
  lg.addColorStop(0, `rgba(255, 222, 158, ${0.17 * reveal})`);
  lg.addColorStop(0.45, `rgba(255, 220, 156, ${0.055 * reveal})`);
  lg.addColorStop(1, "rgba(255, 220, 156, 0)");
  ctx.fillStyle = lg;
  ctx.fillRect(inner.x, inner.y, inner.w, inner.h);

  ctx.save();
  const beam = ctx.createLinearGradient(inner.x, inner.y, inner.x + inner.w * 0.72, inner.y + inner.h);
  beam.addColorStop(0, `rgba(255, 230, 178, ${0.10 * reveal})`);
  beam.addColorStop(0.5, `rgba(255, 228, 172, ${0.045 * reveal})`);
  beam.addColorStop(1, "rgba(255, 228, 172, 0)");
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(inner.x + inner.w * 0.03, inner.y);
  ctx.lineTo(inner.x + inner.w * 0.36, inner.y);
  ctx.lineTo(inner.x + inner.w * 0.92, inner.y + inner.h);
  ctx.lineTo(inner.x + inner.w * 0.56, inner.y + inner.h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 暗角
  const cx = inner.x + inner.w / 2, cy = inner.y + inner.h / 2;
  const vg = ctx.createRadialGradient(cx, cy, Math.min(inner.w, inner.h) * 0.30, cx, cy, Math.max(inner.w, inner.h) * 0.72);
  vg.addColorStop(0, "rgba(38, 30, 18, 0)");
  vg.addColorStop(0.74, "rgba(38, 30, 18, 0.055)");
  vg.addColorStop(1, "rgba(38, 30, 18, 0.20)");
  ctx.fillStyle = vg;
  ctx.fillRect(inner.x, inner.y, inner.w, inner.h);

  // 换页时的一线柔光
  if (transitionK > 0 && transitionK < 1) {
    ctx.fillStyle = `rgba(255, 244, 218, ${0.13 * Math.sin(Math.PI * transitionK)})`;
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
  }

  ctx.restore();
}

function drawPhotoGrain() {
  if (!grainPat) return;
  const inner = L.inner;
  ctx.save();
  ctx.beginPath();
  ctx.rect(inner.x, inner.y, inner.w, inner.h);
  ctx.clip();
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = grainPat;
  ctx.fillRect(inner.x, inner.y, inner.w, inner.h);
  ctx.restore();
}

function drawPrintEdge() {
  const pr = L.print, inner = L.inner;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 250, 238, 0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pr.x + 0.5, pr.y + 0.5, pr.w - 1, pr.h - 1);
  ctx.strokeStyle = "rgba(60, 48, 32, 0.24)";
  ctx.lineWidth = 1;
  ctx.strokeRect(inner.x + 0.5, inner.y + 0.5, inner.w - 1, inner.h - 1);
  ctx.restore();
}

/* =====================================================================
 * 主循环
 * =================================================================== */
function render(dt) {
  if (!backdrop) return;

  if (state.transition) {
    state.transition.t += dt / CONFIG.transitionDur;
    if (state.transition.t >= 1) state.transition = null;
  }
  const tr = state.transition;
  const k = tr ? smooth(tr.t) : 1;
  const reveal = state.reveal;
  const cur = PHOTOS[state.index];

  ctx.drawImage(backdrop, 0, 0, W, H);

  // 装裱纸边
  ctx.fillStyle = "#f7f0e1";
  ctx.fillRect(L.print.x, L.print.y, L.print.w, L.print.h);

  if (tr) {
    const old = PHOTOS[tr.from];
    if (old.ready) {
      drawCovered(old.img, L.inner, state.zoom, old.px, old.py, 1 - k, reveal);
    }
    if (cur.ready) {
      drawCovered(cur.img, L.inner, state.zoom, state.focusX, state.focusY, k, reveal);
    }
  } else if (cur.ready) {
    drawCovered(cur.img, L.inner, state.zoom, state.focusX, state.focusY, 1, reveal);
  }

  drawPhotoAtmosphere(reveal, tr ? tr.t : 0);
  drawPhotoGrain();
  drawPrintEdge();
  drawLeaves();
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.time += dt;

  detect(now);

  if (el.tagLeft) el.tagLeft.classList.toggle("on", now - state.handSeen.left < 400);
  if (el.tagRight) el.tagRight.classList.toggle("on", now - state.handSeen.right < 400);

  const rightFresh = state.hands.right && now - state.hands.right.t < 420;
  const leftFresh = state.hands.left && now - state.hands.left.t < 420;
  const primary = rightFresh ? state.hands.right : (leftFresh ? state.hands.left : null);

  /* ----- 秋色显影：手张开 → 色彩回来；握拳 → 只剩墨影 ----- */
  let target;
  if (state.mode === "camera") {
    if (primary) {
      target = primary.open;
      state.noHandSince = 0;
      state.lastHandAt = now;
    } else {
      if (!state.noHandSince) state.noHandSince = now;
      const gone = (now - state.noHandSince) / 1000;
      target = gone > CONFIG.handAway.holdMs / 1000
        ? CONFIG.handAway.revealRest
        : state.reveal;
    }
  } else {
    target = state.manualReveal;
  }

  /* ----- 捏合放大 ----- */
  let zt = state.zoomTarget;
  if (primary && primary.open > 0.30) {
    const pinchT = smooth(clamp01((primary.pinch - CONFIG.pinch.near) / (CONFIG.pinch.far - CONFIG.pinch.near)));
    const close = 1 - pinchT;
    if (close > 0.06) {
      zt = 1 + (CONFIG.photo.maxZoom - 1) * close;
      const pt = screenToImagePoint(primary.pinchX * W, primary.pinchY * H);
      if (pt) {
        state.focusTX = pt.x;
        state.focusTY = pt.y;
      }
    } else {
      zt = 1;
      const p = PHOTOS[state.index];
      state.focusTX = p.px;
      state.focusTY = p.py;
    }
  } else if (primary || now - state.lastHandAt > CONFIG.handAway.holdMs) {
    zt = 1;
    const p = PHOTOS[state.index];
    state.focusTX = p.px;
    state.focusTY = p.py;
  }
  state.zoomTarget = zt;

  if (lockReveal != null) {
    state.reveal = lockReveal;
    state.revealVel = 0;
  } else {
    state.revealVel += (target - state.reveal) * CONFIG.spring.k * dt;
    state.revealVel *= Math.exp(-CONFIG.spring.d * dt);
    state.reveal = clamp01(state.reveal + state.revealVel * dt);
    if (state.reveal <= 0 || state.reveal >= 1) state.revealVel = 0;
  }

  if (lockZoom != null) {
    state.zoom = state.zoomTarget = lockZoom;
  } else {
    const kz = 1 - Math.exp(-dt * 11);
    state.zoom += (state.zoomTarget - state.zoom) * kz;
  }
  const kf = 1 - Math.exp(-dt * 7);
  state.focusX += (state.focusTX - state.focusX) * kf;
  state.focusY += (state.focusTY - state.focusY) * kf;

  updateParticles(dt);
  render(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* =====================================================================
 * 提示 / 错误
 * =================================================================== */
let toastTimer = null;
function showToast(text, ms = 4200) {
  if (!el.toast || state.demo || state.still) return;
  el.toast.textContent = text;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
}

function showErrorDetail(txt) {
  if (!el.errDetail || !txt) return;
  el.errDetail.textContent = `[加载诊断] ${txt}`;
  el.errDetail.classList.remove("hidden");
}
function hideErrorDetail() {
  if (!el.errDetail) return;
  el.errDetail.classList.add("hidden");
  el.errDetail.textContent = "";
}

function enterFallback(msg, tip) {
  state.mode = "fallback";
  state.manualReveal = Math.max(state.reveal, 0.8);
  el.camWrap.classList.add("hidden");
  video.style.display = "none";
  skel.style.display = "none";
  showToast(msg || "手动模式 · 空格显色，方向键翻页，滚轮放大", 7000);
  if (tip) showErrorDetail(tip);
}

/* =====================================================================
 * 降级输入：键盘 / 鼠标
 * =================================================================== */
window.addEventListener("keydown", e => {
  if (!state.started && !STILL) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) state.manualReveal = 1;
  } else if (e.code === "ArrowRight") {
    switchPhoto(1);
  } else if (e.code === "ArrowLeft") {
    switchPhoto(-1);
  } else if (e.code === "KeyM") {
    syncSoundUI(!audio.silent);
  } else if (e.code === "KeyR") {
    state.zoomTarget = 1;
    const p = PHOTOS[state.index];
    state.focusTX = p.px;
    state.focusTY = p.py;
    if (lockZoom != null) state.zoom = 1;
    showToast("已复位画面", 2400);
  } else if (e.code === "KeyC") {
    if (camReady) {
      stopCamera();
      showToast("摄像头已关闭 · 按 C 重新开启", 4200);
    } else {
      resumeCamera();
    }
  } else if (e.code === "KeyD") {
    setDemo(!state.demo);
  } else if (e.code === "Escape" && state.demo) {
    setDemo(false);
  }
});

window.addEventListener("keyup", e => {
  if (e.code === "Space" && !STILL) state.manualReveal = 0.85;
});

/* ---------------- 演示模式 ---------------- */
let blackoutTimer = null;
function setDemo(on) {
  if (state.demo === on) return;
  el.blackout.classList.add("on");
  clearTimeout(blackoutTimer);
  blackoutTimer = setTimeout(() => {
    state.demo = on;
    document.body.classList.toggle("demo", on);
    el.blackout.classList.remove("on");
    if (on) {
      el.toast.classList.remove("show");
      el.hint.classList.remove("show");
      hideErrorDetail();
    }
  }, 180);
}

/* ---------------- 开场揭幕 ---------------- */
function playReveal() {
  const rv = el.reveal;
  if (!rv) return;
  rv.classList.remove("hidden", "play", "fade");
  void rv.offsetWidth;
  rv.classList.add("play");
  setTimeout(() => rv.classList.add("fade"), 1100);
  setTimeout(() => { rv.classList.add("hidden"); rv.classList.remove("play", "fade"); }, 1500);
}

/* ---------------- 声音 ---------------- */
function syncSoundUI(silent) {
  audio.setSilent(silent);
  el.muteGlyph.textContent = silent ? "静" : "♪";
  el.soundBtn.classList.toggle("muted", silent);
}
el.soundBtn.addEventListener("click", () => syncSoundUI(!audio.silent));

/* ---------------- 摄像头小窗拖动 ---------------- */
skel.width = 1280;
skel.height = 720;
(function setupCamDrag() {
  const w = el.camWrap;
  if (!w) return;
  try {
    const saved = JSON.parse(localStorage.getItem("ningboCamPos") || "null");
    if (saved && typeof saved.x === "number") {
      w.style.right = "auto"; w.style.bottom = "auto";
      w.style.left = (saved.x * 100) + "vw";
      w.style.top = (saved.y * 100) + "vh";
    }
  } catch (e) { /* ignore */ }
  let dragging = false, ox = 0, oy = 0;
  const onDown = e => {
    dragging = true;
    w.classList.add("dragging");
    const r = w.getBoundingClientRect();
    ox = e.clientX - r.left; oy = e.clientY - r.top;
    e.preventDefault();
  };
  const onMove = e => {
    if (!dragging) return;
    w.style.right = "auto"; w.style.bottom = "auto";
    const nx = Math.max(0, Math.min(window.innerWidth - w.offsetWidth, e.clientX - ox));
    const ny = Math.max(0, Math.min(window.innerHeight - w.offsetHeight, e.clientY - oy));
    w.style.left = nx + "px";
    w.style.top = ny + "px";
    try {
      localStorage.setItem("ningboCamPos", JSON.stringify({ x: nx / window.innerWidth, y: ny / window.innerHeight }));
    } catch (e) { /* ignore */ }
  };
  const onUp = () => { dragging = false; w.classList.remove("dragging"); };
  w.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
})();

/* ---------------- 音频与摄像头卫生 ---------------- */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    audio.pageSuspend();
    stopCamera();
  } else {
    audio.pageResume();
    resumeCamera();
  }
});
window.addEventListener("blur", () => {
  audio.pageSuspend();
  stopCamera();
});
window.addEventListener("focus", () => {
  if (!document.hidden) {
    audio.pageResume();
    resumeCamera();
  }
});

/* ---------------- 鼠标降级 ---------------- */
let dragging = false;
window.addEventListener("mousedown", e => {
  if ((!state.started && !STILL) || e.target.closest("#gate") || e.target.closest("button") || e.target.closest("#camWrap")) return;
  dragging = true;
  state.manualReveal = clamp01(1 - e.clientY / window.innerHeight);
});
window.addEventListener("mousemove", e => {
  if (!dragging) return;
  state.manualReveal = clamp01(1 - e.clientY / window.innerHeight);
});
window.addEventListener("mouseup", () => { dragging = false; });

window.addEventListener("wheel", e => {
  if (!state.started && !STILL) return;
  e.preventDefault();
  const step = e.deltaY > 0 ? -0.12 : 0.12;
  state.zoomTarget = clamp(state.zoomTarget + step, 1, CONFIG.photo.maxZoom);
}, { passive: false });

/* ---------------- 入口 ---------------- */
function showHint() {
  if (!el.hint || state.demo) return;
  setTimeout(() => el.hint.classList.add("show"), 650);
  setTimeout(() => el.hint.classList.remove("show"), 9000);
}

el.startBtn.addEventListener("click", async () => {
  if (state.started) return;
  state.started = true;
  el.gate.classList.add("hide");
  playReveal();
  audio.init();
  if (audio.ctx && !audio.silent && !document.hidden && audio.ctx.state === "suspended") {
    audio.ctx.resume();
  }
  showHint();

  showToast("正在加载手势库…", 0);
  if (!(await withTimeout(loadVisionLibrary(), 15000))) {
    enterFallback("手势库加载失败 · 见下方诊断",
      "请确认 vendor/mediapipe 下的库与 wasm 文件完整，并通过本地服务访问。");
    return;
  }

  showToast("正在请求摄像头权限…", 0);
  const camRes = await withTimeout(initCamera(), 12000);
  if (camRes !== "ok") {
    const m = camFailMessage(camRes === false ? "error" : camRes);
    enterFallback(camRes === false ? "摄像头请求超时" : m.text,
      camRes === false ? "授权弹窗无响应，请在 Chrome 里允许摄像头后刷新页面。" : m.tip);
    return;
  }

  showToast("正在加载手势模型…", 0);
  if (!(await withTimeout(loadHandModel(), 25000))) {
    stopCamera();
    enterFallback("模型加载失败",
      "请确认 vendor/models/hand_landmarker.task 文件存在且未损坏（正常约 7.6 MB）。");
    return;
  }

  state.mode = "camera";
  hideErrorDetail();
  showToast("把手伸进画面 · 右手张合，左手翻页", 5200);
});

/* ---------------- 静态检查：?still=1&i=2&reveal=0.9&z=1.3&demo=1 ---------------- */
(function boot() {
  makeTextures();
  resize();

  const pi = parseInt(params.get("i"), 10);
  if (Number.isFinite(pi)) state.index = ((pi % PHOTOS.length) + PHOTOS.length) % PHOTOS.length;

  buildTicks();
  updateHUD(false);

  if (STILL) {
    el.gate.style.display = "none";
    el.camWrap.classList.add("hidden");
    el.reveal.classList.add("hidden");
    state.mode = "fallback";
    state.manualReveal = lockReveal != null ? lockReveal : 0.9;
    if (lockReveal != null) state.reveal = lockReveal;
    if (lockZoom != null) state.zoom = lockZoom;
    state.focusX = state.focusTX = PHOTOS[state.index].px;
    state.focusY = state.focusTY = PHOTOS[state.index].py;
    if (DEMO_START) {
      state.demo = true;
      document.body.classList.add("demo");
    }
  } else {
    state.focusX = state.focusTX = PHOTOS[state.index].px;
    state.focusY = state.focusTY = PHOTOS[state.index].py;
  }

  prewarmLeaves(18);
  window.addEventListener("resize", resize);
})();
