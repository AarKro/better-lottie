// A small stand-in for the After Effects scripting DOM: just enough of it to
// run extension/host/extract.jsx in Node. Match names and enum shapes follow
// the AE scripting guide. Behaviour here is an assumption about AE, so verify
// against the real thing (Save IR…) when something looks off.

import vm from 'node:vm';
import { readFileSync } from 'node:fs';

export const KeyframeInterpolationType = { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 };
export const BlendingMode = { NORMAL: 5212, MULTIPLY: 5213, SCREEN: 5214, ADD: 5215, OVERLAY: 5216 };
export const TrackMatteType = { NO_TRACK_MATTE: 5012, ALPHA: 5013 };

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
  constructor(matchName, name, spec, { spatial = false, separated = false } = {}) {
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

export class CompItem {
  constructor(props) { Object.assign(this, { layers: [] }, props); }
  get numLayers() { return this.layers.length; }
  layer(i) { return this.layers[i - 1]; }
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

export const rect = (name, size, roundness = 0) => G('ADBE Vector Shape - Rect', name, [
  P('ADBE Vector Rect Size', 'Size', size),
  P('ADBE Vector Rect Position', 'Position', [0, 0], { spatial: true }),
  P('ADBE Vector Rect Roundness', 'Roundness', roundness),
]);

export const ellipse = (name, size) => G('ADBE Vector Shape - Ellipse', name, [
  P('ADBE Vector Ellipse Size', 'Size', size),
  P('ADBE Vector Ellipse Position', 'Position', [0, 0], { spatial: true }),
]);

export const path = (name, spec) => G('ADBE Vector Shape - Group', name, [P('ADBE Vector Shape', 'Path', spec)]);

export const fill = (name, color, opacity = 100) => G('ADBE Vector Graphic - Fill', name, [
  P('ADBE Vector Composite Order', 'Composite', 1),
  P('ADBE Vector Fill Rule', 'Fill Rule', 1),
  P('ADBE Vector Fill Color', 'Color', color),
  P('ADBE Vector Fill Opacity', 'Opacity', opacity),
]);

export const stroke = (name, color, width, { cap = 1, join = 1 } = {}) => G('ADBE Vector Graphic - Stroke', name, [
  P('ADBE Vector Stroke Color', 'Color', color),
  P('ADBE Vector Stroke Opacity', 'Opacity', 100),
  P('ADBE Vector Stroke Width', 'Stroke Width', width),
  P('ADBE Vector Stroke Line Cap', 'Line Cap', cap),
  P('ADBE Vector Stroke Line Join', 'Line Join', join),
  P('ADBE Vector Stroke Miter Limit', 'Miter Limit', 4),
  G('ADBE Vector Stroke Dashes', 'Dashes', []),
]);

export const trim = name => G('ADBE Vector Filter - Trim', name, [P('ADBE Vector Trim Start', 'Start', 0)]);

export function shapeLayer(props, contents, { effects = 0 } = {}) {
  return new ShapeLayer({
    ...props,
    groups: {
      'ADBE Transform Group': props.transform || layerTransform(),
      'ADBE Root Vectors Group': G('ADBE Root Vectors Group', 'Contents', contents),
      'ADBE Effect Parade': G('ADBE Effect Parade', 'Effects', Array.from({ length: effects }, (_, i) => G('ADBE Glo2', `Glow ${i + 1}`))),
      'ADBE Mask Parade': G('ADBE Mask Parade', 'Masks', []),
    },
  });
}

export function plainLayer(Class, props) {
  return new Class({ ...props, groups: { 'ADBE Transform Group': props.transform || layerTransform() } });
}

// Runs a host script against `activeItem` and returns its BetterLottie object.
export function loadHost(file, activeItem) {
  const settings = new Map();
  const context = vm.createContext({
    app: {
      project: { activeItem },
      settings: {
        haveSetting: (s, k) => settings.has(`${s}/${k}`),
        getSetting: (s, k) => settings.get(`${s}/${k}`),
        saveSetting: (s, k, v) => settings.set(`${s}/${k}`, v),
      },
    },
    KeyframeInterpolationType, BlendingMode, TrackMatteType, Shape,
    CompItem, ShapeLayer, TextLayer, CameraLayer, LightLayer, SolidSource,
  });
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  return context.BetterLottie;
}
