// Lucide 1.55.0 — ISC license. See Lucide-LICENSE.txt.
const shapes = {
  "layout-grid": "<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\" />\n  <rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\" />\n  <rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\" />\n  <rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\" />",
  "trending-up": "<path d=\"M16 7h6v6\" />\n  <path d=\"m22 7-8.5 8.5-5-5L2 17\" />",
  "folder-heart": "<path d=\"M10.638 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v3.417\" />\n  <path d=\"M14.62 18.8A2.25 2.25 0 1 1 18 15.836a2.25 2.25 0 1 1 3.38 2.966l-2.626 2.856a.998.998 0 0 1-1.507 0z\" />",
  "handshake": "<path d=\"m11 17 2 2a1 1 0 1 0 3-3\" />\n  <path d=\"m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4\" />\n  <path d=\"m21 3 1 11h-2\" />\n  <path d=\"M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3\" />\n  <path d=\"M3 4h8\" />",
  "settings-2": "<path d=\"M14 17H5\" />\n  <path d=\"M19 7h-9\" />\n  <circle cx=\"17\" cy=\"17\" r=\"3\" />\n  <circle cx=\"7\" cy=\"7\" r=\"3\" />",
  "arrow-up-right": "<path d=\"M7 7h10v10\" />\n  <path d=\"M7 17 17 7\" />",
  "plus": "<path d=\"M5 12h14\" />\n  <path d=\"M12 5v14\" />",
  "x": "<path d=\"M18 6 6 18\" />\n  <path d=\"m6 6 12 12\" />",
  "search": "<path d=\"m21 21-4.34-4.34\" />\n  <circle cx=\"11\" cy=\"11\" r=\"8\" />",
  "download": "<path d=\"M12 15V3\" />\n  <path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" />\n  <path d=\"m7 10 5 5 5-5\" />",
  "git-fork": "<circle cx=\"12\" cy=\"18\" r=\"3\" />\n  <circle cx=\"6\" cy=\"6\" r=\"3\" />\n  <circle cx=\"18\" cy=\"6\" r=\"3\" />\n  <path d=\"M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9\" />\n  <path d=\"M12 12v3\" />",
  "pencil": "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\" />\n  <path d=\"m15 5 4 4\" />",
  "smartphone": "<rect width=\"14\" height=\"20\" x=\"5\" y=\"2\" rx=\"2\" ry=\"2\" />\n  <path d=\"M12 18h.01\" />",
  "monitor": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\" />\n  <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\" />\n  <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\" />",
  "check": "<path d=\"M20 6 9 17l-5-5\" />"
};
export function icon(name) {
  return '<svg class="lucide lucide-' + name + '" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (shapes[name] || '') + '</svg>';
}
