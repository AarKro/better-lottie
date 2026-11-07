// The intermediate representation (IR): what the ExtendScript extractor
// writes and the converter reads. Keep this file the single source of truth.
//
// Conventions
// - All times are in seconds of *comp* time (the extractor resolves layer
//   start offsets). The comp runs from 0 to comp.duration.
// - Layers are listed in AE order: index 0 is the top layer.
// - Units are AE's: degrees, scale and opacity in percent, colors 0..1.
//
// @typedef {Object} IR
// @property {1} version
// @property {Comp} comp
// @property {Layer[]} layers
// @property {string[]} [warnings]      from the extractor; passed through to the export report
//
// @typedef {Object} Comp
// @property {string} name
// @property {number} width
// @property {number} height
// @property {number} duration          seconds
// @property {number} frameRate
// @property {number[]} [background]    [r,g,b] 0..1; omitted = transparent
// @property {{ start: number, duration: number }} [workArea]  seconds; used with the workArea option
//
// @typedef {Object} Layer
// @property {number} id                AE layer index
// @property {string} name
// @property {'shape'|'null'|string} type  other types are reported and skipped
// @property {boolean} [enabled]        false = eye switch off, skipped
// @property {boolean} [vector]         footage from an Illustrator, EPS or PDF file; "Prepare comp"
//                                      in the panel turns these into shape layers
// @property {number|null} [parent]     id of the parent layer
// @property {number} [inPoint]         defaults to 0
// @property {number} [outPoint]        defaults to comp.duration
// @property {boolean} [threeD]
// @property {string} [blendMode]       AE mode name, lowercase with hyphens (e.g. 'color-dodge');
//                                      modes without a CSS equivalent are reported
// @property {boolean} [isMatte]        used as a track matte (hidden, but rendered into the matte)
// @property {{ type: 'alpha'|'alpha-inverted'|'luma'|'luma-inverted', layer: number }} [matte]
//                                      this layer's track matte: type and matte layer id
// @property {Mask[]} [masks]           layer masks in AE order (mode None is left out)
// @property {Transform} transform
// @property {ShapeItem[]} [contents]   shape layers only, top item first
// @property {Puppet[]} [puppets]       Puppet effects (ADBE FreePin3) in effect order
//
// @typedef {Object} Puppet           deforms the layer's paths and masks (baked per frame)
// @property {string} name
// @property {boolean} [enabled]        false = effect switched off
// @property {'advanced'|'legacy'} engine
// @property {number} refinement        "Mesh Rotation Refinement" (ARAP iterations)
// @property {{ width: number, height: number, space: 'comp'|'source', scale?: number }} source
//                                      where mesh and pins live. Shape layers: comp space, after
//                                      the layer's transform (and its parents'); mesh coordinates are
//                                      normalized by `scale` (default: the larger of width and height)
// @property {PuppetMesh[]} meshes
// @property {number} [overlapPins]     counts, reported as unsupported
// @property {number} [stiffnessPins]
//
// @typedef {Object} PuppetMesh
// @property {string|null} data         hex of the saved 'fpms' chunk (rest vertices and
//                                      triangles; see decodeMesh in puppet.js). Scripting
//                                      can't read the mesh; null when the project isn't saved
// @property {{ name: string, type: 'position'|string, vertex: number, position: Prop<number[]> }[]} pins
//                                      position in source space; vertex = the mesh vertex it holds
//
// @typedef {Object} Transform
// @property {Prop<number[]>} [anchor]      [x,y(,z)]
// @property {Prop<number[]>|SeparatedPosition} [position]
// @property {Prop<number[]>} [scale]       [sx,sy] percent
// @property {Prop<number>} [rotation]      degrees, clockwise
// @property {Prop<number>} [opacity]       0..100
// @property {Prop<number>} [skew]          shape groups only; reported if nonzero
// @property {boolean} [autoOrient]         layers only: "Auto-Orient: Along Path";
//                                          the path's direction is added to rotation
//
// @typedef {{ separated: true, x: Prop<number>, y: Prop<number> }} SeparatedPosition
//
// @typedef {Object} Mask             in layer space
// @property {string} name
// @property {'add'|'subtract'|'intersect'|'lighten'|'darken'|'difference'} mode
// @property {boolean} inverted
// @property {Prop<Shape>} path
// @property {Prop<number[]>} feather   [x, y] px
// @property {Prop<number>} opacity     0..100
// @property {Prop<number>} expansion   px, negative shrinks
//
// @typedef {Object} ShapeItem   (AE order: top item first)
//   Groups, fills and strokes may carry blendMode: an AE mode name like the
//   layer's (shape-level blend modes; they blend within the layer).
//   { type: 'group', name, enabled?, transform, contents: ShapeItem[] }
//   { type: 'path', path: Prop<Shape> }
//   { type: 'rect', size: Prop<[w,h]>, position: Prop<[x,y]>, roundness: Prop<number> }
//   { type: 'ellipse', size: Prop<[w,h]>, position: Prop<[x,y]> }
//   { type: 'polystar', starType: 'star'|'polygon', points: Prop<number> (≥ 3, may be fractional),
//     position: Prop<[x,y]>, rotation: Prop<number> (degrees), outerRadius: Prop<number>,
//     outerRoundness: Prop<number> (percent), innerRadius?, innerRoundness?: Prop<number> (stars only) }
//   Paths, rects, ellipses and polystars may carry direction: 'reversed' (AE "Reverse
//   Path Direction"): closed subpaths run the other way from the same first
//   vertex; open ones are unchanged. With nonzero fills this decides holes.
//   { type: 'fill', color: Prop<rgb>, opacity: Prop<number>, fillRule?: 'nonzero'|'evenodd' }
//   { type: 'stroke', color, opacity, width: Prop<number>,
//     lineCap?: 'butt'|'round'|'square', lineJoin?: 'miter'|'round'|'bevel', miterLimit?: number,
//     dashes?: [{ type: 'dash'|'gap', value: Prop<number> }], dashOffset?: Prop<number>,
//     taper?: { units: 'percent'|'pixels', startLength, endLength, startWidth, endWidth (0..100),
//               startEase, endEase (0..100): Prop<number> },
//     wave?: { amount (0..100), wavelength (px), cycles, phase (degrees): Prop<number>,
//              units: 'pixels'|'cycles' } }
//   { type: 'gradient-fill', gradientType: 'linear'|'radial', startPoint, endPoint: Prop<[x,y]>,
//     highlightLength, highlightAngle: Prop<number>, stops: Prop<GradientStops>|null,
//     gradientScale?: Prop<[sx,sy]>, gradientRotation?: Prop<number>  (around the shape's origin),
//     opacity, fillRule? }
//   { type: 'gradient-stroke', …gradient fields, …stroke fields except color }
//   { type: 'trim', start, end: Prop<number> (0..100), offset: Prop<number> (degrees),
//     mode: 'simultaneously'|'individually' }
//   { type: 'merge-paths', mode: 'merge'|'add'|'subtract'|'intersect'|'exclude' }
//   { type: 'repeater', copies, offset: Prop<number>, composite: 'below'|'above',
//     transform: { anchor, position, scale, rotation }, startOpacity, endOpacity: Prop<number> }
//   Any other type (offset-paths, …) is reported and ignored.
//
//   Paints (fill, stroke, gradient-*) draw every path above them in the same
//   group, including paths in groups above. Trim Paths changes every path
//   above it the same way, wherever the paints are. Merge Paths combines the
//   paths above it for the paints below it. A Repeater copies everything
//   above it (paths and paints).
//
// @typedef {{ colors: number[][], alphas: number[][] }} GradientStops
//   colors: [offset, midpoint, r, g, b] (0..1); alphas: [offset, midpoint, a].
//   AE's scripting API can't read these; the extractor parses the saved .aep
//   (one XML per color keyframe; none at all when the colors were never
//   edited, which means AE's default white to black). A bare object (no
//   value/keyframes) is accepted as a static value.
//
// @typedef {{ vertices: number[][], inTangents: number[][], outTangents: number[][], closed: boolean }} Shape
//   Tangents are relative to their vertex.
//
// @template T
// @typedef {{ value: T } | { keyframes: Keyframe<T>[] } | T} Prop   a bare value is shorthand for { value }
//
// @template T
// @typedef {Object} Keyframe
// @property {number} t                 seconds
// @property {T} v
// @property {'linear'|'bezier'|'hold'} [inType]   default: bezier if easeIn is set, else linear
// @property {'linear'|'bezier'|'hold'} [outType]
// @property {Ease[]} [easeIn]          one per dimension; a single entry applies to all.
// @property {Ease[]} [easeOut]         Spatial props (position, anchor) always have one.
// @property {number[]} [spatialIn]     motion path tangents, spatial props only
// @property {number[]} [spatialOut]
//
// @typedef {{ speed: number, influence: number }} Ease
//   speed in units/s (px/s along the path for spatial props; for colors and
//   paths AE's speed is treated as progress/s, so only 0 or linear is exact),
//   influence 0..100

export function validate(ir) {
  const fail = msg => { throw new Error(`Invalid IR: ${msg}`); };
  if (!ir || typeof ir !== 'object') fail('not an object');
  const c = ir.comp;
  if (!c) fail('missing comp');
  for (const key of ['width', 'height', 'duration', 'frameRate']) {
    if (!(typeof c[key] === 'number' && c[key] > 0)) fail(`comp.${key} must be a positive number`);
  }
  if (!Array.isArray(ir.layers)) fail('layers must be an array');
  ir.layers.forEach((l, i) => {
    if (l.id == null) fail(`layers[${i}] has no id`);
    if (!l.type) fail(`layers[${i}] has no type`);
  });
}
