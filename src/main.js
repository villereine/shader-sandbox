import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import crack from './crack.glsl.js';

const DIST = 3;         // camera distance; the background plane is sized to fill the window at this distance
const MARGIN = 1.25;    // plane oversize factor so edges don't show on resize or orbit
const SEED = [Math.random() * 100, Math.random() * 100];   // random per page load; hardcode for a reproducible layout
const IS_TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;

const SCATTER_N = 15100;     // instances to place (default for the GUI slider)
const SCATTER_MAX = 20000;   // InstancedMesh capacity, and the GUI slider's max
const SCATTER_LIFT = .02;    // z-offset above the shader plane so instances don't z-fight it
const SCATTER_DEPTH = .15;   // random extra height on top of SCATTER_LIFT, world units (typical dot ~.045 across)
const SCATTER_SHADE = .6;    // how much darker the lowest dots are than the highest (0 = no shading)
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
const SCATTER_PALETTE = [     // dot colors, one per island, picked so neighboring islands differ
  0x9bbf7a, 0x5f8f55, 0xc7dca4,   // greens
  0xd8589a, 0xeea6c6,             // pinks
  0x3f6e8c,                       // steel blue
  0xb39ad8, 0x7d6aa6,             // lavenders
].map((c) => new THREE.Color(c));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, .1, 100);
camera.position.set(0, 0, DIST);
const controls = new OrbitControls(camera, renderer.domElement);
if (IS_TOUCH) controls.enabled = false;   // lock camera on touch devices; finger still pushes dots via pointermove

const SEGS = 50;   // wireframe subdivisions along the plane's shorter side; the longer side gets
                    // SEGS * aspect (recomputed in resize()) so each cell stays square on screen
                    // instead of stretching with the window

const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, SEGS, SEGS), new THREE.ShaderMaterial({
  uniforms: {
    seed: { value: new THREE.Vector2(...SEED) },
    patternScale: { value: .55 },
    patternRatio: { value: 1 },
    zebraAmp: { value: 1.2 },   // see crack.glsl.js
    noiseFreq: { value: .5 },
    widthMin: { value: 5 },   // crack line half-width range, in pixels; see crack.glsl.js
    widthMax: { value: 9 },
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

const _m = new THREE.Matrix4(), _c = new THREE.Color();
function buildScatter(aspect, h) {
  const mw = Math.round(renderer.domElement.width * MARGIN), mh = Math.round(renderer.domElement.height * MARGIN);
  Object.assign(maskCam, { left: -h * aspect / 2, right: h * aspect / 2, top: h / 2, bottom: -h / 2 });
  maskCam.updateProjectionMatrix();
  maskRT.setSize(mw, mh);
  const crackMat = plane.material;
  plane.material = maskMat;
  renderer.setRenderTarget(maskRT);
  renderer.render(scene, maskCam);
  plane.material = crackMat;
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
    const free = SCATTER_PALETTE.filter((c) => ![...near[a]].some((b) => islandColor[b] === c));
    const pick = free.length ? free : SCATTER_PALETTE;
    islandColor[a] = pick[Math.floor(Math.random() * pick.length)];
  }

  // distance (px) from every pixel to the nearest crack pixel: one exact 2D distance transform,
  // used for placement clearance, the density ramp, and the physics walls
  const dist = new Float32Array(mw * mh), N = Math.max(mw, mh);
  for (let p = 0; p < mw * mh; p++) dist[p] = px[p * 4] === 255 ? 1e20 : 0;
  const lf = new Float64Array(N), lv = new Int32Array(N), lz = new Float64Array(N + 1);
  for (let x = 0; x < mw; x++) edt1d(dist, x, mw, mh, lf, lv, lz);       // columns
  for (let y = 0; y < mh; y++) edt1d(dist, y * mw, 1, mw, lf, lv, lz);   // then rows

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
    const size = Math.min(full * spread, cap);
    if (Math.random() > SCATTER_MIN_DENSITY + (1 - SCATTER_MIN_DENSITY) * Math.min(1, d / R)) continue;   // thin out near cracks

    const lift = Math.random(), z = SCATTER_LIFT + lift * SCATTER_DEPTH;   // lift: 0 lowest, 1 highest
    const k = (DIST - z) / DIST;   // pulls each instance in so it lands on the same screen pixel as
                                   // the plane point under it (default view), whatever its height
    const s = size / mh * h * k;   // mask px -> world units
    // rotate so local +X points along the flow field (mask's G/B); invisible on round dots, matters for a non-round shape
    _m.makeRotationZ(Math.atan2(px[(y * mw + x) * 4 + 2] - 127.5, px[(y * mw + x) * 4 + 1] - 127.5));
    _m.scale(new THREE.Vector3(s, s, 1));
    _m.setPosition(((x + .5) / mw - .5) * h * aspect * k, ((y + .5) / mh - .5) * h * k, z);
    scatter.setColorAt(count, _c.copy(islandColor[island[y * mw + x]]).multiplyScalar(1 - SCATTER_SHADE * (1 - lift)));   // lower = darker
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
  dots = {
    n, x: hx.slice(), y: hy.slice(), px: hx.slice(), py: hy.slice(), hx, hy, r, m: r.map((v) => v * v),
    k: kAll.slice(0, n), la: Int32Array.from(la), lb: Int32Array.from(lb),
    ux: Float32Array.from(lux), uy: Float32Array.from(luy), rest: Float32Array.from(rest),
    dist, ghost: new Uint8Array(n), stillSince: new Float64Array(n).fill(-1),
    releaseDelay: Float32Array.from({ length: n }, () => RELEASE_MIN + Math.random() * (RELEASE_MAX - RELEASE_MIN)),
    maxR, mw, mh, h, aspect,
  };
}

// --- hover physics. Each dot is a 2D particle in mask px (the placement space) that springs back
// to its home. Links only push apart when two dots get closer than they sat at rest, so the dense,
// overlapping layout is stable and a push travels through neighbors like colliding balls. Cracks
// are walls via the distance transform. The cursor is a solid ball. Runs only while something moves
let dots = null;
const LINK_PASSES = 1;   // links + walls passes per substep; 2 made pushes travel stiffer but cost more per frame -- unmeasured at the current SCATTER_N, was ~2ms at 8700 dots
const phys ={ cursor: .02, push: .7, spring: .01, damping: .9 };   // GUI "physics" folder; cursor = fraction of plane height
const RELEASE_MIN = 2000, RELEASE_MAX = 5000;   // ms a trapped dot sits still (away from home, clear of the
                                                 // cursor) before it ghosts home; randomized per dot so a big
                                                 // sweep releases its trapped dots staggered, not all at once

// one frame: 2 substeps of verlet + spring home and the cursor ball, then LINK_PASSES passes of
// links and crack walls. p: phys-shaped params (passed in so the dev self-check can use its own). now:
// timestamp (ms, from requestAnimationFrame) for the trapped-dot release timer. Returns the largest
// per-dot move in the last substep, in px, for the sleep test
function stepDots(s, mx, my, p, now = performance.now()) {
  const { n, x, y, px, py, hx, hy, r, m, la, lb, ux, uy, rest, dist, ghost, stillSince, releaseDelay, maxR, mw, mh } = s, cr = p.cursor * mh;
  // px to the nearest crack, bilinear between pixel centers so the wall is smooth: a per-pixel
  // field made pushed-out dots overshoot, then spring back in, forever. Clamped to the mask edge
  const sd = (X, Y) => {
    const fx = X - .5, fy = Y - .5, i = Math.min(mw - 2, Math.max(0, Math.floor(fx))), j = Math.min(mh - 2, Math.max(0, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - i)), ty = Math.min(1, Math.max(0, fy - j)), q = j * mw + i;
    const a = Math.sqrt(dist[q]), b = Math.sqrt(dist[q + 1]), c = Math.sqrt(dist[q + mw]), e = Math.sqrt(dist[q + mw + 1]);
    return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
  };
  let moved = 0;
  for (let sub = 0; sub < 2; sub++) {
    for (let i = 0; i < n; i++) {
      const vx = (x[i] - px[i]) * p.damping, vy = (y[i] - py[i]) * p.damping;
      px[i] = x[i]; py[i] = y[i];
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
        if (sep >= rest[l] || ghost[a] || ghost[b]) continue;
        const w = (rest[l] - sep) / (m[a] + m[b]);   // split by mass (r²)
        x[a] -= ux[l] * w * m[b]; y[a] -= uy[l] * w * m[b];
        x[b] += ux[l] * w * m[a]; y[b] += uy[l] * w * m[a];
      }
      // walls: a rim closer than 1px to a crack is pushed back out along the distance field's
      // gradient, so the dot slides along the wall. Reverting the whole move instead also threw
      // away the spring's pull home, pinning dots (and, through links, their neighbors) at walls
      for (let i = 0; i < n; i++) {
        if (ghost[i]) continue;   // ghosting dots skip walls -- see the trapped-release check below
        const c = r[i] + 1 - 1e-3;   // the 1e-3: dots placed exactly at the limit
        // tunneling: a hard push can move a dot more than the ~1px wall band in one substep,
        // jumping clean over it between samples. Spacing is tied to c (the actual clearance,
        // typically a few px) so it can't outrun a thin crack; capped at 64 samples for a bound on
        // worst-case cost, which still covers pushes into the hundreds of px at typical c -- only
        // truly extreme cursor+push+width combinations (see CLAUDE.md) can still slip past. Only
        // dots that moved that far this substep pay for walking the path; everything else keeps
        // the cheap grid early-exit below unchanged
        const mdx = x[i] - px[i], mdy = y[i] - py[i], moveSq = mdx * mdx + mdy * mdy;
        if (moveSq > 1) {
          const steps = Math.min(64, Math.ceil(Math.sqrt(moveSq) / (c * .5)));
          for (let st = 1; st < steps; st++) {
            const t = st / steps, sx = px[i] + mdx * t, sy = py[i] + mdy * t;
            if (sd(sx, sy) < c) { x[i] = sx; y[i] = sy; break; }   // first unsafe sample; refine below
          }
        } else if (dist[Math.floor(y[i]) * mw + Math.floor(x[i])] >= (c + 1.5) ** 2) continue;   // clearly clear
        const d = sd(x[i], y[i]);
        if (d >= c) continue;
        const gx = sd(x[i] + 1, y[i]) - sd(x[i] - 1, y[i]), gy = sd(x[i], y[i] + 1) - sd(x[i], y[i] - 1), g = Math.hypot(gx, gy);
        if (g > 0) { x[i] += gx / g * (c - d + .01); y[i] += gy / g * (c - d + .01); }
        if (!(sd(x[i], y[i]) >= c - .05)) { x[i] = px[i]; y[i] = py[i]; }   // concave corner: back off
      }
    }
  }
  // Walls make islands non-convex, so a pushed dot can settle where its way home is blocked: a neck
  // narrower than the dot, or neighbors pinned against a wall. A dot away from home, clear of the
  // cursor (so a resting cursor keeps its hole), and not moving ghosts home (walls and links skip a
  // ghost until it arrives) once it's sat that way for its own randomized RELEASE_MIN..RELEASE_MAX,
  // so a big sweep's trapped dots free up staggered instead of snapping back all at once
  const zone = cr + 4 * maxR, zoneSq = zone * zone;   // cursor reach plus a few dots of neighbors it's still working on
  for (let i = 0; i < n; i++) {
    const dm = Math.abs(x[i] - px[i]) + Math.abs(y[i] - py[i]);
    moved = Math.max(moved, dm);
    if (ghost[i]) {
      if (Math.abs(x[i] - hx[i]) + Math.abs(y[i] - hy[i]) < .5) ghost[i] = 0;   // home: solid again
      continue;
    }
    const hdx = x[i] - hx[i], hdy = y[i] - hy[i], cdx = x[i] - mx, cdy = y[i] - my;
    const stuck = dm < .02 && hdx * hdx + hdy * hdy > .25 && cdx * cdx + cdy * cdy >= zoneSq;
    // stillSince < 0 means "timer not running" -- 0 can't be the sentinel since now (a real rAF
    // timestamp) can legitimately be 0, which would otherwise look unset and never latch
    if (!stuck) stillSince[i] = -1;
    else if (stillSince[i] < 0) stillSince[i] = now;
    else if (now - stillSince[i] >= releaseDelay[i]) ghost[i] = 1;
  }
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

// rAF loop only while awake; sleeps after 30 frames with no dot moving more than .02 px and no
// trapped dot mid-countdown toward its release (see stepDots)
let running = false, still = 0;
function wake() {
  still = 0;
  if (!running) { running = true; requestAnimationFrame(tick); }
}
function tick(now) {
  if (!dots || !dots.n) { running = false; return; }
  const moved = stepDots(dots, cursor.x, cursor.y, phys, now);
  writeDots(dots);
  render();
  still = moved < .02 ? still + 1 : 0;
  if (still >= 30 && !dots.stillSince.some((t) => t)) { running = false; return; }
  requestAnimationFrame(tick);
}

// no per-frame loop: re-render on camera change, resize, and while the hover physics is awake
const render = () => renderer.render(scene, camera);
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

  buildScatter(camera.aspect, h);

  render();
}
// settings panel (top right). Sliders rebuild on release, since a rebuild takes a few hundred ms
const ui = {
  instances: IS_TOUCH ? 2700 : SCATTER_N,
  scale: 1.4,
  sizeVar: SCATTER_SIZE_VAR,
  shader: false,
  newSeed: () => { plane.material.uniforms.seed.value.set(Math.random() * 100, Math.random() * 100); resize(); },
};
const gui = new GUI();
const dotsUI = gui.addFolder('dots');
dotsUI.add(ui, 'instances', 0, SCATTER_MAX, 100).onFinishChange(resize);
dotsUI.add(ui, 'scale', .2, 3, .05).name('dot scale').onFinishChange(resize);
dotsUI.add(ui, 'sizeVar', 0, 1.2, .05).name('size variation').onFinishChange(resize);
// shader sliders redraw live while dragging (cheap); dots re-place on release
const shaderUI = gui.addFolder('shader'), u = plane.material.uniforms;
shaderUI.add(u.patternScale, 'value', .3, 3, .05).name('shader scale').onChange(render).onFinishChange(resize);
shaderUI.add(u.patternRatio, 'value', .25, 4, .05).name('shader ratio').onChange(render).onFinishChange(resize);
shaderUI.add(u.zebraAmp, 'value', 0, 1.2, .01).name('warp amp').onChange(render).onFinishChange(resize);
shaderUI.add(u.noiseFreq, 'value', .2, 4, .05).name('warp noise').onChange(render).onFinishChange(resize);
shaderUI.add(u.widthMin, 'value', 1, 20, .5).name('crack width min').onChange(render).onFinishChange(resize);
shaderUI.add(u.widthMax, 'value', 1, 20, .5).name('crack width max').onChange(render).onFinishChange(resize);
shaderUI.add(ui, 'newSeed').name('new seed');
// hides the plane from the main camera only: maskCam still sees layer 0, so placement is unaffected
shaderUI.add(ui, 'shader').name('show shader').onChange((v) => { camera.layers[v ? 'enable' : 'disable'](0); render(); });
if (!ui.shader) camera.layers.disable(0);   // apply the default; onChange only fires on user changes
// read every frame, so these apply live
const physUI = gui.addFolder('physics');
physUI.add(phys, 'cursor', 0, .15, .005).name('cursor size');
physUI.add(phys, 'push', 0, 1, .05);
physUI.add(phys, 'spring', 0, .2, .005);
physUI.add(phys, 'damping', .5, .99, .01);

addEventListener('resize', resize);
resize();
if (import.meta.env.DEV) window.dbg = { renderer, scene, camera, scatter, plane, maskMat, phys, cursor, stepDots, get dots() { return dots; }, get running() { return running; } };   // for the checks in CLAUDE.md

if (import.meta.env.DEV) {   // self-check: edt1d against brute force on a random 40x30 grid
  const W = 40, H = 30, g = Float32Array.from({ length: W * H }, () => (Math.random() < .05 ? 0 : 1e20));
  const ink = [...g.keys()].filter((p) => g[p] === 0), n = Math.max(W, H);
  const f = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) edt1d(g, x, W, H, f, v, z);
  for (let y = 0; y < H; y++) edt1d(g, y * W, 1, W, f, v, z);
  const brute = (p) => Math.min(...ink.map((q) => (q % W - p % W) ** 2 + (Math.floor(q / W) - Math.floor(p / W)) ** 2));
  console.assert(!ink.length || [...g.keys()].every((p) => g[p] === brute(p)), 'edt1d disagrees with brute force');
}

if (import.meta.env.DEV) {   // self-check: stepDots on tiny 40x40 states (links, spring home, walls)
  const W = 40, open = new Float32Array(W * W).fill(1e20);
  const mk = (pts, links, dist) => {   // pts: [x, y, r], links: [a, b, rest]; u from the homes
    const col = (c) => Float32Array.from(pts, (q) => q[c]), x = col(0), y = col(1), r = col(2);
    const u = (l, c) => (pts[l[1]][c] - pts[l[0]][c]) / Math.hypot(pts[l[1]][0] - pts[l[0]][0], pts[l[1]][1] - pts[l[0]][1]);
    return { n: pts.length, x, y, px: x.slice(), py: y.slice(), hx: x.slice(), hy: y.slice(), r, m: r.map((v) => v * v),
      la: Int32Array.from(links, (l) => l[0]), lb: Int32Array.from(links, (l) => l[1]),
      ux: Float32Array.from(links, (l) => u(l, 0)), uy: Float32Array.from(links, (l) => u(l, 1)),
      rest: Float32Array.from(links, (l) => l[2]), dist, ghost: new Uint8Array(pts.length),
      // stillSince/releaseDelay: huge delay so the release-timer logic never fires mid-test
      stillSince: new Float64Array(pts.length).fill(-1), releaseDelay: new Float32Array(pts.length).fill(1e9),
      maxR: Math.max(...r), mw: W, mh: W };
  };
  const off = -1e9, inert = { cursor: 0, push: 0, spring: 0, damping: 0 };
  const a = mk([[18, 20, 3], [20, 20, 3]], [[0, 1, 6]], open);   // 2px apart, rest 6
  for (let i = 0; i < 5; i++) stepDots(a, off, off, inert, i);
  console.assert(Math.hypot(a.x[1] - a.x[0], a.y[1] - a.y[0]) >= 6 - 1e-3, 'stepDots: link left dots closer than rest');
  const b = mk([[20, 20, 3]], [], open);
  b.x[0] = b.px[0] = 26;   // displaced 6px from home
  for (let i = 0; i < 300; i++) stepDots(b, off, off, { cursor: 0, push: 0, spring: .05, damping: .9 }, i);
  console.assert(Math.hypot(b.x[0] - 20, b.y[0] - 20) < .5, 'stepDots: dot did not return home');
  const wall = new Float32Array(W * W).map((_, q) => (q % W >= 30 ? 0 : 1e20)), nf = new Float64Array(W), nv = new Int32Array(W), nz = new Float64Array(W + 1);
  for (let x = 0; x < W; x++) edt1d(wall, x, W, W, nf, nv, nz);
  for (let y = 0; y < W; y++) edt1d(wall, y * W, 1, W, nf, nv, nz);   // crack at x >= 30
  const c = mk([[20, 20, 3]], [], wall);
  let ok = true;
  for (let i = 0; i < 60; i++) {   // cursor ball shoves the dot right, into the wall
    stepDots(c, 20 - 12 + i * .5, 20, { cursor: .25, push: 1, spring: 0, damping: .9 }, i);
    ok &&= wall[Math.floor(c.y[0]) * W + Math.floor(c.x[0])] >= (c.r[0] + 1 - 1e-3) ** 2;
  }
  console.assert(ok && c.x[0] > 21, 'stepDots: wall let a dot reach the crack, or the dot never moved');
  // thin (1px) crack with land on both sides -- unlike the block wall above, this is the actual
  // tunneling shape: a single hard push must not skip clean over it in one substep
  const thin = new Float32Array(W * W).map((_, q) => (q % W === 30 ? 0 : 1e20));
  const tf = new Float64Array(W), tv = new Int32Array(W), tz = new Float64Array(W + 1);
  for (let x = 0; x < W; x++) edt1d(thin, x, W, W, tf, tv, tz);
  for (let y = 0; y < W; y++) edt1d(thin, y * W, 1, W, tf, tv, tz);
  const th = mk([[25, 20, 3]], [], thin);
  stepDots(th, 23, 20, { cursor: .25, push: 1, spring: 0, damping: .9 }, 1);
  console.assert(th.x[0] < 30 && thin[Math.floor(th.y[0]) * W + Math.floor(th.x[0])] >= (th.r[0] + 1 - 1e-3) ** 2,
    'stepDots: a hard push tunneled through a thin crack');
}
