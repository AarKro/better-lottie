// "Work area only": the comp's work area becomes the whole timeline. Every
// keyframe and in/out point moves back by the work area's start; keyframes
// that end up outside 0..duration are resampled by the timeline like any
// others (trackToSmil), so values at the cut are exact.

export function cropToWorkArea(ir) {
  const wa = ir.comp.workArea;
  if (!wa || !(wa.duration > 0)) return ir;
  const start = wa.start || 0;
  const out = shift(ir, start);
  out.comp = { ...out.comp, duration: Math.min(wa.duration, ir.comp.duration - start) };
  out.layers = out.layers.map(l => ({
    ...l,
    inPoint: (l.inPoint ?? 0) - start,
    outPoint: (l.outPoint ?? ir.comp.duration) - start,
  }));
  return out;
}

// Deep copy with every keyframe time moved by −dt.
function shift(value, dt) {
  if (Array.isArray(value)) return value.map(v => shift(v, dt));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'keyframes' && Array.isArray(v) ? v.map(kf => ({ ...shift(kf, dt), t: kf.t - dt })) : shift(v, dt);
  }
  return out;
}
