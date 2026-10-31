# better-lottie

An After Effects extension that exports simple shape-layer animations as a **single self-animating SVG file**. No JavaScript runtime and no player library: you drop the file into a website and it plays.

## Output format: SVG + SMIL (decided)

Each export is one `.svg` file that animates itself with SMIL (`<animate>`, `<animateTransform>`, `<set>`).

Why SMIL rather than CSS keyframes or JSON plus a player:
- **Works everywhere an SVG works.** It plays in `<img src="anim.svg">`, CSS `background-image`, inline `<svg>`, and `<object>`, with no JS.
- **Path morphing works in all browsers.** `<animate attributeName="d">` is supported everywhere. CSS `d: path()` animation is not reliable across browsers (Safari).
- **Per-segment bezier easing.** `calcMode="spline"` + `keySplines` maps directly onto AE keyframe easing, one curve per segment.
- **One shared timeline.** Every animation in the file stays in sync automatically.
- **Playback control when inlined.** `svg.pauseAnimations()`, `svg.unpauseAnimations()`, `svg.setCurrentTime(t)`, `svg.getCurrentTime()`.

CSS output may become an extra option later. Don't build it until SMIL output is solid.

## Architecture

```
AE project ──(ExtendScript: extract)──▶ IR JSON ──(JS: convert)──▶ .svg
            host/extract.jsx                     src/ (pure JS)
```

Two separate halves, kept separate on purpose:

1. **Extractor** (`extension/host/*.jsx`, ExtendScript). Walks the active comp and writes a neutral **intermediate representation (IR)** as JSON. It only reads AE and does no SVG logic.
2. **Converter** (`src/`, modern JS, no AE dependency). Turns the IR into an SVG string. It runs inside the CEP panel (Chromium/Node) **and** in plain Node for tests.

The point of the split: almost all the logic lives in the converter, which can be tested in Node with fixture IR files and needs no After Effects. Keep the `.jsx` side as thin as possible.

### Layout

```
better-lottie/
  src/                     # converter (built)
    ir.js                  # IR spec (JSDoc) + validate(). Source of truth for the IR.
    easing.js              # AE speed/influence ↔ bezier, keySpline normalization
    path.js                # AE shape → path data; rect/ellipse → shapes
    timeline.js            # props → tracks (exact or baked) → SMIL timing
    svg.js                 # IR → SVG string (layers, transforms, parenting, paints)
  bin/better-lottie.js     # CLI: better-lottie in.ir.json [-o out.svg] [--once]
  test/
    fixtures/*.ir.json     # hand-written IR samples, one per feature area
    snapshots/*.svg        # expected output (npm run test:update to rewrite)
    *.test.js
  scripts/build-preview.js # → preview/index.html (gitignored)
  extension/               # TODO: CEP panel + ExtendScript extractor
    CSXS/manifest.xml
    index.html, panel.js   # panel UI: export button, options, warnings list
    host/extract.jsx       # ExtendScript: comp → IR
    host/json2.js          # JSON polyfill (ExtendScript has no JSON object)
```

### Commands
- `npm test`: unit + snapshot tests (`node --test`, no dependencies)
- `npm run test:update`: rewrite snapshots after an intended output change. Review the diff.
- `npm run preview`: build `preview/index.html`. Serve it (`python3 -m http.server -d preview`) or open it directly.

### Status
The converter covers Phase 1, most of Phase 2 (morphing, colors, stroke width, group transforms, parenting/nulls, holds, separated position), and converter-side baking. Not built yet: the extension (`extension/`), trim paths, masks, gradients.

Baking happens in the converter: `propValueAt` evaluates AE's curves itself. The extractor only needs to bake what the converter can't see, i.e. expressions: it writes them as per-frame linear keyframes.

### Extension platform

- Use **CEP** (HTML/JS panel + ExtendScript). It's the proven route for AE. Check whether AE's UXP support is mature enough before investing heavily, but don't block on it. The extractor/converter split means only the thin host layer would need porting.
- **ExtendScript is ES3.** It has no `JSON`, `Array.prototype.forEach/map`, `let/const`, arrow functions or template literals. Write `.jsx` in ES3 and include the `json2.js` polyfill.
- Dev setup (macOS): enable unsigned extensions with `defaults write com.adobe.CSXS.<N> PlayerDebugMode 1`. `<N>` depends on the AE/CEP version (11, 12, …). Then symlink `extension/` into `~/Library/Application Support/Adobe/CEP/extensions/better-lottie`. Add a `.debug` file to get Chrome DevTools on a localhost port.

## Feature scope

### Phase 1: working end to end
- Comp → `<svg viewBox="0 0 W H">`, with duration, frame rate and optional background color
- Shape layers with path, rectangle and ellipse primitives (all converted to `<path>`, see below)
- Fill (color and opacity), stroke (color, opacity, width, line cap and join)
- Layer transform: **position, scale, rotation, opacity, anchor point**, static and animated
- Linear and bezier keyframe easing
- Layer in/out points → visibility via `<set>`/discrete `display` animation
- Loop forever (`repeatCount="indefinite"`) or play once (`fill="freeze"`)
- Writing the `.svg` file plus a warnings list in the panel

### Phase 2: the rest of the easy set
- **Path morphing** (animated path keyframes)
- Animated fill and stroke color, stroke width, fill and stroke opacity
- Shape group transforms ("Transform: Group" inside shape contents)
- **Parenting**, including null layers used as parents
- Hold keyframes
- Separated position dimensions (X Position / Y Position)
- Baking fallback (see below) for expressions and anything that can't be mapped exactly

### Phase 3: nice to have
- Trim paths (`pathLength="1"` + `stroke-dasharray` / `stroke-dashoffset`)
- Masks → `<clipPath>` / `<mask>`
- Linear and radial gradients
- Solid layers (as rects)
- Export the work area only; "start paused" option

### Out of scope
Effects, 3D layers and cameras, blend modes, track mattes (maybe later), text (tell users to use "Create Shapes from Text"), images and video, repeaters, merge paths, and other shape modifiers. **Never drop anything silently.** Each unsupported thing produces a warning that names the layer and property.

## Key conversion rules (where it's easy to get wrong)

### Transform order and nesting
AE applies a layer's transform as `translate(position) · rotate(r) · scale(s) · translate(-anchor)`. SMIL can't animate several transform parts on one element in a clean way, so give **each part its own nested `<g>`**:

```xml
<g transform="translate(px,py)">      <!-- animateTransform type=translate -->
  <g transform="rotate(r)">           <!-- type=rotate -->
    <g transform="scale(sx,sy)">      <!-- type=scale -->
      <g transform="translate(-ax,-ay)">
        <g opacity="...">  …content…  </g>
```

Leave out the groups that are static identity transforms to keep the output small. Separated position can use two nested translates (x, then y).

### Parenting
A parent's transform groups wrap the child, **but AE parenting does not inherit opacity.** Put each layer's opacity on its own innermost content group, never on a group that wraps child layers.

### Units
- Scale: AE percent → divide by 100
- Opacity: 0–100 → 0–1
- Colors: AE `[r,g,b,a]` floats 0–1 → hex or `rgb()`
- Rotation: degrees, clockwise in both AE and SVG (y-down), so no sign flip
- Position/anchor: 3D arrays, ignore z

### Paths
AE shapes have `vertices`, `inTangents`, `outTangents` (relative to the vertex) and `closed`. Always output **`M` followed only by `C` commands**, including straight segments (tangents of 0 are valid). That way every keyframe of a morph has the same command structure, which SMIL `d` interpolation needs.
- Ellipse → 4 cubic segments (kappa ≈ 0.5523). Rect, including roundness → path. Converting primitives to paths keeps morphing and output uniform.
- Keyframes with different vertex counts can't be morphed directly. Warn, then either resample to a common count or fall back to discrete.

### Easing: AE temporal ease → `keySplines`
For a 1D segment from keyframe A to B, with `d = tB − tA`, `avg = (vB − vA) / d`:
- `x1 = A.outInfluence / 100`, `y1 = x1 · A.outSpeed / avg`
- `x2 = 1 − B.inInfluence / 100`, `y2 = 1 − (B.inInfluence / 100) · B.inSpeed / avg`

Notes:
- If `vA == vB` (avg = 0), treat the segment as linear (`0 0 1 1`) or bake it.
- For non-separated position, speed is **spatial** (px/s along the motion path). Use the path length over the segment for `avg`.
- For scale, AE stores ease per dimension. If the dimensions' curves differ, bake.
- **SMIL requires every `keySplines` value to be in [0, 1].** Overshoot (y outside 0..1) can't be expressed, so bake that segment.

### Timeline mapping
- Every `<animate>` uses `dur` = comp duration and `keyTimes` normalized to 0..1 over the comp. Add hold values at 0 and 1 when the first keyframe is after 0 or the last is before the end.
- `calcMode="spline"` needs exactly `keyTimes.length − 1` keySplines. Use `0 0 1 1` for linear segments.
- A hold keyframe inside a spline animation becomes value A at `tA`, value A again at `tB − ε`, then value B at `tB`.
- Every animation in the file uses `begin="0s"`, so the timeline stays shared.

### Baking fallback
When a property can't be mapped exactly, sample it in the extractor with `prop.valueAtTime(t, false)` on every frame and write linear keyframes. Cases: expressions, spatial bezier motion paths (curved position paths), overshoot easing, mismatched per-dimension ease. Then **simplify**: drop samples that lie on the straight line between their neighbours within a tolerance. Baking must be per property and per segment, never all or nothing for the whole file.

## Output conventions
- Round numbers (about 3 decimals for coordinates, 4 for keyTimes) and strip trailing zeros
- Deterministic output: stable IDs and attribute order, so snapshot tests don't flicker
- No external references. The file must be fully self-contained.
- Include a short comment at the top: generator name, version, source comp name

### Usage snippets (also shown in the panel after export)
```html
<!-- simplest: autoplays, no control -->
<img src="logo-anim.svg" alt="">

<!-- inline: controllable -->
<script>
  const svg = document.querySelector('#logo-anim');
  svg.pauseAnimations(); svg.setCurrentTime(0.5); svg.unpauseAnimations();
</script>
```

## Testing
- `node --test`: converter unit tests (easing math, path data, timeline mapping) and snapshot tests from `test/fixtures/*.ir.json` to SVG.
- When a bug shows up with a real AE file, export its IR from the panel ("Save IR" debug button) into `test/fixtures/` and add a test.
- To check an export by eye, open `preview/index.html`. It shows the SVG as `<img>` and inline side by side, with a scrubber that uses `setCurrentTime`. Compare it against the AE render. Playwright screenshots at fixed times can automate this later.

## Working rules
- Converter code stays pure: IR in, string out, no AE, DOM or filesystem calls.
- Any new AE feature means: extend the IR (document it in `src/ir.js`), extract it, convert it, add a fixture test, and add a warning for the cases you don't handle.
