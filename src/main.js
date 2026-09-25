import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import crack from './crack.glsl.js';

const DIST = 3;         // camera distance; the background plane is sized to fill the window at this distance
const MARGIN = 1.25;    // plane oversize factor so edges don't show on resize or orbit
const SEED = [Math.random() * 100, Math.random() * 100];   // random per page load; hardcode for a reproducible layout
const IS_TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;

const SCATTER_N = 19000;     // instances to place (default for the GUI slider)
const SCATTER_MAX = 20000;   // InstancedMesh capacity, and the GUI slider's max
const SCATTER_LIFT = .02;    // z-offset above the shader plane so instances don't z-fight it
const SCATTER_DEPTH = .15;   // random extra height on top of SCATTER_LIFT, world units (typical dot ~.045 across)
const SCATTER_SHADE = .7;    // how far the highest dots blend toward SCATTER_SHADOW (0 = no shading)
const SCATTER_SHADOW = new THREE.Color(0x531745);   // shadow color the high dots blend toward
const SCATTER_MIN_SIZE = .3; // smallest an instance may shrink to fit beside a crack (fraction of base size);
                              // spots too tight even for that are skipped
const SCATTER_BASE_SIZE = .013; // typical (median) instance size, as a fraction of plane height
const SCATTER_SIZE_VAR = .25; // log-normal size spread (GUI default); 0 = all one size, .25 = roughly
                              // 0.6x to 1.65x the typical size at the 2-sigma clamp
const SCATTER_FALLOFF = .03; // distance from a crack (fraction of plane height) over which density ramps
                              // from SCATTER_MIN_DENSITY up to full
const SCATTER_MIN_DENSITY = .05; // placement probability right at a crack edge (fraction of full density)
const SCATTER_MIN_ISLAND = 50; // islands that would get fewer instances than this get none: too small to read as a colored patch
const SCATTER_EDGE = 0;      // how far out from a crack instances must stay: 0 = right up to the solid
                              // black, 1 = clear of the whole speckle halo (0..1)
const SCATTER_FLOW_FREQ = 1.2; // flow-field noise cells per pattern unit (2 units = plane height);
                              // higher = smaller swirls
// dot color families; each island takes one color of the current family, picked so neighboring
// islands differ. "new seed" steps to the next family
// n even steps along a piecewise-linear ramp through the stops, so a 2-3 color swatch still has
// enough distinct shades for neighboring islands to differ
const ramp = (stops, n) => Array.from({ length: n }, (_, i) => {
  const t = i / (n - 1) * (stops.length - 1), s = Math.min(stops.length - 2, Math.floor(t));
  return new THREE.Color(stops[s]).lerp(new THREE.Color(stops[s + 1]), t - s);
});
const SCATTER_PALETTES = [
  ramp([0xc0b203, 0x655500], 7),             // olive
  ramp([0xbcd382, 0x66ab56], 7),             // light greens
  ramp([0x85b857, 0x5e4017], 7),             // leaf green to bark brown
];
let paletteIdx = 0;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x91b4c9);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, .1, 100);
camera.position.set(0, 0, DIST);
const controls = new OrbitControls(camera, renderer.domElement);
if (IS_TOUCH) controls.enabled = false;   // lock camera on touch devices; finger still pushes dots via pointermove

const SEGS = 50;   // wireframe subdivisions along the plane's shorter side; the longer side gets
                    // SEGS * aspect (recomputed in resize()) so each cell stays square on screen
                    // instead of stretching with the window
const ISLAND_CUT_SEGS = 120;   // resolution of the per-island cut-mesh grid, independent of the
                                // debug wireframe's SEGS; a finer grid traces the crack gap more closely
const CENTER_R_SCALE = .3;   // island center's physics radius (cursor reach, mass) as a fraction of the island's
                              // own radius sqrt(area / pi); at 1 one hover reached several islands at once
const ISLAND_SATS = 10;      // satellites per island (fewer on tiny islands); more = sharper dents, more cost
const SAT_INSET = .7;        // satellites sit this fraction of the way from the centroid out to the rim point they were sampled at
const SAT_SIGMA = .7;        // skin-weight falloff, as a fraction of the island's per-satellite radius sqrt(area / sats)

const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, SEGS, SEGS), new THREE.ShaderMaterial({
  uniforms: {
    seed: { value: new THREE.Vector2(...SEED) },
    patternScale: { value: .75 },
    patternRatio: { value: 1 },
    zebraAmp: { value: 1.04 },   // see crack.glsl.js
    noiseFreq: { value: .7 },
    widthMin: { value: 1 },   // crack line half-width range, in pixels; see crack.glsl.js
    widthMax: { value: 1 },
  },
  // uv -> pattern space (2 units = plane height at patternScale 1; higher = bigger cells), aspect
  // taken from the plane's own scale
  vertexShader: /* glsl */ `
    uniform float patternScale, patternRatio;
    varying vec2 vUv;
    void main() {
      // patternRatio > 1 stretches cells wider, < 1 taller; area-preserving, so the cell count holds
      vUv = uv * vec2(length(modelMatrix[0].xyz) / length(modelMatrix[1].xyz), 1.) * 2. / patternScale
          * vec2(inversesqrt(patternRatio), sqrt(patternRatio));
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
    }`,
  fragmentShader: /* glsl */ `
    ${crack}
    varying vec2 vUv;
#ifdef MASK_Q
    // Perlin gradient noise for the instance flow field. Not noise2: value noise's gradient is
    // axis-aligned along every lattice line, which would show up as a grid in the flow
    vec2 grad2(vec2 i) { float a = 6.2831853 * hash21(i); return vec2(cos(a), sin(a)); }
    float perlin(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
      return mix(mix(dot(grad2(i), f), dot(grad2(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
                 mix(dot(grad2(i + vec2(0, 1)), f - vec2(0, 1)), dot(grad2(i + 1.), f - 1.), u.x), u.y);
    }
#endif
    void main() {
      vec2 W;
      float halfPx;
      float d = crackDist(vUv, W, halfPx);
      // warped distance -> screen pixels: constant width, no blobs where the warp folds
      // floor()'d away from 0: at extreme zoom dFdx/dFdy become float32-noisy finite differences
      // (W carries seed + 6 fbm octaves of accumulated magnitude), and dividing d by a
      // near-zero noisy scale blows that noise up into visible grain across the whole field
      float scale = max(.5 * (length(dFdx(W)) + length(dFdy(W))), 1e-4);   // warp units per pixel
      const float AA_PX = .5;   // antialiasing falloff width in pixels; lower = sharper edge
      float a = clamp((halfPx - d / scale) / AA_PX + .5, 0., 1.);
      gl_FragColor = vec4(vec3(1. - a), 1.);
#ifdef MASK_Q
      // placement mask only: G/B carry each instance's screen-space direction, the curl of a Perlin
      // noise (its gradient turned 90°), so directions follow the noise's contour lines and swirl
      // around its highs and lows
      float n = perlin((vUv + seed) * FLOW_FREQ);
      vec2 g = vec2(-dFdy(n), dFdx(n));
      gl_FragColor.gb = .5 + .5 * g / max(length(g), 1e-9);
#endif
    }`,
}));
scene.add(plane);

// wireframe overlay, off by default -- press F to toggle
const wireframe = new THREE.LineSegments(
  new THREE.WireframeGeometry(plane.geometry),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: .3 }),
);
wireframe.visible = false;
plane.add(wireframe);   // child of plane: inherits its scale/position automatically

// --- colored dots scattered over the "land" (non-crack) area, random sizes, shrunk near a crack
// edge, rotated along the flow field. Flat in the plane's own surface (not billboarded to the
// camera), true circles on screen. NOT a child of `plane`: plane.scale is non-uniform
// (h*aspect, h) to fill the window, and non-uniform scale doesn't commute with rotation -- a
// child's own counter-scale only cancels the parent's stretch pre-rotation, then the parent
// re-stretches the already-rotated shape into a parallelogram. So `scatter` is a sibling in the
// scene instead, and buildScatter() bakes plane's world scale (h*aspect, h) into each instance's
// position/size by hand, uniformly post-rotation, instead of inheriting it. ---
const scatterGeo = new THREE.CircleGeometry(.5, 16);   // diameter 1, same footprint as the old unit square
const scatterMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });   // white, tinted per instance by setColorAt
const scatter = new THREE.InstancedMesh(scatterGeo, scatterMat, SCATTER_MAX);
scene.add(scatter);

// Placement reads back what the shader actually paints: the plane alone, rendered into maskRT by
// an ortho camera framing it exactly, at on-screen pixel density (crack widths are in pixels, so
// the density has to match the default view). A CPU copy of the field can't do this: the GPU's
// float32 sin-hash gives different values than JS float64, so the copy draws other cracks.
// Instances and the wireframe live on layer 1, which maskCam doesn't render. The mask uses
// maskMat, which swaps the per-pixel random crack width for SCATTER_EDGE (see MASK_Q in
// crack.glsl.js), so the speckles around each crack count as land. It also writes a flow-field
// direction into G/B (see the fragment shader), which sets each instance's rotation.
const maskMat = plane.material.clone();
maskMat.uniforms = plane.material.uniforms;   // shared, so every GUI change reaches the mask too
maskMat.defines.MASK_Q = SCATTER_EDGE.toFixed(3);   // GLSL needs a float literal
maskMat.defines.FLOW_FREQ = SCATTER_FLOW_FREQ.toFixed(3);
const maskCam = new THREE.OrthographicCamera();
maskCam.position.z = 1;
const maskRT = new THREE.WebGLRenderTarget(1, 1);
scatter.layers.set(1);
wireframe.layers.set(1);
camera.layers.enable(1);

// exact 1D squared distance transform (Felzenszwalb & Huttenlocher: lower envelope of parabolas),
// in place on n samples of g from index off with stride step; run over columns then rows for 2D.
// Input: 0 on crack pixels, 1e20 on land. f, v, z: scratch buffers of length >= n, n, n + 1
function edt1d(g, off, step, n, f, v, z) {
  for (let q = 0; q < n; q++) f[q] = g[off + q * step];
  let k = 0, s;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    while ((s = (f[q] + q * q - f[v[k]] - v[k] * v[k]) / (2 * q - 2 * v[k])) <= z[k]) k--;
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  for (let q = 0, j = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    g[off + q * step] = (q - v[j]) ** 2 + f[v[j]];
  }
}

// shared physics-body shape stepDots() operates on: home position (hx/hy, also seeded as the
// initial x/y/px/py/sx0/sy0 snapshot), radius r, and same-body links (la/lb/ux/uy/rest)
function makeBody(hx, hy, r, la, lb, ux, uy, rest, mw, mh) {
  return {
    n: hx.length, x: hx.slice(), y: hy.slice(), px: hx.slice(), py: hy.slice(), sx0: hx.slice(), sy0: hy.slice(),
    hx, hy, r, m: r.map((v) => v * v),
    la: Int32Array.from(la), lb: Int32Array.from(lb),
    ux: Float32Array.from(ux), uy: Float32Array.from(uy), rest: Float32Array.from(rest),
    mw, mh,
  };
}

const _m = new THREE.Matrix4(), _c = new THREE.Color();
function buildScatter(aspect, h) {
  const mw = Math.round(renderer.domElement.width * MARGIN), mh = Math.round(renderer.domElement.height * MARGIN);
  Object.assign(maskCam, { left: -h * aspect / 2, right: h * aspect / 2, top: h / 2, bottom: -h / 2 });
  maskCam.updateProjectionMatrix();
  maskRT.setSize(mw, mh);
  const crackMat = plane.material;
  plane.material = maskMat;
  if (islandGroup) islandGroup.visible = false;   // last build's cut meshes sit on layer 0 too, drawn with the on-screen material (and possibly mid-push)
  renderer.setRenderTarget(maskRT);
  renderer.render(scene, maskCam);
  plane.material = crackMat;
  if (islandGroup) islandGroup.visible = true;
  const px = new Uint8Array(mw * mh * 4);
  renderer.readRenderTargetPixels(maskRT, 0, 0, mw, mh, px);
  renderer.setRenderTarget(null);
  const land = (x, y) => px[(y * mw + x) * 4] === 255;   // any mask ink, AA fringe included, is crack

  // islands: 4-connected land regions of the mask, flood-filled so each can get its own color
  const island = new Int32Array(mw * mh).fill(-1), stack = [];
  let islands = 0;
  const visit = (q) => { if (island[q] < 0 && px[q * 4] === 255) { island[q] = islands; stack.push(q); } };
  for (let s = 0; s < mw * mh; s++) {
    if (island[s] >= 0 || px[s * 4] !== 255) continue;
    visit(s);
    while (stack.length) {
      const p = stack.pop(), x = p % mw;
      if (x > 0) visit(p - 1);
      if (x < mw - 1) visit(p + 1);
      if (p >= mw) visit(p - mw);
      if (p < mw * (mh - 1)) visit(p + mw);
    }
    islands++;
  }

  // --- cut the plane into one real mesh per island (try: real separation instead of the dots-only
  // illusion, see docs/research-island-mesh-separation.md). A fresh grid, own resolution, samples
  // each corner's island via the mask; any cell whose 3 corners don't agree straddles a crack and
  // is dropped, leaving an actual gap instead of a shader-painted line. Every island mesh shares the
  // plane's material and this one grid's position/uv buffers -- uv stays plane-space, so the pattern
  // lines up with no per-island remapping, and only the index (which triangles survive) is per island.
  const cutSegsX = aspect >= 1 ? Math.round(ISLAND_CUT_SEGS * aspect) : ISLAND_CUT_SEGS;
  const cutSegsY = aspect >= 1 ? ISLAND_CUT_SEGS : Math.round(ISLAND_CUT_SEGS / aspect);
  const cutGeo = new THREE.PlaneGeometry(1, 1, cutSegsX, cutSegsY);
  const gp = cutGeo.attributes.position, gu = cutGeo.attributes.uv, gi = cutGeo.index;
  const vIsland = new Int32Array(gp.count);
  for (let v = 0; v < gp.count; v++) {
    const mx = Math.max(0, Math.min(mw - 1, Math.round(gu.getX(v) * mw)));
    const my = Math.max(0, Math.min(mh - 1, Math.round(gu.getY(v) * mh)));
    vIsland[v] = island[my * mw + mx];
  }
  const byIsland = Array.from({ length: islands }, () => []);
  // bit 1: this vertex touches a dropped (straddling) cell; bit 2: touches a kept one. Both set ==
  // the vertex sits right on the kept/dropped seam -- smoothed below, once the distance field is ready
  const cutTouch = new Uint8Array(gp.count);
  for (let t = 0; t < gi.count; t += 3) {
    const ia = gi.getX(t), ib = gi.getX(t + 1), ic = gi.getX(t + 2), a = vIsland[ia];
    const kept = a >= 0 && vIsland[ib] === a && vIsland[ic] === a;
    const bit = kept ? 2 : 1;
    cutTouch[ia] |= bit; cutTouch[ib] |= bit; cutTouch[ic] |= bit;
    if (kept) byIsland[a].push(ia, ib, ic);
  }
  if (!islandGroup) { islandGroup = new THREE.Group(); islandGroup.position.z = .001; plane.add(islandGroup); }
  islandGroup.children.slice().forEach((m) => { m.geometry.dispose(); islandGroup.remove(m); });
  for (let a = 0; a < islands; a++) {
    if (byIsland[a].length < 3) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', gp);
    g.setAttribute('uv', gu);
    g.setIndex(byIsland[a]);
    const mesh = new THREE.Mesh(g, plane.material);
    mesh.frustumCulled = false;   // vertices move every frame; the build-time bounding sphere goes stale
    islandGroup.add(mesh);
  }

  // neighbors: islands facing each other across a crack, i.e. with land pixels less than G apart
  const G = Math.ceil(.06 * mh), near = Array.from({ length: islands }, () => new Set());
  for (let y = 0; y < mh - G; y += 2) for (let x = 0; x < mw - G; x += 2) {
    const a = island[y * mw + x], right = island[y * mw + x + G], up = island[(y + G) * mw + x];
    if (a < 0) continue;
    if (right >= 0 && right !== a) near[a].add(right), near[right].add(a);
    if (up >= 0 && up !== a) near[a].add(up), near[up].add(a);
  }

  // greedy coloring: each island takes a random palette color none of its neighbors has yet
  const islandColor = [];
  for (let a = 0; a < islands; a++) {
    const palette = SCATTER_PALETTES[paletteIdx];
    const free = palette.filter((c) => ![...near[a]].some((b) => islandColor[b] === c));
    const pick = free.length ? free : palette;
    islandColor[a] = pick[Math.floor(Math.random() * pick.length)];
  }

  // distance (px) from every pixel to the nearest crack pixel: one exact 2D distance transform,
  // used for placement clearance, the density ramp, and smoothing the cut boundary
  const dist = new Float32Array(mw * mh), N = Math.max(mw, mh);
  for (let p = 0; p < mw * mh; p++) dist[p] = px[p * 4] === 255 ? 1e20 : 0;
  const lf = new Float64Array(N), lv = new Int32Array(N), lz = new Float64Array(N + 1);
  for (let x = 0; x < mw; x++) edt1d(dist, x, mw, mh, lf, lv, lz);       // columns
  for (let y = 0; y < mh; y++) edt1d(dist, y * mw, 1, mw, lf, lv, lz);   // then rows

  // smooth the cut boundary: pull only the seam vertices (cutTouch === 3) toward the true sub-pixel
  // crack edge along dist's gradient, instead of leaving them pinned to the coarse cut grid -- turns
  // the ISLAND_CUT_SEGS staircase into a curve that follows the real crack shape. Not a Delaunay
  // triangulation -- Delaunay picks triangle connectivity for shape quality, it doesn't move vertices
  // toward a curve, so it can't smooth a jagged edge by itself; this is the vertex-relaxation step a
  // proper marching-squares boundary trace would give for free, applied directly to the existing grid
  const sdAt = (X, Y) => {   // bilinear sqrt(dist), same formula as stepDots()'s wall pass
    const fx = X - .5, fy = Y - .5, i = Math.min(mw - 2, Math.max(0, Math.floor(fx))), j = Math.min(mh - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), q = j * mw + i;
    const A = Math.sqrt(dist[q]), B = Math.sqrt(dist[q + 1]), C = Math.sqrt(dist[q + mw]), E = Math.sqrt(dist[q + mw + 1]);
    return (A + (B - A) * tx) * (1 - ty) + (C + (E - C) * tx) * ty;
  };
  const maxStep = .5 * (mw / cutSegsX), EPS = .5;   // capped at half a cell so a vertex can't cross into (and flip) its neighbor
  for (let v = 0; v < gp.count; v++) {
    if (cutTouch[v] !== 3) continue;
    const vx = gu.getX(v) * mw, vy = gu.getY(v) * mh;
    const gx = sdAt(vx + EPS, vy) - sdAt(vx - EPS, vy), gy = sdAt(vx, vy + EPS) - sdAt(vx, vy - EPS);
    const glen = Math.hypot(gx, gy) || 1, step = Math.min(maxStep, sdAt(vx, vy));
    gp.setXY(v, (vx - (gx / glen) * step) / mw - .5, (vy - (gy / glen) * step) / mh - .5);
  }

  // island rig: per island one rigid center (cursor-pushable, springs home, pushes crowded neighbor
  // centers apart) and up to ISLAND_SATS satellites on soft springs to wherever the center carries
  // them, also cursor-pushable. Cut-mesh vertices aren't simulated: each moves with its center plus
  // a Gaussian blend of its nearest satellites' wobble (skinning), recomputed every frame in tick()
  const vIdx = new Int32Array(gp.count).fill(-1), pv = [], vhx = [], vhy = [];
  for (let a = 0; a < islands; a++) for (const v of byIsland[a]) {
    if (vIdx[v] >= 0) continue;
    vIdx[v] = pv.length; pv.push(v);
    vhx.push((gp.getX(v) + .5) * mw); vhy.push((gp.getY(v) + .5) * mh);
  }
  const nv = pv.length, vIsl = Int32Array.from(pv, (v) => vIsland[v]), cellA = (mw / cutSegsX) * (mh / cutSegsY);
  const members = Array.from({ length: islands }, () => []);
  for (let k = 0; k < nv; k++) members[vIsl[k]].push(k);

  const cnt = new Float32Array(islands), c0x = new Float32Array(islands), c0y = new Float32Array(islands), ir = new Float32Array(islands);
  for (let a = 0; a < islands; a++) {
    for (const k of members[a]) { c0x[a] += vhx[k]; c0y[a] += vhy[k]; }
    cnt[a] = members[a].length;
    if (cnt[a]) { c0x[a] /= cnt[a]; c0y[a] /= cnt[a]; }
    ir[a] = Math.sqrt(cnt[a] * cellA / Math.PI) * CENTER_R_SCALE;
  }
  const ila = [], ilb = [], ilux = [], iluy = [], ilrest = [];
  for (let a = 0; a < islands; a++) for (const b of near[a]) {
    if (b <= a || !cnt[a] || !cnt[b]) continue;   // near[] records both directions; meshless islands can't be pushed
    const dx = c0x[b] - c0x[a], dy = c0y[b] - c0y[a], d = Math.hypot(dx, dy) || 1;
    ila.push(a); ilb.push(b); ilux.push(dx / d); iluy.push(dy / d); ilrest.push(d - .01);
  }
  isles = { ...makeBody(c0x, c0y, ir, ila, ilb, ilux, iluy, ilrest, mw, mh), offX: new Float32Array(islands), offY: new Float32Array(islands) };

  // satellites: farthest-point sampling over the island's vertices (seeded at the centroid, so the
  // first pick is the farthest rim point and the rest spread out), then pulled SAT_INSET of the way
  // in from the rim toward the centroid
  const shx = [], shy = [], sIsl = [], sr = [], vs = new Int32Array(nv * 4).fill(-1), vw = new Float32Array(nv * 4);
  for (let a = 0; a < islands; a++) {
    const mem = members[a], K = Math.min(ISLAND_SATS, mem.length), dmin = mem.map((k) => (vhx[k] - c0x[a]) ** 2 + (vhy[k] - c0y[a]) ** 2);
    const sig = Math.sqrt(cnt[a] * cellA / Math.max(1, K)) * SAT_SIGMA, first = shx.length;
    for (let s = 0; s < K; s++) {
      let best = 0;
      for (let i = 1; i < mem.length; i++) if (dmin[i] > dmin[best]) best = i;
      const k = mem[best], X = c0x[a] + (vhx[k] - c0x[a]) * SAT_INSET, Y = c0y[a] + (vhy[k] - c0y[a]) * SAT_INSET;
      shx.push(X); shy.push(Y); sIsl.push(a); sr.push(sig * .5);
      for (let i = 0; i < mem.length; i++) dmin[i] = Math.min(dmin[i], (vhx[mem[i]] - vhx[k]) ** 2 + (vhy[mem[i]] - vhy[k]) ** 2);
    }
    // skin weights: each vertex keeps its 4 strongest satellites, Gaussian in rest distance, summed
    // weight capped at 1 so a vertex far from every satellite just rides the center
    for (const k of mem) {
      const cand = [];
      for (let j = first; j < shx.length; j++) cand.push([j, Math.exp(-((vhx[k] - shx[j]) ** 2 + (vhy[k] - shy[j]) ** 2) / (2 * sig * sig))]);
      cand.sort((p, q) => q[1] - p[1]);
      const top = cand.slice(0, 4), sum = top.reduce((t, c) => t + c[1], 0), norm = sum > 1 ? 1 / sum : 1;
      top.forEach(([j, w], c) => { vs[k * 4 + c] = j; vw[k * 4 + c] = w * norm; });
    }
  }
  const ns = shx.length;
  sats = { ...makeBody(Float32Array.from(shx), Float32Array.from(shy), Float32Array.from(sr), [], [], [], [], [], mw, mh),
    sIsl: Int32Array.from(sIsl), workHx: new Float32Array(ns), workHy: new Float32Array(ns),   // spring target: rest + center offset
    ldx: new Float32Array(ns), ldy: new Float32Array(ns) };   // wobble relative to that target, what the vertices blend
  sats.spring = { ...sats, hx: sats.workHx, hy: sats.workHy };   // cached view, same trick as dots.spring
  verts = { n: nv, hx: Float32Array.from(vhx), hy: Float32Array.from(vhy), x: Float32Array.from(vhx), y: Float32Array.from(vhy), vIsl, vs, vw, pv, gp, mw, mh };

  const full = SCATTER_BASE_SIZE * ui.scale * mh;   // typical (median) instance size, mask px
  const R = SCATTER_FALLOFF * mh;   // density-ramp width, mask px
  // per-dot physics data, filled as dots are placed: home (mask px), radius, depth factor, island
  const hxAll = new Float32Array(ui.instances), hyAll = new Float32Array(ui.instances);
  const rAll = new Float32Array(ui.instances), kAll = new Float32Array(ui.instances), isl = new Int32Array(ui.instances);
  const tally = new Int32Array(islands);   // instances per island, tallied as they're placed below
  let count = 0;
  for (let n = 0; n < ui.instances * 4 && count < ui.instances; n++) {   // up to 4 tries per instance
    const x = Math.floor(Math.random() * mw), y = Math.floor(Math.random() * mh);
    if (!land(x, y)) continue;

    const d = Math.sqrt(dist[y * mw + x]);   // px to the nearest crack

    // size: log-normal around full (spread ui.sizeVar, clamped at 2 sigma), capped to the largest
    // disc whose rim stays 1px clear of the crack. Spots too tight even for SCATTER_MIN_SIZE are skipped
    const cap = 2 * (d - 1);
    if (cap < full * SCATTER_MIN_SIZE) continue;
    const gauss = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());   // Box-Muller
    const spread = Math.exp(ui.sizeVar * Math.max(-2, Math.min(2, gauss)));
    const edge = Math.min(1, d / Math.max(1e-6, ui.ramp * mh));   // 0 at a crack, 1 past the scale ramp
    const taper = ui.minSize + (ui.maxSize - ui.minSize) * edge;   // smaller near the border
    const size = Math.min(full * spread * taper, cap);
    if (Math.random() > SCATTER_MIN_DENSITY + (1 - SCATTER_MIN_DENSITY) * Math.min(1, d / R)) continue;   // thin out near cracks

    const lift = Math.random() * edge, z = SCATTER_LIFT + lift * SCATTER_DEPTH;   // lift: 0 lowest, 1 highest; flattens toward the border
    const k = (DIST - z) / DIST;   // pulls each instance in so it lands on the same screen pixel as
                                   // the plane point under it (default view), whatever its height
    const s = size / mh * h * k;   // mask px -> world units
    // rotate so local +X points along the flow field (mask's G/B); invisible on round dots, matters for a non-round shape
    _m.makeRotationZ(Math.atan2(px[(y * mw + x) * 4 + 2] - 127.5, px[(y * mw + x) * 4 + 1] - 127.5));
    _m.scale(new THREE.Vector3(s, s, 1));
    _m.setPosition(((x + .5) / mw - .5) * h * aspect * k, ((y + .5) / mh - .5) * h * k, z);
    scatter.setColorAt(count, _c.copy(islandColor[island[y * mw + x]]).lerp(SCATTER_SHADOW, SCATTER_SHADE * lift));   // higher = more shadow
    hxAll[count] = x + .5; hyAll[count] = y + .5; rAll[count] = size / 2; kAll[count] = k; isl[count] = island[y * mw + x];
    tally[island[y * mw + x]]++;
    scatter.setMatrixAt(count++, _m);
  }
  // islands too small to carry SCATTER_MIN_ISLAND instances don't exist: drop their dots by
  // compacting the survivors down over them, reusing what's already on the InstancedMesh
  let kept = 0;
  for (let i = 0; i < count; i++) {
    if (tally[isl[i]] < SCATTER_MIN_ISLAND) continue;
    if (kept !== i) {
      scatter.getMatrixAt(i, _m); scatter.setMatrixAt(kept, _m);
      scatter.getColorAt(i, _c); scatter.setColorAt(kept, _c);
      hxAll[kept] = hxAll[i]; hyAll[kept] = hyAll[i]; rAll[kept] = rAll[i]; kAll[kept] = kAll[i]; isl[kept] = isl[i];
    }
    kept++;
  }
  count = kept;

  scatter.count = count;
  scatter.instanceMatrix.needsUpdate = true;
  if (scatter.instanceColor) scatter.instanceColor.needsUpdate = true;   // absent until the first setColorAt (0x0 window)

  // links: same-island dot pairs within 1.5x touching distance at rest, found with a uniform grid.
  // Each keeps the unit direction (ux, uy) between the two homes and a rest separation along it,
  // min(touching, placed distance) minus a hair, so the overlapping layout sits still
  const n = count, hx = hxAll.slice(0, n), hy = hyAll.slice(0, n), r = rAll.slice(0, n);
  let maxR = 0;
  for (let i = 0; i < n; i++) maxR = Math.max(maxR, r[i]);
  const cs = 3 * maxR || 1, cols = Math.ceil(mw / cs), rows = Math.ceil(mh / cs);
  const head = new Int32Array(cols * rows).fill(-1), next = new Int32Array(n), la = [], lb = [], lux = [], luy = [], rest = [];
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(hx[i] / cs), cy = Math.floor(hy[i] / cs);
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(rows - 1, cy + 1); gy++)
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++)
        for (let j = head[gy * cols + gx]; j >= 0; j = next[j]) {
          const dx = hx[j] - hx[i], dy = hy[j] - hy[i], d = Math.hypot(dx, dy), touch = r[i] + r[j];
          if (isl[j] !== isl[i] || d >= 1.5 * touch || d < .02) continue;   // < .02: no direction to push along
          la.push(i); lb.push(j); lux.push(dx / d); luy.push(dy / d); rest.push(Math.min(touch, d - .01));
        }
    next[i] = head[cy * cols + cx];
    head[cy * cols + cx] = i;
  }
  // each dot rides the soft mesh: bilinear weights over the 4 corners of the cut-grid cell under its
  // home, keeping only corners that are particles of the dot's own island (renormalized). No valid
  // corner (right at a crack) leaves all weights 0, so the dot keeps its plain home
  const rv = new Int32Array(n * 4).fill(-1), rw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const fx = Math.min(cutSegsX - 1e-3, Math.max(0, hx[i] / mw * cutSegsX)), fy = Math.min(cutSegsY - 1e-3, Math.max(0, (1 - hy[i] / mh) * cutSegsY));
    const cx = Math.floor(fx), cy = Math.floor(fy), tx = fx - cx, ty = fy - cy;
    let sum = 0;
    for (let c = 0; c < 4; c++) {
      const ox = c & 1, oy = c >> 1, v = (cy + oy) * (cutSegsX + 1) + cx + ox, p = vIdx[v];
      if (p < 0 || vIsland[v] !== isl[i]) continue;
      rv[i * 4 + c] = p; rw[i * 4 + c] = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty); sum += rw[i * 4 + c];
    }
    if (sum > 0) for (let c = 0; c < 4; c++) rw[i * 4 + c] /= sum;
  }
  // no crack walls: the distance field is the crack at rest, and it stops lining up with the land
  // as soon as the mesh bends
  dots = {
    ...makeBody(hx, hy, r, la, lb, lux, luy, rest, mw, mh),
    k: kAll.slice(0, n), isl: isl.slice(0, n),
    h, aspect, rv, rw, workHx: new Float32Array(n), workHy: new Float32Array(n),   // per-dot spring target, refilled each frame in tick()
  };
  // cached view stepDots reads for the dots pass in tick(): hx/hy swapped for the per-frame spring
  // target. workHx/workHy are mutated in place each frame (never reallocated), so this stays valid
  // until the next rebuild -- avoids reconstructing this object on every animation frame
  dots.spring = { ...dots, hx: dots.workHx, hy: dots.workHy };
}

// --- hover physics. Each dot is a 2D particle in mask px (the placement space) that springs back
// to its home. Links only push apart when two dots get closer than they sat at rest, so the dense,
// overlapping layout is stable and a push travels through neighbors like colliding balls. The
// cursor is a solid ball. Runs only while something moves
let dots = null, isles = null, sats = null, verts = null;   // isles: one rigid center per island; sats: satellites; verts: cut-mesh vertices, skinned (not simulated)
let islandGroup = null;   // parent of the per-island meshes cut from the plane
const LINK_PASSES = 1;   // link passes per substep; 2 made pushes travel stiffer but cost more per frame -- unmeasured at the current SCATTER_N, was ~2ms at 8700 dots
const phys ={ cursor: .03, push: 1, spring: .01, damping: .99 };   // GUI "physics" folder; cursor = fraction of plane height
const physIslands = { cursor: .06, push: 1, spring: .025, damping: .55 };   // GUI "islands" folder (rigid centers); reach adds the center's own radius on top
const physSats = { cursor: .025, push: 1, spring: .005, damping: .77 };   // GUI "satellites" folder; spring = how firmly a satellite follows its center

// one frame: 2 substeps of verlet + spring home and the cursor ball, then LINK_PASSES passes of
// links. p: phys-shaped params (passed in so the dev self-check can use its own). Returns the
// largest per-particle move in the last substep, in px, for the sleep test
function stepDots(s, mx, my, p) {
  const { n, x, y, px, py, sx0, sy0, hx, hy, r, m, la, lb, ux, uy, rest, mh } = s, cr = p.cursor * mh;
  let moved = 0;
  for (let sub = 0; sub < 2; sub++) {
    for (let i = 0; i < n; i++) {
      const vx = (x[i] - px[i]) * p.damping, vy = (y[i] - py[i]) * p.damping;
      sx0[i] = x[i]; sy0[i] = y[i];   // position before this substep's forces, for the moved measure
      x[i] += vx + (hx[i] - x[i]) * p.spring;
      y[i] += vy + (hy[i] - y[i]) * p.spring;
      const dx = x[i] - mx, dy = y[i] - my, dd = dx * dx + dy * dy, reach = cr + r[i];
      if (dd < reach * reach) {   // inside the cursor ball: move out toward its surface
        const d = Math.sqrt(dd) || 1e-6, t = (reach - d) / d * p.push;
        x[i] += dx * t; y[i] += dy * t;
      }
    }
    // links push apart along their fixed rest direction u, never along the current a->b line: the
    // separation s = (b - a).u is linear in positions, so every penalty max(0, rest - s)^2 is convex
    // and home is the only resting state. Pushing along a->b instead can hold two dots that swapped
    // places in the swapped order against their springs, a permanent jam
    for (let it = 0; it < LINK_PASSES; it++) {
      for (let l = 0; l < la.length; l++) {
        const a = la[l], b = lb[l], sep = (x[b] - x[a]) * ux[l] + (y[b] - y[a]) * uy[l];
        if (sep >= rest[l]) continue;
        const w = (rest[l] - sep) / (m[a] + m[b]);   // split by mass (r²)
        x[a] -= ux[l] * w * m[b]; y[a] -= uy[l] * w * m[b];
        x[b] += ux[l] * w * m[a]; y[b] += uy[l] * w * m[a];
      }
    }
    // px/py capture position after this substep's push AND links settle: next substep's velocity
    // is (new x - px), so a push's snap is a reposition, not an impulse, and doesn't get carried
    // forward as momentum. Without this, a particle the cursor shoves hard (e.g. passing almost
    // exactly over it, d near 0) keeps drifting for several frames after, decaying only by p.damping
    for (let i = 0; i < n; i++) { px[i] = x[i]; py[i] = y[i]; }
  }
  for (let i = 0; i < n; i++) moved = Math.max(moved, Math.abs(x[i] - sx0[i]) + Math.abs(y[i] - sy0[i]));
  return moved;
}

// write dot positions into the instance matrices' translation (rotation/scale never change),
// same mapping as placement in buildScatter
function writeDots(s) {
  const a = scatter.instanceMatrix.array;
  for (let i = 0; i < s.n; i++) {
    a[i * 16 + 12] = (s.x[i] / s.mw - .5) * s.h * s.aspect * s.k[i];
    a[i * 16 + 13] = (s.y[i] / s.mh - .5) * s.h * s.k[i];
  }
  scatter.instanceMatrix.needsUpdate = true;
}

const cursor = { x: -1e9, y: -1e9 };   // mask px; far away = no cursor
const raycaster = new THREE.Raycaster(), ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const _ndc = new THREE.Vector2(), _hit = new THREE.Vector3();
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!dots) return;
  const el = renderer.domElement;
  _ndc.set(e.offsetX / el.clientWidth * 2 - 1, 1 - e.offsetY / el.clientHeight * 2);
  raycaster.setFromCamera(_ndc, camera);
  if (!raycaster.ray.intersectPlane(ground, _hit)) return;
  cursor.x = (_hit.x / (dots.h * dots.aspect) + .5) * dots.mw;   // inverse of writeDots at k = 1
  cursor.y = (_hit.y / dots.h + .5) * dots.mh;
  wake();
});
renderer.domElement.addEventListener('pointerleave', () => { cursor.x = cursor.y = -1e9; wake(); });

// rAF loop only while awake; sleeps after 30 frames with no particle moving more than .02 px
let running = false, still = 0;
function wake() {
  still = 0;
  if (!running) { running = true; requestAnimationFrame(tick); }
}
function tick() {
  if (!isles) { running = false; return; }   // islands move even with 0 dots; every loop below handles n = 0
  // rigid centers first: cursor push, spring home, and pushing crowded neighbor centers apart
  let moved = stepDots(isles, cursor.x, cursor.y, physIslands);
  const { offX, offY } = isles;
  for (let a = 0; a < isles.n; a++) { offX[a] = isles.x[a] - isles.hx[a]; offY[a] = isles.y[a] - isles.hy[a]; }
  // satellites spring toward wherever their center carries them, and take their own cursor push
  const { sIsl, ldx, ldy } = sats;
  for (let j = 0; j < sats.n; j++) { sats.workHx[j] = sats.hx[j] + offX[sIsl[j]]; sats.workHy[j] = sats.hy[j] + offY[sIsl[j]]; }
  moved = Math.max(moved, stepDots(sats.spring, cursor.x, cursor.y, physSats));
  for (let j = 0; j < sats.n; j++) { ldx[j] = sats.x[j] - sats.workHx[j]; ldy[j] = sats.y[j] - sats.workHy[j]; }
  // skin the cut mesh: vertex = home + its center's offset + weighted satellite wobble, written
  // straight into the shared cut-mesh position buffer
  const { x: vx, y: vy, hx: vhx, hy: vhy, pv, gp, vIsl, vs, vw } = verts;
  for (let k = 0; k < verts.n; k++) {
    const a = vIsl[k];
    let ox = offX[a], oy = offY[a];
    for (let c = k * 4; c < k * 4 + 4; c++) { const j = vs[c]; if (j >= 0) { ox += vw[c] * ldx[j]; oy += vw[c] * ldy[j]; } }
    vx[k] = vhx[k] + ox; vy[k] = vhy[k] + oy;
    gp.setXY(pv[k], vx[k] / verts.mw - .5, vy[k] / verts.mh - .5);
  }
  gp.needsUpdate = true;
  // each dot's spring target this frame = its true home plus the mesh displacement under it, so a
  // dent carries its dots along while they keep their own cursor push and links. dots.spring is a
  // cached view onto dots with hx/hy swapped for workHx/workHy (built once in buildScatter);
  // workHx/workHy are refilled below in place, so the cached view stays valid
  const { rv, rw } = dots;
  for (let i = 0; i < dots.n; i++) {
    let ox = 0, oy = 0;
    for (let c = i * 4; c < i * 4 + 4; c++) {
      const p = rv[c];
      if (p >= 0) { ox += rw[c] * (vx[p] - vhx[p]); oy += rw[c] * (vy[p] - vhy[p]); }
    }
    dots.workHx[i] = dots.hx[i] + ox;
    dots.workHy[i] = dots.hy[i] + oy;
  }
  moved = Math.max(moved, stepDots(dots.spring, cursor.x, cursor.y, phys));
  writeDots(dots);
  render();
  still = moved < .02 ? still + 1 : 0;
  if (still >= 30) { running = false; return; }
  requestAnimationFrame(tick);
}

const stats = new Stats();   // fps / frame-time / memory panel, top-left; click to cycle panels
document.body.appendChild(stats.dom);

// no per-frame loop: re-render on camera change, resize, and while the hover physics is awake
const render = () => { stats.begin(); renderer.render(scene, camera); stats.end(); };
controls.addEventListener('change', render);

addEventListener('keydown', (e) => {
  if (e.key !== 'f') return;
  wireframe.visible = !wireframe.visible;
  render();
});

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  const h = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * DIST * MARGIN;
  plane.scale.set(h * camera.aspect, h, 1);

  // rebuild geometry so wireframe cells stay square: segment count on the wider axis scales
  // with aspect, since the plane's own scale above already stretches non-uniformly
  const segsX = camera.aspect >= 1 ? Math.round(SEGS * camera.aspect) : SEGS;
  const segsY = camera.aspect >= 1 ? SEGS : Math.round(SEGS / camera.aspect);
  plane.geometry.dispose();
  plane.geometry = new THREE.PlaneGeometry(1, 1, segsX, segsY);
  wireframe.geometry.dispose();
  wireframe.geometry = new THREE.WireframeGeometry(plane.geometry);

  buildScatter(camera.aspect, h);   // dots, the island cut meshes, and both physics bodies

  render();
}
// settings panel (top right). Sliders rebuild on release, since a rebuild takes a few hundred ms
const ui = {
  instances: IS_TOUCH ? 2700 : SCATTER_N,
  scale: 1.35,
  minSize: .9,    // taper: size factor at a crack edge
  maxSize: 1.1,   // and deep inside an island
  ramp: .06,      // distance from a crack (fraction of plane height) over which size goes from minSize to maxSize
  sizeVar: SCATTER_SIZE_VAR,
  shader: false,
  newSeed: () => {
    plane.material.uniforms.seed.value.set(Math.random() * 100, Math.random() * 100);
    paletteIdx = (paletteIdx + 1) % SCATTER_PALETTES.length;
    resize();
  },
};
const gui = new GUI();
gui.addFolder('seed').add(ui, 'newSeed').name('new seed');   // new layout + next color family
const dotsUI = gui.addFolder('dots');
dotsUI.add(ui, 'instances', 0, SCATTER_MAX, 100).onFinishChange(resize);
dotsUI.add(ui, 'scale', .2, 3, .05).name('dot scale').onFinishChange(resize);
dotsUI.add(ui, 'minSize', 0, 2, .05).name('min dot scale').onFinishChange(resize);
dotsUI.add(ui, 'maxSize', 0, 2, .05).name('max dot scale').onFinishChange(resize);
dotsUI.add(ui, 'ramp', 0, .3, .01).name('scale ramp').onFinishChange(resize);
dotsUI.add(ui, 'sizeVar', 0, 1.2, .05).name('size variation').onFinishChange(resize);
// shader sliders redraw live while dragging (cheap); dots re-place on release
const shaderUI = gui.addFolder('shader'), u = plane.material.uniforms;
shaderUI.add(u.patternScale, 'value', .3, 3, .05).name('shader scale').onChange(render).onFinishChange(resize);
shaderUI.add(u.patternRatio, 'value', .25, 4, .05).name('shader ratio').onChange(render).onFinishChange(resize);
shaderUI.add(u.zebraAmp, 'value', 0, 1.2, .01).name('warp amp').onChange(render).onFinishChange(resize);
shaderUI.add(u.noiseFreq, 'value', .2, 4, .05).name('warp noise').onChange(render).onFinishChange(resize);
shaderUI.add(u.widthMin, 'value', 0, 20, .5).name('crack width min').onChange(render).onFinishChange(resize);
shaderUI.add(u.widthMax, 'value', 1, 20, .5).name('crack width max').onChange(render).onFinishChange(resize);
// hides the plane from the main camera only: maskCam still sees layer 0, so placement is unaffected
shaderUI.add(ui, 'shader').name('show shader').onChange((v) => { camera.layers[v ? 'enable' : 'disable'](0); render(); });
if (!ui.shader) camera.layers.disable(0);   // apply the default; onChange only fires on user changes
// read every frame, so these apply live
// cursor/push/spring/damping sliders bound to a phys-shaped object, read live every frame
function physFolder(name, obj) {
  const f = gui.addFolder(name);
  f.add(obj, 'cursor', 0, .15, .005).name('cursor size');
  f.add(obj, 'push', 0, 1, .05);
  f.add(obj, 'spring', 0, .2, .005);
  f.add(obj, 'damping', .5, .99, .01);
  return f;
}
physFolder('physics', phys);
physFolder('islands', physIslands);   // rigid centers
physFolder('satellites', physSats);

addEventListener('resize', resize);
resize();
if (import.meta.env.DEV) window.dbg = { renderer, scene, camera, scatter, plane, maskMat, phys, physIslands, physSats, cursor, stepDots, get dots() { return dots; }, get isles() { return isles; }, get sats() { return sats; }, get verts() { return verts; }, get running() { return running; } };   // for the checks in CLAUDE.md

if (import.meta.env.DEV) {   // self-check: edt1d against brute force on a random 40x30 grid
  const W = 40, H = 30, g = Float32Array.from({ length: W * H }, () => (Math.random() < .05 ? 0 : 1e20));
  const ink = [...g.keys()].filter((p) => g[p] === 0), n = Math.max(W, H);
  const f = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) edt1d(g, x, W, H, f, v, z);
  for (let y = 0; y < H; y++) edt1d(g, y * W, 1, W, f, v, z);
  const brute = (p) => Math.min(...ink.map((q) => (q % W - p % W) ** 2 + (Math.floor(q / W) - Math.floor(p / W)) ** 2));
  console.assert(!ink.length || [...g.keys()].every((p) => g[p] === brute(p)), 'edt1d disagrees with brute force');
}

if (import.meta.env.DEV) {   // self-check: stepDots on tiny 40x40 states (links, spring home, push, center links)
  const mk = (pts, links) => {   // pts: [x, y, r], links: [a, b, rest]; u from the homes
    const col = (c) => Float32Array.from(pts, (q) => q[c]);
    const u = links.map(([a, b]) => { const dx = pts[b][0] - pts[a][0], dy = pts[b][1] - pts[a][1], d = Math.hypot(dx, dy); return [dx / d, dy / d]; });
    return makeBody(col(0), col(1), col(2), links.map((l) => l[0]), links.map((l) => l[1]), u.map((v) => v[0]), u.map((v) => v[1]), links.map((l) => l[2]), 40, 40);
  };
  const off = -1e9, inert = { cursor: 0, push: 0, spring: 0, damping: 0 };
  const a = mk([[18, 20, 3], [20, 20, 3]], [[0, 1, 6]]);   // 2px apart, rest 6
  for (let i = 0; i < 5; i++) stepDots(a, off, off, inert);
  console.assert(Math.hypot(a.x[1] - a.x[0], a.y[1] - a.y[0]) >= 6 - 1e-3, 'stepDots: link left dots closer than rest');
  const b = mk([[20, 20, 3]], []);
  b.x[0] = b.px[0] = 26;   // displaced 6px from home
  for (let i = 0; i < 300; i++) stepDots(b, off, off, { cursor: 0, push: 0, spring: .05, damping: .9 });
  console.assert(Math.hypot(b.x[0] - 20, b.y[0] - 20) < .5, 'stepDots: dot did not return home');
  // phantom velocity: sweep a cursor ball all the way through and past a dot. It must get shoved
  // out in bounded steps, never keep drifting on later frames the way an unresynced px/py used to
  const ov = mk([[20, 20, 3]], []);
  let maxStep = 0, prevX = ov.x[0];
  for (let i = 0; i < 60; i++) {
    stepDots(ov, 20 - 12 + i * .5, 20, { cursor: .25, push: 1, spring: 0, damping: .9 });
    maxStep = Math.max(maxStep, Math.abs(ov.x[0] - prevX));
    prevX = ov.x[0];
  }
  console.assert(maxStep < 20, 'stepDots: cursor overtaking a dot caused runaway drift (phantom velocity)');
  // island centers: cursor shoves center 0 into center 1 past their rest distance; the link must
  // push center 1 off its home too (that's how one island shoves its neighbor)
  const ic = mk([[10, 20, 3], [20, 20, 3]], [[0, 1, 10]]);
  for (let i = 0; i < 10; i++) stepDots(ic, 4, 20, { cursor: .2, push: 1, spring: 0, damping: 0 });
  console.assert(ic.x[1] - ic.hx[1] > .5, 'island centers: a shoved center did not push its neighbor');
}
