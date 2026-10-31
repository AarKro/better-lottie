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
//
// @typedef {Object} Comp
// @property {string} name
// @property {number} width
// @property {number} height
// @property {number} duration          seconds
// @property {number} frameRate
// @property {number[]} [background]    [r,g,b] 0..1; omitted = transparent
//
// @typedef {Object} Layer
// @property {number} id                AE layer index
// @property {string} name
// @property {'shape'|'null'|string} type  other types are reported and skipped
// @property {boolean} [enabled]        false = eye switch off, skipped
// @property {number|null} [parent]     id of the parent layer
// @property {number} [inPoint]         defaults to 0
// @property {number} [outPoint]        defaults to comp.duration
// @property {boolean} [threeD]
// @property {string} [blendMode]       anything but 'normal' is reported
// @property {string} [trackMatte]      reported, not supported
// @property {Transform} transform
// @property {ShapeItem[]} [contents]   shape layers only, top item first
//
// @typedef {Object} Transform
// @property {Prop<number[]>} [anchor]      [x,y(,z)]
// @property {Prop<number[]>|SeparatedPosition} [position]
// @property {Prop<number[]>} [scale]       [sx,sy] percent
// @property {Prop<number>} [rotation]      degrees, clockwise
// @property {Prop<number>} [opacity]       0..100
// @property {Prop<number>} [skew]          shape groups only; reported if nonzero
//
// @typedef {{ separated: true, x: Prop<number>, y: Prop<number> }} SeparatedPosition
//
// @typedef {Object} ShapeItem
//   { type: 'group', name, enabled?, transform, contents: ShapeItem[] }
//   { type: 'path', path: Prop<Shape> }
//   { type: 'rect', size: Prop<[w,h]>, position: Prop<[x,y]>, roundness: Prop<number> }
//   { type: 'ellipse', size: Prop<[w,h]>, position: Prop<[x,y]> }
//   { type: 'fill', color: Prop<rgb>, opacity: Prop<number>, fillRule?: 'nonzero'|'evenodd' }
//   { type: 'stroke', color, opacity, width: Prop<number>,
//     lineCap?: 'butt'|'round'|'square', lineJoin?: 'miter'|'round'|'bevel', miterLimit?: number }
//   Any other type (trim, repeater, gradient-fill, …) is reported and ignored.
//   A fill or stroke paints every path above it in the same group,
//   including paths in groups above it.
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
