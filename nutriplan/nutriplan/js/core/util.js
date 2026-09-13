/** Petites fonctions utilitaires partagées (aucune dépendance externe). */

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export const round = (v, step = 1) => Math.round(v / step) * step;

/** Formatage d'un nombre sans décimale inutile. */
export function num(v, decimals = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = Number(v).toFixed(decimals);
  return s.replace(/\.0+$/, '').replace('.', ',');
}

/** Grammes -> texte lisible (1240 g -> "1,24 kg"). */
export function grams(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (Math.abs(v) >= 1000) return `${num(v / 1000, 2)} kg`;
  return `${num(v, 0)} g`;
}

export function euros(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${num(v, 2)} €`;
}

export const WEEKDAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

/** Nom du jour pour l'index de jour d'un cycle (0-based). */
export function dayName(startWeekday, dayIndex) {
  return WEEKDAYS[(startWeekday + dayIndex) % 7];
}

/** Échappe le HTML injecté dans les templates. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Crée un élément depuis une chaîne HTML. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Débounce simple. */
export function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Copie profonde (structures JSON uniquement). */
export const deepCopy = (o) => JSON.parse(JSON.stringify(o));

/** Normalisation pour la recherche (sans accents, minuscules). */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Télécharge un contenu texte sous forme de fichier. */
export function downloadFile(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Petit toast d'information en bas d'écran. */
export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const node = el(`<div class="toast toast--${kind}">${esc(message)}</div>`);
  host.appendChild(node);
  setTimeout(() => node.classList.add('is-out'), 2600);
  setTimeout(() => node.remove(), 3100);
}
