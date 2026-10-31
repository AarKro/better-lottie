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
    var result = window.BetterLottieSVG.convert(ir, {
      loop: $('opt-loop').checked,
      background: $('opt-background').checked
    });
    return { ir: ir, svg: result.svg, warnings: result.warnings, fileName: fileBase(ir.comp.name) + '.svg' };
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

  function show(r) {
    last = { svg: r.svg, fileName: r.fileName };
    $('result').hidden = false;
    $('stage').innerHTML = r.svg;
    // An inserted SVG joins the page's clock mid-loop; start it from frame 0.
    var svgEl = $('stage').querySelector('svg');
    if (svgEl && svgEl.setCurrentTime) svgEl.setCurrentTime(0);

    var shapeLayers = r.ir.layers.filter(function (l) { return l.type === 'shape' && l.enabled !== false; }).length;
    var kb = (new Blob([r.svg]).size / 1024).toFixed(1);
    $('meta').textContent = r.ir.comp.width + '×' + r.ir.comp.height + ' · ' + r.ir.comp.duration.toFixed(2) + 's · '
      + shapeLayers + ' shape layer' + (shapeLayers === 1 ? '' : 's') + ' · ' + kb + ' KB';

    var list = $('warnings');
    list.innerHTML = '';
    r.warnings.forEach(function (w) {
      var li = document.createElement('li');
      li.textContent = w;
      list.appendChild(li);
    });
    $('warnings-box').hidden = r.warnings.length === 0;
    $('warnings-title').textContent = r.warnings.length + ' warning' + (r.warnings.length === 1 ? '' : 's');
    renderSnippet();
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

  $('export').addEventListener('click', onExport);
  $('preview').addEventListener('click', onPreview);
  $('save-ir').addEventListener('click', onSaveIR);
  $('copy').addEventListener('click', copySnippet);
}());
