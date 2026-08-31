/* ==========================================================================
   Backpack Tag Generator — geometry core
   text -> opentype paths -> flatten -> Clipper union/offset/boolean
        -> base plate + text layer -> THREE meshes -> SVG / STL / 3MF
   ========================================================================== */
import ClipperLib from "clipper-lib";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import JSZip from "jszip";

export const CS = 1000;               // clipper integer units per millimetre
const NOMINAL = 100;                  // font size used for the nominal pass
const FT = ClipperLib.PolyFillType.pftNonZero;

/* ------------------------------------------------------------- flattening */
function pushCubic(out, x0, y0, x1, y1, x2, y2, x3, y3, tol) {
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  const n = Math.max(2, Math.min(120, Math.ceil(len / tol)));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      X: u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      Y: u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    });
  }
}

function pushQuad(out, x0, y0, x1, y1, x2, y2, tol) {
  const len = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.min(90, Math.ceil(len / tol)));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      X: u * u * x0 + 2 * u * t * x1 + t * t * x2,
      Y: u * u * y0 + 2 * u * t * y1 + t * t * y2,
    });
  }
}

/** opentype/SVG commands (y-down) -> contours of {X,Y} points (y-up). */
export function flattenCommands(cmds, tol = 0.5) {
  const contours = [];
  let cur = null, cx = 0, cy = 0;
  const flip = (y) => -y;
  for (const c of cmds) {
    if (c.type === "M") {
      if (cur && cur.length > 2) contours.push(cur);
      cur = [{ X: c.x, Y: flip(c.y) }];
      cx = c.x; cy = flip(c.y);
    } else if (c.type === "L") {
      if (!cur) continue;
      cur.push({ X: c.x, Y: flip(c.y) });
      cx = c.x; cy = flip(c.y);
    } else if (c.type === "C") {
      if (!cur) continue;
      pushCubic(cur, cx, cy, c.x1, flip(c.y1), c.x2, flip(c.y2), c.x, flip(c.y), tol);
      cx = c.x; cy = flip(c.y);
    } else if (c.type === "Q") {
      if (!cur) continue;
      pushQuad(cur, cx, cy, c.x1, flip(c.y1), c.x, flip(c.y), tol);
      cx = c.x; cy = flip(c.y);
    } else if (c.type === "Z") {
      if (cur && cur.length > 2) contours.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length > 2) contours.push(cur);
  return contours;
}

/* --------------------------------------------------------- clipper helpers */
export function toInt(contours, scale = CS, dx = 0, dy = 0) {
  return contours.map((c) =>
    c.map((p) => ({ X: Math.round((p.X + dx) * scale), Y: Math.round((p.Y + dy) * scale) })));
}

export function boundsOf(contours) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const c of contours) for (const p of c) {
    if (p.X < x1) x1 = p.X;
    if (p.Y < y1) y1 = p.Y;
    if (p.X > x2) x2 = p.X;
    if (p.Y > y2) y2 = p.Y;
  }
  if (!isFinite(x1)) return { x1: 0, y1: 0, x2: 0, y2: 0, w: 0, h: 0 };
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

export function unionPaths(paths, fill = FT) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const out = new ClipperLib.Paths();
  c.Execute(ClipperLib.ClipType.ctUnion, out, fill, fill);
  return out;
}

export function boolOp(subject, clip, type) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(subject, ClipperLib.PolyType.ptSubject, true);
  c.AddPaths(clip, ClipperLib.PolyType.ptClip, true);
  const out = new ClipperLib.Paths();
  c.Execute(type, out, FT, FT);
  return out;
}

export function offsetPaths(paths, delta, join = ClipperLib.JoinType.jtRound) {
  if (!paths.length || delta === 0) return paths.slice();
  const co = new ClipperLib.ClipperOffset(2.0, 0.25 * CS / 100);
  co.AddPaths(paths, join, ClipperLib.EndType.etClosedPolygon);
  const out = new ClipperLib.Paths();
  co.Execute(out, delta);
  return out;
}

/** Morphological closing — welds nearly-touching cursive letters together. */
export function weld(paths, gap) {
  if (gap <= 0) return paths;
  return unionPaths(offsetPaths(offsetPaths(paths, gap), -gap));
}

/** Nested outer/hole hierarchy, so shapes and even-odd SVG both come out right. */
export function toPolyTree(paths) {
  const c = new ClipperLib.Clipper();
  c.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const tree = new ClipperLib.PolyTree();
  c.Execute(ClipperLib.ClipType.ctUnion, tree, FT, FT);
  return tree;
}

/** Walk a PolyTree into [{ outer:[pts], holes:[[pts]] }] with mm coordinates. */
export function treeToRegions(tree) {
  const regions = [];
  const visit = (node) => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) {
        regions.push({
          outer: child.Contour().map((p) => [p.X / CS, p.Y / CS]),
          holes: child.Childs().map((h) => h.Contour().map((p) => [p.X / CS, p.Y / CS])),
        });
      }
      visit(child);
    }
  };
  visit(tree);
  return regions;
}

export function circlePath(cx, cy, r, segs = 72, reverse = false) {
  const pts = [];
  for (let i = 0; i < segs; i++) {
    const a = ((reverse ? -i : i) / segs) * Math.PI * 2;
    pts.push({ X: Math.round((cx + Math.cos(a) * r) * CS), Y: Math.round((cy + Math.sin(a) * r) * CS) });
  }
  return pts;
}

/* ---------------------------------------------------------------- bridging
   A tag that solves into several islands would literally fall apart. Rather
   than a morphological closing (which would also fill the counters of letters
   like A and O), find the nearest points between disconnected islands and
   weld them with an explicit bar, cheapest join first, until one piece remains.
   ------------------------------------------------------------------------ */
function outerContours(paths) {
  const tree = toPolyTree(paths);
  const outers = [];
  const visit = (n) => {
    for (const c of n.Childs()) {
      if (!c.IsHole()) outers.push(c.Contour());
      visit(c);
    }
  };
  visit(tree);
  return outers;
}

function nearestPair(a, b) {
  const stride = (c) => Math.max(1, Math.floor(c.length / 260));
  const sa = stride(a), sb = stride(b);
  let best = Infinity, bp = null, bq = null;
  for (let i = 0; i < a.length; i += sa) {
    for (let j = 0; j < b.length; j += sb) {
      const dx = a[i].X - b[j].X, dy = a[i].Y - b[j].Y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bp = a[i]; bq = b[j]; }
    }
  }
  // refine around the coarse winner
  const near = (c, p, span) => {
    const k = c.indexOf(p);
    const out = [];
    for (let i = -span; i <= span; i++) out.push(c[(k + i + c.length) % c.length]);
    return out;
  };
  for (const p of near(a, bp, sa + 1)) {
    for (const q of near(b, bq, sb + 1)) {
      const dx = p.X - q.X, dy = p.Y - q.Y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bp = p; bq = q; }
    }
  }
  return { d: Math.sqrt(best), p: bp, q: bq };
}

function barPath(p, q, halfW) {
  let dx = q.X - p.X, dy = q.Y - p.Y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const ex = dx * halfW * 1.2, ey = dy * halfW * 1.2;   // overshoot into both islands
  const nx = -dy * halfW, ny = dx * halfW;
  const a = { X: p.X - ex, Y: p.Y - ey }, b = { X: q.X + ex, Y: q.Y + ey };
  const bar = [
    { X: Math.round(a.X + nx), Y: Math.round(a.Y + ny) },
    { X: Math.round(b.X + nx), Y: Math.round(b.Y + ny) },
    { X: Math.round(b.X - nx), Y: Math.round(b.Y - ny) },
    { X: Math.round(a.X - nx), Y: Math.round(a.Y - ny) },
  ];
  // Under non-zero fill a reverse-wound polygon subtracts instead of unioning,
  // so the bar has to match the orientation clipper gives its outer contours.
  if (!ClipperLib.Clipper.Orientation(bar)) bar.reverse();
  return bar;
}

export function bridgeIslands(paths, halfWidth, maxJoins = 8) {
  let work = paths;
  for (let pass = 0; pass < maxJoins; pass++) {
    const outers = outerContours(work);
    if (outers.length <= 1) break;
    let best = null;
    for (let i = 0; i < outers.length; i++) {
      for (let j = i + 1; j < outers.length; j++) {
        const r = nearestPair(outers[i], outers[j]);
        if (!best || r.d < best.d) best = r;
      }
    }
    if (!best) break;
    work = unionPaths(work.concat([barPath(best.p, best.q, halfWidth)]));
  }
  return work;
}

/* ------------------------------------------------------------------ symbols
   Generated procedurally as closed contours (y-up), then normalised so each
   symbol is exactly 1 unit tall and centred on the origin. Multi-contour
   symbols (paw, truck) rely on the union step to merge their parts.
   ------------------------------------------------------------------------ */
function polar(fn, n = 220) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const r = fn(t);
    pts.push({ X: Math.cos(t) * r, Y: Math.sin(t) * r });
  }
  return pts;
}

function disc(cx, cy, r, n = 48) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ X: cx + Math.cos(t) * r, Y: cy + Math.sin(t) * r });
  }
  return pts;
}

function ellipse(cx, cy, rx, ry, rot = 0, n = 48) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.cos(t) * rx, y = Math.sin(t) * ry;
    pts.push({ X: cx + x * Math.cos(rot) - y * Math.sin(rot), Y: cy + x * Math.sin(rot) + y * Math.cos(rot) });
  }
  return pts;
}

function starPoly(points, outer, inner, phase = Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = phase + (i * Math.PI) / points;
    const r = i % 2 ? inner : outer;
    pts.push({ X: Math.cos(a) * r, Y: Math.sin(a) * r });
  }
  return pts;
}

const RAW_SYMBOLS = {
  sparkle: () => [polar((t) => 1 * (0.055 + 0.945 * Math.pow(Math.abs(Math.cos(2 * t)), 0.34)), 320)],
  star: () => [starPoly(5, 1, 0.42)],
  burst: () => [starPoly(8, 1, 0.55)],
  heart: () => {
    // the classic parametric heart, sampled directly rather than via polar radius
    const pts = [];
    for (let i = 0; i < 300; i++) {
      const t = (i / 300) * Math.PI * 2;
      pts.push({
        X: 16 * Math.pow(Math.sin(t), 3),
        Y: 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
      });
    }
    return [pts];
  },
  flower: () => [polar((t) => 0.55 + 0.45 * Math.cos(5 * t), 300)],
  snowflake: () => [polar((t) => 0.34 + 0.66 * Math.pow(Math.abs(Math.cos(3 * t)), 3), 320)],
  bolt: () => [[
    { X: 0.18, Y: 1 }, { X: -0.62, Y: 0.06 }, { X: -0.1, Y: 0.06 },
    { X: -0.28, Y: -1 }, { X: 0.6, Y: 0.0 }, { X: 0.06, Y: 0.0 },
  ]],
  paw: () => [
    ellipse(0, -0.32, 0.50, 0.34, 0),
    ellipse(-0.50, 0.28, 0.16, 0.23, -0.42),
    ellipse(-0.18, 0.55, 0.16, 0.23, -0.12),
    ellipse(0.18, 0.55, 0.16, 0.23, 0.12),
    ellipse(0.50, 0.28, 0.16, 0.23, 0.42),
  ],
  truck: () => [
    [{ X: -1.00, Y: 0.02 }, { X: 0.18, Y: 0.02 }, { X: 0.18, Y: 0.58 }, { X: -1.00, Y: 0.58 }],
    [{ X: 0.18, Y: 0.02 }, { X: 0.66, Y: 0.02 }, { X: 0.66, Y: 0.20 }, { X: 0.50, Y: 0.40 }, { X: 0.18, Y: 0.40 }],
    [{ X: -1.00, Y: -0.10 }, { X: 0.72, Y: -0.10 }, { X: 0.72, Y: 0.04 }, { X: -1.00, Y: 0.04 }],
    disc(-0.62, -0.20, 0.26), disc(0.40, -0.20, 0.26),
  ],
  dot: () => [disc(0, 0, 0.5, 64)],
  plus: () => [[
    { X: -0.24, Y: -1 }, { X: 0.24, Y: -1 }, { X: 0.24, Y: -0.24 }, { X: 1, Y: -0.24 },
    { X: 1, Y: 0.24 }, { X: 0.24, Y: 0.24 }, { X: 0.24, Y: 1 }, { X: -0.24, Y: 1 },
    { X: -0.24, Y: 0.24 }, { X: -1, Y: 0.24 }, { X: -1, Y: -0.24 }, { X: -0.24, Y: -0.24 },
  ]],
};

export const SYMBOL_IDS = Object.keys(RAW_SYMBOLS);

const symbolCache = new Map();
/** Contours for a symbol, normalised to height 1, centred on the origin. */
export function symbolContours(id) {
  if (symbolCache.has(id)) return symbolCache.get(id);
  const raw = (RAW_SYMBOLS[id] || RAW_SYMBOLS.star)();
  const b = boundsOf(raw);
  const s = 1 / (b.h || 1);
  const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  const norm = raw.map((c) => c.map((p) => ({ X: (p.X - cx) * s, Y: (p.Y - cy) * s })));
  symbolCache.set(id, norm);
  return norm;
}

/* ------------------------------------------------------------- tag builder */
/**
 * Full parametric solve. Everything is computed at a nominal font size, then
 * scaled once so the finished plate matches the requested tag width in mm.
 */
export function buildTag(p) {
  const text = (p.text || "").length ? p.text : " ";
  const otPath = p.font.getPath(text, 0, 0, NOMINAL, { kerning: true });
  let textContours = flattenCommands(otPath.commands);

  const tb = boundsOf(textContours);
  const textH = tb.h || NOMINAL * 0.7;

  // ---- symbols before / after the word
  const symContours = [];
  if (p.symbol.id && p.symbol.position !== "none") {
    const size = (p.symbol.sizePct / 100) * textH;
    const gap = textH * 0.16;
    const cy = (tb.y1 + tb.y2) / 2 + (p.symbol.offsetY / 100) * textH;
    const dx = (p.symbol.offsetX / 100) * textH;
    const base = symbolContours(p.symbol.id);
    const bb = boundsOf(base);
    const halfW = (bb.w * size) / 2;
    const place = (cx) =>
      base.forEach((c) => symContours.push(c.map((q) => ({ X: q.X * size + cx, Y: q.Y * size + cy }))));
    // offsetX pushes the pair apart (or together) rather than sliding both one way
    if (p.symbol.position === "before" || p.symbol.position === "both") place(tb.x1 - gap - halfW - dx);
    if (p.symbol.position === "after" || p.symbol.position === "both") place(tb.x2 + gap + halfW + dx);
  }

  const allNominal = textContours.concat(symContours);
  const nb = boundsOf(allNominal);

  // ---- one global scale so (art + outline on both sides) == requested width
  const outlineNominal = (p.outlinePct / 100) * textH;
  const scale = p.tagWidth / Math.max(1e-6, nb.w + 2 * outlineNominal);
  const outlineMm = outlineNominal * scale;

  // ---- into clipper space, origin at the art's lower-left
  let art = toInt(allNominal, CS * scale, -nb.x1, -nb.y1);
  art = unionPaths(art);
  if (p.connect) art = weld(art, (p.connectGap / 100) * textH * scale * CS);
  if (!art.length) return null;

  // ---- base plate = positive offset of the art
  let base = unionPaths(offsetPaths(art, outlineMm * CS));

  // ---- hanger hole: ring welded on, then the inner circle drilled out
  let hole = null;
  if (p.hanger.enabled) {
    const bb = boundsOf(base);
    const outerR = (p.hanger.outerD / 2) * CS;
    const innerR = (p.hanger.innerD / 2) * CS;
    const bite = outerR * 0.45;                       // how far the ring bites in
    const anchor = {
      left:        [bb.x1 + bite, (bb.y1 + bb.y2) / 2],
      right:       [bb.x2 - bite, (bb.y1 + bb.y2) / 2],
      "top-left":  [bb.x1 + bite, bb.y2 - bite],
      "top-right": [bb.x2 - bite, bb.y2 - bite],
      top:         [(bb.x1 + bb.x2) / 2, bb.y2 - bite],
    }[p.hanger.position] || [bb.x1 + bite, (bb.y1 + bb.y2) / 2];

    const dirX = p.hanger.position === "right" || p.hanger.position === "top-right" ? 1 : -1;
    const cx = anchor[0] + dirX * (outerR - bite) + p.hanger.offsetX * CS;
    const cy = anchor[1] + (p.hanger.position.startsWith("top") ? outerR - bite : 0) + p.hanger.offsetY * CS;

    const ring = [circlePath(cx / CS, cy / CS, outerR / CS)];
    base = boolOp(base, ring, ClipperLib.ClipType.ctUnion);
    hole = [circlePath(cx / CS, cy / CS, innerR / CS)];
  }

  // Bridge after the ring is on — a corner-mounted ring can land on empty space
  // where the plate's rounded contour doesn't reach the bounding box.
  if (p.autoBridge) base = bridgeIslands(base, Math.max(outlineMm * 0.8, 0.6) * CS);

  // Drill last, so a bridge can never be routed through the keyring hole.
  if (hole) base = boolOp(base, hole, ClipperLib.ClipType.ctDifference);

  // ---- normalise so the finished tag sits at the origin
  const bb = boundsOf(base);
  const shift = (paths) =>
    paths.map((c) => c.map((q) => ({ X: q.X - bb.x1, Y: q.Y - bb.y1 })));
  base = shift(base);
  art = shift(art);

  const dims = {
    width: (bb.x2 - bb.x1) / CS,
    height: (bb.y2 - bb.y1) / CS,
    outline: outlineMm,
    artWidth: nb.w * scale,
    artHeight: nb.h * scale,
  };

  return {
    basePaths: base,
    textPaths: art,
    baseRegions: treeToRegions(toPolyTree(base)),
    textRegions: treeToRegions(toPolyTree(art)),
    dims,
  };
}

/* --------------------------------------------------------------- 3D meshes */
function regionsToShapes(regions) {
  return regions.map((r) => {
    const shape = new THREE.Shape(r.outer.map((p) => new THREE.Vector2(p[0], p[1])));
    r.holes.forEach((h) => shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1])))));
    return shape;
  });
}

/**
 * Base plate extruded to `baseThickness`; text/symbols extruded the whole way
 * from z=0 to baseThickness+textRaise so the two solids fuse instead of
 * merely touching.
 */
export function buildMeshes(tag, o) {
  const group = new THREE.Group();
  if (!tag) return group;

  const baseGeo = new THREE.ExtrudeGeometry(regionsToShapes(tag.baseRegions), {
    depth: o.baseThickness, bevelEnabled: false, curveSegments: 6, steps: 1,
  });
  const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshStandardMaterial({
    color: new THREE.Color(o.baseColor), roughness: 0.68, metalness: 0.04,
  }));
  baseMesh.name = "base";
  baseMesh.userData.part = "base";
  baseMesh.castShadow = baseMesh.receiveShadow = true;
  group.add(baseMesh);

  const textGeo = new THREE.ExtrudeGeometry(regionsToShapes(tag.textRegions), {
    depth: o.baseThickness + o.textRaise, bevelEnabled: false, curveSegments: 6, steps: 1,
  });
  const textMesh = new THREE.Mesh(textGeo, new THREE.MeshStandardMaterial({
    color: new THREE.Color(o.textColor), roughness: 0.46, metalness: 0.04,
  }));
  textMesh.name = "text";
  textMesh.userData.part = "text";
  textMesh.castShadow = textMesh.receiveShadow = true;
  group.add(textMesh);

  group.position.set(-tag.dims.width / 2, -tag.dims.height / 2, 0);
  return group;
}

/* ------------------------------------------------------------- SVG export */
function regionsToPathData(regions, flipH) {
  const num = (v) => (Math.round(v * 1000) / 1000).toString();
  const ring = (pts) =>
    "M" + pts.map((p, i) => (i ? "L" : "") + num(p[0]) + " " + num(flipH - p[1])).join(" ") + "Z";
  return regions.map((r) => [ring(r.outer)].concat(r.holes.map(ring)).join(" ")).join(" ");
}

/**
 * mode "preview" -> filled two-colour artwork.
 * mode "cut"     -> hairline vectors on separate layers: the plate outline is
 *                   the cut path, the lettering is the engrave path.
 */
export function toSVG(tag, o) {
  const { width: W, height: H } = tag.dims;
  const baseD = regionsToPathData(tag.baseRegions, H);
  const textD = regionsToPathData(tag.textRegions, H);
  const head =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
    `width="${W.toFixed(3)}mm" height="${H.toFixed(3)}mm" ` +
    `viewBox="0 0 ${W.toFixed(3)} ${H.toFixed(3)}">\n`;

  let body;
  if (o.mode === "cut") {
    body =
      `<g id="cut" data-layer="cut" fill="none" stroke="#ff0000" stroke-width="0.1">\n` +
      `  <path d="${baseD}"/>\n</g>\n` +
      `<g id="engrave" data-layer="engrave" fill="none" stroke="#0000ff" stroke-width="0.1">\n` +
      `  <path d="${textD}"/>\n</g>\n`;
  } else {
    body =
      `<g id="base"><path d="${baseD}" fill="${o.baseColor}" fill-rule="evenodd"/></g>\n` +
      `<g id="text"><path d="${textD}" fill="${o.textColor}" fill-rule="evenodd"/></g>\n`;
  }
  return head + body + "</svg>\n";
}

/* ------------------------------------------------------------- STL export */
export function toSTL(group) {
  const scene = new THREE.Scene();
  const clone = group.clone(true);
  clone.position.set(0, 0, 0);
  scene.add(clone);
  scene.updateMatrixWorld(true);
  const dv = new STLExporter().parse(scene, { binary: true });
  return dv instanceof DataView ? dv.buffer : dv;
}

/* ------------------------------------------------------------- 3MF export */
function weldGeometry(geo) {
  const pos = geo.attributes.position;
  const index = geo.index;
  const map = new Map();
  const verts = [];
  const tris = [];
  const key = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const idOf = (i) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = key(x, y, z);
    let id = map.get(k);
    if (id === undefined) {
      id = verts.length;
      verts.push([x, y, z]);
      map.set(k, id);
    }
    return id;
  };
  const count = index ? index.count : pos.count;
  for (let i = 0; i < count; i += 3) {
    const a = index ? index.getX(i) : i;
    const b = index ? index.getX(i + 1) : i + 1;
    const c = index ? index.getX(i + 2) : i + 2;
    const t = [idOf(a), idOf(b), idOf(c)];
    if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(t);
  }
  return { verts, tris };
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Multi-material 3MF: one basematerials group, one object per colour. */
export async function to3MF(group, o) {
  const objects = [];
  group.updateMatrixWorld(true);
  group.traverse((m) => {
    if (!m.isMesh) return;
    const geo = m.geometry.clone();
    geo.applyMatrix4(m.matrixWorld);
    objects.push({ part: m.userData.part, ...weldGeometry(geo) });
    geo.dispose();
  });

  const hex = (c) => (c || "#cccccc").replace("#", "").toUpperCase().slice(0, 6);
  let xml =
    XML_HEAD +
    '<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    ' <metadata name="Application">Backpack Tag Generator</metadata>\n' +
    ' <metadata name="Title">' + (o.title || "tag") + '</metadata>\n' +
    ' <resources>\n' +
    '  <basematerials id="1">\n' +
    '   <base name="Base" displaycolor="#' + hex(o.baseColor) + 'FF"/>\n' +
    '   <base name="Text" displaycolor="#' + hex(o.textColor) + 'FF"/>\n' +
    '  </basematerials>\n';

  objects.forEach((obj, i) => {
    const id = i + 2;
    const pindex = obj.part === "text" ? 1 : 0;
    xml += `  <object id="${id}" type="model" pid="1" pindex="${pindex}" name="${obj.part}">\n   <mesh>\n    <vertices>\n`;
    for (const v of obj.verts) {
      xml += `     <vertex x="${v[0].toFixed(4)}" y="${v[1].toFixed(4)}" z="${v[2].toFixed(4)}"/>\n`;
    }
    xml += "    </vertices>\n    <triangles>\n";
    for (const t of obj.tris) {
      xml += `     <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>\n`;
    }
    xml += "    </triangles>\n   </mesh>\n  </object>\n";
  });

  xml += " </resources>\n <build>\n";
  objects.forEach((_, i) => { xml += `  <item objectid="${i + 2}"/>\n`; });
  xml += " </build>\n</model>\n";

  const zip = new JSZip();
  zip.file("[Content_Types].xml", XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    "</Types>\n");
  zip.folder("_rels").file(".rels", XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    "</Relationships>\n");
  zip.folder("3D").file("3dmodel.model", xml);
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export function statsFor(tag) {
  return {
    pieces: tag.baseRegions.length,
    holes: tag.baseRegions.reduce((a, r) => a + r.holes.length, 0),
  };
}
