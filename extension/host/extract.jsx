// better-lottie host script: reads the active comp into the IR (see src/ir.js)
// and saves files. Runs in ExtendScript, which is ES3: no JSON object, no
// Array.prototype.map/forEach/filter/indexOf, no let/const, no arrow functions.
// Kept thin on purpose: all conversion logic lives in src/.
//
// Every entry point returns a JSON string; failures come back as {"error": "..."}.

var BetterLottie = (function () {
  var IR_VERSION = 1;
  var SETTINGS_SECTION = 'better-lottie';

  // --- JSON (ExtendScript has none) ---

  function quote(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), code = s.charCodeAt(i);
      if (c === '"' || c === '\\') out += '\\' + c;
      else if (code < 0x20 || code === 0x2028 || code === 0x2029) out += '\\u' + ('000' + code.toString(16)).slice(-4);
      else out += c;
    }
    return out + '"';
  }

  function stringify(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return quote(v);
    var parts = [], i;
    if (Object.prototype.toString.call(v) === '[object Array]') {
      for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    for (var k in v) {
      if (v.hasOwnProperty(k) && v[k] !== undefined) parts.push(quote(k) + ':' + stringify(v[k]));
    }
    return '{' + parts.join(',') + '}';
  }

  // --- values and keyframes ---

  // AE values → plain JSON values. Shapes become { vertices, inTangents, outTangents, closed }.
  function plain(v) {
    if (v instanceof Shape) {
      return { vertices: v.vertices, inTangents: v.inTangents, outTangents: v.outTangents, closed: v.closed };
    }
    return v;
  }

  function interpName(type) {
    if (type === KeyframeInterpolationType.HOLD) return 'hold';
    if (type === KeyframeInterpolationType.BEZIER) return 'bezier';
    return 'linear';
  }

  function eases(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ speed: list[i].speed, influence: list[i].influence });
    return out;
  }

  function hasExpression(prop) {
    try { return prop.canSetExpression && prop.expressionEnabled && prop.expression !== ''; } catch (e) { return false; }
  }

  // Expressions can't be translated, so sample the result once per frame.
  // The converter simplifies the resulting linear runs.
  function bakeExpression(prop, ctx, where) {
    var fps = ctx.comp.frameRate, duration = ctx.comp.duration;
    var frames = Math.round(duration * fps);
    var kfs = [], first = null, changes = false;
    for (var f = 0; f <= frames; f++) {
      var t = Math.min(f / fps, duration);
      var v = plain(prop.valueAtTime(t, false));
      var s = stringify(v);
      if (first === null) first = s; else if (s !== first) changes = true;
      kfs.push({ t: t, v: v });
    }
    if (!changes) return { value: kfs[0].v };
    ctx.warn(where, 'expression baked to one keyframe per frame');
    return { keyframes: kfs };
  }

  function readProp(prop, ctx, where) {
    if (!prop) return undefined;
    if (hasExpression(prop)) return bakeExpression(prop, ctx, where);
    if (prop.numKeys < 2) return { value: plain(prop.numKeys ? prop.keyValue(1) : prop.value) };
    var kfs = [];
    for (var k = 1; k <= prop.numKeys; k++) {
      var kf = {
        t: prop.keyTime(k),
        v: plain(prop.keyValue(k)),
        inType: interpName(prop.keyInInterpolationType(k)),
        outType: interpName(prop.keyOutInterpolationType(k))
      };
      try {
        kf.easeIn = eases(prop.keyInTemporalEase(k));
        kf.easeOut = eases(prop.keyOutTemporalEase(k));
      } catch (e) { /* no temporal ease on this property type */ }
      if (prop.isSpatial) {
        try {
          kf.spatialIn = prop.keyInSpatialTangent(k);
          kf.spatialOut = prop.keyOutSpatialTangent(k);
        } catch (e2) { /* not spatial after all */ }
      }
      kfs.push(kf);
    }
    return { keyframes: kfs };
  }

  // --- transforms ---

  var LAYER_TRANSFORM = {
    anchor: 'ADBE Anchor Point', position: 'ADBE Position', scale: 'ADBE Scale',
    rotation: 'ADBE Rotate Z', opacity: 'ADBE Opacity'
  };
  var GROUP_TRANSFORM = {
    anchor: 'ADBE Vector Anchor', position: 'ADBE Vector Position', scale: 'ADBE Vector Scale',
    rotation: 'ADBE Vector Rotation', opacity: 'ADBE Vector Group Opacity', skew: 'ADBE Vector Skew'
  };

  function readTransform(group, names, ctx, where) {
    var tr = {};
    if (!group) return tr;
    for (var key in names) {
      if (!names.hasOwnProperty(key)) continue;
      var p = group.property(names[key]);
      if (p) tr[key] = readProp(p, ctx, where + ' > ' + p.name);
    }
    var pos = group.property('ADBE Position');
    if (pos && pos.dimensionsSeparated) {
      tr.position = {
        separated: true,
        x: readProp(group.property('ADBE Position_0'), ctx, where + ' > X Position'),
        y: readProp(group.property('ADBE Position_1'), ctx, where + ' > Y Position')
      };
    }
    return tr;
  }

  // --- shape contents ---

  var ITEM_TYPES = {
    'ADBE Vector Group': 'group',
    'ADBE Vector Shape - Group': 'path',
    'ADBE Vector Shape - Rect': 'rect',
    'ADBE Vector Shape - Ellipse': 'ellipse',
    'ADBE Vector Shape - Star': 'polystar',
    'ADBE Vector Graphic - Fill': 'fill',
    'ADBE Vector Graphic - Stroke': 'stroke',
    'ADBE Vector Graphic - G-Fill': 'gradient-fill',
    'ADBE Vector Graphic - G-Stroke': 'gradient-stroke',
    'ADBE Vector Filter - Trim': 'trim',
    'ADBE Vector Filter - Merge': 'merge-paths',
    'ADBE Vector Filter - Repeater': 'repeater',
    'ADBE Vector Filter - Offset': 'offset-paths',
    'ADBE Vector Filter - RC': 'round-corners',
    'ADBE Vector Filter - PB': 'pucker-bloat',
    'ADBE Vector Filter - Twist': 'twist',
    'ADBE Vector Filter - Wiggler': 'wiggle-paths',
    'ADBE Vector Filter - Zigzag': 'zig-zag'
  };
  // Present on every shape group but irrelevant to 2D output.
  var IGNORED_ITEMS = { 'ADBE Vector Materials Group': true };
  var LINE_CAPS = { 1: 'butt', 2: 'round', 3: 'square' };
  var LINE_JOINS = { 1: 'miter', 2: 'round', 3: 'bevel' };
  var MERGE_MODES = { 1: 'merge', 2: 'add', 3: 'subtract', 4: 'intersect', 5: 'exclude' };

  function value(group, matchName) {
    var p = group.property(matchName);
    return p ? p.value : undefined;
  }

  // Changed from its default: edited, keyframed or driven by an expression.
  function modified(p) {
    try { return p.isModified || p.numKeys > 0 || hasExpression(p); } catch (e) { return false; }
  }

  function anyModified(group) {
    if (!group) return false;
    for (var i = 1; i <= group.numProperties; i++) {
      if (modified(group.property(i))) return true;
    }
    return false;
  }

  // Every stroke has hidden Dash 1–3, Gap 1–3 and Offset streams with default
  // values, all reporting enabled. Only modified ones are in use; the pattern
  // runs up to the last modified dash or gap.
  function readDashes(stroke, it, ctx, where) {
    var group = stroke.property('ADBE Vector Stroke Dashes');
    if (!group) return;
    var list = [], last = -1, offset = null;
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.matchName.indexOf('ADBE Vector Stroke Offset') === 0) { offset = p; continue; }
      list.push({ type: p.matchName.indexOf('ADBE Vector Stroke Gap') === 0 ? 'gap' : 'dash', prop: p });
      if (modified(p)) last = list.length - 1;
    }
    if (last < 0) return;
    it.dashes = [];
    for (var j = 0; j <= last; j++) {
      it.dashes.push({ type: list[j].type, value: readProp(list[j].prop, ctx, where + ' > ' + list[j].prop.name) });
    }
    if (offset) it.dashOffset = readProp(offset, ctx, where + ' > Offset');
  }

  // Shared by Stroke and Gradient Stroke.
  function readStroke(p, it, ctx, w) {
    it.opacity = readProp(p.property('ADBE Vector Stroke Opacity'), ctx, w + ' > Opacity');
    it.width = readProp(p.property('ADBE Vector Stroke Width'), ctx, w + ' > Stroke Width');
    it.lineCap = LINE_CAPS[value(p, 'ADBE Vector Stroke Line Cap')] || 'butt';
    it.lineJoin = LINE_JOINS[value(p, 'ADBE Vector Stroke Line Join')] || 'miter';
    it.miterLimit = value(p, 'ADBE Vector Stroke Miter Limit');
    readDashes(p, it, ctx, w);
    if (anyModified(p.property('ADBE Vector Stroke Taper')) || anyModified(p.property('ADBE Vector Stroke Wave'))) it.taper = true;
  }

  // Shared by Gradient Fill and Gradient Stroke. Colors come from the project
  // file (see readProjectGradients), matched by order within the layer.
  function readGradient(p, it, ctx, w) {
    it.gradientType = value(p, 'ADBE Vector Grad Type') === 2 ? 'radial' : 'linear';
    it.startPoint = readProp(p.property('ADBE Vector Grad Start Pt'), ctx, w + ' > Start Point');
    it.endPoint = readProp(p.property('ADBE Vector Grad End Pt'), ctx, w + ' > End Point');
    it.highlightLength = readProp(p.property('ADBE Vector Grad HiLite Length'), ctx, w + ' > Highlight Length');
    it.highlightAngle = readProp(p.property('ADBE Vector Grad HiLite Angle'), ctx, w + ' > Highlight Angle');
    if (modified(p.property('ADBE Vector Grad Scale')) || modified(p.property('ADBE Vector Grad Rotation'))) it.gradientTransform = true;
    var colors = p.property('ADBE Vector Grad Colors');
    if (colors && colors.numKeys > 0) ctx.warn(w, 'animated gradient colors are exported with the first keyframe\'s colors');
    var blobs = ctx.layerGradients ? ctx.layerGradients[ctx.gradientIndex] : null;
    ctx.gradientIndex++;
    it.stops = blobs && blobs.length ? parseGradient(blobs[0]) : null;
    ctx.gradientItems.push(it);
  }

  function readContents(vectors, ctx, where) {
    var items = [];
    if (!vectors) return items;
    for (var i = 1; i <= vectors.numProperties; i++) {
      var p = vectors.property(i);
      if (IGNORED_ITEMS[p.matchName]) continue;
      var type = ITEM_TYPES[p.matchName] || p.matchName;
      var w = where + ' > ' + p.name;
      var it = { type: type, name: p.name };
      if (p.enabled === false) it.enabled = false;
      switch (type) {
        case 'group':
          it.transform = readTransform(p.property('ADBE Vector Transform Group'), GROUP_TRANSFORM, ctx, w);
          it.contents = readContents(p.property('ADBE Vectors Group'), ctx, w);
          break;
        case 'path':
          it.path = readProp(p.property('ADBE Vector Shape'), ctx, w);
          break;
        case 'rect':
          it.size = readProp(p.property('ADBE Vector Rect Size'), ctx, w + ' > Size');
          it.position = readProp(p.property('ADBE Vector Rect Position'), ctx, w + ' > Position');
          it.roundness = readProp(p.property('ADBE Vector Rect Roundness'), ctx, w + ' > Roundness');
          break;
        case 'ellipse':
          it.size = readProp(p.property('ADBE Vector Ellipse Size'), ctx, w + ' > Size');
          it.position = readProp(p.property('ADBE Vector Ellipse Position'), ctx, w + ' > Position');
          break;
        case 'fill':
          it.color = readProp(p.property('ADBE Vector Fill Color'), ctx, w + ' > Color');
          it.opacity = readProp(p.property('ADBE Vector Fill Opacity'), ctx, w + ' > Opacity');
          it.fillRule = value(p, 'ADBE Vector Fill Rule') === 2 ? 'evenodd' : 'nonzero';
          break;
        case 'stroke':
          it.color = readProp(p.property('ADBE Vector Stroke Color'), ctx, w + ' > Color');
          readStroke(p, it, ctx, w);
          break;
        case 'gradient-fill':
          readGradient(p, it, ctx, w);
          it.opacity = readProp(p.property('ADBE Vector Fill Opacity'), ctx, w + ' > Opacity');
          it.fillRule = value(p, 'ADBE Vector Fill Rule') === 2 ? 'evenodd' : 'nonzero';
          break;
        case 'gradient-stroke':
          readGradient(p, it, ctx, w);
          readStroke(p, it, ctx, w);
          break;
        case 'trim':
          it.start = readProp(p.property('ADBE Vector Trim Start'), ctx, w + ' > Start');
          it.end = readProp(p.property('ADBE Vector Trim End'), ctx, w + ' > End');
          it.offset = readProp(p.property('ADBE Vector Trim Offset'), ctx, w + ' > Offset');
          it.mode = value(p, 'ADBE Vector Trim Type') === 2 ? 'individually' : 'simultaneously';
          break;
        case 'merge-paths':
          it.mode = MERGE_MODES[value(p, 'ADBE Vector Merge Type')] || 'add';
          break;
        default:
          // Unsupported: the converter reports it by type.
          break;
      }
      items.push(it);
    }
    return items;
  }

  // --- layers ---

  var BLEND_NAMES = ['NORMAL', 'MULTIPLY', 'SCREEN', 'ADD', 'OVERLAY', 'DARKEN', 'LIGHTEN', 'SOFT_LIGHT',
    'HARD_LIGHT', 'COLOR_DODGE', 'COLOR_BURN', 'DIFFERENCE', 'EXCLUSION', 'HUE', 'SATURATION', 'COLOR',
    'LUMINOSITY', 'DISSOLVE'];

  function blendName(mode) {
    for (var i = 0; i < BLEND_NAMES.length; i++) {
      if (BlendingMode[BLEND_NAMES[i]] === mode) return BLEND_NAMES[i].toLowerCase().replace(/_/g, '-');
    }
    return 'other';
  }

  function layerType(layer) {
    if (layer instanceof ShapeLayer) return 'shape';
    if (layer instanceof TextLayer) return 'text';
    if (layer instanceof CameraLayer) return 'camera';
    if (layer instanceof LightLayer) return 'light';
    if (layer.nullLayer) return 'null';
    if (layer.adjustmentLayer) return 'adjustment';
    if (layer.source instanceof CompItem) return 'precomp';
    if (layer.source && layer.source.mainSource instanceof SolidSource) return 'solid';
    return 'footage';
  }

  function readLayer(layer, ctx) {
    var where = 'layer "' + layer.name + '"';
    var L = {
      id: layer.index,
      name: layer.name,
      type: layerType(layer),
      inPoint: layer.inPoint,
      outPoint: layer.outPoint
    };
    if (!layer.enabled || layer.guideLayer) L.enabled = false;
    if (layer.parent) L.parent = layer.parent.index;
    if (L.type === 'camera' || L.type === 'light') return L;
    // Hidden layers still pass their transform to children, so read it anyway.
    L.transform = readTransform(layer.property('ADBE Transform Group'), LAYER_TRANSFORM, ctx, where);
    try {
      if (layer.autoOrient === AutoOrientType.ALONG_PATH) L.transform.autoOrient = true;
      else if (layer.autoOrient !== AutoOrientType.NO_AUTO_ORIENT) ctx.warn(where, 'auto-orient towards camera is not supported (ignored)');
    } catch (e0) { /* layer type without auto-orient */ }
    if (L.enabled === false) return L;

    try { if (layer.threeDLayer) L.threeD = true; } catch (e1) {}
    try { if (layer.blendingMode !== BlendingMode.NORMAL) L.blendMode = blendName(layer.blendingMode); } catch (e2) {}
    try { if (layer.trackMatteType !== TrackMatteType.NO_TRACK_MATTE) L.trackMatte = true; } catch (e3) {}
    try { if (layer.timeRemapEnabled) ctx.warn(where, 'time remapping is not supported (ignored)'); } catch (e4) {}
    try {
      var fx = layer.property('ADBE Effect Parade');
      if (fx && fx.numProperties) ctx.warn(where, 'effects are not supported (ignored)');
      var masks = layer.property('ADBE Mask Parade');
      if (masks && masks.numProperties) ctx.warn(where, 'masks are not supported yet (ignored)');
    } catch (e5) {}

    if (L.type === 'shape') {
      var gradients = ctx.projectGradients();
      ctx.layerGradients = gradients ? gradients[layer.index] || [] : null;
      ctx.gradientIndex = 0;
      ctx.gradientItems = [];
      L.contents = readContents(layer.property('ADBE Root Vectors Group'), ctx, where);
      // Colors are matched by order; if the counts disagree, trust none of them.
      if (ctx.layerGradients && ctx.gradientItems.length && ctx.layerGradients.length !== ctx.gradientItems.length) {
        ctx.warn(where, 'gradient colors could not be matched to the saved project (save and export again)');
        for (var g = 0; g < ctx.gradientItems.length; g++) ctx.gradientItems[g].stops = null;
      }
    }
    return L;
  }

  // --- gradient colors from the saved project file ---
  //
  // Scripting can't read gradient colors (the Colors property has no value).
  // The .aep file is RIFX: big-endian chunks of [id:4][size:4][data, padded
  // to even]; LIST chunks start their data with a 4-byte list type. Gradient
  // colors are XML in LIST 'GCky' > 'Utf8', inside the property data that
  // follows the 'tdmn' chunk naming 'ADBE Vector Grad Colors'. A comp is a
  // LIST 'Item' (id at offset 16 of its 'idta'); its layers are LIST 'Layr'
  // children in timeline order.
  //
  function hasGradients(comp) {
    function search(group) {
      for (var i = 1; i <= group.numProperties; i++) {
        var p = group.property(i);
        if (p.matchName === 'ADBE Vector Graphic - G-Fill' || p.matchName === 'ADBE Vector Graphic - G-Stroke') return true;
        if (p.matchName === 'ADBE Vector Group' && search(p.property('ADBE Vectors Group'))) return true;
      }
      return false;
    }
    for (var l = 1; l <= comp.numLayers; l++) {
      var layer = comp.layer(l);
      if (layer instanceof ShapeLayer && search(layer.property('ADBE Root Vectors Group'))) return true;
    }
    return false;
  }

  // Returns { layerIndex: [[xml, …] per gradient property, in order] } or null.
  function readProjectGradients(comp, ctx) {
    var saved = app.project.file;
    if (!saved || !saved.exists) {
      ctx.warn('project', 'save the project to export gradient colors');
      return null;
    }
    try {
      if (app.project.dirty) ctx.warn('project', 'unsaved changes: gradient colors come from the last saved version');
    } catch (e) { /* older AE: no dirty flag */ }
    var f = new File(saved.fsName);
    f.encoding = 'BINARY';
    if (!f.open('r')) {
      ctx.warn('project', 'could not read the project file for gradient colors');
      return null;
    }
    try {
      if (readAt(f, 0, 4) !== 'RIFX') return null;
      var item = findItem(f, 12, f.length, comp.id);
      if (!item) return null;
      var layers = {}, index = 0;
      eachChunk(f, item.start, item.end, function (id, body, size) {
        if (id === 'LIST' && readAt(f, body, 4) === 'Layr') {
          index++;
          layers[index] = [];
          collectGradients(f, body + 4, body + size, layers[index]);
        }
        return true;
      });
      return layers;
    } finally {
      f.close();
    }
  }

  function readAt(f, pos, n) {
    f.seek(pos);
    return f.read(n);
  }

  function u32(f) {
    var s = f.read(4);
    return s.charCodeAt(0) * 16777216 + (s.charCodeAt(1) << 16) + (s.charCodeAt(2) << 8) + s.charCodeAt(3);
  }

  // Calls fn(id, dataStart, size) per chunk in [start, end); stop on false.
  function eachChunk(f, start, end, fn) {
    var pos = start;
    while (pos + 8 <= end) {
      f.seek(pos);
      var id = f.read(4);
      var size = u32(f);
      if (fn(id, pos + 8, size) === false) return;
      pos += 8 + size + (size % 2);
    }
  }

  var ITEM_CONTAINERS = { Fold: true, Item: true, Sfdr: true };

  function findItem(f, start, end, compId) {
    var found = null;
    eachChunk(f, start, end, function (id, body, size) {
      if (id !== 'LIST') return true;
      var type = readAt(f, body, 4);
      if (type === 'Item' && itemId(f, body + 4, body + size) === compId) {
        found = { start: body + 4, end: body + size };
        return false;
      }
      if (ITEM_CONTAINERS[type]) found = findItem(f, body + 4, body + size, compId);
      return !found;
    });
    return found;
  }

  function itemId(f, start, end) {
    var id = -1;
    eachChunk(f, start, end, function (cid, body) {
      if (cid !== 'idta') return true;
      f.seek(body + 16);
      id = u32(f);
      return false;
    });
    return id;
  }

  function collectGradients(f, start, end, out) {
    var lastName = '';
    eachChunk(f, start, end, function (id, body, size) {
      if (id === 'tdmn') {
        var raw = readAt(f, body, size), nul = raw.indexOf(String.fromCharCode(0));
        lastName = nul < 0 ? raw : raw.substring(0, nul);
      } else if (id === 'LIST') {
        if (lastName === 'ADBE Vector Grad Colors') {
          var blobs = [];
          collectXml(f, body + 4, body + size, blobs);
          out.push(blobs);
        } else {
          collectGradients(f, body + 4, body + size, out);
        }
        lastName = '';
      }
      return true;
    });
  }

  function collectXml(f, start, end, out) {
    eachChunk(f, start, end, function (id, body, size) {
      if (id !== 'LIST') return true;
      if (readAt(f, body, 4) === 'GCky') {
        eachChunk(f, body + 4, body + size, function (cid, b, s) {
          if (cid !== 'Utf8') return true;
          out.push(readAt(f, b, s));
          return false;
        });
      } else {
        collectXml(f, body + 4, body + size, out);
      }
      return true;
    });
  }

  // <key>Color Stops</key> … <key>Stop-N</key> … <float>offset</float><float>midpoint</float><float>r</float>…
  function parseStops(xml, key, count) {
    var start = xml.indexOf('<key>' + key + '</key>');
    if (start < 0) return [];
    var end = xml.indexOf('<key>Stops Size</key>', start);
    if (end < 0) end = xml.length;
    var size = xml.substring(end).match(/<int[^>]*>(\d+)<\/int>/);
    var limit = size ? parseInt(size[1], 10) : 1000;
    var parts = xml.substring(start, end).split('<key>Stop-');
    var stops = [];
    for (var i = 1; i < parts.length && stops.length < limit; i++) {
      var floats = parts[i].match(/<float>[^<]*<\/float>/g) || [];
      var v = [];
      for (var j = 0; j < floats.length && j < 2 + count; j++) v.push(parseFloat(floats[j].replace(/<\/?float>/g, '')));
      if (v.length === 2 + count) stops.push(v);
    }
    return stops;
  }

  function parseGradient(xml) {
    return { colors: parseStops(xml, 'Color Stops', 3), alphas: parseStops(xml, 'Alpha Stops', 1) };
  }

  // --- entry points ---

  function guard(fn) {
    try {
      return fn();
    } catch (e) {
      return stringify({ error: String(e) + (e.line ? ' (extract.jsx line ' + e.line + ')' : '') });
    }
  }

  function extractActiveComp() {
    return guard(function () {
      var comp = app.project && app.project.activeItem;
      if (!(comp instanceof CompItem)) return stringify({ error: 'Open or select a composition first.' });
      return extract(comp);
    });
  }

  // For tooling and debugging: extract a comp that isn't open.
  function extractCompById(id) {
    return guard(function () {
      var comp = app.project.itemByID(id);
      if (!(comp instanceof CompItem)) return stringify({ error: 'No composition with id ' + id + '.' });
      return extract(comp);
    });
  }

  function extract(comp) {
    var warnings = [];
    var gradients;
    var ctx = {
      comp: comp,
      warn: function (where, msg) { warnings.push(where + ': ' + msg); },
      // Read the project file once, and only if some layer needs it.
      projectGradients: function () {
        if (gradients === undefined) gradients = hasGradients(comp) ? readProjectGradients(comp, ctx) : null;
        return gradients;
      }
    };
    var layers = [];
    for (var i = 1; i <= comp.numLayers; i++) layers.push(readLayer(comp.layer(i), ctx));
    return stringify({
      version: IR_VERSION,
      comp: {
        name: comp.name,
        width: comp.width,
        height: comp.height,
        duration: comp.duration,
        frameRate: comp.frameRate,
        background: comp.bgColor
      },
      layers: layers,
      warnings: warnings
    });
  }

  // Shows a save dialog (remembering the last folder) and writes UTF-8 text.
  // Returns {"path": "..."} or {"cancelled": true}.
  function saveText(text, defaultName) {
    return guard(function () {
      var folder = Folder.desktop.fsName;
      if (app.settings.haveSetting(SETTINGS_SECTION, 'lastFolder')) {
        var saved = app.settings.getSetting(SETTINGS_SECTION, 'lastFolder');
        if (Folder(saved).exists) folder = saved;
      }
      var target = new File(folder + '/' + defaultName).saveDlg('Save ' + defaultName);
      if (!target) return stringify({ cancelled: true });
      target.encoding = 'UTF-8';
      target.lineFeed = 'Unix';
      if (!target.open('w')) return stringify({ error: 'Could not write ' + target.fsName });
      target.write(text);
      target.close();
      app.settings.saveSetting(SETTINGS_SECTION, 'lastFolder', target.parent.fsName);
      return stringify({ path: target.fsName });
    });
  }

  return {
    extractActiveComp: extractActiveComp,
    extractCompById: extractCompById,
    saveText: saveText,
    stringify: stringify
  };
}());
