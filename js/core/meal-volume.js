/**
 * Analyse du volume d'un repas — couche STRICTEMENT SÉPARÉE du moteur
 * nutritionnel (js/core/nutrition.js). Purement informative : ne modifie
 * jamais une quantité, une macro, ni l'optimiseur ; ne bloque jamais la
 * validation d'un repas.
 *
 * Un repas peut atteindre ses objectifs nutritionnels tout en représentant
 * une quantité de nourriture très importante à consommer en une seule fois.
 * Le rôle de ce module est de le SIGNALER, jamais de le corriger.
 *
 * Ce fichier n'est importé QUE par la vue (js/views/editor.js). Le supprimer,
 * avec son import dans la vue, laisse le moteur nutritionnel strictement
 * identique.
 */

/** Rendement cru → cuit exploitable, s'il existe (aucun coefficient inventé). */
const cookedFactorOf = (food) => {
  const f = Number(food?.cookedFactor);
  return Number.isFinite(f) && f > 0 ? f : null;
};

/**
 * Contribution d'un ingrédient à la masse d'assiette, dans l'état RÉELLEMENT
 * présent dans l'assiette (pas l'état des valeurs nutritionnelles) :
 *  - pesé cru : la masse dans l'assiette est la masse cuite → quantité × cookedFactor ;
 *  - pesé cuit / égoutté / prêt : déjà l'état consommé → masse = quantité ;
 *  - pesé cru SANS cookedFactor exploitable : aucun facteur inventé (surtout
 *    pas 1 par défaut) → contribution exclue, l'estimation est signalée partielle.
 */
function plateContribution(food, qty, state) {
  if (state !== 'cru') return { grams: qty, excluded: false };
  const factor = cookedFactorOf(food);
  if (factor === null) return { grams: 0, excluded: true };
  return { grams: qty * factor, excluded: false };
}

/**
 * Masse d'assiette d'un repas pour une personne.
 * Les ingrédients libres (sans foodId) n'ont pas de masse connue et sont
 * ignorés. Le verrouillage d'un ingrédient (optimiseur) n'a aucune incidence
 * ici : un ingrédient verrouillé compte normalement dans la masse.
 *
 * @returns {{ grams: number, excludedCount: number, partial: boolean }}
 */
export function plateMassOf(items, foodsById, person) {
  let grams = 0;
  let excludedCount = 0;
  for (const it of items) {
    if (!it.foodId) continue; // ingrédient libre : masse inconnue, ignoré
    const food = foodsById[it.foodId];
    if (!food) continue;
    const qty = it.qty?.[person] || 0;
    if (qty <= 0) continue;
    const state = it.state || food.referenceState;
    const { grams: g, excluded } = plateContribution(food, qty, state);
    if (excluded) { excludedCount += 1; continue; }
    grams += g;
  }
  return { grams, excludedCount, partial: excludedCount > 0 };
}

/**
 * Seuils de volume — constantes internes V1.4 (pas de réglage utilisateur).
 * Les bornes hautes de chaque palier sont inclusives : une masse de 750 g
 * exactement reste au niveau 1, pas au niveau 2.
 */
export const VOLUME_LEVELS = [
  { level: 0, max: 600, label: null },
  { level: 1, max: 750, label: 'Repas volumineux' },
  { level: 2, max: 900, label: 'Repas très volumineux' },
  { level: 3, max: Infinity, label: 'Repas extrêmement volumineux' },
];

/** Palier d'avertissement correspondant à une masse d'assiette donnée. */
export function volumeLevelFor(grams) {
  return VOLUME_LEVELS.find((l) => grams <= l.max);
}

/**
 * Analyse de volume d'un repas pour une personne. Purement informative :
 * ne lit que items/foodsById, n'écrit jamais dedans.
 *
 * @returns {{ grams: number, level: number, label: string|null, partial: boolean }}
 */
export function analyzeMealVolume(items, foodsById, person) {
  const { grams, partial } = plateMassOf(items, foodsById, person);
  const { level, label } = volumeLevelFor(grams);
  return { grams, level, label, partial };
}
