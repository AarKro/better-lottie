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

1. **Extractor** (`extension/host/extract.jsx`, ExtendScript). Walks the active comp and writes a neutral **intermediate representation (IR)** as JSON. It only reads AE and does no SVG logic. The one host script that changes the project is `prepare.jsx` ("Prepare comp"), which the panel loads on first use (`$.evalFile`, path from `getSystemPath('extension')`).
2. **Converter** (`src/`, modern JS, no AE dependency). Turns the IR into an SVG string. It runs inside the CEP panel (Chromium/Node) **and** in plain Node for tests.

The point of the split: almost all the logic lives in the converter, which can be tested in Node with fixture IR files and needs no After Effects. Keep the `.jsx` side as thin as possible.

### Layout

```
better-lottie/
  src/                     # converter
    ir.js                  # IR spec (JSDoc) + validate(). Source of truth for the IR.
    easing.js              # AE speed/influence ↔ bezier, keySpline normalization
    timeline.js            # props → tracks (exact or baked) → SMIL timing; combineTracks; auto-orient
    path.js                # shape arrays (multi-subpath blocks) → path data; rect/ellipse/polystar → shapes
    geometry.js            # matrices, orientation, path length on shape arrays
    anim.js                # SMIL/element helpers shared by the modules below
    transform.js           # AE transforms → nested <g>; matrix tracks for flattening
    paint.js               # fill/stroke/gradients/dashes → styles (+ <defs>)
    shapes.js              # shape contents: paint/group stacking, Trim Paths, Merge Paths, Repeaters
    taper.js               # Taper/Wave strokes → filled outline polygons
    masks.js               # layer masks and track mattes → <mask>
    svg.js                 # document, layers, parenting, in/out points
  bin/better-lottie.js     # CLI: better-lottie in.ir.json [-o out.svg] [--once]
  test/
    fixtures/*.ir.json     # hand-written IR samples; ae-*.ir.json are extracted from real AE (scratch project)
    snapshots/*.svg        # expected output (npm run test:update to rewrite)
    *.test.js
  scripts/
    build-preview.js       # → preview/index.html (gitignored)
    install-dev.js         # PlayerDebugMode + symlink extension/ into AE's CEP folder
    package.js             # signed release .zxp (downloads Adobe's ZXPSignCmd 4.1.3, hash-checked)
  extension/               # the CEP extension; this folder is what AE loads
    CSXS/manifest.xml      # AEFT 16.0+ (AE 2019), CSXS 9.0+
    .debug                 # DevTools at http://localhost:8099 (dev only)
    index.html, panel.css
    panel.js               # UI; calls the host via __adobe_cep__.evalScript (no CSInterface.js)
    lib/better-lottie.js   # converter bundle, built by `npm run build` (gitignored)
    host/extract.jsx       # ExtendScript: active comp → IR JSON string; save dialog + file write
    host/prepare.jsx       # "Prepare comp": copy of the comp with Illustrator/text layers → shape layers
```

### Commands
- `npm test`: unit, snapshot and extractor tests (`node --test`)
- `npm run test:update`: rewrite snapshots after an intended output change. Review the diff.
- `npm run preview`: build `preview/index.html`. Serve it (`python3 -m http.server -d preview`) or open it directly.
- `npm run build`: bundle `src/` into `extension/lib/better-lottie.js` (esbuild, IIFE, global `BetterLottieSVG`, target chrome61 for CEP 9). Rerun after every converter change, then reopen the panel.
- `npm run dev:install`: build, set `PlayerDebugMode` for CSXS 9–12, symlink `extension/` to `~/Library/Application Support/Adobe/CEP/extensions/better-lottie`. Restart AE → Window › Extensions › better-lottie. `npm run dev:uninstall` removes the link.
- `npm run package`: build, copy `extension/` without `.debug` to `dist/stage/`, sign with ZXPSignCmd 4.1.3 (downloaded from Adobe's CEP-Resources into `node_modules/.cache/`, pinned commit + SHA-256; 4.1.1 from npm segfaults with `-tsa` on macOS; the macOS build is x86_64, so Rosetta on Apple Silicon; timestamped via DigiCert TSA, so it needs network) → `dist/better-lottie-<version>.zxp`, then verify. Fails if `package.json`, manifest `ExtensionBundleVersion` and `VERSION` in `src/svg.js` differ. The first run creates a self-signed cert at `certs/better-lottie.p12` (gitignored; password `ZXP_CERT_PASSWORD` or the default). Users install the `.zxp` with aescripts' ZXP Installer; a signed extension doesn't need `PlayerDebugMode`.

### Making a release
1. Bump the version in all three places: `package.json` (`npm version X.Y.Z --no-git-tag-version`, which also updates the lockfile), `VERSION` in `src/svg.js`, and `ExtensionBundleVersion` plus the `Extension` `Version` in `extension/CSXS/manifest.xml`. Then `npm run test:update`: the version is in every snapshot's header comment, so only that line should change.
2. `npm run package` → `dist/better-lottie-<version>.zxp`. Signing needs network (timestamp). Keep `certs/better-lottie.p12` and sign every release with it. "bad CPU type" on Apple Silicon → `softwareupdate --install-rosetta`.
3. Commit "Release X.Y.Z", annotated tag `vX.Y.Z`, push the branch **and** the tag (`git push origin main vX.Y.Z`; a plain `git push` leaves the tag behind). Never move a tag that's already pushed; bump the patch version instead.
4. The user creates the GitHub release from the tag and attaches the `.zxp`. The README's install guide links to `releases/latest`.

### Status
- **Converter:** Phases 1 and 2, plus dashes, Trim Paths, Merge Paths (all five modes), linear/radial gradient fills and strokes (incl. Scale/Rotation and animated colors), Auto-Orient Along Path, layer masks, track mattes, repeaters, stroke Taper and Wave, Polygon/Star.
- **Extension:** panel (Export SVG, Preview, Prepare comp, Save IR, loop/background options, warnings, usage snippet) and extractor. Prepare comp is verified in AE 2026 by script (renders before/after identical); the panel button and loading `prepare.jsx` from the panel are **not yet tested inside AE**. Verified in **real AE 2026** on the user's project (`abgabe.aep`, comps "rocks-glass" and "shaker"): AE's own frames (`saveFrameToPng`) match the SVG.
- **Verified against AE renders** (`test/ae/`, pixel diffs ≤ 2.5/255 on average, only anti-aliased edges differ): masks (all modes, feather, inverted, opacity, expansion, animated path), all four track matte types incl. an animated matte, repeaters (offset, fractional copies, composite order), taper (ease 0–100), wave, gradient Scale/Rotation, Polygon/Star (comps `polystar`, `polystar-anim`; ≤ 0.15/255).
- **Blend modes verified in AE:** every layer and shape-level mode with a CSS equivalent matches AE renders to within 2/255 (Soft Light included); comps `blend-layers` and `blend-shapes` in the scratch project.
- **Release package:** the 0.3.1 `.zxp` installs via aescripts' ZXP Installer and loads in AE 2026 on macOS with the dev link removed. Windows install untested.
- **Not verified in AE:** animated gradient *colors* with different keyframe colors (scripts can't set gradient colors; the file layout was verified with identical keyframes).
- **Not built:** work-area export, mask modes lighten/darken/difference (approximated), adds after an intersect mask (approximated). Not yet checked in Safari/Firefox (pathLength trims, SMIL inside masks).

Baking happens in the converter: `propValueAt` evaluates AE's curves itself. The extractor only bakes what the converter can't see, i.e. expressions: it writes them as per-frame linear keyframes, and the converter's linear-run simplification shrinks them back down.

### Facts verified in AE 2026 (keep the mock in `test/helpers/ae-mock.js` in sync)
- **Dashes:** every stroke has `Dash 1–3`, `Gap 1–3` and `Offset` streams, all `enabled`, default 10/0, even when the UI shows none. Only `isModified` (or keys/expressions) tells real dashes apart. Strokes also always have `ADBE Vector Stroke Taper` and `…Wave` groups.
- **Gradient colors:** `ADBE Vector Grad Colors` is `NO_VALUE`; scripting can't read it. The saved `.aep` (RIFX, big-endian) stores the stops as XML in `LIST GCky > Utf8`, after the `tdmn` naming `ADBE Vector Grad Colors`. A comp is `LIST Item` whose `idta` has the item id at byte 16; its layers are `LIST Layr` children in timeline order. The project can contain several comps with the same name (e.g. imported Illustrator comps), so match by id. `app.project.dirty` exists.
- **Merge Paths mode** (`ADBE Vector Merge Type`): 1 merge, 2 add, 3 subtract, 4 intersect, 5 exclude. Illustrator-outlined artwork in this project uses intersect; compound paths from Illustrator ("Create Shapes from Vector Layer") use merge. Merge keeps each path's winding and applies the fill rule; add is a union that ignores both; subtract = top path minus the rest; exclude = XOR.
- **Shape Direction** (`ADBE Vector Shape Direction` on paths, rects and ellipses, range 1–3): 1 and 2 draw as drawn (2 does *not* force clockwise), 3 reverses. A reversed closed path starts at the same vertex and runs the other way (v0, vn−1 … v1); rect: top-right corner then leftwards; ellipse: top then counter-clockwise; open paths are unchanged. Comps `direction`, `direction-trim` in the scratch project.
- **Compound paints:** a fill or stroke draws all its paths as one shape: nonzero holes from opposite winding, and 50% fills/strokes are uniform where paths overlap.
- **Trim Paths:** `ADBE Vector Trim Start/End/Offset/Type` (Type 1 simultaneously, 2 individually). A trim at a layer's root trims strokes inside the groups above it.
- **Auto-Orient** (`layer.autoOrient`, `AutoOrientType.ALONG_PATH`) is used on parented layers; without it the shaker comp rendered badly wrong.
- **Gradient Scale/Rotation** (`ADBE Vector Grad Scale`/`Rotation`): `rotate(r) · scale(sx, sy)` around the shape's origin (0,0), fitted to 0.001 error.
- **Unedited gradient colors** are not stored in the `.aep` at all (AE stores only modified streams) → AE's default white to black. Keyframed colors: one `Utf8` per keyframe inside the paint's `LIST GCky`.
- **Masks:** `ADBE Mask Parade` > `ADBE Mask Atom` (`maskMode`, `inverted`) with `ADBE Mask Shape/Feather/Opacity/Offset`. A first Subtract mask starts from the full layer. Feather 12 ≈ Gaussian σ 5. Mask opacity scales the mask's coverage.
- **Track mattes:** `trackMatteType`, `trackMatteLayer` (AE 2023+, else the layer above), matte layers report `enabled=false`, `isTrackMatte=true`. Luma uses sRGB luminance (0.4 gray at 60% → 0.24).
- **Repeater:** `ADBE Vector Repeater Copies/Offset/Order` (Order 1 = below: copy 0 on top; 2 = above) and `…Transform` with `Anchor/Position/Scale/Rotation/Opacity 1/Opacity 2`. Copy k = translate(position·k) · rotate/scale^k about the anchor (positions are not rotated by earlier copies). Opacity of copy i = start + (end − start)·i/⌈copies⌉; a fractional count fades the last copy by the fraction.
- **Taper/Wave:** Length Units 1 = percent (`…Start Length`), 2 = pixels (`…StartWidthPx`); Wave Units 1 = wavelength px, 2 = cycles. Width in a taper = start width + (1 − start width)·bezier(handles (0,e), (1−e,1)) with e = ease/100. Wave: W·(1 − A/2 − A/2·cos(2π·cycles·s + phase)). Setting a hidden stream (e.g. Wave Cycles while Units = px) throws in scripts.
- **Create Shapes from Vector Layer** (command 3973; from Text: 3781) acts on the selected layers of the comp open in the viewer (other selected types are ignored). The new `<name> Outlines` shape layer goes directly above the original and gets its transform (keyframes, expressions), parent, in/out, stretch, effects and masks; the original is switched off. **Not** copied: blend mode, motion blur, its own track matte; children and matted layers keep pointing at the original. Renders identically. `prepare.jsx` fixes these up, re-parents with `setParentWithJump` (plain `.parent =` changes the child's values), takes the original's name, removes the original. Text animators are baked to the current time. The new shapes are unsaved, so their gradient colors can't be read until the project is saved. Footage layers whose source is `.ai/.eps/.pdf` get `vector: true` in the IR.
- **Polygon/Star** (`ADBE Vector Shape - Star`): `…Star Type` (1 star, 2 polygon), `Points` (min 3, fractional allowed), `Position`, `Rotation`, `Inner/Outer Radius`, `Inner/Outer Roundess` (sic). Geometry fitted to AE's own "Convert To Bezier Path" (command 4162; it only acts when run in its own DoScript call with the property selected) to 1e-4, see `polystarShape` and `test/fixtures/ae-polystar-shapes.json`. Not lottie-web's formula: roundness handles are q·r·K·sin(π/n), and fractional points add a partial vertex.
- `saveFrameToPng` writes colors already composited over the comp background, plus alpha: compare against SVGs rendered *with* the background.
- Still unverified: ease `speed` units for color and path properties (treated as progress/s); `File.saveDlg` without a filter on macOS works in practice.

### Probing real AE from the terminal
With the user's OK (it drives their open AE), run read-only scripts via `osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile "/path/probe.jsx"'`. DoScript does not return the script's result: write output to a file (e.g. `~/Downloads/…`) and read it.
- Wrap probes in `app.beginSuppressDialogs()` / `app.endSuppressDialogs(false)`. AE shows a modal error dialog even for errors you catch, e.g. reading `.value` of a `NO_VALUE` property; check `propertyValueType` first.
- `$.evalFile('…/extension/host/extract.jsx')` then `BetterLottie.extractCompById(id)` extracts any comp without touching the UI.
- `comp.saveFrameToPng(t, file)` renders AE's reference frames for side-by-side comparison with the SVG (scrub the SVG with `pauseAnimations()` + `setCurrentTime(t)`). Re-render when the project changed.
- To test features the user's project lacks, use the **scratch project** `test/ae/scratch.aep` (gitignored; with `frames/`, `ir/`, `shots/`). Only switch projects when the open one has no unsaved changes, and tell the user to reopen theirs afterwards. Scripts can build comps (`addShape`, `addProperty`, `setTrackMatte`, `addKey`) but cannot set gradient colors.

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

### Phase 4 (done)
- Layer masks, track mattes, repeaters, animated gradient colors, gradient Scale/Rotation, stroke Taper/Wave

### Next candidates
- Solid layers (as rects); precomps
- Export the work area only; "start paused" option

### Out of scope
Effects, 3D layers and cameras, blend modes, text and Illustrator layers (point users to "Prepare comp"), images and video, and the remaining shape modifiers (offset paths, wiggle, zig zag, pucker & bloat, twist, round corners). **Never drop anything silently.** Each unsupported thing produces a warning that names the layer and property.

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
- Ellipse → 4 cubic segments (kappa ≈ 0.5523). Rect, including roundness → path. Polygon/Star → path; animated points or rotation bake, and animated points pad every frame to one vertex count (continuous across whole points). Converting primitives to paths keeps morphing and output uniform.
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
- Discrete switches (layer in/out points, zero-length trims) sit half a frame before their frame (`switchTime`). keyTime × dur in floating point can land just after the frame time (0.128 × 10 = 1.2800000000000002), which hid a starting stroke for one frame.
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
- **A paint draws all its paths as one compound `<path>`** (`compoundPaint`), as AE does: with the fill's rule inner paths cut holes, and translucent fills/strokes don't double up where paths overlap (comp `direction` in the scratch project). Outlined Illustrator artwork depends on this (the whisk in a user's mixer comp came out solid when each path was its own `<path>`). Paths in sub-groups with static transforms are flattened in. Paths behind an animated group transform, repeated paths, intersect/subtract merges, and strokes with dashes, taper or Trim Paths stay one element per path. Paths keyed at the same times with the same easing keep their keyframes (`concatShapes`); otherwise the combined shape bakes.
- **Reverse Path Direction** (`direction: 'reversed'`) flips closed subpaths, keeping the first vertex (`reverseBlocks`). With nonzero fills it decides which inner paths are holes.
- **Trim Paths** applies to every path above it, including sub-groups, regardless of paint position. A pre-pass (`assignTrims`) links each path to its nearest trim. Output: `pathLength="1"`, `stroke-dasharray="len gap"`, `stroke-dashoffset="-start"`. The gap is 1.001 so the next dash starts past the path's end; a dash starting exactly at the end is drawn or not depending on float rounding, which showed as flickering round-cap dots (orange comp). Only trims that wrap around the end (offsets on closed paths) use period 1 + 0.001. "Simultaneously" lays the member paths end to end by length (`localTrim`). Zero length with round/square caps is hidden with a discrete `display` animation (a zero dash still draws caps). Trim affects strokes only; fills stay whole (warned).
- **Merge Paths** flattens the paths above into the merge's group space (applying sub-group transforms; baked if those animate). merge: concatenated subpaths as drawn with the fill's rule (AE's compound paths from Illustrator; holes from opposite winding or evenodd). add: subpaths wound clockwise + nonzero = union, ignoring windings and the fill rule. exclude: evenodd. intersect: first path inside nested `<clipPath>`s of the others. subtract: first path with a `<mask>` of the others (the topmost path is the base). All five verified against AE renders (comp `merge-modes`); before 0.3.3, merge and add were swapped and outlined artwork lost its holes.
- **Gradients** go into `<defs>` with `gradientUnits="userSpaceOnUse"` (AE gradient points are in the shape's space). Radial: r = |end − start|, focal point from highlight length/angle (lottie-web's formula). Color and opacity stops are merged; a midpoint ≠ 0.5 becomes an extra stop.
- **Ids** (`grad`, `clip`, `mask`) are prefixed per comp (hash of the name, or `options.idPrefix`) so several exports can be inlined on one page.

### Masks and mattes (masks.js)
- **Never put a mask inside a mask's content.** Chromium does not repaint a `<mask>` whose content is itself masked when the inner content animates (verified: the frame stays stale even during playback). Layer masks therefore become: one `<mask>` for consecutive add/subtract masks (white/black shapes), plus one `<mask>` per intersect, applied as nested `<g mask>` around the content. Inverted masks = white rect + black shape inside an opacity group.
- Feather: `feGaussianBlur` with σ = feather / 2.4 on the shape, `filterUnits="userSpaceOnUse"` sized from the path's bounds over all keyframes. Expansion: stroke (grow) / `feMorphology erode` (shrink).
- Track mattes: the matte layer is rendered (even though hidden) into a `<mask>` in comp space around the target layer's output. alpha → `feColorMatrix` to white-with-alpha; alpha-inverted → white rect + black-with-alpha; luma → as is; luma-inverted → white rect + color-inverted. `color-interpolation-filters="sRGB"`.

### Blend modes
The comp background is not a layer in AE and never takes part in blending: with a background rect, all layers go into an isolated group above it.

Layer blend modes wrap the layer's final output (after matte and visibility) in `<g style="mix-blend-mode:…">`; the root `<svg>` gets `isolation:isolate` so blending never reaches the page behind an inlined SVG (an `<img>` is isolated anyway). AE Add/Linear Dodge → `plus-lighter`; the "classic" variants map to their modern modes (warned); modes CSS lacks (Linear Burn/Light, Vivid/Pin Light, Hard Mix, Subtract, Divide, Lighter/Darker Color, Dissolve, Stencil/Silhouette, Alpha Add, Luminescent Premul) export as normal with a warning. Matte layers ignore their own blend mode.

Shape-level blend modes (`ADBE Vector Blend Mode` on groups, fills, strokes) are AE's menu position, separators included: 1 normal, 3 darken, 4 multiply, 5 color burn, 6 linear burn, 7 darker color, 9 lighten, 10 screen, 11 color dodge, 12 add, 13 lighter color, 15 overlay, 16 soft light, 17 hard light, 18 linear light, 19 vivid light, 20 pin light, 21 hard mix, 23 difference, 24 exclusion, 26 hue, 27 saturation, 28 color, 29 luminosity; 2, 8, 14, 22, 25 render as normal (identified by fitting AE renders). The extractor writes names. The converter puts `mix-blend-mode` on the paint's paths or the group's wrapper and isolates the layer's content, assuming (unverified) that AE's shape blends stay within their layer. `src/blend.js` holds the shared AE → CSS map.

### Repeaters and taper
- Repeaters split the group's stack at the lowest repeater: items below draw first, then the copies of everything above. Copy 0 holds the content in `<g id>`; the others `<use>` it. Paints below a repeater draw every copy of the paths above.
- Taper/Wave strokes become filled polygons (`taper.js`): 64 samples (denser near the ends), fixed-count caps so the structure stays constant for `d` animation, trimmed first so the taper follows the visible part. Always baked when animated.

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
