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
  src/                     # converter
    ir.js                  # IR spec (JSDoc) + validate(). Source of truth for the IR.
    easing.js              # AE speed/influence ↔ bezier, keySpline normalization
    timeline.js            # props → tracks (exact or baked) → SMIL timing; combineTracks; auto-orient
    path.js                # shape arrays (multi-subpath blocks) → path data; rect/ellipse → shapes
    geometry.js            # matrices, orientation, path length on shape arrays
    anim.js                # SMIL/element helpers shared by the modules below
    transform.js           # AE transforms → nested <g>; matrix tracks for flattening
    paint.js               # fill/stroke/gradients/dashes → styles (+ <defs>)
    shapes.js              # shape contents: paint/group stacking, Trim Paths, Merge Paths
    svg.js                 # document, layers, parenting, in/out points
  bin/better-lottie.js     # CLI: better-lottie in.ir.json [-o out.svg] [--once]
  test/
    fixtures/*.ir.json     # hand-written IR samples, one per feature area
    snapshots/*.svg        # expected output (npm run test:update to rewrite)
    *.test.js
  scripts/
    build-preview.js       # → preview/index.html (gitignored)
    install-dev.js         # PlayerDebugMode + symlink extension/ into AE's CEP folder
  extension/               # the CEP extension; this folder is what AE loads
    CSXS/manifest.xml      # AEFT 16.0+ (AE 2019), CSXS 9.0+
    .debug                 # DevTools at http://localhost:8099 (dev only)
    index.html, panel.css
    panel.js               # UI; calls the host via __adobe_cep__.evalScript (no CSInterface.js)
    lib/better-lottie.js   # converter bundle, built by `npm run build` (gitignored)
    host/extract.jsx       # ExtendScript: active comp → IR JSON string; save dialog + file write
```

### Commands
- `npm test`: unit, snapshot and extractor tests (`node --test`)
- `npm run test:update`: rewrite snapshots after an intended output change. Review the diff.
- `npm run preview`: build `preview/index.html`. Serve it (`python3 -m http.server -d preview`) or open it directly.
- `npm run build`: bundle `src/` into `extension/lib/better-lottie.js` (esbuild, IIFE, global `BetterLottieSVG`, target chrome61 for CEP 9). Rerun after every converter change, then reopen the panel.
- `npm run dev:install`: build, set `PlayerDebugMode` for CSXS 9–12, symlink `extension/` to `~/Library/Application Support/Adobe/CEP/extensions/better-lottie`. Restart AE → Window › Extensions › better-lottie. `npm run dev:uninstall` removes the link.

### Status
- **Converter:** Phases 1 and 2, plus dashes, Trim Paths, Merge Paths (all five modes), linear/radial gradient fills and strokes, and Auto-Orient Along Path.
- **Extension:** panel (Export SVG, Preview, Save IR, loop/background options, warnings, usage snippet) and extractor. Verified in **real AE 2026** on the user's project (`abgabe.aep`, comps "rocks-glass" and "shaker"): AE's own frames (`saveFrameToPng`) match the SVG.
- **Not built:** masks, track mattes, repeaters, animated gradient colors, gradient Scale/Rotation, stroke taper, work-area export, ZXP packaging/signing. Not yet checked in Safari/Firefox (pathLength-based trims especially).

Baking happens in the converter: `propValueAt` evaluates AE's curves itself. The extractor only bakes what the converter can't see, i.e. expressions: it writes them as per-frame linear keyframes, and the converter's linear-run simplification shrinks them back down.

### Facts verified in AE 2026 (keep the mock in `test/helpers/ae-mock.js` in sync)
- **Dashes:** every stroke has `Dash 1–3`, `Gap 1–3` and `Offset` streams, all `enabled`, default 10/0, even when the UI shows none. Only `isModified` (or keys/expressions) tells real dashes apart. Strokes also always have `ADBE Vector Stroke Taper` and `…Wave` groups.
- **Gradient colors:** `ADBE Vector Grad Colors` is `NO_VALUE`; scripting can't read it. The saved `.aep` (RIFX, big-endian) stores the stops as XML in `LIST GCky > Utf8`, after the `tdmn` naming `ADBE Vector Grad Colors`. A comp is `LIST Item` whose `idta` has the item id at byte 16; its layers are `LIST Layr` children in timeline order. The project can contain several comps with the same name (e.g. imported Illustrator comps), so match by id. `app.project.dirty` exists.
- **Merge Paths mode** (`ADBE Vector Merge Type`): 1 merge, 2 add, 3 subtract, 4 intersect, 5 exclude. Illustrator-outlined artwork in this project uses intersect.
- **Trim Paths:** `ADBE Vector Trim Start/End/Offset/Type` (Type 1 simultaneously, 2 individually). A trim at a layer's root trims strokes inside the groups above it.
- **Auto-Orient** (`layer.autoOrient`, `AutoOrientType.ALONG_PATH`) is used on parented layers; without it the shaker comp rendered badly wrong.
- Gradients also have `ADBE Vector Grad Scale`/`Rotation` (reported when modified).
- Still unverified: ease `speed` units for color and path properties (treated as progress/s); `File.saveDlg` without a filter on macOS works in practice.

### Probing real AE from the terminal
With the user's OK (it drives their open AE), run read-only scripts via `osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile "/path/probe.jsx"'`. DoScript does not return the script's result: write output to a file (e.g. `~/Downloads/…`) and read it.
- Wrap probes in `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)`. AE shows a modal error dialog even for errors you catch, e.g. reading `.value` of a `NO_VALUE` property; check `propertyValueType` first.
- `$.evalFile('…/extension/host/extract.jsx')` then `BetterLottie.extractCompById(id)` extracts any comp without touching the UI.
- `comp.saveFrameToPng(t, file)` renders AE's reference frames for side-by-side comparison with the SVG (scrub the SVG with `pauseAnimations()` + `setCurrentTime(t)`). Re-render when the project changed.

### Extension platform

- Use **CEP** (HTML/JS panel + ExtendScript). It's the proven route for AE. AE 2026 ships CEP 12 and also UXP frameworks. Revisit UXP later; the extractor/converter split means only the thin host layer would need porting.
- **ExtendScript is ES3.** It has no `JSON`, `Array.prototype.forEach/map/indexOf`, `let/const`, arrow functions, template literals or trailing commas. `extract.jsx` has its own `stringify`, and `test/extract.test.js` parses it with acorn at `ecmaVersion: 3` and bans newer APIs. Use `Object.prototype.toString` for array checks, not `instanceof Array`.
- Strings sent to ExtendScript go through `literal()` in panel.js (JSON plus U+2028/2029 escaping). Don't build script strings by hand.
- Don't put raw U+2028/U+2029 characters in source files; write them as backslash-u escape sequences. (Some editing tools turn typed escapes into the raw character; check with `od -c` when a parser reports an unterminated string or regex.)

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

### Phase 3 (done)
- Trim Paths, Merge Paths, dashes, linear and radial gradients, Auto-Orient Along Path

### Next candidates
- Masks → `<clipPath>` / `<mask>`; track mattes
- Solid layers (as rects); repeaters
- Animated gradient colors (one GCky blob per keyframe, presumably; unverified)
- Export the work area only; "start paused" option

### Out of scope
Effects, 3D layers and cameras, blend modes, text (tell users to use "Create Shapes from Text"), images and video, and the remaining shape modifiers (offset paths, wiggle, zig zag, pucker & bloat, twist, round corners). **Never drop anything silently.** Each unsupported thing produces a warning that names the layer and property.

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
When a segment can't be mapped exactly, the converter samples AE's curve itself (`propValueAt`) on every frame and writes linear keyframes. Cases: curved motion paths, overshoot easing, mismatched per-dimension ease. The extractor bakes only expressions (`valueAtTime`). Then **simplify**: drop samples that lie on the straight line between their neighbours within a tolerance. Baking is per property and per segment, never all or nothing for the whole file.

`combineTracks` handles values built from several inputs (rect = size + position + roundness, trims, merged paths, radial gradient radius): if one input moves and the result is linear in it, its keyframes and easing carry over; otherwise it bakes.

### Shape contents (shapes.js)
- Shape arrays are flat number arrays of subpath blocks `[n, closed, (vx,vy,ix,iy,ox,oy)×n, …]`, so merged paths are concatenations and still interpolate.
- **Paints** draw every path above them in their group, including sub-groups (wrapped in the sub-group's transforms).
- **Trim Paths** applies to every path above it, including sub-groups, regardless of paint position. A pre-pass (`assignTrims`) links each path to its nearest trim. Output: `pathLength="1"`, `stroke-dasharray="len 1-len"`, `stroke-dashoffset="-start"`; the period of 1 makes offsets wrap like AE. "Simultaneously" lays the member paths end to end by length (`localTrim`). Zero length with round/square caps is hidden with a discrete `display` animation (a zero dash still draws caps). Trim affects strokes only; fills stay whole (warned).
- **Merge Paths** flattens the paths above into the merge's group space (applying sub-group transforms; baked if those animate). add: concatenated subpaths with the fill's rule. merge: subpaths wound clockwise + nonzero = union. exclude: evenodd. intersect: first path inside nested `<clipPath>`s of the others. subtract: first path with a `<mask>` of the others (assumes the topmost path is the base; unverified).
- **Gradients** go into `<defs>` with `gradientUnits="userSpaceOnUse"` (AE gradient points are in the shape's space). Radial: r = |end − start|, focal point from highlight length/angle (lottie-web's formula). Color and opacity stops are merged; a midpoint ≠ 0.5 becomes an extra stop.
- **Ids** (`grad`, `clip`, `mask`) are prefixed per comp (hash of the name, or `options.idPrefix`) so several exports can be inlined on one page.

### Auto-Orient
The layer's rotation gets the motion path's direction added: the exact tangent of the spatial bezier at the eased arc-length position (`orientationTrack`), held before the first and after the last keyframe, and unwrapped so it never spins through ±180°.

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
- Verify AE behaviour against real AE (see "Probing real AE") before encoding assumptions in the extractor or the mock.
