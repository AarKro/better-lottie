// Panel UI. Talks to host/extract.jsx through CEP's evalScript and runs the
// bundled converter (lib/better-lottie.js → window.BetterLottieSVG) in the panel.
(function () {
  'use strict';

  var cep = window.__adobe_cep__;
  var $ = function (id) { return document.getElementById(id); };
  var last = null; // { svg, fileName }

  applyHostTheme();

  // --- host bridge ---

  function evalHost(script) {
    return new Promise(function (resolve) {
      if (!cep) return resolve(JSON.stringify({ error: 'Not running inside After Effects.' }));
      cep.evalScript(script, resolve);
    });
  }

  // A JS string literal that ExtendScript (ES3) can parse.
  function literal(s) {
    return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  async function callHost(fn, args) {
    var raw = await evalHost('BetterLottie.' + fn + '(' + (args || []).map(literal).join(',') + ')');
    var data;
    try { data = JSON.parse(raw); } catch (e) {
      throw new Error(raw && raw !== 'EvalScript error.' ? raw : 'The host script failed to load. Reopen the panel.');
    }
    if (data.error) throw new Error(data.error);
    return data;
  }

  // prepare.jsx changes the project, so it isn't the panel's main host script;
  // it's loaded the first time "Prepare comp" is used.
  var prepLoaded = false;

  async function loadPrep() {
    if (prepLoaded) return;
    // getSystemPath gives a file URL: file:///Users/… on macOS, file:///C:/… on Windows.
    var dir = decodeURIComponent(cep.getSystemPath('extension').replace(/^file:\/\/(\/(?=[A-Za-z]:))?/, ''));
    var raw = await evalHost('try { $.evalFile(' + literal(dir + '/host/prepare.jsx') + '); "ok" } catch (e) { String(e) }');
    if (raw !== 'ok') throw new Error('Could not load prepare.jsx: ' + raw);
    prepLoaded = true;
  }

  function applyHostTheme() {
    try {
      var c = JSON.parse(cep.getHostEnvironment()).appSkinInfo.panelBackgroundColor.color;
      document.documentElement.style.setProperty('--bg',
        'rgb(' + Math.round(c.red) + ',' + Math.round(c.green) + ',' + Math.round(c.blue) + ')');
    } catch (e) { /* outside AE or older host: keep the default */ }
  }

  // --- actions ---

  function fileBase(name) {
    return (name || 'animation').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').toLowerCase() || 'animation';
  }

  async function convertActiveComp() {
    var ir = await callHost('extractActiveComp');
    var workArea = $('opt-workarea').checked;
    var result = window.BetterLottieSVG.convert(ir, {
      loop: $('opt-loop').checked,
      background: $('opt-background').checked,
      workArea: workArea
    });
    var wa = ir.comp.workArea;
    var duration = workArea && wa && wa.duration > 0 ? Math.min(wa.duration, ir.comp.duration - (wa.start || 0)) : ir.comp.duration;
    return { ir: ir, svg: result.svg, warnings: result.warnings, duration: duration, fileName: fileBase(ir.comp.name) + '.svg' };
  }

  async function onPreview() {
    await run('Converting…', async function () {
      var r = await convertActiveComp();
      show(r);
      return 'Preview of "' + r.ir.comp.name + '". Not saved yet.';
    });
  }

  async function onExport() {
    await run('Exporting…', async function () {
      var r = await convertActiveComp();
      show(r);
      var saved = await callHost('saveText', [r.svg, r.fileName]);
      if (saved.cancelled) return 'Export cancelled.';
      last.fileName = baseName(saved.path);
      renderSnippet();
      return 'Saved ' + saved.path;
    });
  }

  async function onPrepare() {
    await run('Preparing…', async function () {
      if (cep) await loadPrep();
      var prep = await callHost('prepareActiveComp');
      if (!prep.id) {
        if (prep.warnings.length) throw new Error('Nothing in "' + prep.comp + '" could be converted. ' + prep.warnings.join(' '));
        return 'Nothing to prepare: "' + prep.comp + '" has no Illustrator or text layers.';
      }
      var n = prep.converted.length;
      var done = 'Created "' + prep.comp + '" with ' + n + ' layer' + (n === 1 ? '' : 's') + ' converted to shapes. ';
      if (prep.needsSave) {
        // Gradients would preview black to white and puppets undeformed until then.
        $('result').hidden = true;
        return done + 'Save the project (gradient colors and puppet meshes are read from the saved file), then preview or export it.';
      }
      // The prepared copy is now the active comp: preview it right away.
      var r = await convertActiveComp();
      r.warnings = prep.warnings.concat(r.warnings);
      show(r);
      return done + 'Check it against the original, then export it.';
    });
  }

  async function onSaveIR() {
    await run('Extracting…', async function () {
      var ir = await callHost('extractActiveComp');
      var saved = await callHost('saveText', [JSON.stringify(ir, null, 2) + '\n', fileBase(ir.comp.name) + '.ir.json']);
      return saved.cancelled ? 'Cancelled.' : 'Saved ' + saved.path;
    });
  }

  async function run(busyText, fn) {
    var buttons = document.querySelectorAll('.actions button');
    buttons.forEach(function (b) { b.disabled = true; });
    status(busyText);
    try {
      status(await fn());
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      buttons.forEach(function (b) { b.disabled = false; });
    }
  }

  // --- rendering ---

  // Layers "Prepare comp" can turn into shapes.
  function convertible(ir) {
    return ir.layers.filter(function (l) {
      return l.enabled !== false && ((l.type === 'footage' && l.vector) || l.type === 'text');
    }).length;
  }

  function show(r) {
    last = { svg: r.svg, fileName: r.fileName };
    var n = convertible(r.ir);
    $('notice').hidden = n === 0;
    $('notice').textContent = n + ' Illustrator or text layer' + (n === 1 ? ' is' : 's are')
      + ' missing from the SVG. Click "Prepare comp" to make a copy of this comp with '
      + (n === 1 ? 'it' : 'them') + ' converted to shape layers, then export the copy.';
    $('result').hidden = false;
    $('stage').innerHTML = r.svg;
    // An inserted SVG joins the page's clock mid-loop; start it from frame 0.
    var svgEl = $('stage').querySelector('svg');
    if (svgEl && svgEl.setCurrentTime) svgEl.setCurrentTime(0);

    var shapeLayers = r.ir.layers.filter(function (l) { return l.type === 'shape' && l.enabled !== false; }).length;
    var kb = (new Blob([r.svg]).size / 1024).toFixed(1);
    $('meta').textContent = r.ir.comp.width + '×' + r.ir.comp.height + ' · ' + r.duration.toFixed(2) + 's · '
      + shapeLayers + ' shape layer' + (shapeLayers === 1 ? '' : 's') + ' · ' + kb + ' KB';

    renderWarnings(r.warnings);
    renderSnippet();
  }

  function renderWarnings(warnings) {
    var list = $('warnings');
    list.innerHTML = '';
    warnings.forEach(function (w) {
      var li = document.createElement('li');
      li.textContent = w;
      list.appendChild(li);
    });
    $('warnings-box').hidden = warnings.length === 0;
    $('warnings-title').textContent = warnings.length + ' warning' + (warnings.length === 1 ? '' : 's');
  }

  function renderSnippet() {
    $('snippet').textContent = '<img src="' + last.fileName + '" alt="">';
  }

  function baseName(path) {
    return path.split(/[\\/]/).pop();
  }

  function status(text, isError) {
    $('status').textContent = text;
    $('status').classList.toggle('error', !!isError);
  }

  function copySnippet() {
    var area = document.createElement('textarea');
    area.value = $('snippet').textContent;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
    $('copy').textContent = 'Copied';
    setTimeout(function () { $('copy').textContent = 'Copy'; }, 1200);
  }

  // Show the active comp right away when the panel opens. With no comp open,
  // keep the usual hint instead of an error.
  async function previewOnOpen() {
    if (!cep) return;
    try {
      var r = await convertActiveComp();
      show(r);
      status('Preview of "' + r.ir.comp.name + '". Not saved yet.');
    } catch (e) { /* no comp yet */ }
  }

  $('export').addEventListener('click', onExport);
  $('preview').addEventListener('click', onPreview);
  $('prepare').addEventListener('click', onPrepare);
  $('save-ir').addEventListener('click', onSaveIR);
  $('copy').addEventListener('click', copySnippet);
  previewOnOpen();
}());
