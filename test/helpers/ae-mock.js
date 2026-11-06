// A small stand-in for the After Effects scripting DOM: just enough of it to
// run extension/host/extract.jsx in Node. Match names and enum shapes follow
// the AE scripting guide. Behaviour here is an assumption about AE, so verify
// against the real thing (Save IR…) when something looks off.

import vm from 'node:vm';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
export const BlendingMode = { NORMAL: 5212, MULTIPLY: 5213, SCREEN: 5214, ADD: 5215, OVERLAY: 5216 };
export const TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013 };
export const AutoOrientType = { NO_AUTO_ORIENT: 4212, ALONG_PATH: 4213, CAMERA_OR_POINT_OF_INTEREST: 4214 };
export const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 };
Object.assign(TrackMatteType, { ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 });

export class KeyframeEase {
  constructor(speed, influence) { this.speed = speed; this.influence = influence; }
}
export const EASY = () => [new KeyframeEase(0, 33.333)];

export class Shape {
  constructor({ vertices = [], inTangents, outTangents, closed = true } = {}) {
    const zeros = vertices.map(() => [0, 0]);
    Object.assign(this, { vertices, inTangents: inTangents || zeros, outTangents: outTangents || zeros, closed });
  }
}

export class Property {
  // spec: a plain value, { keys: [{ t, v, inType, outType, easeIn, easeOut, spatialIn, spatialOut }] },
  // or { expr: t => value }
  constructor(matchName, name, spec, { spatial = false, separated = false, modified = false } = {}) {
    const isSpec = spec && typeof spec === 'object' && !Array.isArray(spec) && !(spec instanceof Shape);
    this.matchName = matchName;
    this.name = name;
    this.keys = isSpec && spec.keys ? spec.keys : [];
    this.exprFn = isSpec && spec.expr ? spec.expr : null;
    this.value = isSpec ? (this.keys.length ? this.keys[0].v : this.exprFn(0)) : spec;
    this.isSpatial = spatial;
    this.dimensionsSeparated = separated;
    this.canSetExpression = true;
    this.expressionEnabled = !!this.exprFn;
    this.expression = this.exprFn ? '/* mock */' : '';
    this.enabled = true;
    this.propertyType = 6812; // PropertyType.PROPERTY
    // AE: true once edited, keyframed or given an expression.
    this.isModified = modified || this.keys.length > 0 || !!this.exprFn;
  }
  get numKeys() { return this.keys.length; }
  key(i) { return this.keys[i - 1]; }
  keyTime(i) { return this.key(i).t; }
  keyValue(i) { return this.key(i).v; }
  keyInInterpolationType(i) { return KeyframeInterpolationType[this.key(i).inType || 'LINEAR']; }
  keyOutInterpolationType(i) { return KeyframeInterpolationType[this.key(i).outType || 'LINEAR']; }
  // AE always reports eases, linear keyframes included.
  keyInTemporalEase(i) { return this.key(i).easeIn || [new KeyframeEase(0, 16.666667)]; }
  keyOutTemporalEase(i) { return this.key(i).easeOut || [new KeyframeEase(0, 16.666667)]; }
  keyInSpatialTangent(i) { return this.key(i).spatialIn || [0, 0, 0]; }
  keyOutSpatialTangent(i) { return this.key(i).spatialOut || [0, 0, 0]; }
  valueAtTime(t) { return this.exprFn ? this.exprFn(t) : this.value; }
}

export class PropertyGroup {
  constructor(matchName, name, children = []) {
    this.matchName = matchName;
    this.name = name;
    this.children = children;
    this.enabled = true;
    this.propertyType = 6814; // PropertyType.NAMED_GROUP
  }
  get numProperties() { return this.children.length; }
  property(x) {
    if (typeof x === 'number') return this.children[x - 1] || null;
    return this.children.find(c => c.matchName === x || c.name === x) || null;
  }
}

export class Layer {
  constructor(props) {
    Object.assign(this, {
      enabled: true, guideLayer: false, parent: null, inPoint: 0, outPoint: 0, threeDLayer: false,
      blendingMode: BlendingMode.NORMAL, trackMatteType: TrackMatteType.NO_TRACK_MATTE,
      timeRemapEnabled: false, nullLayer: false, adjustmentLayer: false, source: null, groups: {},
      autoOrient: AutoOrientType.NO_AUTO_ORIENT, isTrackMatte: false, trackMatteLayer: null,
      locked: false, shy: false, selected: false, motionBlur: false, stretch: 100, label: 1, comment: '',
    }, props);
  }
  property(matchName) { return this.groups[matchName] || null; }
}
export class AVLayer extends Layer {}
export class ShapeLayer extends AVLayer {}
export class TextLayer extends AVLayer {}
export class CameraLayer extends Layer {}
export class LightLayer extends Layer {}
export class SolidSource {}
export class FileSource {}

// file: { name }; shapes: the shape contents "Create Shapes from Vector Layer" makes from it.
export class FootageItem {
  constructor(props) { Object.assign(this, { footageMissing: false, mainSource: new FileSource(), shapes: [] }, props); }
}

export const PropertyType = { PROPERTY: 6812, INDEXED_GROUP: 6813, NAMED_GROUP: 6814 };

let currentApp = null; // the app of the last loadHost, for openInViewer

// Layers in a comp built from these keep `index` in sync with their position.
const LAYER_METHODS = {
  setTrackMatte(matte, type) {
    this.trackMatteLayer = matte;
    this.trackMatteType = type;
    matte.isTrackMatte = true;
    matte.enabled = false; // AE switches a matte layer off
  },
  setParentWithJump(parent) { this.parent = parent; },
  remove() { this.comp.layers.splice(this.comp.layers.indexOf(this), 1); this.comp.reindex(); },
};
Object.assign(Layer.prototype, LAYER_METHODS);

export class CompItem {
  constructor(props) { Object.assign(this, { layers: [] }, props); }
  get numLayers() { return this.layers.length; }
  layer(i) { return this.layers[i - 1]; }
  reindex() { this.layers.forEach((l, i) => { l.index = i + 1; l.comp = this; }); }
  openInViewer() { if (currentApp) currentApp.project.activeItem = this; }
  remove() { if (currentApp) currentApp.project.removed.push(this); }
  // Layers are copied shallowly; parents and mattes point into the copy.
  duplicate() {
    const copy = new CompItem({ ...this, id: this.id + 1000, layers: [] });
    copy.layers = this.layers.map(l => Object.assign(Object.create(Object.getPrototypeOf(l)), l));
    const map = new Map(this.layers.map((l, i) => [l, copy.layers[i]]));
    for (const l of copy.layers) {
      if (l.parent) l.parent = map.get(l.parent);
      if (l.trackMatteLayer) l.trackMatteLayer = map.get(l.trackMatteLayer);
    }
    copy.reindex();
    if (currentApp) currentApp.project.items.push(copy);
    return copy;
  }
}

// AE's Create Shapes from Vector Layer (3973) / from Text (3781) on the
// selected layers, as verified in AE 2026: a "<name> Outlines" shape layer
// goes directly above the original with its transform, parent, timing, time
// stretch, effects and masks; the original is switched off. Blend mode, motion
// blur and the track matte are not copied; children and matted layers keep
// pointing at the original.
function createShapes(comp, command) {
  for (const layer of comp.layers.filter(l => l.selected)) {
    const vector = layer.source instanceof FootageItem && /\.(ai|eps|pdf)$/i.test(layer.source.file.name);
    if (command === 3973 ? !vector || layer.source.footageMissing : !(layer instanceof TextLayer)) continue;
    const contents = command === 3973 ? layer.source.shapes : [G('ADBE Vector Group', 'T', [])];
    const shape = new ShapeLayer({
      name: `${layer.name} Outlines`, parent: layer.parent, inPoint: layer.inPoint, outPoint: layer.outPoint,
      stretch: layer.stretch, selected: true, label: 8,
      groups: {
        'ADBE Transform Group': layer.groups['ADBE Transform Group'],
        'ADBE Root Vectors Group': G('ADBE Root Vectors Group', 'Contents', contents),
        'ADBE Effect Parade': layer.groups['ADBE Effect Parade'] || G('ADBE Effect Parade', 'Effects', []),
        'ADBE Mask Parade': layer.groups['ADBE Mask Parade'] || G('ADBE Mask Parade', 'Masks', []),
      },
    });
    comp.layers.splice(comp.layers.indexOf(layer), 0, shape);
    layer.enabled = false;
    layer.selected = false;
  }
  comp.reindex();
}

// --- builders ---

const P = (mn, name, spec, opts) => new Property(mn, name, spec, opts);
const G = (mn, name, children) => new PropertyGroup(mn, name, children);

export function layerTransform({ anchor = [0, 0, 0], position = [0, 0, 0], x, y, scale = [100, 100, 100], rotation = 0, opacity = 100 } = {}) {
  const separated = x !== undefined;
  return G('ADBE Transform Group', 'Transform', [
    P('ADBE Anchor Point', 'Anchor Point', anchor, { spatial: true }),
    P('ADBE Position', 'Position', position, { spatial: true, separated }),
    P('ADBE Position_0', 'X Position', x ?? 0),
    P('ADBE Position_1', 'Y Position', y ?? 0),
    P('ADBE Scale', 'Scale', scale),
    P('ADBE Rotate Z', 'Rotation', rotation),
    P('ADBE Opacity', 'Opacity', opacity),
  ]);
}

export function group(name, items, { position = [0, 0], rotation = 0, opacity = 100 } = {}) {
  return G('ADBE Vector Group', name, [
    G('ADBE Vectors Group', 'Contents', items),
    G('ADBE Vector Transform Group', 'Transform', [
      P('ADBE Vector Anchor', 'Anchor Point', [0, 0], { spatial: true }),
      P('ADBE Vector Position', 'Position', position, { spatial: true }),
      P('ADBE Vector Scale', 'Scale', [100, 100]),
      P('ADBE Vector Skew', 'Skew', 0),
      P('ADBE Vector Rotation', 'Rotation', rotation),
      P('ADBE Vector Group Opacity', 'Opacity', opacity),
    ]),
    G('ADBE Vector Materials Group', 'Material Options', []),
  ]);
}

export const rect = (name, size, roundness = 0, direction = 1) => G('ADBE Vector Shape - Rect', name, [
  P('ADBE Vector Shape Direction', 'Shape Direction', direction),
  P('ADBE Vector Rect Size', 'Size', size),
  P('ADBE Vector Rect Position', 'Position', [0, 0], { spatial: true }),
  P('ADBE Vector Rect Roundness', 'Roundness', roundness),
]);

export const ellipse = (name, size, direction = 1) => G('ADBE Vector Shape - Ellipse', name, [
  P('ADBE Vector Shape Direction', 'Shape Direction', direction),
  P('ADBE Vector Ellipse Size', 'Size', size),
  P('ADBE Vector Ellipse Position', 'Position', [0, 0], { spatial: true }),
]);

// Shape Direction: 1 and 2 draw as drawn, 3 reverses (AE 2026).
export const path = (name, spec, direction = 1) => G('ADBE Vector Shape - Group', name, [
  P('ADBE Vector Shape Direction', 'Shape Direction', direction),
  P('ADBE Vector Shape', 'Path', spec),
]);

export const fill = (name, color, opacity = 100, blend = 1) => G('ADBE Vector Graphic - Fill', name, [
  P('ADBE Vector Blend Mode', 'Blend Mode', blend),
  P('ADBE Vector Composite Order', 'Composite', 1),
  P('ADBE Vector Fill Rule', 'Fill Rule', 1),
  P('ADBE Vector Fill Color', 'Color', color),
  P('ADBE Vector Fill Opacity', 'Opacity', opacity),
]);

// Every stroke carries hidden Dash 1–3 / Gap 1–3 / Offset streams at 10 / 0;
// `dashes` sets (and marks modified) the first ones, e.g. [20, 10].
function strokeExtras(dashes = [], dashOffset, taper = {}) {
  const t = (name, label, key, fallback) => P(name, label, taper[key] ?? fallback, { modified: taper[key] !== undefined });
  const names = ['Dash 1', 'Gap 1', 'Dash 2', 'Gap 2', 'Dash 3', 'Gap 3'];
  return [
    G('ADBE Vector Stroke Dashes', 'Dashes', [
      ...names.map((n, i) => P(`ADBE Vector Stroke ${n}`, n.replace(' 1', ''), i < dashes.length ? dashes[i] : 10, { modified: i < dashes.length })),
      P('ADBE Vector Stroke Offset', 'Offset', dashOffset ?? 0, { modified: dashOffset !== undefined }),
    ]),
    G('ADBE Vector Stroke Taper', 'Taper', [
      t('ADBE Vector Taper Length Units', 'Length Units', 'units', 1),
      t('ADBE Vector Taper Start Length', 'Start Length', 'startLength', 0),
      t('ADBE Vector Taper End Length', 'End Length', 'endLength', 0),
      t('ADBE Vector Taper StartWidthPx', 'Start Length', 'startPx', 0),
      t('ADBE Vector Taper EndWidthPx', 'End Length', 'endPx', 0),
      t('ADBE Vector Taper Start Width', 'Start Width', 'startWidth', 0),
      t('ADBE Vector Taper End Width', 'End Width', 'endWidth', 0),
      t('ADBE Vector Taper Start Ease', 'Start Ease', 'startEase', 0),
      t('ADBE Vector Taper End Ease', 'End Ease', 'endEase', 0),
    ]),
    G('ADBE Vector Stroke Wave', 'Wave', [P('ADBE Vector Taper Wave Amount', 'Amount', 0)]),
  ];
}

export const stroke = (name, color, width, { cap = 1, join = 1, dashes, dashOffset, taper } = {}) => G('ADBE Vector Graphic - Stroke', name, [
  P('ADBE Vector Stroke Color', 'Color', color),
  P('ADBE Vector Stroke Opacity', 'Opacity', 100),
  P('ADBE Vector Stroke Width', 'Stroke Width', width),
  P('ADBE Vector Stroke Line Cap', 'Line Cap', cap),
  P('ADBE Vector Stroke Line Join', 'Line Join', join),
  P('ADBE Vector Stroke Miter Limit', 'Miter Limit', 4),
  ...strokeExtras(dashes, dashOffset, taper),
]);

// Gradient colors have no scriptable value; the extractor reads them from the project file.
export const gradientFill = (name, { type = 1, start = [0, -50], end = [0, 50], colorKeys = [] } = {}) => G('ADBE Vector Graphic - G-Fill', name, [
  P('ADBE Vector Fill Rule', 'Fill Rule', 1),
  P('ADBE Vector Grad Type', 'Type', type),
  P('ADBE Vector Grad Start Pt', 'Start Point', start, { spatial: true }),
  P('ADBE Vector Grad End Pt', 'End Point', end, { spatial: true }),
  P('ADBE Vector Grad HiLite Length', 'Highlight Length', 0),
  P('ADBE Vector Grad HiLite Angle', 'Highlight Angle', 0),
  P('ADBE Vector Grad Scale', 'Scale', [100, 100]),
  P('ADBE Vector Grad Rotation', 'Rotation', 0),
  P('ADBE Vector Grad Colors', 'Colors', colorKeys.length ? { keys: colorKeys.map(t => ({ t, v: undefined })) } : undefined),
  P('ADBE Vector Fill Opacity', 'Opacity', 100),
]);

export const repeater = (name, { copies = 3, offset = 0, order = 1, position = [50, 0], rotation = 0, scale = [100, 100], startOpacity = 100, endOpacity = 100 } = {}) =>
  G('ADBE Vector Filter - Repeater', name, [
    P('ADBE Vector Repeater Copies', 'Copies', copies),
    P('ADBE Vector Repeater Offset', 'Offset', offset),
    P('ADBE Vector Repeater Order', 'Composite', order),
    G('ADBE Vector Repeater Transform', 'Transform', [
      P('ADBE Vector Repeater Anchor', 'Anchor Point', [0, 0], { spatial: true }),
      P('ADBE Vector Repeater Position', 'Position', position, { spatial: true }),
      P('ADBE Vector Repeater Scale', 'Scale', scale),
      P('ADBE Vector Repeater Rotation', 'Rotation', rotation),
      P('ADBE Vector Repeater Opacity 1', 'Start Opacity', startOpacity),
      P('ADBE Vector Repeater Opacity 2', 'End Opacity', endOpacity),
    ]),
  ]);

export function mask(name, verts, { mode = MaskMode.ADD, inverted = false, feather = [0, 0], opacity = 100, expansion = 0 } = {}) {
  const atom = G('ADBE Mask Atom', name, [
    P('ADBE Mask Shape', 'Mask Path', new Shape({ vertices: verts })),
    P('ADBE Mask Feather', 'Mask Feather', feather),
    P('ADBE Mask Opacity', 'Mask Opacity', opacity),
    P('ADBE Mask Offset', 'Mask Expansion', expansion),
  ]);
  return Object.assign(atom, { maskMode: mode, inverted });
}

export const merge = (name, mode) => G('ADBE Vector Filter - Merge', name, [P('ADBE Vector Merge Type', 'Mode', mode)]);

export const trim = (name, { start = 0, end = 100, offset = 0, type = 1 } = {}) => G('ADBE Vector Filter - Trim', name, [
  P('ADBE Vector Trim Start', 'Start', start),
  P('ADBE Vector Trim End', 'End', end),
  P('ADBE Vector Trim Offset', 'Offset', offset),
  P('ADBE Vector Trim Type', 'Trim Multiple Shapes', type),
]);

export function shapeLayer(props, contents, { effects = 0, masks = [] } = {}) {
  return new ShapeLayer({
    ...props,
    groups: {
      'ADBE Transform Group': props.transform || layerTransform(),
      'ADBE Root Vectors Group': G('ADBE Root Vectors Group', 'Contents', contents),
      'ADBE Effect Parade': G('ADBE Effect Parade', 'Effects', Array.from({ length: effects }, (_, i) => G('ADBE Glo2', `Glow ${i + 1}`))),
      'ADBE Mask Parade': G('ADBE Mask Parade', 'Masks', masks),
    },
  });
}

export function plainLayer(Class, props) {
  return new Class({ ...props, groups: { 'ADBE Transform Group': props.transform || layerTransform() } });
}

// ExtendScript's File, enough for reading the project binary.
class MockFile {
  constructor(path) { this.fsName = path; this.encoding = 'UTF-8'; this.pos = 0; }
  get exists() { return existsSync(this.fsName); }
  get length() { return statSync(this.fsName).size; }
  open() { this.buf = readFileSync(this.fsName); return true; }
  seek(pos) { this.pos = pos; return true; }
  read(n) {
    const s = this.buf.toString(this.encoding === 'BINARY' ? 'latin1' : 'utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  close() { this.buf = null; return true; }
}

// Runs a host script against `activeItem` and returns its BetterLottie object.
// projectFile: path of a RIFX file standing in for the saved .aep.
// files: one host script or several, run in order (prepare.jsx after extract.jsx).
// The returned object also exposes the mock `app` as `.app`.
export function loadHost(files, activeItem, { projectFile = null, items = [] } = {}) {
  const settings = new Map();
  if (activeItem instanceof CompItem) activeItem.reindex();
  const app = {
    project: {
      activeItem,
      items: [activeItem, ...items],
      removed: [],
      file: projectFile ? new MockFile(projectFile) : null,
      dirty: false,
      itemByID: id => app.project.items.find(i => i && i.id === id) || null,
    },
    settings: {
      haveSetting: (s, k) => settings.has(`${s}/${k}`),
      getSetting: (s, k) => settings.get(`${s}/${k}`),
      saveSetting: (s, k, v) => settings.set(`${s}/${k}`, v),
    },
    undoGroups: [],
    beginUndoGroup: name => app.undoGroups.push(name),
    endUndoGroup: () => app.undoGroups.push('end'),
    executeCommand: id => createShapes(app.project.activeItem, id),
  };
  currentApp = app;
  const context = vm.createContext({
    app,
    File: MockFile,
    KeyframeInterpolationType, BlendingMode, TrackMatteType, AutoOrientType, MaskMode, Shape, PropertyType,
    CompItem, ShapeLayer, TextLayer, CameraLayer, LightLayer, SolidSource, FootageItem, FileSource,
  });
  for (const file of [].concat(files)) vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  return Object.assign(context.BetterLottie, { app });
}

// --- a minimal .aep (RIFX) for gradient colors ---

function rifxChunk(id, data) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}
const rifxList = (type, children) => rifxChunk('LIST', Buffer.concat([Buffer.from(type, 'latin1'), ...children]));

export function gradientXml(colors, alphas = [[0, 0.5, 1], [1, 0.5, 1]]) {
  const stop = (key, i, values) => `<prop.pair><key>Stop-${i}</key><prop.list><prop.pair><key>${key}</key><array>`
    + `<array.type><float/></array.type>${values.map(v => `<float>${v}</float>`).join('')}</array></prop.pair></prop.list></prop.pair>`;
  const section = (name, key, stops) => `<prop.pair><key>${name}</key><prop.list><prop.pair><key>Stops List</key><prop.list>`
    + stops.map((s, i) => stop(key, i, s)).join('') + `</prop.list></prop.pair><prop.pair><key>Stops Size</key>`
    + `<int type='unsigned' size='32'>${stops.length}</int></prop.pair></prop.list></prop.pair>`;
  return `<?xml version='1.0'?><prop.map version='4'><prop.list><prop.pair><key>Gradient Color Data</key><prop.list>`
    + section('Alpha Stops', 'Stops Alpha', alphas) + section('Color Stops', 'Stops Color', colors.map(c => [...c, 1]))
    + `</prop.list></prop.pair></prop.list></prop.map>`;
}

// comps: [{ id, layers: [[entry per gradient paint, …] per layer] }]; an entry
// is one XML string, an array of them (one per color keyframe), or null for
// a gradient whose colors were never edited (AE stores no Colors stream).
export function buildAep(comps) {
  const tdmn = name => { const b = Buffer.alloc(40); b.write(name, 'latin1'); return rifxChunk('tdmn', b); };
  const items = comps.map(({ id, layers }) => {
    const idta = Buffer.alloc(80);
    idta.writeUInt32BE(id, 16);
    return rifxList('Item', [
      rifxChunk('idta', idta),
      ...layers.map(grads => rifxList('Layr', [
        rifxChunk('Utf8', Buffer.from('layer')),
        rifxList('tdgp', [
          tdmn('ADBE Root Vectors Group'),
          rifxList('tdgp', grads.flatMap(entry => [
            tdmn('ADBE Vector Graphic - G-Fill'),
            rifxList('tdgp', [
              tdmn('ADBE Vector Grad Start Pt'), rifxList('tdbs', []),
              ...(entry == null ? [] : [
                tdmn('ADBE Vector Grad Colors'),
                rifxList('tdbs', [rifxList('GCky', [].concat(entry).map(xml => rifxChunk('Utf8', Buffer.from(xml))))]),
              ]),
            ]),
          ])),
        ]),
      ])),
    ]);
  });
  const body = Buffer.concat([Buffer.from('Egg!'), rifxChunk('head', Buffer.alloc(20)), rifxList('Fold', items)]);
  const head = Buffer.alloc(8);
  head.write('RIFX', 0, 'latin1');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
}
