# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A minimal Vite + Three.js sandbox for prototyping a single fullscreen GLSL shader (currently a procedural crack/Voronoi pattern: black lines on white) plus a scattered-instance layer that sits on the "land" between cracks. No build step beyond Vite dev, no bundling config, no tests.

## Commands

- `npm install` — install deps
- `npm run dev` — start Vite dev server (also the `.claude/launch.json` debug target, port 5173)

There is no build, lint, or test script. Verify shader changes by looking at the running page. Press `F` in the running page to toggle a wireframe overlay of the plane's geometry.

## Architecture

Two files carry all the logic:

- [src/main.js](src/main.js) — Three.js scaffolding: renderer, scene, camera, `OrbitControls`. Builds one `PlaneGeometry` with a `ShaderMaterial` for the crack pattern, plus an `InstancedMesh` of small squares scattered over the non-crack area. The plane is scaled on every resize to fill the window at camera distance `DIST`, times `MARGIN` (1.25) so its edges never show when orbiting or resizing. Rendering is event-driven, not a `requestAnimationFrame` loop: the scene is static, so it re-renders only on `OrbitControls` `change` and window `resize`. The vertex shader converts UV to "pattern space" (2 units = plane height), with aspect ratio taken from the plane's own scale. `SEED` (random per page load) offsets the pattern via the `seed` uniform, so reloading gives a new layout; hardcode it for a reproducible one.
- [src/crack.glsl.js](src/crack.glsl.js) — a GLSL source string (template literal, spliced into the fragment shader via `${crack}`) implementing one layer of the "Vorocracks" technique (adapted from a Shadertoy shader, credited in the header). Exports `crackDist(vec2 U, out vec2 W, out float halfPx, out vec2 cellSite)` (distance to the nearest crack in fbm-warped space, the warped coordinate `W`, a per-crack random line half-width `halfPx` in pixels, and `cellSite`, a per-cell-constant value for telling cells apart) plus a `crackDist(U, W, halfPx)` overload for callers that don't need cell identity. Tuning constants (`ZEBRA_AMP`, `FILLET_*`, `WIDTH_*`) sit at the top of the file.

**The scatter layer in `main.js` is a hand-ported JS duplicate of the crack field math** (`hash21`, `disp`, `smin`, `noise2`, `fbm22`, `voronoiB` → `fieldAt`), used to reject-sample instance placement (skip points inside a crack, shrink instances near an edge, rotate them away from the nearest crack via a central-difference gradient) on the CPU where the GLSL function can't be called. There is no shared source between the two copies — keep them in sync by hand when tuning constants or field math in `crack.glsl.js` (`OFS`, `ZEBRA_AMP`, `FILLET_MIN`, `FILLET_MAX` are duplicated as top-of-file consts in `main.js`). Only the distance value is ported, not `halfPx`/`cellSite`.

To add or swap a pattern: write a new `.glsl.js` module exporting a GLSL template string with a `crackDist`-like function (same signature), then import it in `main.js` in place of `crack`. If the new pattern needs CPU-side placement (like the scatter layer), its field math needs a matching hand-port too.

[docs/research-curved-voronoi.md](docs/research-curved-voronoi.md) is leftover research from an earlier attempt at building real mesh geometry (contoured/triangulated cells, later a face-dropping grid) matching this shader's field. That approach was tried and then abandoned in favor of the plain shader plane above; the doc's field math is still accurate, its conclusions about mesh-building are not in use.

## Non-obvious constraints

- **Antialiasing uses `W`, not `d`.** The fragment shader converts distance to screen pixels via `dFdx`/`dFdy` of the warped coordinate `W`. Differentiating `d` directly paints false seams where the nearest Voronoi border switches. Working in warped units keeps line width constant in screen pixels even where the fbm warp compresses or stretches the pattern.
- **Voronoi search is a fixed 7x7 window, used by both passes.** Jitter can put the true nearest site 3 cells away, and centering the second pass on the winning cell creases the field along straight seams.
- **`ZEBRA_AMP` above ~0.3 makes the warp fold and breaks the distance field.**
- **The scatter JS port must track the GLSL field math by hand.** Changing Voronoi/fbm/warp behavior in `crack.glsl.js` without updating the corresponding functions in `main.js` desyncs instance placement from what the shader actually paints (instances landing in visible cracks, or gaps in the scatter where there's no crack).
