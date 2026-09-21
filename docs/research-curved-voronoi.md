# Curved Voronoi cell geometry on the CPU

Research notes: how to generate real mesh geometry per cell that matches the
shader in [src/crack.glsl.js](../src/crack.glsl.js), whose borders are curved
(fbm domain warp applied *before* the Voronoi) and corner-rounded (smin fillets).

Every claim is tagged:

- **[V]** verified against a primary source (linked) or by a numerical experiment run here
- **[S]** my own synthesis / reasoning
- **[?]** could not confirm

Numerical experiments referenced below were run as throwaway Node scripts that
port the GLSL in `crack.glsl.js` to JS. They are not checked in; the results are
reproduced inline so the conclusions can be re-derived.

---

## 0. What the shader actually computes

From [src/crack.glsl.js](../src/crack.glsl.js), the pipeline per fragment is:

```
U += seed
W  = U + ZEBRA_AMP * fbm22(U)       // ZEBRA_AMP = 0.6, 6 octaves
d  = voronoiB(W)                    // jittered grid, 7x7 window
```

The critical structural fact, which drives everything below:

**The Voronoi is computed in warped space `W`, not in mesh space `U`.** **[V]**
(directly readable in `crackDist`, lines 76-80.)

So the sites are *not* points in mesh space at all. A cell's region in mesh space
is the **preimage** of a straight-edged warped-space Voronoi cell under the warp:

```
cell_mesh = { U : winner(warp(U)) == this site }
```

This is why the existing straight-bisector clipping in
[src/main.js](../src/main.js) (`clip`, lines 87-102) can never match: it builds
Voronoi cells in mesh space from mesh-space sites, which is a different diagram
entirely, not a distorted version of the right one. **[S]**

---

## 1. Warped Voronoi: can the warp be inverted?

### 1a. The warp folds at ZEBRA_AMP = 0.6 — inversion is ill-posed

`CLAUDE.md` says "above ~.3 the warp folds and the field breaks". I measured the
Jacobian determinant of `U -> U + 0.6*fbm22(U)` over `[-4,4]^2`, 160 000 samples
by central differences:

```
9.19% of samples have det(J) < 0     (min -3.097, max 6.555)
```

**[V]** (experiment). A negative Jacobian determinant means the map is
orientation-reversing there, i.e. the warp is genuinely **non-injective** at
ZEBRA_AMP = 0.6. Nearly a tenth of the domain is folded.

Consequences, all **[S]** reasoning from that measurement:

- There is **no well-defined inverse warp**. For a warped point in a folded
  region, several mesh-space points map to it. "Inverse-map the cell polygon's
  vertices" (option (a) in the brief) is not merely hard, it is **ill-posed** for
  this parameter value.
- Cells can be **disconnected or non-simply-connected in mesh space**, because a
  connected warped-space cell can have a preimage in several pieces.

I tested that last point directly: sample mesh space on a 600x600 grid over
`[-3,3]^2`, assign each sample the winning warped-space cell, then flood-fill
each cell's pixel set:

```
51 distinct cells;  1 of 45 non-sliver cells had >1 significant component
   cell (-2,2): 3 components, sizes 5089 / 379 / 19 px
```

**[V]** (experiment). So in practice ~98% of cells are a single blob, but
**folding does produce genuinely disconnected cells**, roughly one in forty-five.
Any approach that assumes "one cell = one simple closed polygon" will produce a
visible artifact on those. **[S]**

### 1b. Iterative inversion: partially works, fails exactly where it matters

Two standard schemes, 2000 random round-trips each (warp a known `U`, try to
recover it):

| method | converged < 1e-3 | failures | worst error |
|---|---|---|---|
| fixed point `U <- W - A*fbm(U)`, 60 iters | 1459 / 2000 | 541 | 0.579 |
| Newton on `warp(U) - W`, 40 iters | 1606 / 2000 | 394 | 1.1e12 (diverged) |

**[V]** (experiment). Fixed-point iteration is a contraction only when the
Lipschitz constant of `A*fbm` is < 1, which fails in the folded regions; Newton
diverges catastrophically when `det(J) -> 0`, which is precisely the fold set.
~20-27% failure is not a tuning problem, it is the fold. **[S]**

Note also the *magnitude* of the warp: mean displacement 0.169, max 0.556 pattern
units, where 1 unit = 1 cell. **[V]** So the warp moves borders by up to half a
cell — this is a large distortion, not a subtle wobble. It cannot be treated
perturbatively.

### 1c. Forward-warping a subdivided straight polygon is the wrong direction

Option (c) in the brief — subdivide a straight-edge mesh-space polygon and push
each vertex through the warp — pushes geometry from mesh space *into* warped
space. But the mesh needs to live in **mesh space**. **[S]**

It would be correct only if you built the polygon with straight bisectors in
*warped* space (from the actual jittered sites, which do live there) and then
applied the **inverse** warp — which §1a shows does not exist. Forward-warping a
mesh-space polygon computes a shape with no relationship to the shader's cells.

### 1d. Literature on curved-boundary Voronoi

The established literature on Voronoi diagrams with curved edges is about
diagrams **of curved input sites** (line/arc/spline segments), where bisectors
are conics or higher algebraic curves — e.g. Ramanathan & Gurumoorthy, *Voronoi
diagram and medial axis algorithm for planar domains with curved boundaries*
([Part I](https://www.sciencedirect.com/science/article/pii/S0377042798002118),
[Part II](https://www.sciencedirect.com/science/article/pii/S0377042798002234)).
**[V]** (these papers exist and are about that problem).

That is a **different problem** from ours: our sites are points and the bisectors
would be straight — the curvature comes entirely from the domain warp applied
afterwards. **[S]**

**[?] I could not find any paper or library that extracts exact polygon geometry
for a point-Voronoi diagram composed with an arbitrary non-invertible procedural
domain warp.** I searched for domain-warp inversion, warped/anisotropic Voronoi
polygon extraction, and curved Voronoi geometry. The closest genuinely relevant
body of work is **anisotropic / Riemannian Voronoi diagrams** (where a metric
tensor field bends the bisectors), but those assume a smoothly varying metric and
still produce piecewise-curved cells via numerical tracing, not closed forms —
and I did not verify a specific implementation, so I am not recommending one.
**[?]**

**Conclusion for §1: there is no analytic route.** The only sound way to get the
cell outline in mesh space is to **evaluate the field in mesh space and contour
it**, which is §3. **[S]**

---

## 2. smin fillets as geometry

### 2a. The shader's smin and what k means

`crack.glsl.js` lines 17-20 use the classic polynomial smooth min:

```glsl
float h = clamp(.5 + .5*(b-a)/k, 0., 1.);
return mix(b, a, h) - k*h*(1.-h);
```

Iq's [smin article](https://iquilezles.org/articles/smin/) documents the
quadratic member of what he calls the CD family, and states that **"the value of
the parameter k matches exactly the maximum inflation or thickening that the
shapes a and b undergo due to the smooth blending"**. **[V]**

The article also states that all CD-family smooth minimums **"are guaranteed to
produce underestimates"** of distance and that **"the length of their gradient is
always less than one"** inside the blend region. **[V]** This matters for
contouring: the field is *not* a unit-gradient SDF near fillets, so you cannot
use the field value as a reliable Euclidean distance there (it affects how you
do step-marching and how you inset — see §5). **[S]**

### 2b. The fillet is NOT a circular arc

Iq explicitly contrasts the quadratic with the circular variant, noting the
circular variant **"achieves mathematically perfect circular profiles"** —
implying the quadratic does not. **[V]**

I confirmed this numerically. Take two half-planes meeting at a wedge, apply the
shader's exact `smin`, extract the 0-isoline, restrict to the strictly-blended
region (`|a-b| < 0.9k`), and least-squares fit a circle (Kasa):

| wedge half-angle | fitted radius | max radial residual |
|---|---|---|
| 60 deg | 0.1628 | 7.42% of r |
| 45 deg | 0.2783 | 1.31% of r |
| 30 deg | 0.6287 | 0.15% of r |

**[V]** (experiment, k = 0.35). The blend is clearly **not** a circular arc at
sharp corners (7.4% off), and only *approaches* circular as the wedge flattens.

**[S]** This is what you'd expect: with `a`, `b` linear in position, the
subtracted term `k·h(1-h)` is quadratic in `(b-a)`, so the isoline is a
**parabola-family conic**, not an arc. So there *is* a closed form for the
idealised two-line corner — it is a conic, not an arc — but:

- it only holds for exactly two straight bisectors meeting in isolation;
- in the shader the smin is folded over **all 49 neighbours in sequence**
  (`m = smin(m, ..., fillet)`, line 47), so three-or-more-way junctions are
  iterated blends whose isoline has no tidy closed form **[S]**;
- and all of it then sits inside the non-invertible warp.

So: **a closed-form fillet is not usable here.** Contouring is the practical
answer. **[S]**

For contrast, if you ever want *exactly* circular fillets you can get them by
`sdf(p) - r` — iq's rounding operator, which
[states](https://iquilezles.org/articles/distfunctions2d/) that subtracting a
constant **"effectively moves the isosurface ... to one of the outer rings, which
naturally are rounded"**. **[V]** That requires a true distance field, which
smin's underestimate is not. **[S]**

---

## 3. Contouring: marching squares vs dual contouring

### What each does to sharp features

Matt Keeter's [2D Contouring](https://www.mattkeeter.com/projects/contours/) is
the best primary write-up for the 2D case specifically:

- Marching squares **"does not explicitly preserve corners ... resulting in
  beveled corners rather than sharp features"**. **[V]**
- Dual contouring stores a vertex per cell rather than edges, positioned by a
  least-squares fit so that **"in a cell containing a corner, the vertex should
  be on that corner"**, which **"explicitly preserves sharp edges and corners"**.
  **[V]**
- Marching squares on a hierarchical/quadtree grid cracks, because **"the
  zero-crossing search will not be numerically identical, so the edges will not
  quite touch"**. **[V]** (Not an issue on a uniform grid.)

Boris the Brave's [Dual Contouring
Tutorial](https://www.boristhebrave.com/2018/04/15/dual-contouring-tutorial/)
confirms DC needs **gradients / Hermite data** in addition to values, and that
its main failure mode is **colinear normals on flat regions**, where solving the
QEF can place the vertex outside its cell; the fix is a constrained QEF plus bias
toward the cell centre. **[V]**

### Which one do we want here?

**Marching squares — and its corner-rounding is a *feature*, not a defect.**
**[S]**

The whole point of the smin fillet is that the shader's cell corners are
*already rounded*. Dual contouring exists to recover sharp corners; we do not
want sharp corners. Paying for gradient evaluation and QEF solving to sharpen
features that the source field deliberately blunts would be backwards. **[S]**

One real caveat: marching squares beveling is at grid resolution, whereas the
smin fillet radius is 0.2-0.5 pattern units. As long as the sampling step is well
below the fillet radius, the fillet is resolved by the *sampling*, and the
residual MS beveling is sub-cell noise. **[S]**

### Marching cubes 2D variants

"Marching cubes in 2D" is just marching squares; the 3D-specific literature
(dual marching cubes, cubical marching squares) is about topology ambiguity and
adaptive octrees that do not arise for a uniform 2D grid. **[S]** *Cubical
Marching Squares* ([Ho et al.,
2005](https://www.csie.ntu.edu.tw/~cyy/publications/papers/Ho2005CMS.pdf)) is
real and does address adaptive feature-preserving extraction **[V]**, but it is a
3D method and irrelevant here. **[S]**

### JS/TS libraries for 2D isolines from a sampled field

Versions/dates checked via `npm view` on 2026-09-20. **[V]**

| package | version | last published | license | notes |
|---|---|---|---|---|
| [`d3-contour`](https://github.com/d3/d3-contour) | 4.0.2 | 2023-01-11 | ISC | marching squares over a rectangular array; outputs GeoJSON MultiPolygon. Repo describes itself as using "marching squares" **[V]** |
| [`marchingsquares`](https://github.com/RaumZeit/MarchingSquares.js/) | 1.3.3 | 2022-06-19 | **AGPL-3.0** | isolines + isobands, quadtree-accelerated for multiple thresholds **[V]** |
| `marching-squares` | 1.0.0 | ~2023 | — | TS fork of the above **[V]** |

**Licensing caveat worth flagging: `marchingsquares` is AGPL-3.0.** **[V]** For a
personal sandbox that is fine, but it is a copyleft obligation that `d3-contour`
(ISC) does not carry. **[S]**

`d3-contour` important limitation: it contours a **rectangular array of values**
and returns polygons in **grid index coordinates**, so you rescale yourself; and
it applies linear interpolation along cell edges only. **[S]** Its output
MultiPolygon rings follow a winding convention that distinguishes holes, which is
useful given §1a's disconnected/holed cells. **[?] I did not verify the exact
winding/hole semantics against its source.**

**[S]** For this project, hand-rolling marching squares is ~40 lines and avoids a
dependency and the AGPL question entirely — see §6.

---

## 4. Existing Voronoi libraries

| package | version | last published | verdict |
|---|---|---|---|
| [`d3-delaunay`](https://github.com/d3/d3-delaunay) | 6.0.4 | 2023-04-01 | **Straight-line Euclidean only.** **[S]** Built on Delaunator, connects circumcenters of adjacent Delaunay triangles **[V]**. Gives `voronoi.cellPolygon(i)` clipped to a bounding box. |
| [`delaunator`](https://github.com/mapbox/delaunator) | 5.1.0 | 2026-03-23 | Actively maintained **[V]**; triangulation only, no Voronoi polygons directly. |

**None of these support curved, warped, weighted, or anisotropic diagrams.**
**[S]** d3-delaunay would only replace the existing `clip()` function with a
faster/more robust equivalent — it solves a problem already solved in
[src/main.js](../src/main.js) and does nothing about the warp or the fillets.

`three-mesh-bvh` is a raycast/BVH acceleration library; it is unrelated to
Voronoi construction. **[S]**

**[?] I did not find a Three.js-specific cell-fracture implementation** analogous
to Blender's. Blender's own cell fracture is a Python addon driving `voro++`
(straight-line 3D Voronoi); **[?] I did not verify its source directly** in this
research. Either way it would be straight-bisector, so it would not help with
curvature. **[S]**

---

## 5. Polygon inset / offset for the crack gap

The current `shrink()` in [src/main.js](../src/main.js) (lines 105-112) moves
each vertex toward the centroid by a fixed distance. That is **not** a true
offset: it is only correct for a polygon whose vertices are equidistant from the
centroid (a regular polygon). For an elongated or concave cell it insets the far
vertices proportionally too little and the near ones too much. **[S]**

Correct approaches:

| option | version / date | license | notes |
|---|---|---|---|
| [`clipper-lib`](https://www.npmjs.com/package/clipper-lib) | 6.4.2, 2022-06-13 | BSL **[V]** | JS port of Angus Johnson's Clipper; `ClipperOffset` does true polygon offsetting with miter/round/square joins **[V]** |
| [`js-angusj-clipper`](https://github.com/xaviergonz/js-angusj-clipper) | 1.3.1, 2023-02-04 | MIT **[V]** | WASM/asm.js port, faster, heavier to integrate **[V]** |
| [`polygon-offset`](https://www.npmjs.com/package/polygon-offset) | 0.3.2, 2022-10-05 | MIT **[V]** | ~14 kB with its Martinez dependency **[V]** |
| [`straight-skeleton`](https://github.com/vHawk/straight-skeleton) | 3.0.0, **2026-03-24** | MIT **[V]** | TS wrapper over CGAL's straight skeleton via WASM **[V]**; the only one recently published |

The straight skeleton is the *theoretically* right structure for offsetting a
polygon at arbitrary distance (it tracks the topology changes as edges collapse).
**[S]** But it is overkill here. **[S]**

**The lazy correct answer for this project: offset each clipped half-plane
inward before clipping, not after.** **[S]** Because each cell is built as an
intersection of half-planes, insetting by `GAP` is exactly equivalent to moving
every half-plane inward by `GAP` — for a convex polygon that is an exact offset,
needs no library, and is a one-line change in `clip()` (subtract `GAP` from the
plane offset). That correctness argument holds only while the cell is convex,
which it is under pure half-plane clipping. **[S]**

Once you move to contoured (curved, possibly non-convex) cells, the equivalent
trick is even simpler: **contour at a non-zero isolevel.** Extracting the
`d = GAP` isoline instead of `d = 0` gives the inset directly from the field, no
polygon offsetting at all. **[S]** Caveat from §2a: inside fillets the smin
gradient is < 1, so the realised inset there is slightly *larger* than `GAP` in
world units. **[S]** For a visual gap that is unnoticeable; if it ever matters,
normalise by the measured gradient magnitude.

---

## 6. Ranked recommendation

Given: minimal sandbox, prefers the laziest thing that works, no heavy deps,
straight-bisector clipping already working.

### 1st — Marching squares on `crackDist` sampled in mesh space, contoured at `d = GAP`

Port `crackDist` to JS (warp + 7x7 Voronoi + smin — roughly 60 lines, mechanical,
and I already did exactly this port for the experiments above, so it is known to
be straightforward), sample it on a uniform grid over the visible region, and run
marching squares at isolevel `GAP`.

Why first:

- It is the **only** approach that is actually correct, because §1 shows the warp
  cannot be inverted and the cell outline only exists as a level set. **[S]**
- It gets the warp curvature **and** the smin fillets **and** the inset for free,
  in one step, because all three are already baked into the field value. No
  separate fillet math, no polygon offsetting (§5). **[S]**
- Rounded corners from MS are exactly what we want (§3). **[S]**
- Zero dependencies: MS at a single threshold on a uniform grid is ~40 lines,
  with the only fiddly part being the two saddle cases. **[S]**

Cost / caveats:

- You must **segment cells**, not just contour: label each sample with its
  winning cell (`cellSite` is already an output of `crackDist`, line 76) and
  contour each label's region separately, otherwise you get one giant crack
  network rather than per-cell polygons. **[S]**
- Resolution drives quality; needs a step well under the 0.2-0.5 fillet radius.
  Cost is `O(grid²)` field evaluations, each doing 6 fbm octaves + 98 site
  evaluations. Sampling 600x600 was comfortably fast in plain Node in my
  experiments **[V]**, and this is a one-time build, not per-frame (`main.js`
  already renders event-driven only).
- **~1 cell in 45 will come out disconnected** (§1a) — decide whether to keep the
  largest component or emit both. **[S]**
- Triangulation: the existing centroid-fan `meshFor()` assumes star-shaped
  polygons. Contoured cells are *usually* star-shaped but not guaranteed. Either
  accept rare artifacts or use an ear-clipping triangulator —
  `THREE.ShapeUtils.triangulateShape` already ships with Three.js, so that is a
  free upgrade with no new dependency. **[S]**

### 2nd — Same, but with `d3-contour` instead of hand-rolled MS

Identical approach, swapping ~40 lines of MS for a 4 kB ISC dependency that
handles thresholds and hole winding for you. Take this if the hand-rolled saddle
cases misbehave. Slightly less lazy by the dependency rule, more lazy by the
lines-written rule. Prefer `d3-contour` (ISC) over `marchingsquares` (AGPL-3.0).

### 3rd — Keep straight bisectors, fix only the inset

If matching the shader exactly turns out not to matter visually, the cheapest
real improvement to what exists today is replacing centroid-shrink with
per-half-plane inset (§5) — a one-line change that makes the gap uniform on
elongated cells. Leaves borders straight and corners sharp; `GAP` keeps hiding
the mismatch, as the comment in `main.js` already admits.

### Not recommended

- **Inverting the warp** (Newton / fixed point): ill-posed at ZEBRA_AMP = 0.6,
  20-27% failure in measurement (§1b). Would require dropping ZEBRA_AMP to ~0.3,
  changing the art direction to suit the algorithm.
- **Forward-warping a subdivided straight polygon**: wrong direction (§1c).
- **Dual contouring**: solves the opposite problem (sharp feature recovery) at
  the cost of gradients and QEF solving (§3).
- **d3-delaunay**: straight-line only; replaces code that already works (§4).
- **Straight skeleton / Clipper**: real offsetting machinery for a gap that the
  isolevel trick gives for free (§5).

---

## What I could not confirm

- **[?]** Any prior art for extracting polygon geometry from a point-Voronoi
  composed with a non-invertible procedural domain warp. I believe none exists in
  a reusable form, but absence of evidence here is weak evidence.
- **[?]** The Vorocracks original source. shadertoy.com/view/Xs3fR4 returns
  **HTTP 403** to automated fetches. Search results attribute "Vorocracks marble"
  to **FabriceNeyret2** and mention a "zebra" parameter, consistent with
  `ZEBRA_AMP` in our header comment, but I could not read the original code to
  verify what was changed in adaptation.
- **[?]** `d3-contour`'s exact winding/hole semantics (not read from source).
- **[?]** Blender cell-fracture internals (not read from source); believed to be
  `voro++`, straight-line, therefore not applicable regardless.
- **[?]** Whether any maintained JS anisotropic/Riemannian Voronoi implementation
  exists that could bend bisectors directly.
