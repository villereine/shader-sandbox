# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A minimal Vite + Three.js sandbox for prototyping a single fullscreen GLSL shader (currently a procedural crack/Voronoi pattern: black lines on white) plus a scattered-instance layer that sits on the "land" between cracks. No build step beyond Vite dev, no bundling config, no tests.

## Commands

- `npm install` — install deps
- `npm run dev` — start Vite dev server (also the `.claude/launch.json` debug target, port 5173)

There is no build, lint, or test script. Verify shader changes by looking at the running page. Press `F` in the running page to toggle a wireframe overlay of the plane's geometry. The lil-gui panel (top right, imported from three's bundled `examples/jsm/libs`, no extra dependency) has `instances` (exact count placed), `dot scale`, `edge shrink` (width of the size ease toward cracks), `shader scale` (the crack pattern's `patternScale` uniform; redraws live while dragging, re-places dots on release), `new seed`, and `show shader`. Sliders rebuild on release (`onFinishChange`), because a rebuild takes a few hundred ms; a typed value applies when the field loses focus.

To check that no instance touches a crack, paste this into the dev page's console at the default view (no orbit). It uses the `window.dbg` handle that `main.js` exposes in dev and compares against the placement mask (speckles excluded, see below). `onCrackPx` should be 0:

```js
const { renderer, scene, camera, scatter, plane, maskMat } = dbg, gl = renderer.getContext(), crackMat = plane.material;
const w = renderer.domElement.width, h = renderer.domElement.height;
const read = () => { const b = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
scatter.visible = false; plane.material = maskMat; renderer.render(scene, camera); const M = read(); plane.material = crackMat;
scatter.visible = true; plane.visible = false; renderer.render(scene, camera); const S = read();
plane.visible = true; renderer.render(scene, camera);
let onCrackPx = 0; for (let i = 0; i < w * h * 4; i += 4) if (S[i] < 255 && M[i] < 255) onCrackPx++;
onCrackPx
```

## Architecture

Two files carry all the logic:

- [src/main.js](src/main.js) — Three.js scaffolding: renderer, scene, camera, `OrbitControls`. Builds one `PlaneGeometry` with a `ShaderMaterial` for the crack pattern, plus an `InstancedMesh` of small colored dots scattered over the non-crack area. The plane is scaled on every resize to fill the window at camera distance `DIST`, times `MARGIN` (1.25) so its edges never show when orbiting or resizing. Rendering is event-driven, not a `requestAnimationFrame` loop: the scene is static, so it re-renders only on `OrbitControls` `change` and window `resize`. The vertex shader converts UV to "pattern space" (2 units = plane height, divided by the `patternScale` uniform), with aspect ratio taken from the plane's own scale. `SEED` (random per page load) offsets the pattern via the `seed` uniform, so reloading gives a new layout; hardcode it for a reproducible one. The GUI's `new seed` rerolls that uniform and calls `resize()` to rebuild; `maskMat` shares the same uniform object, so the mask always matches. GUI values live in the `ui` object, which `buildScatter()` reads (`ui.instances`, `ui.scale`). `show shader` toggles layer 0 on the main camera only, so the mask render still sees the plane.
- [src/crack.glsl.js](src/crack.glsl.js) — a GLSL source string (template literal, spliced into the fragment shader via `${crack}`) implementing one layer of the "Vorocracks" technique (adapted from a Shadertoy shader, credited in the header). Exports `crackDist(vec2 U, out vec2 W, out float halfPx, out vec2 cellSite)` (distance to the nearest crack in fbm-warped space, the warped coordinate `W`, a random line half-width `halfPx` in pixels, and `cellSite`, the warped-space position of the pixel's Voronoi site) plus a `crackDist(U, W, halfPx)` overload for callers that don't need `cellSite`. Nothing reads `cellSite` today. It's recomputed per pixel as `u + P`, so exact equality across a cell isn't guaranteed; islands are identified by the flood fill in `buildScatter()` instead. Tuning constants (`OFS`, `ZEBRA_AMP`, `FILLET_*`, `WIDTH_*`) sit at the top of the file.

**The scatter layer places instances from the shader's own output.** On every resize, `buildScatter()` renders the plane alone into `maskRT` through an ortho camera (`maskCam`) that frames the whole plane at on-screen pixel density, reads the pixels back, and reject-samples random pixels: skip any pixel with ink, look up its distance to the nearest ink pixel in an exact distance transform of the mask (`edt1d`, Felzenszwalb & Huttenlocher, run over columns then rows; a dev-only `console.assert` checks it against brute force on a random grid at every load), pick a random disc size (its range eased with a smoothstep down to `SCATTER_MIN_SIZE` toward the crack over `ui.edge`) capped so the rim stays 1px clear of the crack (capped further when `SCATTER_TILT` > 0, because a rim tilted toward the camera drifts outward on screen, more so away from the view center), thin out density near cracks, and rotate the disc so its local +X points along the flow field (below). Rotation is invisible on round dots but the direction is there for a non-round shape. Before sampling, `buildScatter()` flood-fills the mask's land into islands, finds neighboring islands (land less than `G` px apart across a crack), and greedily gives each island a `SCATTER_PALETTE` color that none of its neighbors has, so every dot takes its island's color. Each dot also sits at a random height (`SCATTER_LIFT` plus up to `SCATTER_DEPTH`) and is darkened by up to `SCATTER_SHADE` the lower it sits, so bright dots read as on top. Its position and size are scaled by `(DIST - z) / DIST` so it still lands on its mask pixel at the default view. `scatter` and `wireframe` sit on layer 1 so `maskCam` (layer 0 only) doesn't render them into the mask.

The mask render swaps in `maskMat`, a clone of the crack material with `MASK_Q` defined. On screen, `voronoiB` hashes crack width and fillet from `iu + u - P`, which changes every pixel, so each pixel gets its own random width and the cracks grow a speckle halo. Under `MASK_Q` both take one fixed value instead, so the mask is a clean crack shape and instances may sit on the speckles. `SCATTER_EDGE` (0..1) sets that value: 0 puts the boundary at the solid black core, 1 at the outer edge of the halo.

Under `MASK_Q` the fragment shader also writes a flow direction into G/B, and `buildScatter()` reads each instance's rotation from it. The direction is the curl of a Perlin noise (its screen-space gradient via `dFdx`/`dFdy`, turned 90°), so instances follow the noise's contour lines and swirl around its highs and lows. `SCATTER_FLOW_FREQ` sets the swirl size. The Perlin function lives in `main.js`, not `crack.glsl.js`, because only the mask uses it. `noise2` doesn't work for this: value noise's gradient is axis-aligned along every lattice line, which shows up as a grid in the flow.

To add or swap a pattern: write a new `.glsl.js` module exporting a GLSL template string with a `crackDist`-like function (same signature), then import it in `main.js` in place of `crack`. The mask code in `main.js`'s fragment shader also uses the module's `hash21` and `seed` uniform, so the new module must define both. Supporting `MASK_Q` is optional: without it, the mask is whatever the pattern paints on screen. Placement reads pixels either way, so it follows the new pattern without a port.

[docs/research-curved-voronoi.md](docs/research-curved-voronoi.md) is leftover research from an earlier attempt at building real mesh geometry (contoured/triangulated cells, later a face-dropping grid) matching this shader's field. That approach was tried and then abandoned in favor of the plain shader plane above; the doc's field math is still accurate, its conclusions about mesh-building are not in use.

## Non-obvious constraints

- **Antialiasing uses `W`, not `d`.** The fragment shader converts distance to screen pixels via `dFdx`/`dFdy` of the warped coordinate `W`. Differentiating `d` directly paints false seams where the nearest Voronoi border switches. Working in warped units keeps line width constant in screen pixels even where the fbm warp compresses or stretches the pattern.
- **Voronoi search is a fixed 7x7 window, used by both passes.** Jitter can put the true nearest site 3 cells away, and centering the second pass on the winning cell creases the field along straight seams.
- **`ZEBRA_AMP` above ~0.3 makes the warp fold and breaks the distance field**, per the comment in `crack.glsl.js`. The current value is `.6`, past that limit.
- **Don't reintroduce a JS port of the field for placement.** An earlier version did, and its instances ignored the cracks entirely (18% of instance pixels on cracks, which is the cracks' share of the screen). `hash21` is `fract(sin(x) * 43758.5)`: the GPU computes `x` in float32 and JS in float64, the rounding difference gets multiplied by 43758, and the two return unrelated values (input (3,7) gives 0.373 in float64, 0.431 in float32).
- **The mask must match on-screen pixel density.** Crack width is set in screen pixels (`halfPx`, via `dFdx`/`dFdy`), so the mask is rendered at the drawing buffer size times `MARGIN`. At a lower resolution the shader would paint relatively wider cracks than the screen shows. Placement is computed for the default view only; zooming or orbiting afterward changes crack width on screen without moving instances, which is intended.
- **`buildScatter()` runs on every `resize` event, with no debounce.** A rebuild measured about 230 ms at 1280x720 (mask readback, distance transform, island flood fill), and it no longer depends on `edge shrink` or `SCATTER_FALLOFF` since the distance transform replaced a per-instance search.
