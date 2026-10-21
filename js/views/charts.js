/**
 * Graphique en anneau (donut) — SVG pur, aucune dépendance de charting.
 * Toujours accompagné d'une légende textuelle (valeur + %) : le graphique
 * n'est jamais la seule source de l'information, seulement une aide à la
 * comparaison visuelle rapide.
 */

import { esc } from '../core/util.js';

/**
 * @param {Array<{label:string, value:number, color:string, icon?:string, displayValue?:number}>} segments
 *   `color` est une valeur CSS directement utilisable (ex. "var(--cat-legume)").
 *   `value` sert au calcul des proportions (l'angle de l'arc) ; `displayValue`,
 *   si fourni, est ce qui est AFFICHÉ dans la légende à la place de `value`
 *   (ex. proportion calculée en kcal, mais légende en grammes).
 * @param {{size?:number, thickness?:number, centerLabel?:string, centerValueHtml?:string, formatValue?:(n:number)=>string}} opts
 */
export function donutChart(segments, opts = {}) {
  const size = opts.size || 132;
  const thickness = opts.thickness || 16;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const fmt = opts.formatValue || ((n) => String(n));

  let offset = 0;
  const arcs = total > 0
    ? segments
        .filter((s) => s.value > 0)
        .map((s) => {
          const frac = s.value / total;
          const len = frac * c;
          const circle = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${s.color}"
            stroke-width="${thickness}" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}"
            stroke-linecap="butt" />`;
          offset += len;
          return circle;
        })
        .join('')
    : `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line-strong)" stroke-width="${thickness}" />`;

  const svg = `<svg class="donut__svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(opts.ariaLabel || 'Répartition')}">${arcs}</svg>`;

  const centerHtml = `<div class="donut__center-text">
      ${opts.centerValueHtml || (total > 0 ? `<span class="donut__center-value">${fmt(total)}</span>` : '')}
      ${opts.centerLabel ? `<span class="donut__center-label">${esc(opts.centerLabel)}</span>` : ''}
    </div>`;

  const legend = segments
    .map((s) => {
      const pct = total > 0 ? Math.round((Math.max(0, s.value) / total) * 100) : 0;
      return `<div class="donut__legend-row">
        <span class="donut__legend-dot" style="background:${s.color}"></span>
        <span class="donut__legend-label">${s.icon ? `${s.icon} ` : ''}${esc(s.label)}</span>
        <span class="donut__legend-value">${fmt(s.displayValue ?? s.value)}</span>
        <span class="donut__legend-pct">${pct}%</span>
      </div>`;
    })
    .join('');

  return `<div class="donut">
    <div class="donut__figure" style="width:${size}px;height:${size}px">
      ${svg}
      ${centerHtml}
    </div>
    <div class="donut__legend">${legend}</div>
  </div>`;
}

/**
 * Anneau de progression à valeur unique (ex. "81 % de l'objectif kcal") —
 * un arc coloré sur une piste neutre, jamais un donut à plusieurs segments.
 * `pct` peut dépasser 100 (visuellement plafonné à un tour complet, mais le
 * texte central affiche la vraie valeur, jamais tronquée silencieusement).
 */
export function progressRing(pct, { size = 64, thickness = 7, color = 'var(--brand-500)', label = '' } = {}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, pct));
  const len = (clamped / 100) * c;
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg class="ring__svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)} ${Math.round(pct)} %">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--surface-sunken)" stroke-width="${thickness}" />
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${thickness}"
        stroke-dasharray="${len} ${c - len}" stroke-linecap="round" />
    </svg>
    <div class="ring__text"><span class="ring__pct">${Math.round(pct)}%</span></div>
  </div>`;
}
