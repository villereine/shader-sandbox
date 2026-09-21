import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import crack from './crack.glsl.js';

const DIST = 3;         // camera distance; the background plane is sized to fill the window at this distance
const MARGIN = 1.25;    // plane oversize factor so edges don't show on resize or orbit
const SEED = [Math.random() * 100, Math.random() * 100];   // random per page load; hardcode for a reproducible layout

const SCATTER_N = 4000;      // instances to try placing (most get rejected: crack proximity + density falloff)
const SCATTER_LIFT = .02;    // z-offset above the shader plane so instances don't z-fight it
const SCATTER_MIN_SIZE = .3; // smallest an instance shrinks to right at a crack edge (fraction of base size)
const SCATTER_BASE_SIZE = .02; // instance size in pattern-space units (a real square: same x/y), before falloff
const SCATTER_GAP_MARGIN = 1.5;   // crack-proximity reject threshold, as a multiple of the
                              // shader's rendered crack half-width in pixels (CRACK_HALFPX_AVG,
                              // near buildScatter() below) -- compared against d converted to the
                              // same pixel-equivalent unit via scaleAt(), same normalization the
                              // shader itself uses (see fieldAt's comment for why raw d can't be
                              // compared to a threshold directly). >1 gives instances room to
                              // shrink/thin out before actually reaching the visible edge.
                              // Also the falloff distance: an instance shrinks to SCATTER_MIN_SIZE
                              // and thins out to SCATTER_MIN_DENSITY by the time it's this close.
const SCATTER_MIN_DENSITY = .05; // island-edge placement probability (fraction of center density);
                                  // 0 would give a hard edge band with zero leaves right at the gap
const SCATTER_TILT = .5;     // max random X/Y tilt in radians (~29°), leaf-on-a-branch look

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
  uniforms: { seed: { value: new THREE.Vector2(...SEED) } },
  // uv -> pattern space (2 units = plane height), aspect taken from the plane's own scale
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv * vec2(length(modelMatrix[0].xyz) / length(modelMatrix[1].xyz), 1.) * 2.;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
    }`,
  fragmentShader: /* glsl */ `
    ${crack}
    varying vec2 vUv;
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
    }`,
}));
scene.add(plane);

// sanity check: one plain square, not an instance, not a child of `plane` -- isolates rendering
// from the crack shader/scatter system entirely
const testSquare = new THREE.Mesh(
  new THREE.PlaneGeometry(0.5, 0.5),
  new THREE.MeshBasicMaterial({ color: 0x0000ff, side: THREE.DoubleSide }),
);
testSquare.position.set(0, 0, 0.1);
scene.add(testSquare);

// --- JS port of crack.glsl.js: same hash/warp/Voronoi/smin math, so instance placement below
// samples the same field the shader paints. Keep in sync with crack.glsl.js by hand — there's no
// shared source, porting GLSL->JS is mechanical. Only the distance value is needed here (not
// per-crack width or cell id), so this is a smaller port than the field math used to need. ---
const OFS = .2, ZEBRA_AMP = .6, FILLET_MIN = .2, FILLET_MAX = .5;

const hash21 = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
};
const disp = (x, y) => {   // p * mat2(127.1,311.7,269.5,183.3) in GLSL, column-major
  const sx = Math.sin(x * 127.1 + y * 269.5) * 18.5453;
  const sy = Math.sin(x * 311.7 + y * 183.3) * 18.5453;
  return [-OFS + (1 + 2 * OFS) * (sx - Math.floor(sx)), -OFS + (1 + 2 * OFS) * (sy - Math.floor(sy))];
};
const smin = (a, b, k) => {
  const h = Math.max(0, Math.min(1, .5 + .5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
};
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const v = (hash21(ix, iy) * (1 - fx) + hash21(ix + 1, iy) * fx) * (1 - fy)
          + (hash21(ix, iy + 1) * (1 - fx) + hash21(ix + 1, iy + 1) * fx) * fy;
  return 2 * v - 1;
}
function fbm22(x, y) {
  let vx = 0, vy = 0, a = .5;
  const c = Math.cos(.37), s = Math.sin(.37);
  for (let i = 0; i < 6; i++, a /= 2) {
    [x, y] = [x * c - y * s, x * s + y * c];
    vx += a * noise2(x, y);
    vy += a * noise2(x + 17.7, y + 17.7);
    x *= 2; y *= 2;
  }
  return [vx, vy];
}
function siteVec(iux, iuy, ux, uy, k) {
  const px = iux + (k % 7 - 3), py = iuy + (Math.floor(k / 7) - 3);
  const [dx, dy] = disp(px, py);
  return [px - ux + dx, py - uy + dy];
}
function voronoiB(ux, uy) {
  const iux = Math.floor(ux), iuy = Math.floor(uy);
  let m = 1e9, Px = 0, Py = 0;
  for (let k = 0; k < 49; k++) {
    const [rx, ry] = siteVec(iux, iuy, ux, uy, k);
    const d = rx * rx + ry * ry;
    if (d < m) { m = d; Px = rx; Py = ry; }
  }
  const fillet = FILLET_MIN + (FILLET_MAX - FILLET_MIN) * hash21(iux + ux - Px + 31.4, iuy + uy - Py + 31.4);
  m = 1e9;
  for (let k = 0; k < 49; k++) {
    const [rx, ry] = siteVec(iux, iuy, ux, uy, k);
    const ex = Px - rx, ey = Py - ry;
    if (ex * ex + ey * ey > .04) {
      const nx = rx - Px, ny = ry - Py, len = Math.hypot(nx, ny) || 1;
      const bis = .5 * ((Px + rx) * (nx / len) + (Py + ry) * (ny / len));
      m = smin(m, bis, fillet);
    }
  }
  return m;
}
// crackDist equivalent: seed offset, warp, then Voronoi. Returns [d, W] -- d is NOT a pixel or
// pattern-space distance (voronoiB's second pass is a signed, smin-blended bisector value with no
// fixed unit), so it can only be compared to a threshold after dividing by a screen-derivative
// scale, same as the shader does with dFdx/dFdy(W). W (the warped coordinate) is returned so
// scaleAt() below can estimate that same derivative numerically.
function fieldAt(x, y) {
  x += SEED[0]; y += SEED[1];
  const [wx, wy] = fbm22(x, y);
  const Wx = x + ZEBRA_AMP * wx, Wy = y + ZEBRA_AMP * wy;
  return [voronoiB(Wx, Wy), Wx, Wy];
}

// wireframe overlay, off by default -- press F to toggle
const wireframe = new THREE.LineSegments(
  new THREE.WireframeGeometry(plane.geometry),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: .3 }),
);
wireframe.visible = false;
plane.add(wireframe);   // child of plane: inherits its scale/position automatically

// --- scattered squares over the "land" (non-crack) area, sized down near a crack edge, rotated
// to face away from the nearest crack. Flat in the plane's own surface (not billboarded to the
// camera), true squares on screen. NOT a child of `plane`: plane.scale is non-uniform
// (h*aspect, h) to fill the window, and non-uniform scale doesn't commute with rotation -- a
// child's own counter-scale only cancels the parent's stretch pre-rotation, then the parent
// re-stretches the already-rotated shape into a parallelogram. So `scatter` is a sibling in the
// scene instead, and buildScatter() bakes plane's world scale (h*aspect, h) into each instance's
// position/size by hand, uniformly post-rotation, instead of inheriting it. ---
const scatterGeo = new THREE.PlaneGeometry(1, 1);
const scatterMat = new THREE.MeshBasicMaterial({ color: 0x2a2a2a, side: THREE.DoubleSide });
const scatter = new THREE.InstancedMesh(scatterGeo, scatterMat, SCATTER_N);
scene.add(scatter);

// gradient of d at (x,y) via central difference, used to rotate an instance away from the
// nearest crack -- points from crack toward land, since d increases with distance from a crack.
// d's magnitude isn't calibrated to any real unit (see fieldAt), but its direction of increase
// still points the right way, which is all a rotation angle needs.
function gradientAt(x, y) {
  const EPS = .001;
  const dx = fieldAt(x + EPS, y)[0] - fieldAt(x - EPS, y)[0];
  const dy = fieldAt(x, y + EPS)[0] - fieldAt(x, y - EPS)[0];
  return Math.atan2(dy, dx);
}

// JS port of the shader's `scale` (main.js fragment shader / dFdx,dFdy(W)): screen-derivative of
// the warped coordinate W, in pattern-units-per-pixel. There's no adjacent-fragment derivative to
// sample in JS, so it's estimated the same way gradientAt() estimates d's gradient -- central
// difference over a small pattern-space step, converted to a per-pixel rate via patternPerPx.
function scaleAt(x, y, patternPerPx) {
  const EPS = .001;
  const [, Wx1, Wy1] = fieldAt(x + EPS, y), [, Wx0, Wy0] = fieldAt(x - EPS, y);
  const [, Wx2, Wy2] = fieldAt(x, y + EPS), [, Wx3, Wy3] = fieldAt(x, y - EPS);
  const dWdx = Math.hypot(Wx1 - Wx0, Wy1 - Wy0) / (2 * EPS) * patternPerPx;
  const dWdy = Math.hypot(Wx2 - Wx3, Wy2 - Wy3) / (2 * EPS) * patternPerPx;
  return .5 * (dWdx + dWdy);
}

// average of the shader's per-crack half-width range, in pixels -- what a leaf is rejected
// against below, since raw d has no fixed unit on its own (see fieldAt/scaleAt)
const CRACK_HALFPX_AVG = 7;   // (WIDTH_MIN + WIDTH_MAX) / 2 in crack.glsl.js

const _m = new THREE.Matrix4();
function buildScatter(aspect, h) {
  // pattern-units-per-screen-pixel at DIST: world-units-per-pixel for a perspective camera at
  // the initial distance, times pattern-units-per-world-unit (2 pattern units per h world units,
  // per the vertex shader)
  const worldPerPx = 2 * DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / renderer.domElement.clientHeight;
  const patternPerPx = worldPerPx * (2 / h);
  const halfPxThreshold = CRACK_HALFPX_AVG * SCATTER_GAP_MARGIN;

  let count = 0;
  for (let n = 0; n < SCATTER_N; n++) {
    // reject-sample: random point in plane-local unscaled space (-.5..+.5), converted to pattern
    // space the same way the vertex shader does: vUv (0..1) * (aspect,1) * 2, where vUv = local+.5
    const lx = Math.random() - .5, ly = Math.random() - .5;
    const px = (lx + .5) * 2 * aspect, py = (ly + .5) * 2;
    const [d] = fieldAt(px, py);
    // same normalization the shader uses (halfPx - d/scale): d alone has no fixed unit, dividing
    // by scaleAt's screen-derivative converts it to pixel-equivalent half-width units first
    const dPx = d / scaleAt(px, py, patternPerPx);
    if (dPx <= halfPxThreshold) continue;   // landed in a crack (or too close to one): skip this instance

    const t = Math.min(1, dPx / halfPxThreshold - 1);   // 0 right at the crack edge, 1 a full gap away or more
    const density = SCATTER_MIN_DENSITY + (1 - SCATTER_MIN_DENSITY) * t;   // thin out near the edge
    if (Math.random() > density) continue;

    // world-space size (uniform: no parent to un-stretch it), and world-space position --
    // (lx,ly) in [-.5,.5] scaled by plane's own world scale (h*aspect, h), same as resize()
    // applies to `plane` itself, since `scatter` is no longer a child that would inherit it
    const size = h * SCATTER_BASE_SIZE * (SCATTER_MIN_SIZE + (1 - SCATTER_MIN_SIZE) * t);
    _m.makeRotationFromEuler(new THREE.Euler(
      (Math.random() * 2 - 1) * SCATTER_TILT,
      (Math.random() * 2 - 1) * SCATTER_TILT,
      gradientAt(px, py),
    ));
    _m.scale(new THREE.Vector3(size, size, 1));
    _m.setPosition(lx * h * aspect, ly * h, SCATTER_LIFT);
    scatter.setMatrixAt(count++, _m);
  }
  scatter.count = count;
  scatter.instanceMatrix.needsUpdate = true;
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
addEventListener('resize', resize);
resize();
