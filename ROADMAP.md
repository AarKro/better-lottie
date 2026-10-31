# Roadmap

Features we can still build, roughly in order of priority. Effort: **S** = hours, **M** = a day or two, **L** = several days.

Every After Effects feature gets verified against AE's own renders (scratch project in `test/ae/`, see CLAUDE.md) before it's marked done.

## Next up

- [ ] **Precomps** (M): nested compositions, including layer start offsets, time stretch and time remapping. SMIL can shift and scale timing, so a precomp can stay one reusable group.
- [ ] **Polystar** (S): star and polygon shapes (points, radii, roundness, rotation), converted to paths.
- [ ] **Interactions without JavaScript** (M): AE markers define segments (e.g. `hover`, `click`, `intro`), exported as SMIL animations triggered by `begin="mouseover"` / `begin="click"`. Works when the SVG is inline in the page (not in `<img>`, which gets no mouse events).
- [ ] **CSS-variable theming** (S): mark colors in the panel to export as `var(--name, #fallback)`, so a website can recolor the animation from its own CSS, including dark mode. Option to map a color to `currentColor`.
- [ ] **Effects as SVG filters** (M, per group of effects):
  - [ ] Gaussian Blur, Fast Box Blur → `feGaussianBlur`
  - [ ] Drop Shadow → `feDropShadow`
  - [ ] Glow (approximation: blur + merge)
  - [ ] Fill, Tint, Hue/Saturation → `feColorMatrix` / `feFlood`
  - [ ] Turbulent Displace / Wave Warp (approximation: `feTurbulence` + `feDisplacementMap`)

## After Effects coverage

- [ ] **Solid layers** (S): exported as rectangles.
- [ ] **Image layers** (M): embedded in the SVG; warn about file size.
- [ ] **Text layers as real text** (L): SVG `<text>` that stays selectable, translatable and readable by screen readers. Fonts must be available on the website. Text animators are out of scope at first.
- [ ] **Shape modifiers** (M each): Round Corners, Offset Paths, Zig Zag, Pucker & Bloat, Twist, Wiggle Paths. Recomputed geometry; animated ones become frame-by-frame paths.
- [ ] **Work area export** (S): export only the comp's work area.
- [ ] **Time remapping on layers** (M): currently ignored with a warning.
- [ ] **Remaining track matte cases** (S): matte layers that aren't shape layers.

## Web features Lottie doesn't have

- [ ] **Accessibility** (S): `<title>`, `<desc>` and `role="img"` from panel fields.
- [ ] **Reduced motion** (S): honour `prefers-reduced-motion` by showing a chosen still frame instead of the animation.
- [ ] **"Start paused" and "play once on load" options** (S)
- [ ] **CSS output mode** (L): an alternative export using CSS `@keyframes` instead of SMIL. Enables scroll-driven animations (`animation-timeline: scroll()`) and pausing from CSS. Shape morphs would stay SMIL, because Safari can't animate `d` with CSS.
- [ ] **Multiple animations in one file** (M): several comps as named states of one SVG (e.g. idle / hover / active).

## Export quality and workflow

- [ ] **Size optimization pass** (M): shorter path data, shared definitions, merging static groups.
- [ ] **Size report in the panel** (S): which layers take up the most bytes and why (e.g. "path sampled every frame").
- [ ] **Copy as inline SVG / data URI** (S): one-click snippets in the panel besides `<img>`.
- [ ] **Batch export** (S): export several comps at once.
- [ ] **Browser checks** (M): verify output in Safari and Firefox (trim paths with `pathLength`, SMIL inside masks, `plus-lighter`), ideally automated with Playwright's WebKit and Firefox engines.
- [ ] **Packaged release** (M): a signed `.zxp` so people can install without Node.js.

## Not planned

3D layers and cameras, blend modes browsers lack (Linear Burn, Vivid Light, Pin Light, Hard Mix, Subtract, Divide, …), video layers, audio.
