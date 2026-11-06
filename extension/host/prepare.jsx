// better-lottie "Prepare comp": duplicates the active comp and, in the copy,
// turns the layers the converter can't read (Illustrator/EPS/PDF footage and
// text) into shape layers with AE's own Create Shapes commands. Unlike
// extract.jsx this changes the project, so it lives in its own file and runs
// as one undo step. Loaded by the panel after extract.jsx; adds
// BetterLottie.prepareActiveComp. ES3, like extract.jsx.
//
// What the commands do (AE 2026, scripted): the new "<name> Outlines" layer
// goes directly above the original and gets its transform (keyframes and
// expressions), parent, in/out points, time stretch, effects and masks; the
// original is switched off. Not carried over: blend mode, motion blur, its own
// track matte, layers parented to it and layers using it as their matte. The
// shapes land exactly where the original rendered.

(function () {
  var VECTOR_COMMAND = 3973; // Layer › Create › Create Shapes from Vector Layer
  var TEXT_COMMAND = 3781; // Layer › Create › Create Shapes from Text
  var SUFFIX = ' [better-lottie]';

  function stringify(v) { return BetterLottie.stringify(v); }

  function kind(layer) {
    if (layer instanceof TextLayer) return 'text';
    try {
      if (layer.source instanceof FootageItem && layer.source.file && /\.(ai|eps|pdf)$/i.test(layer.source.file.name)) return 'vector';
    } catch (e) { /* no source */ }
    return null;
  }

  function matteOf(layer) {
    try { return layer.trackMatteLayer || null; } catch (e) { return null; } // AE before 2023: the layer above
  }

  function sameLayer(a, b) {
    return !!(a && b && a.index === b.index);
  }

  function textIsAnimated(layer) {
    var text = layer.property('ADBE Text Properties');
    var doc = text.property('ADBE Text Document');
    return text.property('ADBE Text Animators').numProperties > 0 || doc.numKeys > 0 || doc.expressionEnabled;
  }

  // Gradient colors can only be read from the saved project (see extract.jsx),
  // so new gradient layers need a save before they export correctly.
  function hasGradient(group) {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.matchName === 'ADBE Vector Graphic - G-Fill' || p.matchName === 'ADBE Vector Graphic - G-Stroke') return true;
      if (p.propertyType !== PropertyType.PROPERTY && hasGradient(p)) return true;
    }
    return false;
  }

  // Converts one layer in place; returns the new shape layer or null.
  function convertLayer(comp, layer, command) {
    var state = {
      name: layer.name,
      enabled: layer.enabled,
      locked: layer.locked,
      shy: layer.shy,
      guide: layer.guideLayer,
      label: layer.label,
      comment: layer.comment,
      blend: layer.blendingMode,
      motionBlur: layer.motionBlur,
      matteType: layer.trackMatteType,
      matte: matteOf(layer)
    };
    var children = [], matted = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var other = comp.layer(i);
      if (sameLayer(other.parent, layer)) children.push(other);
      if (sameLayer(matteOf(other), layer)) matted.push(other);
    }

    layer.locked = false;
    for (var j = 1; j <= comp.numLayers; j++) comp.layer(j).selected = false;
    layer.selected = true;
    var count = comp.numLayers;
    app.executeCommand(command);
    var shape = layer.index > 1 ? comp.layer(layer.index - 1) : null;
    if (comp.numLayers !== count + 1 || !(shape instanceof ShapeLayer)) {
      layer.locked = state.locked;
      return null;
    }

    shape.blendingMode = state.blend;
    shape.motionBlur = state.motionBlur;
    shape.shy = state.shy;
    shape.guideLayer = state.guide;
    shape.label = state.label;
    shape.comment = state.comment;
    for (var c = 0; c < children.length; c++) {
      // Plain .parent = would change the child's transform to keep it in place.
      if (children[c].setParentWithJump) children[c].setParentWithJump(shape);
      else children[c].parent = shape;
    }
    for (var m = 0; m < matted.length; m++) matted[m].setTrackMatte(shape, matted[m].trackMatteType);
    if (state.matte) shape.setTrackMatte(state.matte, state.matteType);
    else if (state.matteType !== TrackMatteType.NO_TRACK_MATTE) shape.trackMatteType = state.matteType;
    // Same name, so expressions like thisComp.layer("Logo") keep working: the
    // topmost layer of a name wins, and the original is removed next.
    shape.name = state.name;
    layer.remove();
    shape.enabled = state.enabled;
    shape.locked = state.locked;
    return shape;
  }

  function prepare(comp) {
    var copy = comp.duplicate();
    copy.name = comp.name + SUFFIX;
    copy.openInViewer();
    var layers = [];
    for (var i = 1; i <= copy.numLayers; i++) layers.push(copy.layer(i));

    var converted = [], warnings = [], gradients = false;
    for (var j = 0; j < layers.length; j++) {
      var layer = layers[j], k = kind(layer), where = 'layer "' + layer.name + '"';
      if (!k) continue;
      if (k === 'vector' && layer.source.footageMissing) {
        warnings.push(where + ': its Illustrator file is missing; relink it (File › Replace Footage) and prepare again');
        continue;
      }
      var animated = k === 'text' && textIsAnimated(layer);
      var shape = convertLayer(copy, layer, k === 'vector' ? VECTOR_COMMAND : TEXT_COMMAND);
      if (!shape) {
        warnings.push(where + ': After Effects could not convert it to shapes');
        continue;
      }
      converted.push(shape.name); // the original layer is gone now
      if (hasGradient(shape.property('ADBE Root Vectors Group'))) gradients = true;
      if (animated) warnings.push(where + ': text animation is not carried over; the shapes show the text at the current time');
    }
    if (!converted.length) {
      copy.remove();
      comp.openInViewer();
      return { comp: comp.name, converted: [], warnings: warnings };
    }
    return { comp: copy.name, id: copy.id, converted: converted, warnings: warnings, needsSave: gradients };
  }

  // Returns {"comp", "id", "converted": [layer names], "warnings": [...], "needsSave"};
  // without "id" when nothing needed (or could be) converted and no copy was made.
  // needsSave: the new shapes have gradients, whose colors export only once
  // the project is saved.
  function prepareActiveComp() {
    try {
      var comp = app.project && app.project.activeItem;
      if (!(comp instanceof CompItem)) return stringify({ error: 'Open or select a composition first.' });
      var todo = false;
      for (var i = 1; i <= comp.numLayers; i++) if (kind(comp.layer(i))) todo = true;
      if (!todo) return stringify({ comp: comp.name, converted: [], warnings: [] });
      app.beginUndoGroup('Prepare comp for better-lottie');
      try {
        return stringify(prepare(comp));
      } finally {
        app.endUndoGroup();
      }
    } catch (e) {
      return stringify({ error: String(e) + (e.line ? ' (prepare.jsx line ' + e.line + ')' : '') });
    }
  }

  BetterLottie.prepareActiveComp = prepareActiveComp;
}());
