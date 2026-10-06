/**
 * Material Symbols ship one SVG per icon: `<svg viewBox="0 -960 960 960"><path d="…"/></svg>`.
 * The panel keeps only the path data and draws it itself, so the color follows `currentColor`.
 */
export const MATERIAL_VIEW_BOX = '0 -960 960 960';

/** The `d` of every `<path>` in a Material Symbols SVG, joined; empty when there is none. */
export function svgPathData(svg: string): string {
  return Array.from(svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g), (match) => match[1]).join(' ');
}
