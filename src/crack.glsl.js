// Layer 0 (biggest cracks) of "Vorocracks" variant, https://www.shadertoy.com/view/Xs3fR4
// Stripped: subsequent layers, checker, iTime scroll, tint.
// crackDist(U): U in pattern space (2 units = plane height). Returns distance to the nearest crack.
export default /* glsl */ `
uniform vec2 seed;   // offsets the sampled pattern; set from JS to get a different layout
const float OFS = .2;         // jitter Voronoi centers in -OFS ... 1.+OFS
const float ZEBRA_AMP = .6;       // fbm warp of the cells; above ~.3 the warp folds and the field breaks
const float FILLET_MIN = .2;       // per-cell random fillet radius range; rounds sharp crack junctions, 0 = hard-min corners
const float FILLET_MAX = .5;
const float WIDTH_MIN = 5.;       // per-crack random line half-width range, in pixels (see main.js HALF_PX)
const float WIDTH_MAX = 9.;

// mod289 keeps sin()'s argument bounded before hashing -- GPU sin() loses precision fast on large
// arguments (mat2/dot below multiply p by ~100-300x), which reads as concentric ripple/grain
// noise once zoomed in far enough to notice it. Wrapping the input first (any large-ish period
// works; 289 is the usual choice, borrowed from Ashima's noise hashes) keeps sin() accurate at
// any zoom or seed, without changing the hash's statistical behavior.
vec2 mod289(vec2 x) { return x - floor(x / 289.) * 289.; }
#define disp(p) ( -OFS + (1.+2.*OFS) * fract( 18.5453 * sin( mod289(p) * mat2(127.1,311.7,269.5,183.3)) ) )
#define hash21(p) fract(sin(dot(mod289(p),vec2(127.1,311.7)))*43758.5453123)

// polynomial smooth min (iq) - blends a and b within k of each other instead of a hard corner
float smin( float a, float b, float k ) {
    float h = clamp( .5 + .5*(b-a)/k, 0., 1. );
    return mix( b, a, h ) - k*h*(1.-h);
}

// site k of a fixed 7x7 window, relative to u. 7x7 because jitter can put the
// true nearest site 3 cells away; both passes below use the same window, since
// centering the second on the winning cell creases the field along straight seams.
vec2 site( vec2 iu, vec2 u, int k ) {
    vec2 p = iu + vec2(k%7-3,k/7-3);
    return p - u + disp(p);
}

// distance to Voronoi borders. width: per-cell random line half-width (WIDTH_MIN..WIDTH_MAX), hashed from the winning site.
// site_: warped-space position of the winning site, i.e. which cell this point belongs to (for per-cell culling).
float voronoiB( vec2 u, out float width, out vec2 site_ ) {
    vec2 iu = floor(u), P;
    float m = 1e9;
    for( int k=0; k < 49; k++ ) {
        vec2 r = site(iu, u, k);
        float d = dot(r,r);
        if( d < m ) m = d, P = r;
    }
    site_ = u + P;
#ifdef MASK_Q   // scatter placement mask (main.js): one fixed width/fillet instead of the per-pixel hash,
                // so the speckle halo drops out and only a clean crack shape remains
    float wq = MASK_Q, fq = MASK_Q;
#else
    float wq = hash21(iu + u - P), fq = hash21(iu + u - P + 31.4);
#endif
    width = WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * wq;
    float fillet = FILLET_MIN + (FILLET_MAX - FILLET_MIN) * fq;
    m = 1e9;
    for( int k=0; k < 49; k++ ) {
        vec2 r = site(iu, u, k);
        if( dot(P-r,P-r) > .04 )   // merge near-coincident sites; their bisector draws as a straight hairline
            m = smin( m, .5*dot( (P+r), normalize(r-P) ), fillet );
    }
    return m;
}

float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p); f = f*f*(3.-2.*f);
    float v = mix( mix(hash21(i+vec2(0,0)),hash21(i+vec2(1,0)),f.x),
                   mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),f.x), f.y);
    return 2.*v-1.;
}

vec2 fbm22(vec2 p) {
    vec2 v = vec2(0);
    float a = .5;
    mat2 R = mat2(cos(.37),-sin(.37),sin(.37),cos(.37));
    for (int i = 0; i < 6; i++, p*=2., a/=2.)
        p *= R,
        v += a * vec2(noise2(p), noise2(p+17.7));
    return v;
}

// Distance to the nearest crack, in warped space. W returns the warped coordinate:
// use its screen derivatives for the pixel scale. d itself has seams where the nearest
// border switches, so differentiating d directly paints those seams as false lines.
// halfPx returns this crack's random line half-width in pixels (WIDTH_MIN..WIDTH_MAX).
// cellSite returns the warped-space position identifying which Voronoi cell U falls in
// (same value for every point in one cell; compare cellSite to tell cells apart).
float crackDist(vec2 U, out vec2 W, out float halfPx, out vec2 cellSite) {
    U += seed;
    W = U + ZEBRA_AMP * fbm22(U);
    return voronoiB( W, halfPx, cellSite );
}

// convenience overload for callers that only need distance/width, not cell identity
float crackDist(vec2 U, out vec2 W, out float halfPx) {
    vec2 cellSite;
    return crackDist(U, W, halfPx, cellSite);
}
`;
