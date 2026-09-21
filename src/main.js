import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import GUI from 'three/examples/jsm/libs/lil-gui.module.min.js';
import crack from './crack.glsl.js';

const DIST = 3;         // camera distance; the background plane is sized to fill the window at this distance
const MARGIN = 1.25;    // plane oversize factor so edges don't show on resize or orbit
const SEED = [Math.random() * 100, Math.random() * 100];   // random per page load; hardcode for a reproducible layout

const SCATTER_N = 6000;      // instances to place (default for the GUI slider)
const SCATTER_MAX = 20000;   // InstancedMesh capacity, and the GUI slider's max
const SCATTER_LIFT = .02;    // z-offset above the shader plane so instances don't z-fight it
const SCATTER_DEPTH = .05;   // random extra height on top of SCATTER_LIFT, world units (full dot ~.07)
const SCATTER_SHADE = .6;    // how much darker the lowest dots are than the highest (0 = no shading)
const SCATTER_MIN_SIZE = .3; // smallest an instance may shrink to fit beside a crack (fraction of base size);
                              // spots too tight even for that are skipped
const SCATTER_BASE_SIZE = .02; // full instance size, as a fraction of plane height
const SCATTER_FALLOFF = .03; // distance from a crack (fraction of plane height) over which density ramps
                              // from SCATTER_MIN_DENSITY up to full
const SCATTER_MIN_DENSITY = .05; // placement probability right at a crack edge (fraction of full density)
const SCATTER_TILT = 0;      // max random X/Y tilt in radians; 0 keeps dots round, .5 (~29°) gave
                              // the old leaf-on-a-branch look but turns dots into ovals
const SCATTER_EDGE = 0;      // how far out from a crack instances must stay: 0 = right up to the solid
                              // black, 1 = clear of the whole speckle halo (0..1)
const SCATTER_FLOW_FREQ = 1.2; // flow-field noise cells per pattern unit (2 units = plane height);
                              // higher = smaller swirls
const SCATTER_PALETTE = [     // dot colors, one per island, picked so neighboring islands differ
  0x9bbf7a, 0x5f8f55, 0xc7dca4,   // greens
  0xd8589a, 0xeea6c6,             // pinks
  0xf2ece2,                       // cream
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

const SEGS = 50;   // wireframe subdivisions along the plane's shorter side; the longer side gets
                    // SEGS * aspect (recomputed in resize()) so each cell stays square on screen
                    // instead of stretching with the window

const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, SEGS, SEGS), new THREE.ShaderMaterial({
  uniforms: { seed: { value: new THREE.Vector2(...SEED) }, patternScale: { value: 1 } },
  // uv -> pattern space (2 units = plane height at patternScale 1; higher = bigger cells), aspect
  // taken from the plane's own scale
  vertexShader: /* glsl */ `
    uniform float patternScale;
    varying vec2 vUv;
    void main() {
      vUv = uv * vec2(length(modelMatrix[0].xyz) / length(modelMatrix[1].xyz), 1.) * 2. / patternScale;
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
maskMat.uniforms.seed = plane.material.uniforms.seed;   // shared, so GUI changes reach both
maskMat.uniforms.patternScale = plane.material.uniforms.patternScale;
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
  // so neither the density ramp nor the edge-shrink width costs a per-instance search
  const dist = new Float32Array(mw * mh), N = Math.max(mw, mh);
  for (let p = 0; p < mw * mh; p++) dist[p] = px[p * 4] === 255 ? 1e20 : 0;
  const lf = new Float64Array(N), lv = new Int32Array(N), lz = new Float64Array(N + 1);
  for (let x = 0; x < mw; x++) edt1d(dist, x, mw, mh, lf, lv, lz);       // columns
  for (let y = 0; y < mh; y++) edt1d(dist, y * mw, 1, mw, lf, lv, lz);   // then rows

  const full = SCATTER_BASE_SIZE * ui.scale * mh;   // full instance size, mask px
  const R = SCATTER_FALLOFF * mh, E = ui.edge * mh;   // density-ramp and size-ease widths, mask px
  let count = 0;
  for (let n = 0; n < ui.instances * 4 && count < ui.instances; n++) {   // up to 4 tries per instance
    const x = Math.floor(Math.random() * mw), y = Math.floor(Math.random() * mh);
    if (!land(x, y)) continue;

    const d = Math.sqrt(dist[y * mw + x]);   // px to the nearest crack

    const tx = (Math.random() * 2 - 1) * SCATTER_TILT, ty = (Math.random() * 2 - 1) * SCATTER_TILT;

    // random size between SCATTER_MIN_SIZE and full, its range eased (smoothstep) down to
    // SCATTER_MIN_SIZE toward the crack over ui.edge ("edge shrink"), then capped to the largest
    // disc whose rim stays 1px clear of the crack. f: a tilted rim rising toward the camera also
    // drifts outward on screen, more the farther the instance sits from the view center
    const t = Math.min(1, d / E), ease = t * t * (3 - 2 * t);   // E = 0: d / 0 = Infinity, no shrink
    const rise = Math.sqrt(1 - (Math.cos(tx) * Math.cos(ty)) ** 2);   // sin of the tilt from flat
    const f = 1 + Math.hypot(x - mw / 2, y - mh / 2) / mh * h * rise / DIST;
    const size = Math.min(full * (SCATTER_MIN_SIZE + (1 - SCATTER_MIN_SIZE) * Math.random() * ease), 2 * (d - 1) / f);
    if (size < full * SCATTER_MIN_SIZE) continue;
    if (Math.random() > SCATTER_MIN_DENSITY + (1 - SCATTER_MIN_DENSITY) * Math.min(1, d / R)) continue;   // thin out near cracks

    const lift = Math.random(), z = SCATTER_LIFT + lift * SCATTER_DEPTH;   // lift: 0 lowest, 1 highest
    const k = (DIST - z) / DIST;   // pulls each instance in so it lands on the same screen pixel as
                                   // the plane point under it (default view), whatever its height
    const s = size / mh * h * k;   // mask px -> world units
    _m.makeRotationFromEuler(new THREE.Euler(tx, ty,
      Math.atan2(px[(y * mw + x) * 4 + 2] - 127.5, px[(y * mw + x) * 4 + 1] - 127.5),   // flow direction from the mask's G/B: +X points along the flow
    ));
    _m.scale(new THREE.Vector3(s, s, 1));
    _m.setPosition(((x + .5) / mw - .5) * h * aspect * k, ((y + .5) / mh - .5) * h * k, z);
    scatter.setColorAt(count, _c.copy(islandColor[island[y * mw + x]]).multiplyScalar(1 - SCATTER_SHADE * (1 - lift)));   // lower = darker
    scatter.setMatrixAt(count++, _m);
  }
  scatter.count = count;
  scatter.instanceMatrix.needsUpdate = true;
  if (scatter.instanceColor) scatter.instanceColor.needsUpdate = true;   // absent until the first setColorAt (0x0 window)
}

// scene is static, so only re-render on camera/resize instead of every frame
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
  instances: SCATTER_N,
  scale: 1,
  edge: SCATTER_FALLOFF,   // width of the size ease toward cracks, fraction of plane height
  shader: true,
  newSeed: () => { plane.material.uniforms.seed.value.set(Math.random() * 100, Math.random() * 100); resize(); },
};
const gui = new GUI();
gui.add(ui, 'instances', 0, SCATTER_MAX, 100).onFinishChange(resize);
gui.add(ui, 'scale', .2, 3, .05).name('dot scale').onFinishChange(resize);
gui.add(ui, 'edge', 0, .2, .005).name('edge shrink').onFinishChange(resize);
// shader redraws live while dragging (cheap); dots re-place on release
gui.add(plane.material.uniforms.patternScale, 'value', .3, 3, .05).name('shader scale').onChange(render).onFinishChange(resize);
gui.add(ui, 'newSeed').name('new seed');
// hides the plane from the main camera only: maskCam still sees layer 0, so placement is unaffected
gui.add(ui, 'shader').name('show shader').onChange((v) => { camera.layers[v ? 'enable' : 'disable'](0); render(); });

addEventListener('resize', resize);
resize();
if (import.meta.env.DEV) window.dbg = { renderer, scene, camera, scatter, plane, maskMat };   // for the overlap check in CLAUDE.md

if (import.meta.env.DEV) {   // self-check: edt1d against brute force on a random 40x30 grid
  const W = 40, H = 30, g = Float32Array.from({ length: W * H }, () => (Math.random() < .05 ? 0 : 1e20));
  const ink = [...g.keys()].filter((p) => g[p] === 0), n = Math.max(W, H);
  const f = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) edt1d(g, x, W, H, f, v, z);
  for (let y = 0; y < H; y++) edt1d(g, y * W, 1, W, f, v, z);
  const brute = (p) => Math.min(...ink.map((q) => (q % W - p % W) ** 2 + (Math.floor(q / W) - Math.floor(p / W)) ** 2));
  console.assert(!ink.length || [...g.keys()].every((p) => g[p] === brute(p)), 'edt1d disagrees with brute force');
}
