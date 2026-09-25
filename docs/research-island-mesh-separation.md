# Research: cutting the plane into real per-island meshes

Investigated against `src/main.js` as of branch `dot-physics-fixes` (uncommitted working tree — `git status` shows `M src/main.js`). Line numbers below are from that working copy: `buildScatter()` spans lines 187-357, the island flood fill 202-217, the distance transform 257-263, the `isles` body 349-356, `tick()` 505-525, `resize()` 537-557. Three.js is pinned at `^0.170.0` (`node_modules/three` resolves to exactly `0.170.0`, r170); all three.js citations below are to that installed source tree unless a GitHub URL is given. No code was changed for this investigation.

## Summary

Real per-island separation is buildable with **zero new npm dependencies** and without touching the WebGL2 shader pipeline at all. Three claims, each checked against a primary source:

1. **WebGL2 has no tessellation shader stage — confirmed, not assumed.** `createShader()`'s `type` parameter is a `GLenum`, and the only two `SHADER`-suffixed constants either WebGL1 or WebGL2 define are `VERTEX_SHADER` (`0x8B31`) and `FRAGMENT_SHADER` (`0x8B30`); `webgl2.idl` adds no further `SHADER` constant on top of WebGL1's set. `TESS_CONTROL_SHADER`, `TESS_EVALUATION_SHADER`, and `GEOMETRY_SHADER` appear nowhere in either IDL. GPU tessellation is off the table for cutting the mesh — this has to happen as ordinary CPU-side geometry construction, uploaded once as a real `BufferGeometry`.
2. **Three.js already ships a general polygon triangulator, and it's public API.** `THREE.ShapeGeometry` (and `THREE.ExtrudeGeometry`) both triangulate through `ShapeUtils.triangulateShape()`, which is a thin wrapper around `Earcut.triangulate()` — a literal port of `mapbox/earcut` v2.2.4, vendored at `node_modules/three/src/extras/Earcut.js:1-2`. `ShapeUtils` is exported from the public API (`Three.js:157`), so `THREE.ShapeUtils.triangulateShape(contour, holes)` can be called directly on an arbitrary polygon — no need to route through `Shape`/`ShapeGeometry` at all if you want to build your own `BufferGeometry` (useful here, see UVs below). Earcut handles concave and hole-bearing polygons by design; this is exactly the shape an island outline traced off a crack pattern will have.
3. **The app already computes the raster data a contour tracer needs — it just never turns it into geometry.** `buildScatter()` already flood-fills land pixels into per-island labels (`main.js:202-217`) and runs an exact 2D distance transform to the nearest crack (`main.js:257-263`, `edt1d` at `main.js:153-168`). That's precisely the input marching squares needs. What's genuinely missing, and not something three.js provides, is the contour-tracing step itself — turning that raster into ordered `Vector2` polygon loops. That has to be hand-written; it doesn't need a new dependency either, since it's a small, self-contained lookup-table algorithm.

The `isles` object (`main.js:349-356`) and its per-frame `offX`/`offY` (computed at `main.js:513`) already are the rigid per-island offset a real cut mesh would need — they currently drive `dots.workHx/workHy` (`main.js:514-518`), nothing else. `THREE.BatchedMesh`, present in this three.js build (`node_modules/three/src/objects/BatchedMesh.js`, confirmed in the official `r170` example `webgl_mesh_batch.html`), is built for exactly "many independently-transformable meshes, one draw call" and its `setMatrixAt(instanceId, matrix)` is a direct target for `isles.offX[a]`/`isles.offY[a]` — the same shape of write the app already does into `scatter`'s instance matrices in `writeDots()` (`main.js:474-481`).

One accuracy note the investigation surfaced: **in the current working tree, none of this runs.** `resize()` has the `buildScatter()` call commented out (`main.js:553`, `// buildScatter(camera.aspect, h);   // instancing paused, uncomment to resume`) and forces `scatter.visible = false` (`main.js:554`). Since `dots`/`isles` are only ever assigned inside `buildScatter()` (`main.js:338-356`) and start `null` (`main.js:363`), `tick()`'s first line (`main.js:506`, `if (!dots || !dots.n) { running = false; return; }`) makes the whole per-dot and per-island physics system a no-op right now — it's mid-pause, not mid-broken. Any implementation of this research has to either re-enable that call or build the new island-mesh path alongside it.

## Mechanism

### Current state: one uncut rectangle, confirmed at the geometry level

The plane is a single `PlaneGeometry`, subdivided only for the wireframe-debug overlay, with no relationship to the crack shape:

```js
// src/main.js:51-55
const SEGS = 50;   // wireframe subdivisions along the plane's shorter side; the longer side gets
                    // SEGS * aspect (recomputed in resize()) so each cell stays square on screen
                    // instead of stretching with the window

const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, SEGS, SEGS), new THREE.ShaderMaterial({
```

```js
// src/main.js:113-119
// wireframe overlay, off by default -- press F to toggle
const wireframe = new THREE.LineSegments(
  new THREE.WireframeGeometry(plane.geometry),
  new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: .3 }),
);
wireframe.visible = false;
plane.add(wireframe);   // child of plane: inherits its scale/position automatically
```

`resize()` rebuilds that same uncut rectangle on every window resize (segment counts only track aspect ratio, never the crack layout):

```js
// src/main.js:544-551
const segsX = camera.aspect >= 1 ? Math.round(SEGS * camera.aspect) : SEGS;
const segsY = camera.aspect >= 1 ? SEGS : Math.round(SEGS / camera.aspect);
plane.geometry.dispose();
plane.geometry = new THREE.PlaneGeometry(1, 1, segsX, segsY);
wireframe.geometry.dispose();
wireframe.geometry = new THREE.WireframeGeometry(plane.geometry);
```

That `geometry.dispose()` + reassignment pattern is the one the app already uses for "rebuild this mesh's geometry from scratch on resize" — the same pattern a per-island cut mesh would reuse (see Recommendation).

### 1. No GPU tessellation stage exists in WebGL — checked against the IDL, not assumed

`createShader` is defined once, in the WebGL1 base interface that `WebGL2RenderingContext` inherits:

```
// https://registry.khronos.org/webgl/specs/latest/1.0/webgl.idl
WebGLShader? createShader(GLenum type);
...
const GLenum FRAGMENT_SHADER = 0x8B30;
const GLenum VERTEX_SHADER   = 0x8B31;
```

`webgl2.idl` (`https://registry.khronos.org/webgl/specs/latest/2.0/webgl2.idl`) adds no additional `SHADER`-named `GLenum` on top of that set — no `TESS_CONTROL_SHADER`, `TESS_EVALUATION_SHADER`, or `GEOMETRY_SHADER` constant exists anywhere in either IDL, so `gl.createShader(gl.TESS_CONTROL_SHADER)` isn't just unsupported at runtime, the constant doesn't exist to pass. The WebGL 2.0 spec itself states its lineage directly: "It is derived from OpenGL® ES 3.0, and provides similar rendering functionality" (`https://registry.khronos.org/webgl/specs/latest/2.0/`) — OpenGL ES 3.0 predates tessellation shaders in the ES line entirely (desktop OpenGL got them in 4.0; WebGL tracks ES, not desktop GL). This fully confirms the constraint as given: geometry has to be cut on the CPU (or via a compute-shader-less GPU readback trick), never via a hardware tessellation stage, in either WebGL1 or WebGL2.

### 2. Extracting island outlines: data is already there, the tracer isn't

`buildScatter()` already has both inputs marching squares needs, computed for other reasons:

```js
// src/main.js:202-217 -- 4-connected flood fill: `island` labels every land pixel
const island = new Int32Array(mw * mh).fill(-1), stack = [];
let islands = 0;
const visit = (q) => { if (island[q] < 0 && px[q * 4] === 255) { island[q] = islands; stack.push(q); } };
for (let s = 0; s < mw * mh; s++) {
  if (island[s] >= 0 || px[s * 4] !== 255) continue;
  visit(s);
  while (stack.length) { /* ... 4-neighbor spread ... */ }
  islands++;
}
```

```js
// src/main.js:257-263 -- exact distance-to-nearest-crack field, one value per mask pixel
const dist = new Float32Array(mw * mh), N = Math.max(mw, mh);
for (let p = 0; p < mw * mh; p++) dist[p] = px[p * 4] === 255 ? 1e20 : 0;
const lf = new Float64Array(N), lv = new Int32Array(N), lz = new Float64Array(N + 1);
for (let x = 0; x < mw; x++) edt1d(dist, x, mw, mh, lf, lv, lz);       // columns
for (let y = 0; y < mh; y++) edt1d(dist, y * mw, 1, mw, lf, lv, lz);   // then rows
```

Marching squares' canonical reference is the cell-based "marching" lookup-table contouring method from Lorensen, W.E. and Cline, H.E., "Marching Cubes: A High Resolution 3D Surface Construction Algorithm," *ACM SIGGRAPH Computer Graphics*, Vol. 21, No. 4 (July 1987), pp. 163-169 (DOI `10.1145/37402.37422`) — marching squares is the well-known 2D restriction of that same per-cell case-table idea (4 corner samples instead of 8, a 16-entry case table instead of 256). This research pass did not turn up an earlier primary source specifically naming the 2D case on its own; secondary sources (Wikipedia's "Marching squares" article) don't cite one either, so that's flagged rather than invented.

Two practical choices for the tracer, both operating on data `buildScatter()` already has and neither needing a new dependency:

- **Marching squares on `dist`**, treating each island's own signed-ish field (`dist` restricted to that island's pixels, or a per-island binary indicator) as the scalar field and tracing the zero-crossing. Gives sub-pixel-accurate, smoothly interpolated boundaries — the crack edge doesn't have to look staircased.
- **Direct boundary tracing on the `island` label raster** (Moore-neighbor / boundary-following over `island[p] === a`), skipping interpolation. Simpler to write than full marching squares, but the boundary is blocky at mask-pixel resolution unless the outline is later smoothed or the mask is supersampled.

Either way, an island whose outline encloses a different island (crack forms a closed ring with land — and a different island's land — inside it) needs its **hole** loops traced too, not just its outer loop, because `THREE.Shape.holes` (an array of `THREE.Path`) is what earcut needs to cut that inner region out (`ShapeUtils.triangulateShape(contour, holes)`, `node_modules/three/src/extras/ShapeUtils.js:28`, consumed by `ShapeGeometry.js:91` and `ExtrudeGeometry.js:154` identically). That's the one place this task is genuinely more than "read `dist` once" — nested-loop detection has to be part of the tracer.

### 3. Triangulating the traced polygon: `THREE.ShapeGeometry` → earcut, confirmed non-hand-rolled

```js
// node_modules/three/src/extras/Earcut.js:1-5
/**
 * Port from https://github.com/mapbox/earcut (v2.2.4)
 */
const Earcut = {
  triangulate: function ( data, holeIndices, dim = 2 ) {
```

```js
// node_modules/three/src/extras/ShapeUtils.js:1,28,53
import { Earcut } from './Earcut.js';
...
  static triangulateShape( contour, holes ) {
    ...
    const triangles = Earcut.triangulate( vertices, holeIndices );
```

```js
// node_modules/three/src/geometries/ShapeGeometry.js:9,73-91
constructor( shapes = new Shape( [ new Vector2( 0, 0.5 ), new Vector2( - 0.5, - 0.5 ), new Vector2( 0.5, - 0.5 ) ] ), curveSegments = 12 ) {
  ...
  if ( ShapeUtils.isClockWise( shapeVertices ) === false ) { shapeVertices = shapeVertices.reverse(); }
  ...
  const faces = ShapeUtils.triangulateShape( shapeVertices, shapeHoles );
```

So the answer to "is it earcut or three's own ear-clipping code" is: it's the actual mapbox earcut source, vendored, not a from-scratch three.js triangulator — and it's exposed as public API (`export { ShapeUtils } from './extras/ShapeUtils.js';`, `node_modules/three/src/Three.js:157`), callable directly on any array of `{x,y}` points without going through `Shape`/`ShapeGeometry` at all. Earcut is a general-purpose polygon triangulator built to handle concave and hole-bearing input, so a traced island outline (which will routinely be non-convex — crack patterns don't produce convex land blobs) is squarely inside what it's designed for; this isn't a "does it happen to work" question, it's the library's stated purpose.

Building a `THREE.Shape` from a traced point loop is a one-line fit for the API. `Shape` extends `Path`, and `Path`'s constructor turns a plain `Vector2[]` into a closed outline automatically:

```js
// node_modules/three/src/extras/core/Path.js:11-25
constructor( points ) {
  super();
  this.type = 'Path';
  this.currentPoint = new Vector2();
  if ( points ) { this.setFromPoints( points ); }
}
setFromPoints( points ) {
  this.moveTo( points[ 0 ].x, points[ 0 ].y );
  for ( let i = 1, l = points.length; i < l; i ++ ) { this.lineTo( points[ i ].x, points[ i ].y ); }
  return this;
}
```

So `new THREE.Shape(outerLoop)` with `shape.holes.push(new THREE.Path(holeLoop))` per hole is literally what the marching-squares output plugs into.

### 4. UV mapping breaks once the plane isn't one full rectangle — and `ShapeGeometry`'s default UVs don't fix it

The crack pattern is derived entirely from the plane's own `uv` attribute (0..1 across the full, uncut rectangle) and its world scale:

```js
// src/main.js:67-75
vertexShader: /* glsl */ `
  uniform float patternScale, patternRatio;
  varying vec2 vUv;
  void main() {
    // patternRatio > 1 stretches cells wider, < 1 taller; area-preserving, so the cell count holds
    vUv = uv * vec2(length(modelMatrix[0].xyz) / length(modelMatrix[1].xyz), 1.) * 2. / patternScale
        * vec2(inversesqrt(patternRatio), sqrt(patternRatio));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }`,
```

`ShapeGeometry`'s default UV generation is *not* "position relative to the original full-plane rect" — it's the shape's own local x/y, verbatim:

```js
// node_modules/three/src/geometries/ShapeGeometry.js:104-112
for ( let i = 0, l = shapeVertices.length; i < l; i ++ ) {
  const vertex = shapeVertices[ i ];
  vertices.push( vertex.x, vertex.y, 0 );
  normals.push( 0, 0, 1 );
  uvs.push( vertex.x, vertex.y ); // world uvs
}
```

If island outlines are traced in mask-pixel space (the natural coordinate system, since that's what `dist`/`island` are indexed in) and fed straight into `ShapeGeometry`, the resulting `uv` attribute would be raw mask-pixel coordinates per island, completely disconnected from the `vUv` calculation the crack shader expects (0..1-ish pattern-space units derived from the *original* plane's full extent and scale). The crack texture would tile wrong, differently per island, the instant the mesh is cut. This is exactly why calling `ShapeUtils.triangulateShape()` directly (rather than going through `ShapeGeometry`) is the better fit here: it hands back triangle index triples only, so the app can build its own `BufferGeometry` and write a `uv` attribute by hand as `(maskX / mw, maskY / mh)` (or whatever plane-normalized space matches the existing `vUv` derivation) instead of inheriting `ShapeGeometry`'s local-space default. That's a small, deliberate step, not a three.js gap — but it's a real one, and skipping it silently breaks the visual the whole app exists to show.

### 5. One mesh per island vs. `BatchedMesh`: the batching primitive exists and fits the offset data exactly

A literal "one `THREE.Mesh` per island" approach (dozens to low hundreds of islands, order-of-magnitude estimate: `SCATTER_MIN_ISLAND = 50` at `main.js:24` culls any island that couldn't place at least 50 dots out of the default `SCATTER_N = 12600` total, so surviving islands skew toward "few enough to matter, many enough to add up") means that many separate draw calls, each with its own `geometry.dispose()`/rebuild on every resize. `THREE.BatchedMesh` (present in this three.js build: `node_modules/three/src/objects/BatchedMesh.js`, and demonstrated in the official r170 example `webgl_mesh_batch.html` on `github.com/mrdoob/three.js`) is built for exactly this — many distinct geometries, drawn in one call, each with its own instance transform:

```js
// node_modules/three/src/objects/BatchedMesh.js:171
constructor( maxInstanceCount, maxVertexCount, maxIndexCount = maxVertexCount * 2, material ) {
```

```js
// node_modules/three/src/objects/BatchedMesh.js:441
addGeometry( geometry, reservedVertexCount = - 1, reservedIndexCount = - 1 ) {
```

```js
// node_modules/three/src/objects/BatchedMesh.js:390
addInstance( geometryId ) {
```

```js
// node_modules/three/src/objects/BatchedMesh.js:844
setMatrixAt( instanceId, matrix ) {
```

The official example's usage (`webgl_mesh_batch.html`, r170) confirms the intended pattern: `addGeometry()` once per distinct shape returns a `geometryId`, `addInstance(geometryId)` returns an `instanceId`, and `setMatrixAt(id, matrix)` sets that instance's own transform — one geometry, one instance, one independent transform, all in a single draw call. That maps directly onto this app's existing per-island offset, computed every frame already:

```js
// src/main.js:508,513
let moved = stepDots(isles, cursor.x, cursor.y, physIslands, now);
for (let a = 0; a < isles.n; a++) { isles.offX[a] = isles.x[a] - isles.hx[a]; isles.offY[a] = isles.y[a] - isles.hy[a]; }
```

One geometry (that island's traced, triangulated outline) plus one instance per island, translated each frame by `isles.offX[a]`/`isles.offY[a]` (converted from mask pixels to world units the same way `writeDots()` already does for the dot layer, `main.js:476-478`), is the whole mechanism — no per-island `THREE.Mesh` objects, no per-island draw call, and the per-instance matrix write is the same shape of operation the app already performs into `scatter.instanceMatrix` every frame.

The real cost of `BatchedMesh` is that its vertex/index/instance buffers are sized once, at construction (`maxVertexCount`, `maxIndexCount`, `maxInstanceCount` in the constructor above), not grown automatically; `addGeometry()` throws (`BatchedMesh.js`, `'BatchedMesh: Reserved space request exceeds the maximum buffer size.'`) if a reservation overflows what was allocated. Since island count and per-island outline complexity are only known after `buildScatter()` reads the mask back, the buffers have to be sized generously up front, or the whole `BatchedMesh` disposed and reconstructed on a structural rebuild — the same "dispose, then reassign" pattern `resize()` already applies to `plane.geometry` (`main.js:548-551`), just applied one level up, to the batch object itself instead of a single geometry.

WebGPU would change this picture (compute shaders or mesh shaders could plausibly do contour extraction and cutting on-GPU), but this app only ever constructs a `THREE.WebGLRenderer` (`main.js:39`) and has no WebGPU renderer path, so that's out of scope beyond this one line.

## Recommendation

**Lightest path: zero new npm dependencies.** Everything needed — a general polygon triangulator, and a batched-draw primitive with per-instance transforms — already ships inside `three@0.170.0`. The only code that has to be written from scratch is the contour tracer, and it's small by nature (a lookup-table algorithm over data the app already computes).

Concretely, in `buildScatter()`, after the existing flood fill and distance transform (`main.js:202-263`):

1. **Trace each island's outline(s)** as `Vector2` loops directly off `island`/`dist` — marching squares on `dist` for smooth sub-pixel edges, or boundary-following on `island` for a simpler but blockier result. Detect nested loops (an island fully enclosing another) and keep them as hole loops.
2. **Triangulate with `THREE.ShapeUtils.triangulateShape(outerLoop, holeLoops)`** directly (not `ShapeGeometry`), so the triangle indices come back without three.js's default local-space `uv` attribute getting in the way.
3. **Build one `BufferGeometry` per island by hand**: `position` from the traced points (converted from mask pixels to the same world units `buildScatter()` already uses for dot placement, `main.js:290-294`), `index` from step 2, and a hand-written `uv` attribute derived the same way the plane's own `vUv` is (`main.js:72-73`), so the crack pattern stays continuous across the cut.
4. **Feed every island's geometry into one `THREE.BatchedMesh`**, sized generously against the expected island count/complexity (`addGeometry()` per island, `addInstance()` once per island, 1:1).
5. **Each frame, in `tick()`, right where `isles.offX`/`isles.offY` are already computed** (`main.js:513`), call `setMatrixAt(instanceId, translationMatrix)` per island instead of (or alongside) feeding `dots.workHx/workHy` — the dots keep following their island via the existing spring-target math, the mesh now visibly moves with them.

**Cost versus the current dots-only illusion:**
- *Code*: a new contour tracer (the only genuinely new algorithm — everything else is calling existing three.js API), a hand-built per-island `BufferGeometry` step in place of/alongside the instance-placement loop, and a `BatchedMesh` setup-and-resize path alongside the existing `plane.geometry` dispose/reassign in `resize()`.
- *Rebuild cost*: added on top of `buildScatter()`'s existing ~230ms rebuild-on-resize (mask readback, distance transform, flood fill, per CLAUDE.md). Contour tracing and triangulation scale with total crack perimeter and per-island vertex count, not with `mw*mh` pixel count the way the distance transform does, so it's plausibly cheaper than the existing passes — but this is an estimate, not a measurement; profile before assuming it stays inside a "few hundred ms" rebuild budget once island counts get large.
- *Perf ceiling*: bounded by `BatchedMesh`'s fixed `maxVertexCount`/`maxIndexCount`/`maxInstanceCount`, chosen at construction; a structural rebuild (not just a resize) is needed whenever island count or complexity outgrows what was reserved, same shape of problem the plane's own `geometry.dispose()`-and-reassign already solves for a single mesh.
- *Payoff*: the dots-only approach only ever fakes separation by moving a decorative particle layer over one uncut rectangle — the crack lines on the plane itself never move. This path makes the plane itself come apart, at the cost of a tracer, a hand-authored UV/geometry pipeline, and a batching layer the dots-only approach never needed.
