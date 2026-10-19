/** Petites fonctions utilitaires partagées (aucune dépendance externe). */

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

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

/**
 * Texte normalis\u00e9, mots s\u00e9par\u00e9s par un espace unique, encadr\u00e9 d'espaces
 * (fronti\u00e8res de mot par simple inclusion de cha\u00eene \u2014 ex. utile pour qu'un
 * mot-cl\u00e9 ne \u00ab matche \u00bb jamais \u00e0 l'int\u00e9rieur d'un autre qui le contient).
 */
export function normalizeWords(s) {
  const cleaned = normalize(String(s ?? '')).replace(/[^a-z0-9]+/g, ' ').trim();
  return cleaned ? ` ${cleaned} ` : '';
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
