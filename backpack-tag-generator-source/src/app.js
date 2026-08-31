/* ==========================================================================
   Backpack Tag Generator — UI, viewport and export wiring
   ========================================================================== */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as opentype from "opentype.js";
import { FONTS } from "./fonts.js";
import { buildTag, buildMeshes, toSVG, toSTL, to3MF, statsFor } from "./core.js";

const $ = (id) => document.getElementById(id);
const MM_PER_IN = 25.4;

/* ---------------------------------------------------------------- state */
const S = {
  units: "mm",
  text: "JULIA",
  connect: true,
  connectGap: 2,
  fontId: "Pacifico",
  tagWidth: 50,
  outlinePct: 17,
  // Depth is fixed for now — the inputs exist but are hidden in the markup.
  baseThickness: 4,
  textRaise: 2,
  autoBridge: true,
  // Symbols are temporarily removed from the UI; the solver still accepts them,
  // so restoring the picker only means re-adding the controls.
  symbol: { id: "star", position: "none", sizePct: 70, offsetX: 0, offsetY: 0 },
  hanger: { enabled: true, position: "top-left", outerD: 8, innerD: 4, offsetX: 0, offsetY: 0 },
  baseColor: "#0f172a",
  textColor: "#e2e8f0",
  view: "3d",
  cutView: false,
};

const fontCache = new Map();
let customFont = null;
let tag = null;
let modelGroup = null;

/* ------------------------------------------------------------ font loading */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Self-contained base64 -> ArrayBuffer; avoids relying on a host atob. */
function b64ToBuffer(b64) {
  let len = b64.length;
  while (len > 0 && b64.charCodeAt(len - 1) === 61) len--;      // trim '='
  const bytes = new Uint8Array((len * 3) >> 2);
  let acc = 0, bits = 0, out = 0;
  for (let i = 0; i < len; i++) {
    const v = B64LOOKUP[b64.charCodeAt(i)];
    if (v === 255) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (acc >> bits) & 0xff;
    }
  }
  return bytes.buffer.slice(0, out);
}

function getFont() {
  if (S.fontId === "__custom" && customFont) return customFont;
  if (fontCache.has(S.fontId)) return fontCache.get(S.fontId);
  const entry = FONTS.find((f) => f.id === S.fontId) || FONTS[0];
  const font = opentype.parse(b64ToBuffer(entry.data));
  fontCache.set(entry.id, font);
  return font;
}

/* ---------------------------------------------------------------- units */
const disp = (mm) => (S.units === "in" ? mm / MM_PER_IN : mm);
const undisp = (v) => (S.units === "in" ? v * MM_PER_IN : v);
const fmt = (mm, d) => disp(mm).toFixed(d !== undefined ? d : S.units === "in" ? 3 : 1);

const NUMERIC = [
  ["f-base", "baseThickness", 0.4, 20, 0.2],
  ["f-raise", "textRaise", 0.2, 10, 0.1],
  ["f-outer", null, 3, 60, 0.5],
  ["f-inner", null, 1, 40, 0.5],
];

function syncUnitInputs() {
  const inch = S.units === "in";
  const step = (mm) => (inch ? Math.max(0.005, +(mm / MM_PER_IN).toFixed(3)) : mm);
  const set = (id, mmValue, min, max, st) => {
    const el = $(id);
    el.min = disp(min).toFixed(3);
    el.max = disp(max).toFixed(3);
    el.step = step(st);
    el.value = fmt(mmValue, inch ? 3 : 2);
  };
  set("f-base", S.baseThickness, 0.4, 20, 0.2);
  set("f-raise", S.textRaise, 0.2, 10, 0.1);
  set("f-outer", S.hanger.outerD, 3, 60, 0.5);
  set("f-inner", S.hanger.innerD, 1, 40, 0.5);
  document.querySelectorAll(".u").forEach((el) => { el.textContent = S.units === "in" ? "in" : "mm"; });
  $("unit-mm").className = "px-2.5 py-1.5 text-[11px] font-semibold " +
    (inch ? "text-slate-400 hover:text-slate-200" : "bg-lime-400 text-slate-950");
  $("unit-in").className = "px-2.5 py-1.5 text-[11px] font-semibold " +
    (inch ? "bg-lime-400 text-slate-950" : "text-slate-400 hover:text-slate-200");
}

/* ------------------------------------------------------------ 3D viewport */
const V = { ok: false };
function initViewport() {
  const mount = $("viewport");
  V.scene = new THREE.Scene();
  V.scene.background = new THREE.Color("#070b12");

  V.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 4000);
  V.camera.position.set(60, 90, 110);

  V.renderer = new THREE.WebGLRenderer({ antialias: true });
  V.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  V.renderer.shadowMap.enabled = true;
  V.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  V.renderer.outputEncoding = THREE.sRGBEncoding;
  mount.appendChild(V.renderer.domElement);
  V.renderer.domElement.style.display = "block";
  V.renderer.domElement.style.touchAction = "none";   // rotate/pinch instead of page scroll

  V.controls = new OrbitControls(V.camera, V.renderer.domElement);
  V.controls.enableDamping = true;
  V.controls.dampingFactor = 0.09;

  V.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x0a0f18, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.45);
  key.position.set(-70, 120, 80);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 5;
  key.shadow.camera.far = 500;
  key.shadow.bias = -0.0012;
  V.key = key;
  V.scene.add(key);
  const fill = new THREE.DirectionalLight(0x9dc4ff, 0.5);
  fill.position.set(90, 50, -90);
  V.scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshStandardMaterial({ color: 0x0c121c, roughness: 1 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.05;
  floor.receiveShadow = true;
  V.scene.add(floor);

  const grid = new THREE.GridHelper(600, 60, 0x24364d, 0x141d29);
  V.scene.add(grid);

  V.wrapper = new THREE.Group();
  V.wrapper.rotation.x = -Math.PI / 2;      // model is Z-up, bed is Y-up
  V.scene.add(V.wrapper);

  const resize = () => {
    const w = mount.clientWidth || 1, h = mount.clientHeight || 1;
    V.camera.aspect = w / h;
    V.camera.updateProjectionMatrix();
    V.renderer.setSize(w, h, false);
  };
  resize();
  new ResizeObserver(resize).observe(mount);

  (function loop() {
    requestAnimationFrame(loop);
    V.controls.update();
    V.renderer.render(V.scene, V.camera);
  })();
  V.ok = true;
}

/** No WebGL (old browser, blocked GPU) shouldn't kill the tool — fall back to 2D. */
function viewportUnavailable() {
  $("viewport").innerHTML =
    '<div class="flex h-full items-center justify-center p-6 text-center text-xs text-slate-500">' +
    "This browser can't open a 3D view, so the 2D preview is showing instead. " +
    "Exports still work." + "</div>";
}

function frameModel(angle) {
  if (!modelGroup || !V.ok) return;
  const box = new THREE.Box3().setFromObject(V.wrapper);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const dist = (Math.max(size.x, size.y, size.z) / 2 / Math.tan((V.camera.fov * Math.PI) / 360)) * 1.9;
  const dir = { iso: [0.62, 0.72, 0.86], top: [0.001, 1, 0.001], front: [0, 0.08, 1] }[angle || "iso"];
  const v = new THREE.Vector3(...dir).normalize().multiplyScalar(dist);
  V.camera.position.copy(center).add(v);
  V.controls.target.copy(center);
  V.controls.update();
}

/* ------------------------------------------------------------- 2D preview */
function render2D() {
  if (!tag) return;
  const svg = toSVG(tag, {
    mode: S.cutView ? "cut" : "preview",
    baseColor: S.baseColor,
    textColor: S.textColor,
  })
    .replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%" height="100%"')
    .replace("<svg ", '<svg style="max-width:100%;max-height:100%" ');
  $("svgview").innerHTML = svg;
}

/* ------------------------------------------------------------- the rebuild */
let timer = null;
function scheduleRebuild() {
  clearTimeout(timer);
  $("busy").classList.remove("hidden");
  $("busy").classList.add("flex");
  timer = setTimeout(() => requestAnimationFrame(rebuild), 130);
}

function rebuild() {
  const warn = [];
  if (!S.text.trim()) warn.push("Type some text to generate a tag.");
  if (S.hanger.enabled && S.hanger.innerD >= S.hanger.outerD - 1) {
    warn.push("Inner hole must be at least 1mm smaller than the outer ring.");
  }

  try {
    tag = buildTag({
      text: S.text,
      font: getFont(),
      connect: S.connect,
      connectGap: S.connectGap,
      tagWidth: S.tagWidth,
      outlinePct: S.outlinePct,
      autoBridge: S.autoBridge,
      symbol: S.symbol,
      hanger: {
        ...S.hanger,
        innerD: Math.min(S.hanger.innerD, S.hanger.outerD - 1),
      },
    });
  } catch (err) {
    console.error("tag solve failed:", err);
    tag = null;
    warn.push("Could not solve that shape — try different settings.");
  }

  if (tag) {
    if (modelGroup) {
      if (V.wrapper) V.wrapper.remove(modelGroup);
      modelGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    modelGroup = buildMeshes(tag, {
      baseThickness: S.baseThickness,
      textRaise: S.textRaise,
      baseColor: S.baseColor,
      textColor: S.textColor,
    });
    if (V.ok) {
      V.wrapper.add(modelGroup);
      const span = Math.max(tag.dims.width, tag.dims.height, 40);
      V.key.shadow.camera.left = -span; V.key.shadow.camera.right = span;
      V.key.shadow.camera.top = span; V.key.shadow.camera.bottom = -span;
      V.key.shadow.camera.updateProjectionMatrix();
      if (!V.framed) { frameModel("iso"); V.framed = true; }
    }

    const st = statsFor(tag);
    $("s-pw").textContent = fmt(S.tagWidth);
    $("s-ow").textContent = fmt(tag.dims.width);
    $("s-oh").textContent = fmt(tag.dims.height);
    $("s-z").textContent = fmt(S.baseThickness + S.textRaise);
    $("s-pieces").textContent = st.pieces + " / " + st.holes;
    if (st.pieces > 1) warn.push(`Tag is in ${st.pieces} separate pieces — turn on "Keep tag in one piece" or raise the outline size.`);
    if (S.baseThickness < 1.2) warn.push("Base under 1.2mm is fragile for a printed tag.");
    render2D();
  }

  const box = $("warn");
  if (warn.length) {
    box.textContent = warn[0];
    box.classList.remove("hidden");
    box.classList.add("flex");
  } else {
    box.classList.add("hidden");
    box.classList.remove("flex");
  }
  $("busy").classList.add("hidden");
  $("busy").classList.remove("flex");
}

/* ---------------------------------------------------------------- exports */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const safeName = () =>
  (S.text.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tag").slice(0, 40);

/* -------------------------------------------------------------- UI wiring */
function bind() {
  // text
  $("f-text").addEventListener("input", (e) => {
    S.text = e.target.value;
    $("ct-count").textContent = S.text.length;
    scheduleRebuild();
  });
  $("f-connect").addEventListener("change", (e) => {
    S.connect = e.target.checked;
    $("wrap-gap").style.display = S.connect ? "" : "none";
    scheduleRebuild();
  });
  $("f-gap").addEventListener("input", (e) => {
    S.connectGap = +e.target.value;
    $("ct-gap").textContent = S.connectGap + "%";
    scheduleRebuild();
  });

  // fonts
  const sel = $("f-font");
  FONTS.forEach((f) => sel.add(new Option(f.label, f.id)));
  sel.value = S.fontId;
  sel.addEventListener("change", (e) => { S.fontId = e.target.value; scheduleRebuild(); });

  $("f-fontfile").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      customFont = opentype.parse(await file.arrayBuffer());
      if (!sel.querySelector('option[value="__custom"]')) sel.add(new Option("Uploaded font", "__custom"));
      sel.querySelector('option[value="__custom"]').textContent = file.name;
      sel.value = "__custom";
      S.fontId = "__custom";
      scheduleRebuild();
    } catch {
      const box = $("warn");
      box.textContent = "That font could not be read. Try a .ttf or .otf.";
      box.classList.remove("hidden");
      box.classList.add("flex");
    }
  });
  $("f-fontclear").addEventListener("click", () => {
    customFont = null;
    const opt = sel.querySelector('option[value="__custom"]');
    if (opt) opt.remove();
    sel.value = S.fontId = FONTS[0].id;
    scheduleRebuild();
  });

  // dimensions
  $("f-width").addEventListener("input", (e) => {
    S.tagWidth = Math.min(70, Math.max(50, +e.target.value));
    $("ct-w").textContent = fmt(S.tagWidth);
    scheduleRebuild();
  });
  $("f-outline").addEventListener("input", (e) => {
    S.outlinePct = +e.target.value;
    $("ct-out").textContent = S.outlinePct + "%";
    scheduleRebuild();
  });
  $("f-base").addEventListener("input", (e) => { S.baseThickness = undisp(+e.target.value || 0.4); scheduleRebuild(); });
  $("f-raise").addEventListener("input", (e) => { S.textRaise = undisp(+e.target.value || 0.2); scheduleRebuild(); });
  $("f-bridge").addEventListener("change", (e) => { S.autoBridge = e.target.checked; scheduleRebuild(); });

  // hanger
  $("f-hang").addEventListener("change", (e) => { S.hanger.enabled = e.target.checked; scheduleRebuild(); });
  $("f-hangpos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hp]");
    if (!b) return;
    S.hanger.position = b.dataset.hp;
    $("f-hangpos").querySelectorAll("[data-hp]").forEach((x) => x.classList.toggle("chip-on", x === b));
    scheduleRebuild();
  });
  $("f-outer").addEventListener("input", (e) => { S.hanger.outerD = undisp(+e.target.value || 3); scheduleRebuild(); });
  $("f-inner").addEventListener("input", (e) => { S.hanger.innerD = undisp(+e.target.value || 1); scheduleRebuild(); });
  $("f-holex").addEventListener("input", (e) => {
    S.hanger.offsetX = +e.target.value;
    $("ct-hx").textContent = S.hanger.offsetX;
    scheduleRebuild();
  });
  $("f-holey").addEventListener("input", (e) => {
    S.hanger.offsetY = +e.target.value;
    $("ct-hy").textContent = S.hanger.offsetY;
    scheduleRebuild();
  });

  // colours
  $("f-bg").addEventListener("input", (e) => {
    S.baseColor = e.target.value;
    if (modelGroup) modelGroup.getObjectByName("base").material.color.set(S.baseColor);
    render2D();
  });
  $("f-fg").addEventListener("input", (e) => {
    S.textColor = e.target.value;
    if (modelGroup) modelGroup.getObjectByName("text").material.color.set(S.textColor);
    render2D();
  });

  // units
  const setUnits = (u) => { S.units = u; syncUnitInputs(); rebuild(); $("ct-w").textContent = fmt(S.tagWidth); };
  $("unit-mm").addEventListener("click", () => setUnits("mm"));
  $("unit-in").addEventListener("click", () => setUnits("in"));

  // view switching
  const setView = (v) => {
    S.view = v;
    const is3d = v === "3d";
    $("viewport").classList.toggle("hidden", !is3d);
    $("svgview").classList.toggle("hidden", is3d);
    $("svgview").classList.toggle("flex", !is3d);
    $("v3d-tools").classList.toggle("hidden", !is3d);
    $("v2d-tools").classList.toggle("hidden", is3d);
    $("v2d-tools").classList.toggle("flex", !is3d);
    $("v-3d").className = "px-3 py-1.5 text-[11px] font-semibold " + (is3d ? "bg-lime-400 text-slate-950" : "text-slate-400 hover:text-slate-200");
    $("v-2d").className = "px-3 py-1.5 text-[11px] font-semibold " + (is3d ? "text-slate-400 hover:text-slate-200" : "bg-lime-400 text-slate-950");
    if (!is3d) render2D();
  };
  $("v-3d").addEventListener("click", () => setView("3d"));
  $("v-2d").addEventListener("click", () => setView("2d"));
  setView("3d");

  $("v3d-tools").addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) frameModel(b.dataset.view === "fit" ? "iso" : b.dataset.view);
  });
  $("f-cutview").addEventListener("change", (e) => { S.cutView = e.target.checked; render2D(); });

  // accordions
  document.querySelectorAll("[data-acc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const body = document.querySelector(`[data-body="${btn.dataset.acc}"]`);
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "";
      btn.lastElementChild.textContent = open ? "+" : "−";
    });
  });

  // exports
  $("btn-svg").addEventListener("click", () => {
    if (!tag) return;
    const svg = toSVG(tag, { mode: "cut", baseColor: S.baseColor, textColor: S.textColor });
    download(new Blob([svg], { type: "image/svg+xml" }), safeName() + "-tag.svg");
  });
  $("btn-stl").addEventListener("click", () => {
    if (!modelGroup) return;
    download(new Blob([toSTL(modelGroup)], { type: "model/stl" }), safeName() + "-tag.stl");
  });
  $("btn-3mf").addEventListener("click", async () => {
    if (!modelGroup) return;
    const blob = await to3MF(modelGroup, { baseColor: S.baseColor, textColor: S.textColor, title: safeName() });
    download(blob, safeName() + "-tag.3mf");
  });
}

/* ------------------------------------------------------------------- boot */
try {
  initViewport();
} catch (err) {
  viewportUnavailable();
}
bind();
syncUnitInputs();
if (!V.ok) $("v-2d").click();
rebuild();
frameModel("iso");
