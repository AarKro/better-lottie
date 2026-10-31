// Number and string formatting for SVG output. Everything that ends up in the
// file goes through here so output stays short and deterministic.

export function num(n, digits = 3) {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? '0' : String(r);
}

// AE colors are [r, g, b(, a)] floats in 0..1. Alpha is ignored: AE uses the
// separate Opacity property of fills and strokes instead.
export function hex(rgb) {
  const c = x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

export function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function escComment(s) {
  return String(s).replace(/--/g, '- -');
}
