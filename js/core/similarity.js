/**
 * Détection d'aliments similaires — purement générique (aucune liste de produits
 * codée en dur). Sert à AVERTIR, jamais à fusionner ou supprimer quoi que ce soit.
 */

import { normalize, normalizeWords } from './util.js';

/** Similarité de Dice sur les trigrammes du nom normalisé (0 → 1). */
export function nameSimilarity(a, b) {
  const grams = (s) => {
    const t = normalizeWords(s);
    const set = new Set();
    for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common++;
  return (2 * common) / (A.size + B.size);
}

const sameBrand = (a, b) => {
  const x = normalize(a?.brand);
  const y = normalize(b?.brand);
  return Boolean(x && y && x === y);
};

const closeNumber = (a, b, tol = 0.1) => {
  if (!a || !b) return false;
  return Math.abs(a - b) / Math.max(a, b) <= tol;
};

/**
 * Aliments de la banque probablement identiques ou très proches du candidat.
 * @returns [{ food, score, reasons: string[] }] trié du plus probable au moins probable
 */
export function findSimilarFoods(candidate, foods, { threshold = 0.6, limit = 4 } = {}) {
  if (!candidate?.name) return [];
  const out = [];
  for (const food of foods) {
    if (food.id === candidate.id) continue;
    const rawNameScore = nameSimilarity(candidate.name, food.name);
    let score = rawNameScore;
    const reasons = [];
    if (score >= 0.4) reasons.push('nom proche');
    const brandMatch = sameBrand(candidate, food);
    if (brandMatch) { score += 0.3; reasons.push('même marque'); }
    if (candidate.gramsPerUnit && closeNumber(candidate.gramsPerUnit, food.gramsPerUnit, 0.02)) {
      score += 0.1;
      reasons.push(`même poids par unité (${food.gramsPerUnit} g)`);
    }
    if (closeNumber(candidate.kcal, food.kcal, 0.05) && candidate.category === food.category) {
      score += 0.1;
      reasons.push('valeurs nutritionnelles proches');
    }
    // Un simple nom proche ne suffit pas s'il s'agit d'aliments sans rapport :
    // on exige la même catégorie, la même marque, ou un nom quasi identique —
    // la similarité de nom PURE (rawNameScore), pas gonflée par les bonus
    // marque/poids/nutrition déjà ajoutés à `score` ci-dessus ; réutilisée
    // plutôt que recalculée (nameSimilarity() est l'essentiel du coût de
    // cette fonction, appelée en O(n²) par findDuplicateGroups()).
    const related = brandMatch || candidate.category === food.category || rawNameScore >= 0.85;
    if (score >= threshold && related && reasons.length) out.push({ food, score: Math.min(1, score), reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Groupes d'aliments similaires à l'intérieur d'une banque (contrôle après import). */
export function findDuplicateGroups(foods, options = { threshold: 0.7 }) {
  const seen = new Set();
  const groups = [];
  for (const food of foods) {
    if (seen.has(food.id)) continue;
    const similar = findSimilarFoods(food, foods, options).filter((x) => !seen.has(x.food.id));
    if (!similar.length) continue;
    groups.push({ food, similar });
    seen.add(food.id);
    for (const x of similar) seen.add(x.food.id);
  }
  return groups;
}

/**
 * Clé canonique et stable d'un groupe de doublons détecté (identifiants de
 * TOUS ses membres, triés — indépendante de l'ordre dans lequel
 * findDuplicateGroups() les a rencontrés). Sert à retenir qu'un utilisateur
 * a explicitement écarté ce groupe précis (« pas un doublon »), sans qu'il
 * faille persister autre chose qu'une chaîne par groupe écarté.
 *
 * Volontairement sensible à la COMPOSITION EXACTE du groupe : si un membre
 * est ajouté ou retiré du regroupement (ex. un nouvel aliment vient s'y
 * greffer, ou une modification de nom change les scores de similarité), la
 * clé change et le groupe peut réapparaître — décision assumée, un
 * changement de composition est une situation suffisamment différente pour
 * mériter un nouvel avis, plutôt qu'un risque de masquer silencieusement un
 * vrai doublon impliquant le nouveau venu.
 */
export function duplicateGroupKey(group) {
  return [group.food.id, ...group.similar.map((x) => x.food.id)].sort().join('|');
}

/**
 * Retire les groupes explicitement écartés par l'utilisateur. `dismissedKeys`
 * est la liste persistée (state.dismissedDuplicates) — jamais mutée ici,
 * cette fonction reste pure comme le reste du module.
 */
export function excludeDismissedGroups(groups, dismissedKeys) {
  if (!dismissedKeys || !dismissedKeys.length) return groups;
  const dismissed = new Set(dismissedKeys);
  return groups.filter((g) => !dismissed.has(duplicateGroupKey(g)));
}
