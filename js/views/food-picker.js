/**
 * Filtrage et chips de catégorie partagés entre les deux recherches
 * d'ingrédients de l'app — éditeur de repas (editor.js) et composition de
 * recette (recipes.js) — pour qu'elles ne divergent jamais silencieusement
 * (même capacités de filtrage partout, même si l'affichage des résultats
 * reste propre à chaque écran).
 */

import { CATEGORIES } from '../core/nutrition.js';
import { normalize, esc } from '../core/util.js';

/**
 * Filtre une liste d'aliments par catégorie (ou pseudo-catégorie 'all' /
 * 'fav' / 'recent') puis par recherche texte (nom + marque) — les deux se
 * combinent, jamais l'un à la place de l'autre. Catégorie vide, aucun favori
 * ou aucun aliment récent : la liste résultante est simplement vide, jamais
 * une erreur.
 */
export function filterFoods(foods, { query = '', category = 'all' } = {}) {
  let list = foods;
  if (category === 'fav') list = list.filter((f) => f.favorite);
  else if (category === 'recent') list = list.filter((f) => f.lastUsed).sort((a, b) => (b.lastUsed > a.lastUsed ? 1 : -1));
  else if (category !== 'all') list = list.filter((f) => f.category === category);
  const q = normalize(query);
  if (q) list = list.filter((f) => normalize(`${f.name} ${f.brand}`).includes(q));
  return list;
}

/** Barre de chips « Tous / Favoris / Récents / <catégories> » — même rendu partout. */
export function foodFilterChips(selected, attr = 'data-cat') {
  const defs = [['all', 'Tous'], ['fav', 'Favoris'], ['recent', 'Récents'], ...CATEGORIES.map((c) => [c.id, c.label])];
  return defs
    .map(([id, label]) => `<button class="chip" ${attr}="${id}" aria-pressed="${selected === id}">${esc(label)}</button>`)
    .join('');
}

/**
 * Câble les clics sur les chips produites par foodFilterChips() : met à jour
 * aria-pressed sur toutes les chips DIRECTEMENT (jamais un re-rendu complet,
 * qui rejouerait l'animation d'entrée du tiroir/formulaire — même motif que
 * la recherche texte), puis appelle `onChange(id)` pour que l'écran appelant
 * mette à jour son état et rafraîchisse seulement ses résultats.
 */
export function wireFoodFilterChips(root, attr, onChange) {
  root.querySelectorAll(`[${attr}]`).forEach((chip) => {
    chip.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute(attr);
      for (const c of root.querySelectorAll(`[${attr}]`)) c.setAttribute('aria-pressed', String(c.getAttribute(attr) === id));
      onChange(id);
    });
  });
}
