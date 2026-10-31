# better-lottie

Turn After Effects animations into **animated SVG files** you can put straight on a website. No JavaScript, no player library, no plugin on the website: the file animates itself.

```html
<img src="my-animation.svg" alt="">
```

That's all the website needs.

## Prerequisites

- **Adobe After Effects 2019 or newer** (tested with After Effects 2026)
- **macOS** (tested). Windows should work but hasn't been tested yet.
- **[Node.js](https://nodejs.org) 20 or newer.** Only needed once, to install the extension.
- **Git** to download the project, or download it as a ZIP instead

## Installation

1. **Download the project**

   ```sh
   git clone <repository-url> better-lottie
   cd better-lottie
   ```

   Or download the ZIP, unpack it, and open a terminal in that folder.

2. **Install and link the extension**

   ```sh
   npm install
   npm run dev:install
   ```

   This builds the extension and links it into After Effects' extensions folder. It also turns on a setting that lets After Effects load extensions that aren't distributed through Adobe's store.

3. **Restart After Effects** completely (quit and reopen it).

4. **Allow the extension to save files:** in After Effects, open **Settings › Scripting & Expressions** and turn on **Allow Scripts to Write Files and Access Network**.

5. **Open the panel:** **Window › Extensions › better-lottie**. Dock it wherever you like.

### Updating

Download the latest version (`git pull`), then run `npm install` and `npm run build`. Close and reopen the panel in After Effects. You don't need to install it again.

### Uninstalling

```sh
npm run dev:uninstall
```

## Why?

Tools like Lottie export your animation as data that needs a JavaScript player on the page. better-lottie exports a single, self-contained `.svg` file instead:

- **Works anywhere an image works:** `<img>` tags, CSS backgrounds, CMS image fields, email-friendly HTML
- **Small files:** usually a few kilobytes
- **Sharp at any size:** it's vector, so it looks crisp on every screen
- **Easing is preserved:** your keyframe curves come through as they are in After Effects

## How to use it

1. **Open the composition** you want to export, or select it in the Project panel.
2. Click **Preview** to see the result in the panel without saving anything.
3. Click **Export SVG…** and choose where to save the file.
4. Copy the `<img>` snippet the panel shows and use it on your website.

### Options

- **Loop:** on by default. Turn it off to play the animation once and stop on the last frame.
- **Include comp background:** off by default, so the SVG has a transparent background. Turn it on to include your composition's background color.

### Warnings

If your composition uses something better-lottie can't export, the panel lists it under **warnings** with the layer name. Nothing is dropped silently. The rest of the animation still exports.

## What's supported

| | |
|---|---|
| **Layers** | Shape layers, null objects (as parents), parenting, layer in/out points |
| **Transform** | Position, scale, rotation, opacity, anchor point, separated X/Y position, Auto-Orient along path |
| **Shapes** | Paths, rectangles, ellipses, groups, shape morphing |
| **Fill & stroke** | Solid colors, linear and radial gradients (incl. gradient scale/rotation and animated colors), stroke width, line caps and joins, dashes, stroke taper and wave |
| **Shape effects** | Trim Paths, Merge Paths, Repeater |
| **Masks & mattes** | Layer masks (add, subtract, intersect, inverted, feather, expansion, opacity), track mattes (alpha, luma and inverted) |
| **Animation** | All keyframe easing, hold keyframes, motion paths, expressions (recorded frame by frame) |

### Not supported

Effects, text layers, images and video, 3D layers and cameras, blend modes, precomps, and a few shape effects (Offset Paths, Wiggle Paths, Zig Zag, Pucker & Bloat, Twist, Round Corners, Polystar).

## Tips

- **Save your project before exporting** if it uses gradients. After Effects doesn't let extensions read gradient colors directly, so better-lottie reads them from the saved project file.
- **Illustrator artwork:** right-click the layer and choose **Create › Create Shapes from Vector Layer** first. Only shape layers are exported.
- **Text:** right-click the text layer and choose **Create › Create Shapes from Text**.
- **Keep it simple:** shape-based animations with a moderate number of layers give the smallest files.

## Using the SVG on a website

The simplest way is an image tag. It plays automatically:

```html
<img src="my-animation.svg" alt="" width="400">
```

If you want to **control playback** (pause, play, jump to a moment), paste the SVG's contents directly into your HTML instead and use:

```html
<script>
  const animation = document.querySelector('svg');
  animation.pauseAnimations();      // pause
  animation.unpauseAnimations();    // play
  animation.setCurrentTime(1.5);    // jump to 1.5 seconds
</script>
```

Note: browsers pause animations in `<img>` tags while they are scrolled out of view. That's normal and saves battery.

## Troubleshooting

| Problem | Fix |
|---|---|
| The panel isn't in **Window › Extensions** | Quit After Effects completely and reopen it. If it's still missing, run `npm run dev:install` again. |
| "Open or select a composition first" | Click inside the composition's timeline or viewer, then try again. |
| Saving fails | Turn on **Allow Scripts to Write Files and Access Network** (step 4 of the installation). |
| Gradients come out black and white, or there's a warning about unsaved changes | Save the After Effects project, then export again. |
| The export looks different from After Effects | Click **Save IR…** in the panel and attach the saved file, a screenshot, and a short description to a bug report. |

## For developers

The technical details (architecture, how After Effects features are converted, testing) are in [`CLAUDE.md`](CLAUDE.md). Run the tests with `npm test`.
