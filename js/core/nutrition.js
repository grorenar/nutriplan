/**
 * Moteur nutritionnel — isolé de l'UI et de l'accès aux données.
 * Toutes les fonctions sont pures : elles prennent des données, renvoient des données.
 *
 * Conventions :
 *  - les valeurs nutritionnelles d'un aliment sont TOUJOURS pour 100 g,
 *    exprimées dans son "état de référence" (cru / cuit / égoutté / prêt) ;
 *  - les quantités des ingrédients sont en grammes, dans l'état choisi pour l'ingrédient ;
 *  - la conversion cru <-> cuit utilise le coefficient de l'aliment (cookedFactor).
 */

import { clamp, round } from './util.js';

export const CATEGORIES = [
  { id: 'proteine', label: 'Protéine' },
  { id: 'feculent', label: 'Féculent' },
  { id: 'legumineuse', label: 'Légumineuse' },
  { id: 'legume', label: 'Légume' },
  { id: 'fruit', label: 'Fruit' },
  { id: 'laitier', label: 'Produit laitier' },
  { id: 'matiere_grasse', label: 'Matière grasse' },
  { id: 'oleagineux', label: 'Noix & graines' },
  { id: 'autre', label: 'Autre' },
];

export const STATES = [
  { id: 'cru', label: 'Cru / brut' },
  { id: 'cuit', label: 'Cuit' },
  { id: 'egoutte', label: 'Égoutté' },
  { id: 'pret', label: 'Prêt à consommer' },
];

export const PERSONS = ['thomas', 'julie'];
export const PERSON_LABEL = { thomas: 'Thomas', julie: 'Julie' };

export const MEAL_TYPES = {
  breakfast: 'Petit-déjeuner',
  lunch: 'Déjeuner',
  snack_afternoon: 'Collation 16 h',
  dinner: 'Dîner',
  snack_evening: 'Collation du soir',
  day: 'Journée',
};

/**
 * Profils par catégorie : bornes raisonnables (en grammes, dans l'état de l'ingrédient),
 * portion type (`def` = réf_cat) et énergie type d'une portion (`eCat` = E_cat).
 * Ces deux derniers nombres alimentent `referenceFor()` : un point de départ pour des
 * proportions réalistes, jamais une cible nutritionnelle.
 */
export const CATEGORY_PROFILE = {
  proteine: { min: 50, max: 250, def: 150, eCat: 164, step: 5 },
  feculent: { min: 20, max: 400, def: 90, eCat: 266, step: 5 },
  legumineuse: { min: 40, max: 300, def: 150, eCat: 207, step: 5 },
  legume: { min: 60, max: 320, def: 200, eCat: 65, step: 10 },
  fruit: { min: 30, max: 260, def: 120, eCat: 78, step: 10 },
  laitier: { min: 40, max: 500, def: 150, eCat: 112, step: 5 },
  matiere_grasse: { min: 2, max: 45, def: 10, eCat: 90, step: 1 },
  oleagineux: { min: 5, max: 80, def: 20, eCat: 148, step: 5 },
  autre: { min: 5, max: 300, def: 60, eCat: 100, step: 5 },
};

/**
 * `food.recipeProfile`, quand présent, prime sur la catégorie : c'est le cas
 * de l'aliment virtuel d'une recette `weight` (recipeAsVirtualFood), dont les
 * bornes sont dérivées de SA PROPRE échelle (baseGrams), jamais d'une
 * catégorie partagée — une recette va de 40 g à plusieurs kg, une constante
 * de catégorie unique n'a pas de sens ici (décision explicite). Un `food` réel
 * n'a jamais ce champ : chemin de catégorie strictement inchangé pour lui.
 */
export const profileOf = (food) => food?.recipeProfile || CATEGORY_PROFILE[food?.category] || CATEGORY_PROFILE.autre;

/**
 * Référence de portion pour un aliment (architecture C) : moyenne géométrique
 * entre une référence en masse (réf_cat, la portion type de la catégorie) et
 * une référence iso-énergétique (réf_cat × E_cat / densité), bornée à
 * [réf_cat/3, réf_cat×3] pour les densités extrêmes.
 *   réf = clamp( √(réf_cat × E_cat × 100 / densité) , réf_cat/3 , réf_cat×3 )
 * C'est un point de départ pour des proportions réalistes, jamais une cible
 * nutritionnelle : l'optimiseur peut s'en écarter librement.
 */
export function referenceFor(food) {
  const p = profileOf(food);
  const density = Number(food?.kcal) || 0;
  if (density <= 0) return p.def;
  const raw = Math.sqrt((p.def * p.eCat * 100) / density);
  return clamp(raw, p.def / 3, p.def * 3);
}

/* ------------------------------------------------------------------ */
/* Conversion d'état                                                   */
/* ------------------------------------------------------------------ */

/** Le rendement après cuisson de l'aliment est-il exploitable ? */
const cookedFactorOf = (food) => {
  const f = Number(food?.cookedFactor);
  return Number.isFinite(f) && f > 0 ? f : null;
};

/**
 * Une conversion entre deux états est-elle définie pour cet aliment ?
 * Seul le couple cru <-> cuit dispose d'un coefficient (le rendement après
 * cuisson). Aucun coefficient n'est inventé pour « égoutté » ou « prêt à
 * consommer » : ces états ne se convertissent pas.
 */
export function canConvert(food, fromState, toState) {
  if (!fromState || !toState || fromState === toState) return true;
  const pair = [fromState, toState].sort().join('-'); // "cru-cuit"
  if (pair !== 'cru-cuit') return false;
  return cookedFactorOf(food) !== null;
}

/**
 * État de la conversion nécessaire entre l'état saisi dans le repas et l'état
 * des valeurs nutritionnelles de l'aliment. Sert à prévenir l'utilisateur
 * plutôt qu'à produire un calcul inventé.
 */
export function conversionInfo(food, itemState) {
  const from = itemState || food?.referenceState;
  const to = food?.referenceState;
  const needed = Boolean(from && to && from !== to);
  const possible = canConvert(food, from, to);
  return {
    from,
    to,
    needed,
    possible,
    factor: needed && possible ? cookedFactorOf(food) : null,
    message:
      needed && !possible
        ? `Conversion impossible : aucune conversion définie entre « ${stateLabel(from)} » et ` +
          `« ${stateLabel(to)} ». Les macros de cet ingrédient ne sont pas calculées et ne sont ` +
          `pas comptées dans le total. Choisis l'état correspondant aux valeurs nutritionnelles, ` +
          `ou une combinaison cru / cuit avec un rendement renseigné.`
        : null,
  };
}

export const stateLabel = (id) => STATES.find((s) => s.id === id)?.label || id || '';

/**
 * Convertit une quantité exprimée dans `fromState` vers `toState`.
 * Seul le couple cru <-> cuit modifie le poids (rendement après cuisson :
 * coefficient = poids cuit ÷ poids cru). Toute autre combinaison est renvoyée
 * telle quelle : aucun coefficient n'est inventé.
 */
export function convertGrams(food, qty, fromState, toState) {
  if (!food || !qty || fromState === toState) return qty;
  if (!canConvert(food, fromState, toState)) return qty;
  const f = cookedFactorOf(food) ?? 1;
  if (fromState === 'cru' && toState === 'cuit') return qty * f;
  if (fromState === 'cuit' && toState === 'cru') return qty / f;
  return qty; // égoutté / prêt : pas de conversion automatique
}

/** Quantité ramenée à l'état de référence de l'aliment (base de tous les calculs). */
/**
 * Quantité ramenée à l'état de référence de l'aliment (base de tous les calculs).
 * Renvoie null quand aucune conversion n'est définie entre l'état pesé et
 * l'état des valeurs nutritionnelles : deux états différents ne sont JAMAIS
 * considérés comme équivalents par défaut.
 */
export function toReferenceGrams(food, qty, itemState) {
  const from = itemState || food?.referenceState;
  if (!canConvert(food, from, food?.referenceState)) return null;
  return convertGrams(food, qty, from, food.referenceState);
}

/* ------------------------------------------------------------------ */
/* Calcul des macros                                                   */
/* ------------------------------------------------------------------ */

export const emptyMacros = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 });

/**
 * Macros d'un ingrédient pour une quantité donnée.
 * Si la conversion entre l'état pesé et l'état des valeurs nutritionnelles
 * n'est pas définie, aucune macro n'est calculée : l'objet renvoyé porte
 * `unconvertible: true` et des valeurs nulles, plutôt qu'un calcul faux
 * qui supposerait les deux états équivalents.
 */
export function macrosFor(food, qty, itemState) {
  const m = emptyMacros();
  if (!food || !qty) return m;
  const ref = toReferenceGrams(food, qty, itemState);
  if (ref === null) {
    m.unconvertible = true;
    return m;
  }
  const g = ref / 100;
  m.kcal = (food.kcal || 0) * g;
  m.protein = (food.protein || 0) * g;
  m.carbs = (food.carbs || 0) * g;
  m.fat = (food.fat || 0) * g;
  m.fiber = (food.fiber || 0) * g;
  return m;
}

/**
 * Macros totales d'une liste d'ingrédients pour une personne.
 * `recipesById`/`preparationsById` (optionnels, `{}` par défaut) : items
 * `recipeId`/`preparationId` inclus dans le total — chemin additif, sans
 * effet quand ils sont omis (aucun appelant existant n'en a besoin tant qu'il
 * ne manipule que des `foodId`).
 */
export function mealMacros(items, foodsById, person, recipesById = {}, preparationsById = {}) {
  const total = emptyMacros();
  total.unconvertible = 0; // ingrédients exclus faute de conversion définie
  for (const it of items) {
    if (!it.foodId && !it.recipeId && !it.preparationId) continue; // ingrédient libre : ne participe pas aux macros
    const food = resolveItemFood(it, foodsById, recipesById, preparationsById);
    if (!food) continue;
    const m = macrosFor(food, it.qty?.[person] || 0, it.state);
    if (m.unconvertible) {
      // jamais intégré au total : la valeur serait potentiellement fausse
      total.unconvertible += 1;
      continue;
    }
    total.kcal += m.kcal;
    total.protein += m.protein;
    total.carbs += m.carbs;
    total.fat += m.fat;
    total.fiber += m.fiber;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Recettes (catalogue) — étape 1                                      */
/* ------------------------------------------------------------------ */

/**
 * Macros d'une recette, ramenées à une base de 100 (g pour `kind:'weight'`,
 * "100 unités de portion" pour `kind:'portion'`, la composition décrivant
 * alors UNE portion). Jamais stockées : toujours recalculées depuis
 * `recipe.items`, avec `macrosFor()` — aucune nouvelle logique de calcul
 * nutritionnel, seulement une agrégation.
 */
export function recipeMacrosPer100g(recipe, foodsById) {
  const total = emptyMacros();
  total.unconvertible = 0;
  for (const ri of recipe?.items || []) {
    const food = foodsById[ri.foodId];
    if (!food) continue;
    const m = macrosFor(food, ri.qty, ri.state);
    if (m.unconvertible) { total.unconvertible += 1; continue; }
    total.kcal += m.kcal;
    total.protein += m.protein;
    total.carbs += m.carbs;
    total.fat += m.fat;
    total.fiber += m.fiber;
  }
  const base = recipe?.kind === 'portion'
    ? (recipe.items || []).reduce((s, ri) => s + (Number(ri.qty) || 0), 0)
    : Number(recipe?.baseGrams) || 0;
  // base non renseignée (recette weight sans baseGrams, ou aucun ingrédient) :
  // macros nulles explicites, jamais un total non mis à l'échelle.
  if (base <= 0) return { ...emptyMacros(), unconvertible: total.unconvertible };
  const scale = 100 / base;
  return {
    kcal: total.kcal * scale, protein: total.protein * scale,
    carbs: total.carbs * scale, fat: total.fat * scale, fiber: total.fiber * scale,
    unconvertible: total.unconvertible,
  };
}

/**
 * Une recette `kind:'weight'` (poids continu) ne peut contenir aucun aliment
 * non fractionnable : cette combinaison — un ingrédient interne à discrétiser
 * pendant qu'une quantité totale scale en continu — n'est pas traitée dans
 * cette version (cf. décision verrouillée). Un aliment non fractionnable doit
 * passer par une recette `kind:'portion'`, où la recette entière devient
 * l'unité indivisible.
 */
export function canAddIngredientToRecipe(recipe, food) {
  if (recipe?.kind === 'weight' && isWholeUnitFood(food)) {
    return {
      ok: false,
      reason: `« ${food?.name || 'cet aliment'} » est non fractionnable : une recette au poids ne peut pas ` +
        `en contenir. Bascule cette recette en recette « portion », ou choisis un autre aliment.`,
    };
  }
  return { ok: true, reason: null };
}

/** Somme des grammes d'UNE portion — la seule échelle pertinente pour une recette `kind:'portion'`. */
/** Poids d'UNE portion (recette ou snapshot `kind:'portion'`) — seule échelle pertinente pour ce type. */
export const portionGramsOf = (recipeLike) => Math.max(1, (recipeLike?.items || []).reduce((s, ri) => s + (Number(ri.qty) || 0), 0));

/**
 * `preparation.preparedQuantity` en GRAMMES — l'unité de stockage réelle,
 * toujours celle des `item.qty` : en grammes directement pour `kind:'weight'`,
 * convertie depuis un NOMBRE DE PORTIONS pour `kind:'portion'` (où
 * `preparedQuantity` est stocké en portions — décision verrouillée). Toute
 * comparaison avec des quantités d'items doit passer par cette conversion.
 */
export function preparedGramsOf(preparation) {
  if (preparation?.recipeSnapshot?.kind === 'portion') {
    return (Number(preparation.preparedQuantity) || 0) * portionGramsOf(preparation.recipeSnapshot);
  }
  return Number(preparation?.preparedQuantity) || 0;
}

/**
 * Traduit une recette en un objet qui se comporte comme un `food` du point de
 * vue de l'optimiseur — mêmes champs, aucune nouvelle mécanique numérique :
 * `adjustQuantities()`/`mealMacros()` l'utilisent sans savoir qu'il s'agit
 * d'une recette. `referenceState:'pret'` + `cookedFactor:1` car les macros
 * sont déjà agrégées (recipeMacrosPer100g) : aucune conversion supplémentaire
 * n'est nécessaire pour cet objet.
 *
 * `kind:'weight'` (Type A, continue) : bornes dérivées de `baseGrams`, PAS de
 * constante de catégorie partagée — une recette petite (40 g) et un batch de
 * plusieurs kg n'ont rien de commun : [baseGrams/10, baseGrams×10],
 * résolution 1 g (déjà garantie par `roundQuantity()`).
 *
 * `kind:'portion'` (Type B, indivisible — étape 9) : la recette ENTIÈRE
 * devient l'unité, exactement comme un aliment non fractionnable
 * (`gramsPerUnit` = poids d'UNE portion, `fractionable:false`) — RÉUTILISE
 * `isWholeUnitFood()`/`roundQuantity()`/`roundForFinalQuantities()` tels
 * quels, aucune ligne de ces fonctions n'a été modifiée pour ce cas.
 */
export function recipeAsVirtualFood(recipe, foodsById) {
  const m = recipeMacrosPer100g(recipe, foodsById);
  if (recipe.kind === 'portion') {
    const portionGrams = portionGramsOf(recipe);
    return {
      id: recipe.id,
      name: recipe.name,
      category: 'recette_portion',
      kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, fiber: m.fiber,
      referenceState: 'pret',
      cookedFactor: 1,
      gramsPerUnit: portionGrams,
      unitName: 'portion',
      fractionable: false,
      isRecipe: true,
      recipeProfile: { min: portionGrams, max: portionGrams * 10, def: portionGrams, eCat: m.kcal > 0 ? m.kcal : 100 },
    };
  }
  const def = Math.max(1, Number(recipe.baseGrams) || 0);
  return {
    id: recipe.id,
    name: recipe.name,
    category: 'recette_weight',
    kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, fiber: m.fiber,
    referenceState: 'pret',
    cookedFactor: 1,
    gramsPerUnit: 0,
    fractionable: true,
    isRecipe: true,
    recipeProfile: { min: Math.max(1, def / 10), max: def * 10, def, eCat: m.kcal > 0 ? m.kcal : 100 },
  };
}

/**
 * Traduit une PRÉPARATION en aliment virtuel — même principe que
 * `recipeAsVirtualFood()` (Type A continu / Type B indivisible selon
 * `recipeSnapshot.kind`), avec deux différences volontaires :
 *  - les macros dérivent du SNAPSHOT figé (`preparation.recipeSnapshot`),
 *    JAMAIS de la recette source (qui a pu être modifiée depuis) ;
 *  - la borne par défaut (`weight`) est `[preparedQuantity/10, preparedQuantity]`
 *    — un plafond structurel large. `adjustQuantities()` la resserre au
 *    disponible RÉEL (mode normal, `Σ affecté ≤ disponible`) quand
 *    l'appelant le fournit via `options.preparationAvailability`.
 *  - en `portion`, `preparedQuantity` s'exprime en NOMBRE DE PORTIONS (pas
 *    en grammes) — cohérent avec la décision verrouillée : une préparation
 *    de recette portion est préparée "en portions", pas en grammes.
 */
export function preparationAsVirtualFood(preparation, foodsById) {
  const snapshot = preparation.recipeSnapshot;
  const m = recipeMacrosPer100g(snapshot, foodsById);
  if (snapshot?.kind === 'portion') {
    const portionGrams = portionGramsOf(snapshot);
    const preparedPortions = Math.max(1, Number(preparation.preparedQuantity) || 0);
    return {
      id: preparation.id,
      name: preparation.label,
      category: 'preparation_portion',
      kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, fiber: m.fiber,
      referenceState: 'pret',
      cookedFactor: 1,
      gramsPerUnit: portionGrams,
      unitName: 'portion',
      fractionable: false,
      isPreparation: true,
      recipeProfile: { min: portionGrams, max: preparedPortions * portionGrams, def: portionGrams, eCat: m.kcal > 0 ? m.kcal : 100 },
    };
  }
  const def = Math.max(1, Number(preparation.preparedQuantity) || 0);
  return {
    id: preparation.id,
    name: preparation.label,
    category: 'preparation_weight',
    kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat, fiber: m.fiber,
    referenceState: 'pret',
    cookedFactor: 1,
    gramsPerUnit: 0,
    fractionable: true,
    isPreparation: true,
    recipeProfile: { min: Math.max(1, def / 10), max: def, def, eCat: m.kcal > 0 ? m.kcal : 100 },
  };
}

/**
 * Résout l'aliment (réel ou virtuel) représenté par un item, pour un des
 * trois chemins possibles (`foodId` inchangé ; `recipeId` ; `preparationId`,
 * via le snapshot figé) — `weight` (Type A) et `portion` (Type B, étape 9)
 * traités identiquement du point de vue de cette résolution, la différence
 * vit entièrement dans `recipeAsVirtualFood()`/`preparationAsVirtualFood()`.
 * Factorisée pour que `mealMacros()` et `adjustQuantities()` résolvent un
 * item exactement de la même façon. Exportée pour que l'éditeur de repas
 * (`editor.js`) résolve, lui aussi, l'aliment réel OU virtuel d'un item
 * avant de lire ses propriétés d'unité (`isWholeUnitFood`, `gramsPerUnit`…) —
 * même résolution, aucune logique dupliquée.
 */
export function resolveItemFood(it, foodsById, recipesById, preparationsById = {}) {
  if (it.foodId) return foodsById[it.foodId] || null;
  if (it.recipeId) {
    const recipe = recipesById[it.recipeId];
    return recipe ? recipeAsVirtualFood(recipe, foodsById) : null;
  }
  if (it.preparationId) {
    const prep = preparationsById[it.preparationId];
    return prep && prep.recipeSnapshot ? preparationAsVirtualFood(prep, foodsById) : null;
  }
  return null; // ingrédient libre
}

/* ------------------------------------------------------------------ */
/* Écarts / tolérance                                                  */
/* ------------------------------------------------------------------ */

export const MACRO_KEYS = [
  { key: 'kcal', target: 'kcal', label: 'kcal', unit: '' },
  { key: 'protein', target: 'protein', label: 'P', unit: 'g' },
  { key: 'carbs', target: 'carbs', label: 'G', unit: 'g' },
  { key: 'fat', target: 'fat', label: 'L', unit: 'g' },
];

/**
 * Statut d'une valeur par rapport à sa cible.
 *  ok   : dans ±tolérance (5 % par défaut)
 *  warn : hors cible mais proche (jusqu'à 3× la tolérance)
 *  off  : très éloigné
 */
export function statusFor(value, target, tolerance = 0.05) {
  if (!target) return 'none';
  const dev = Math.abs(value - target) / target;
  if (dev <= tolerance) return 'ok';
  if (dev <= tolerance * 3) return 'warn';
  return 'off';
}

/**
 * Statut d'affichage d'UNE macro, tenant compte de son rôle (P1.1, décision
 * verrouillée) — distinct de `macroCost()` (fonction de coût de
 * l'optimiseur, v1.5.0.7, non modifiée) : les seuils ci-dessous sont propres
 * à l'affichage utilisateur, réutilisent uniquement la classification
 * plafond/plancher/souple de `MACRO_ROLE`, jamais ses poids/constantes.
 *
 *  kcal    (plafond) : [-t, 0]   → ok · < -t → warn · > 0 → off (jamais rouge par déficit)
 *  fat     (plafond) : <= 0      → ok · ]0, t] → warn · > t → off
 *  protein (plancher): < -t      → off · [-t, 0[ → warn · [0, 3t] → ok · > 3t → warn
 *  carbs   (souple)  : identique à statusFor() (symétrique, inchangé)
 */
export function statusForKey(key, value, target, tolerance = 0.05) {
  if (!target) return 'none';
  const dev = (value - target) / target;
  const role = MACRO_ROLE[key];
  if (role === 'ceiling') {
    if (key === 'fat') {
      if (dev <= 0) return 'ok';
      if (dev <= tolerance) return 'warn';
      return 'off';
    }
    // kcal
    if (dev > 0) return 'off';
    if (dev >= -tolerance) return 'ok';
    return 'warn';
  }
  if (role === 'floor') {
    // protein
    if (dev < -tolerance) return 'off';
    if (dev < 0) return 'warn';
    if (dev <= tolerance * 3) return 'ok';
    return 'warn';
  }
  // 'soft' (carbs) et tout cas non couvert : comportement symétrique existant, inchangé
  return statusFor(value, target, tolerance);
}

/** Évaluation complète d'un repas pour une personne. */
export function evaluate(macros, target, tolerance = 0.05) {
  const rows = MACRO_KEYS.map(({ key, label }) => {
    const value = macros[key] || 0;
    const goal = target?.[key] || 0;
    return {
      key,
      label,
      value,
      target: goal,
      delta: value - goal,
      status: statusForKey(key, value, goal, tolerance),
    };
  });
  const worst = rows.reduce(
    (acc, r) => (r.status === 'off' ? 'off' : r.status === 'warn' && acc !== 'off' ? 'warn' : acc),
    'ok'
  );
  return { rows, status: worst };
}

/* ------------------------------------------------------------------ */
/* Ajustement automatique                                              */
/* ------------------------------------------------------------------ */

/**
 * Coût asymétrique par macro (décision verrouillée, calibration validée) :
 * kcal et lipides sont des PLAFONDS (dépasser la cible est fortement pénalisé,
 * être en dessous est acceptable) ; les protéines sont un PLANCHER SOUPLE
 * (être en dessous est pénalisé, dépasser est largement toléré mais jamais
 * gratuit) ; les glucides restent un objectif SOUPLE et SYMÉTRIQUE, nettement
 * secondaire (ils ne doivent jamais prendre le dessus sur kcal/lipides/protéines).
 *
 * Priorité résultante : kcal > lipides > protéines > glucides.
 *
 * Chaque macro a un poids "côté indolore" (W_SOFT) et un poids "côté pénalisé"
 * (W_HARD) selon le SIGNE de l'écart (cf. macroCost()) — une simple pondération
 * symétrique (l'ancien WEIGHTS) ne peut pas exprimer cette asymétrie, puisque
 * welschLoss(d) ne dépend que de d². Le côté pénalisé utilise en plus une
 * constante de saturation (C_HARD) plus large que celle du côté indolore
 * (C_SOFT = l'ancien WELSCH_C) : le "coude" où la perte de Welsch cesse de
 * réagir à l'écart recule, pour que la pression de retour reste sensible sur
 * une plage de dépassement plus large — sans jamais devenir un coût non borné
 * (on conserve la philosophie Welsch : jamais de composition absurde pour une
 * cible structurellement inatteignable).
 *
 * Rappel historique conservé : les kcal restent, par construction, largement
 * redondantes avec P/C/L (≈ 4P + 4C + 9L) — ce n'est plus géré en sous-pondérant
 * kcal en permanence (ancien WEIGHTS.kcal = 0.35), mais en acceptant sans frais
 * un léger déficit calorique (W_SOFT.kcal) : la même intention (ne pas gonfler
 * les macros pour combler un manque de kcal), exprimée par le signe plutôt que
 * par une pondération globale.
 */
export const MACRO_ROLE = { kcal: 'ceiling', fat: 'ceiling', protein: 'floor', carbs: 'soft' };
/** Poids côté indolore (sous la cible pour un plafond, au-dessus pour un plancher). */
const W_SOFT = { kcal: 0.12, fat: 0.20, protein: 0.12, carbs: 0.60 };
/** Poids côté pénalisé (dépassement d'un plafond, déficit d'un plancher). */
const W_HARD = { kcal: 3.20, fat: 2.00, protein: 1.00, carbs: 0.60 };

/** Arrondi final tenant compte des unités non fractionnables. */
/** Un aliment est-il saisi par unités entières ? (générique : tout aliment non fractionnable) */
export const isUnitFood = (food) => Boolean(food && Number(food.gramsPerUnit) > 0);
export const isWholeUnitFood = (food) => isUnitFood(food) && food.fractionable === false;

/** Grammes -> unités (nombre décimal). */
export const toUnits = (food, grams) => (isUnitFood(food) ? grams / Number(food.gramsPerUnit) : null);

/** Unités -> grammes. */
export const fromUnits = (food, units) => (isUnitFood(food) ? units * Number(food.gramsPerUnit) : units);

/**
 * Rendement après cuisson : coefficient = poids cuit ÷ poids cru.
 * Fonction pure, utilisée par l'aide au calcul de la fiche aliment.
 *   500 g crus → 375 g cuits  ⇒  0,75
 *   500 g crus → 1000 g cuits ⇒  2
 * @returns {{ ok: true, factor: number } | { ok: false, error: string }}
 */
export function computeYield(rawInput, cookedInput) {
  const parse = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  };
  const raw = parse(rawInput);
  const cooked = parse(cookedInput);

  if (raw === null || cooked === null) return { ok: false, error: 'Renseigne le poids cru et le poids cuit.' };
  if (Number.isNaN(raw) || Number.isNaN(cooked)) return { ok: false, error: 'Les poids doivent être des nombres.' };
  if (raw < 0 || cooked < 0) return { ok: false, error: 'Les poids ne peuvent pas être négatifs.' };
  if (raw === 0) return { ok: false, error: 'Le poids cru ne peut pas être nul.' };
  if (cooked === 0) return { ok: false, error: 'Le poids cuit ne peut pas être nul.' };

  return { ok: true, factor: Math.round((cooked / raw) * 10000) / 10000 };
}

/** Pas de saisie d'une quantité : le poids d'une unité pour un aliment non fractionnable. */
export function quantityStep(food, { inUnits = false } = {}) {
  if (inUnits) return isWholeUnitFood(food) ? 1 : 0.5;
  if (isWholeUnitFood(food)) return Number(food.gramsPerUnit);
  return 1;
}

/**
 * Contrainte ABSOLUE sur les quantités : un aliment non fractionnable ne peut
 * exister qu'en multiples entiers de gramsPerUnit, quelle que soit la manière
 * dont la quantité a été obtenue (saisie en grammes, saisie en unités,
 * ajustement automatique, duplication, import…).
 * 0 g reste possible : l'ingrédient est alors simplement absent pour la personne.
 */
export function snapQuantity(food, qty) {
  const value = Math.max(0, Number(qty) || 0);
  if (!isWholeUnitFood(food)) return value;
  if (value <= 0) return 0;
  const g = Number(food.gramsPerUnit);
  return Math.max(1, Math.round(value / g)) * g;
}

export function roundQuantity(food, qty, min = 0, max = Infinity) {
  // Aliment non fractionnable : uniquement des unités entières (jamais 1,37 œuf).
  if (isWholeUnitFood(food)) {
    const g = Number(food.gramsPerUnit);
    let units = Math.max(1, Math.round(qty / g));
    if (units * g > max) units = Math.max(1, Math.floor(max / g));
    if (units * g < min) units = Math.ceil(min / g);
    return units * g;
  }
  // Aliment fractionnable : résolution au gramme près. `p.step` ne sert plus
  // qu'au pas d'incrémentation du champ de saisie (quantityStep) — jamais à la
  // recherche ni à l'arrondi final, qui imposaient auparavant des paliers de
  // catégorie (5 g, 10 g) sans rapport avec la précision réellement possible.
  return clamp(Math.round(qty), min, max);
}

/**
 * Quantité initiale proposée lors de l'ajout d'un aliment.
 * On part du défaut de catégorie ; l'ajustement continu fera le reste.
 */
export function initialQuantity(food) {
  const p = profileOf(food);
  return roundQuantity(food, p.def);
}

/**
 * Perte bornée (Welsch) : quadratique près de zéro, mais son gradient sature
 * puis décroît au-delà d'un certain écart, au lieu de croître indéfiniment
 * (perte de Huber, essayée puis abandonnée : sur une cible structurellement
 * inatteignable, elle tire les ingrédients jusqu'à leur borne maximale).
 * `C` fixe l'échelle à laquelle la perte « accepte » de manquer la cible
 * plutôt que de produire une composition absurde.
 */
const C_SOFT = 0.08; // côté indolore (= ancien WELSCH_C, inchangé)
/** Côté pénalisé (dépassement d'un plafond, déficit d'un plancher) : le coude
 * de saturation recule, pour que la pression de retour reste sensible sur une
 * plage de dépassement plus large — toujours borné, jamais un coût infini. */
const C_HARD = 0.30;

/** Poids de la pénalité de disproportion (dispersion + échelle globale). */
const BETA = 0.006;
/** Poids du terme d'échelle globale à l'intérieur de la pénalité. */
const GAMMA = 3;

const welschLoss = (d, C = C_SOFT) => C * (1 - Math.exp(-(d * d) / (2 * C)));

/**
 * Coût d'une macro pour un écart relatif signé `d = (valeur - cible) / cible`.
 * Point d'entrée UNIQUE de l'asymétrie plafond/plancher/souple (cf. commentaire
 * de MACRO_ROLE/W_SOFT/W_HARD ci-dessus) — utilisé identiquement par `costOf()`
 * et par `costAt()` dans `solveFromStart()`, pour qu'ils ne puissent jamais diverger.
 */
export function macroCost(k, d) {
  const role = MACRO_ROLE[k];
  if (role === 'soft') return W_HARD[k] * welschLoss(d, C_SOFT); // glucides : symétrique
  const bad = role === 'ceiling' ? d > 0 : d < 0;
  const w = bad ? W_HARD[k] : W_SOFT[k];
  const C = bad ? C_HARD : C_SOFT;
  return w * welschLoss(d, C);
}

const GOLDEN = (Math.sqrt(5) - 1) / 2;

/** Minimum d'une fonction 1D sur [a, b] par recherche en section dorée. */
function goldenSectionMin(f, a, b, iterations = 24) {
  let x1 = b - GOLDEN * (b - a);
  let x2 = a + GOLDEN * (b - a);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let i = 0; i < iterations; i++) {
    if (f1 <= f2) {
      b = x2; x2 = x1; f2 = f1;
      x1 = b - GOLDEN * (b - a); f1 = f(x1);
    } else {
      a = x1; x1 = x2; f1 = f2;
      x2 = a + GOLDEN * (b - a); f2 = f(x2);
    }
  }
  const x = (a + b) / 2;
  return { x, f: f(x) };
}

/**
 * Minimisation 1D sur [lo, hi] par grille de 48 points puis section dorée
 * autour de CHAQUE vallée détectée (minimum local de la grille). Le coût
 * n'est pas garanti unimodal (mesuré : des minima locaux existent) — une
 * simple recherche ternaire échouerait sur ces cas. Retenu après comparaison :
 * zéro échec, pour un nombre d'évaluations très inférieur à la recherche ternaire.
 */
function minimize1D(f, lo, hi, gridPoints = 48) {
  if (!(hi > lo)) { const x = lo; return { x, f: f(x) }; }
  const xs = new Array(gridPoints);
  const fs = new Array(gridPoints);
  for (let i = 0; i < gridPoints; i++) {
    xs[i] = lo + ((hi - lo) * i) / (gridPoints - 1);
    fs[i] = f(xs[i]);
  }
  let best = { x: xs[0], f: fs[0] };
  for (let i = 1; i < gridPoints; i++) if (fs[i] < best.f) best = { x: xs[i], f: fs[i] };
  for (let i = 0; i < gridPoints; i++) {
    const isValley = (i === 0 || fs[i] <= fs[i - 1]) && (i === gridPoints - 1 || fs[i] <= fs[i + 1]);
    if (!isValley) continue;
    const a = xs[Math.max(0, i - 1)];
    const b = xs[Math.min(gridPoints - 1, i + 1)];
    const refined = goldenSectionMin(f, a, b);
    if (refined.f < best.f) best = refined;
  }
  return best;
}

const MACRO_ORDER = ['kcal', 'protein', 'carbs', 'fat'];

/**
 * Résout l'ajustement par descente par coordonnées EN ESPACE LOGARITHMIQUE
 * (x = ln q), à partir d'un jeu de quantités de départ donné par `startOf`.
 * Chaque coordonnée est minimisée par `minimize1D` sur le coût complet ; les
 * contributions des autres variables sont gelées pendant cette minimisation
 * (Gauss-Seidel), ce qui rend chaque évaluation de coût en O(1).
 */
function solveFromStart(vars, fixed, t, startOf, iterations) {
  const n = vars.length;
  const q = vars.map((v) => clamp(startOf(v), v.min, v.max));
  const refLn = vars.map((v) => Math.log(v.ref));
  const u = q.map((qi, i) => Math.log(qi) - refLn[i]);

  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (let i = 0; i < n; i++) for (const k of MACRO_ORDER) sum[k] += vars[i].per1[k] * q[i];

  for (let iter = 0; iter < iterations; iter++) {
    let move = 0;
    for (let i = 0; i < n; i++) {
      const v = vars[i];
      const sumOthers = {};
      for (const k of MACRO_ORDER) sumOthers[k] = sum[k] - v.per1[k] * q[i];
      let sumU = 0;
      let sumU2 = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        sumU += u[j];
        sumU2 += u[j] * u[j];
      }

      const costAt = (x) => {
        const qi = Math.exp(x);
        let mCost = 0;
        for (const k of MACRO_ORDER) {
          const val = sumOthers[k] + v.per1[k] * qi;
          const d = (val + fixed[k] - t[k]) / t[k];
          mCost += macroCost(k, d);
        }
        const ui = x - refLn[i];
        const s1 = sumU + ui;
        const s2 = sumU2 + ui * ui;
        const dispersion = s2 - (s1 * s1) / n;
        const scaleTerm = (GAMMA * s1 * s1) / n;
        return mCost + BETA * (dispersion + scaleTerm);
      };

      const { x } = minimize1D(costAt, Math.log(v.min), Math.log(v.max));
      const nextQ = clamp(Math.exp(x), v.min, v.max);
      move = Math.max(move, Math.abs(nextQ - q[i]));
      for (const k of MACRO_ORDER) sum[k] = sumOthers[k] + v.per1[k] * nextQ;
      q[i] = nextQ;
      u[i] = Math.log(nextQ) - refLn[i];
    }
    if (move < 0.05) break;
  }

  return { q, cost: costOf(vars, fixed, t, q) };
}

/** Coût total (même formule que `solveFromStart`) pour un vecteur de quantités déjà fixé. */
function costOf(vars, fixed, t, q) {
  const n = vars.length;
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (let i = 0; i < n; i++) for (const k of MACRO_ORDER) sum[k] += vars[i].per1[k] * q[i];
  let mCost = 0;
  for (const k of MACRO_ORDER) {
    const d = (sum[k] + fixed[k] - t[k]) / t[k];
    mCost += macroCost(k, d);
  }
  const u = q.map((qi, i) => Math.log(qi / vars[i].ref));
  const meanU = n ? u.reduce((s, x) => s + x, 0) / n : 0;
  const dispersion = u.reduce((s, x) => s + (x - meanU) ** 2, 0);
  return mCost + BETA * (dispersion + GAMMA * n * meanU * meanU);
}

/**
 * Ramène le résultat continu à des quantités réellement accessibles.
 *
 * Un aliment non fractionnable (`isWholeUnitFood`) ne peut exister qu'en
 * multiples entiers de son poids par unité. `roundQuantity()` le fait déjà,
 * mais SEULE, indépendamment par variable, elle ne redonne jamais la main
 * aux autres variables : l'écart introduit par le palier n'est alors jamais
 * compensé, et un repas peut sortir de la tolérance macro alors qu'une
 * composition tout aussi proche des bornes et des pas existants l'aurait
 * respectée (cause identifiée : régression V1.4, cf. Test J).
 *
 * Principe : pour chaque aliment non fractionnable, le palier le plus proche
 * de l'optimum continu est UN candidat ; son palier voisin immédiat — celui
 * que l'arrondi au plus proche écarte de justesse — en est un second. Pour
 * chaque combinaison candidate, les aliments non fractionnables sont figés à
 * leur palier (même mécanisme que le verrouillage : contribution fixe), puis
 * les variables FRACTIONNABLES restantes sont réoptimisées avec le même
 * `solveFromStart`, le même coût, le même multi-départ — rien de nouveau
 * n'est introduit, aucun terme spécifique à un aliment. La combinaison
 * retenue est celle de coût total le plus bas.
 *
 * Bornée explicitement à 1 + k candidats (k = nombre d'aliments non
 * fractionnables déverrouillés) : la combinaison « tous au palier le plus
 * proche », puis un seul palier voisin exploré À LA FOIS pour chacun — jamais
 * le produit cartésien 2^k. Si aucun aliment non fractionnable n'est présent,
 * c'est un no-op strict : comportement identique à avant cette fonction.
 */
function roundForFinalQuantities(vars, fixed, t, best, starts, iterations) {
  const wholeIdx = [];
  for (let i = 0; i < vars.length; i++) if (isWholeUnitFood(vars[i].food)) wholeIdx.push(i);

  if (!wholeIdx.length) {
    return vars.map((v, i) => roundQuantity(v.food, clamp(best.q[i], v.min, v.max), v.min, v.max));
  }

  // pour chaque aliment non fractionnable : palier le plus proche + palier voisin écarté de justesse
  const nearest = {};
  const alt = {};
  for (const i of wholeIdx) {
    const v = vars[i];
    const g = Number(v.food.gramsPerUnit);
    const q = clamp(best.q[i], v.min, v.max);
    const kMin = Math.max(1, Math.ceil(v.min / g));
    const kMax = Math.max(kMin, Math.floor(v.max / g));
    const kNearest = clamp(Math.round(q / g), kMin, kMax);
    const kFloor = clamp(Math.floor(q / g), kMin, kMax);
    const kCeil = clamp(Math.ceil(q / g), kMin, kMax);
    const kAlt = kNearest === kFloor ? kCeil : kFloor;
    nearest[i] = kNearest * g;
    alt[i] = kAlt !== kNearest ? kAlt * g : null; // pas de second palier distinct (borne atteinte)
  }

  const others = vars.filter((_, i) => !wholeIdx.includes(i));

  /** Fige les aliments non fractionnables aux quantités données, réoptimise le reste. */
  function evaluate(wholeQty) {
    const fixed2 = { ...fixed };
    for (const i of wholeIdx) for (const k of MACRO_ORDER) fixed2[k] += vars[i].per1[k] * wholeQty[i];
    let localBest = null;
    for (const startOf of starts) {
      const r = solveFromStart(others, fixed2, t, startOf, iterations);
      if (!localBest || r.cost < localBest.cost - 1e-9) localBest = r;
    }
    const roundedOthers = others.map((v, i) => roundQuantity(v.food, clamp(localBest.q[i], v.min, v.max), v.min, v.max));
    const full = new Array(vars.length);
    let oi = 0;
    for (let i = 0; i < vars.length; i++) full[i] = wholeIdx.includes(i) ? wholeQty[i] : roundedOthers[oi++];
    return { full, cost: costOf(vars, fixed, t, full) };
  }

  const baseline = {};
  for (const i of wholeIdx) baseline[i] = nearest[i];
  let bestCandidate = evaluate(baseline);

  // un seul palier voisin exploré À LA FOIS (jamais le produit cartésien) :
  // borné à k candidats supplémentaires, k = nombre d'aliments non fractionnables.
  for (const i of wholeIdx) {
    if (alt[i] === null) continue;
    const evaluated = evaluate({ ...baseline, [i]: alt[i] });
    if (evaluated.cost < bestCandidate.cost - 1e-9) bestCandidate = evaluated;
  }

  return bestCandidate.full;
}

/**
 * Cœur de l'application : ajuste les quantités des ingrédients DÉVERROUILLÉS
 * pour rapprocher simultanément kcal / P / G / L des objectifs — architecture C.
 *
 * Coût minimisé, par personne :
 *   Σ_macro  macroCost( macro, (valeur - cible) / cible )
 *     + β · [ Σᵢ (uᵢ - ū)²  +  γ · n · ū² ]
 *   avec  uᵢ = ln(qᵢ / réfᵢ)  (réfᵢ = referenceFor(food), architecture C)
 *         macroCost(k, d) = perte bornée de Welsch, ASYMÉTRIQUE selon le rôle
 *         de la macro (plafond/plancher/souple — cf. MACRO_ROLE/W_SOFT/W_HARD)
 *
 * Le premier terme rapproche les 4 macros de leurs cibles avec une perte qui
 * « accepte » de manquer une cible structurellement inatteignable plutôt que
 * de produire une composition absurde. Le second est une pénalité de
 * disproportion (jamais une interdiction) fondée sur des VARIATIONS RELATIVES
 * par rapport aux références de catégorie : elle pénalise un ingrédient qui
 * s'écarte des autres (dispersion) et un repas globalement gonflé ou rétréci
 * (échelle). Il n'y a plus d'ancrage sur la quantité de départ : un aliment
 * mal saisi au départ n'est plus jamais figé.
 *
 * Minimisation : descente par coordonnées en espace logarithmique, chaque
 * coordonnée résolue par grille 48 points + section dorée (le coût 1D n'est
 * pas garanti unimodal). Multi-départ (quantité actuelle, référence, quantité
 * mise à l'échelle du besoin calorique) : on retient le résultat de coût le
 * plus bas, pour éviter de rester bloqué dans un minimum local médiocre.
 *
 * Arrondi final (`roundForFinalQuantities`) : pour un aliment non
 * fractionnable, le palier le plus proche de l'optimum continu et son palier
 * voisin sont chacun essayés, les variables fractionnables étant à chaque
 * fois réoptimisées autour — sinon l'écart introduit par le palier n'est
 * jamais compensé par le reste du repas.
 *
 * Garanties :
 *  - aucun ingrédient n'est ajouté ni supprimé ;
 *  - un ingrédient verrouillé n'est jamais modifié ;
 *  - les ingrédients libres (sans foodId) sont ignorés ;
 *  - aucun plafond de masse spécifique à une catégorie, aucun terme de volume
 *    dans ce coût (le volume d'un repas est une couche séparée, informative).
 *
 * @returns {{quantities: Object<string, number>, changed: boolean}}
 *          quantités par identifiant d'ingrédient (seuls les déverrouillés changent).
 */
/**
 * Construit `vars[]`/`fixed{}` à partir d'une liste d'items — cœur commun de
 * `adjustQuantities()` et de `resolveZeroWasteAllocation()` (étape 8), pour
 * qu'un item soit résolu EXACTEMENT de la même façon dans les deux cas.
 *
 * `forced` (optionnel, `{}` par défaut) : `{ itemId: grammes }` — traite cet
 * item comme verrouillé à CETTE quantité précise, quelle que soit sa
 * quantité stockée ou son propre `locked`. C'est le seul mécanisme dont a
 * besoin le mode zéro reste : imposer la quantité d'UN item (celui qui tire
 * sur la préparation) pendant que les autres se réoptimisent autour.
 */
function buildVarsAndFixed(items, foodsById, recipesById, preparationsById, person, pinned, preparationAvailability, forced = {}) {
  const vars = [];
  const fixed = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

  for (const it of items) {
    const isForced = Object.prototype.hasOwnProperty.call(forced, it.id);
    const qty = isForced ? forced[it.id] : it.qty?.[person] || 0;
    if (!it.foodId && !it.recipeId && !it.preparationId) continue;
    // quantité nulle = ingrédient absent pour cette personne : on l'ignore
    // (sauf si elle est explicitement imposée à 0 par le mode zéro reste)
    if (qty <= 0 && !isForced) continue;
    const food = resolveItemFood(it, foodsById, recipesById, preparationsById);
    if (!food) continue;
    // "épinglé" = quantité saisie à l'instant par l'utilisateur : traitée comme fixe
    const locked = isForced || !!it.locked?.[person] || pinned.has(it.id);
    const m = macrosFor(food, qty, it.state);
    // conversion impossible : on laisse la quantité telle quelle et on ne
    // l'intègre à aucun calcul (ni contribution fixe, ni variable d'ajustement)
    if (m.unconvertible) continue;
    const hasEnergy = (food.kcal || 0) > 0 || (food.protein || 0) > 0 || (food.carbs || 0) > 0 || (food.fat || 0) > 0;

    if (locked || !hasEnergy) {
      fixed.kcal += m.kcal;
      fixed.protein += m.protein;
      fixed.carbs += m.carbs;
      fixed.fat += m.fat;
      continue;
    }

    // contribution par gramme (dans l'état de l'ingrédient)
    const per1 = macrosFor(food, 1, it.state);
    const p = profileOf(food);
    let max = p.max;
    let min = p.min;
    if (it.preparationId && preparationAvailability[it.preparationId] !== undefined) {
      // le disponible fourni exclut déjà la contribution COURANTE de cet item
      // (calculé sur tout le cycle) : on la lui rend, pour que sa propre borne
      // reflète "ce qu'il reste, lui compris" plutôt que de le pénaliser lui-même.
      const available = preparationAvailability[it.preparationId];
      max = Math.max(0, Math.min(p.max, available + qty));
      min = Math.min(min, max); // un disponible faible ne doit jamais rendre min > max
    }
    vars.push({
      id: it.id,
      food,
      per1,
      min,
      max,
      ref: referenceFor(food),
      q0: qty,
    });
  }
  return { vars, fixed };
}

export function adjustQuantities(items, foodsById, target, person, options = {}) {
  const iterations = options.iterations ?? 60;
  const result = {};
  if (!target) return { quantities: result, changed: false };

  const pinned = new Set(options.pinned || []);
  // {} par défaut : chemin additif, comportement des items foodId inchangé
  // quand aucune recette/préparation n'est passée (aucun appelant existant
  // n'en a besoin tant qu'il ne manipule que des foodId).
  const recipesById = options.recipesById || {};
  const preparationsById = options.preparationsById || {};
  // disponible RÉEL par préparation (cycle entier), calculé par l'appelant
  // (nutrition.js ne connaît ni l'état global ni derive.js) — mode normal
  // uniquement (§8) : une contrainte D'INÉGALITÉ, jamais d'égalité ici.
  const preparationAvailability = options.preparationAvailability || {};

  const { vars, fixed } = buildVarsAndFixed(items, foodsById, recipesById, preparationsById, person, pinned, preparationAvailability);

  if (!vars.length) return { quantities: result, changed: false };

  const t = {
    kcal: Math.max(1, target.kcal || 0),
    protein: Math.max(1, target.protein || 0),
    carbs: Math.max(1, target.carbs || 0),
    fat: Math.max(1, target.fat || 0),
  };

  // départ « quantité actuelle mise à l'échelle du besoin calorique »
  const currentKcal = fixed.kcal + vars.reduce((s, v) => s + v.per1.kcal * v.q0, 0);
  const scaleFactor = currentKcal > 0 ? clamp(t.kcal / currentKcal, 0.1, 10) : 1;

  const starts = [(v) => v.q0, (v) => v.ref, (v) => v.q0 * scaleFactor];

  let best = null;
  for (const startOf of starts) {
    const r = solveFromStart(vars, fixed, t, startOf, iterations);
    if (!best || r.cost < best.cost - 1e-9) best = r;
  }

  const rounded = roundForFinalQuantities(vars, fixed, t, best, starts, iterations);

  let changed = false;
  for (let i = 0; i < vars.length; i++) {
    result[vars[i].id] = rounded[i];
    if (Math.abs(rounded[i] - vars[i].q0) > 0.001) changed = true;
  }
  return { quantities: result, changed };
}

/**
 * MODE ZÉRO RESTE (étape 8, point important n°2) — répartit EXACTEMENT
 * `preparedQuantity` entre N "créneaux" (un par item `zeroWaste:true`
 * référençant la même préparation, chacun dans son propre repas/personne) :
 *
 *     Σ allocation[i] === preparedQuantity     (égalité STRICTE, prioritaire)
 *
 * Les objectifs nutritionnels restent l'objectif d'optimisation SECONDAIRE :
 * ils choisissent la MEILLEURE répartition parmi celles qui respectent
 * l'égalité, mais ne peuvent jamais l'empêcher d'être satisfaite (§24 — en
 * cas de conflit, l'égalité de stock prime sur l'exactitude nutritionnelle).
 *
 * Algorithme : N−1 allocations LIBRES, la Nième = preparedQuantity − Σ(autres)
 * — jamais N variables indépendantes, qui pourraient violer l'égalité par
 * construction. Descente par coordonnées sur ces N−1 allocations, chaque
 * coordonnée résolue par `minimize1D` : EXACTEMENT le même schéma que
 * `solveFromStart()`, un niveau au-dessus (sur des allocations plutôt que
 * sur des grammes d'un aliment). Pour chaque allocation candidate, le repas
 * concerné est réoptimisé NORMALEMENT — même `solveFromStart`/`costOf`/
 * `roundForFinalQuantities` que partout ailleurs, via `buildVarsAndFixed`
 * avec l'item de la préparation imposé (`forced`) — aucune nouvelle
 * mécanique numérique, aucune modification de macroCost/BETA/GAMMA/welschLoss.
 *
 * `slots[i] = { items, itemId, target, person }` : `items` est la liste
 * COMPLÈTE des items du repas concerné (l'item `itemId`, qui référence la
 * préparation, en fait partie) — les AUTRES items de ce même repas se
 * réoptimisent autour de l'allocation imposée à `itemId`.
 *
 * @returns {{ allocation: number[], quantities: Object<string,number>[] }}
 *          `allocation[i]` = quantité imposée à l'item zeroWaste du créneau i
 *          (Σ === preparedQuantity, résolution 1 g) ; `quantities[i]` = les
 *          quantités optimisées des AUTRES items de ce créneau (même forme
 *          que le retour de `adjustQuantities()`).
 */
export function resolveZeroWasteAllocation(slots, preparedQuantity, foodsById, recipesById, preparationsById, options = {}) {
  const n = slots.length;
  if (!n) return { allocation: [], quantities: [] };
  const total = Math.max(0, Number(preparedQuantity) || 0);
  const innerIterations = options.innerIterations ?? 30;
  const outerIterations = options.outerIterations ?? 20;
  // pas d'arrondi final : 1 g pour une préparation `weight`, le poids d'une
  // portion pour une préparation `portion` (les portions restent entières —
  // réutilise le même principe que roundQuantity/roundForFinalQuantities,
  // jamais une mécanique nouvelle). `total` est TOUJOURS un multiple de
  // `roundStep` par construction (preparedGramsOf = portions × portionGrams),
  // donc le dernier créneau absorbe un reliquat qui est lui aussi un multiple
  // exact — l'égalité ET la granularité sont préservées simultanément.
  const roundStep = Math.max(1, Number(options.roundStep) || 1);

  const targetOf = (target) => ({
    kcal: Math.max(1, target?.kcal || 0),
    protein: Math.max(1, target?.protein || 0),
    carbs: Math.max(1, target?.carbs || 0),
    fat: Math.max(1, target?.fat || 0),
  });

  /** Réoptimise un créneau, l'item zéro reste étant imposé à `qty` grammes. */
  function solveSlot(slot, qty) {
    const { vars, fixed } = buildVarsAndFixed(
      slot.items, foodsById, recipesById, preparationsById, slot.person,
      new Set(), {}, { [slot.itemId]: qty }
    );
    const t = targetOf(slot.target);
    if (!vars.length) return { quantities: {}, cost: costOf(vars, fixed, t, []) };
    const starts = [(v) => v.q0, (v) => v.ref];
    let best = null;
    for (const startOf of starts) {
      const r = solveFromStart(vars, fixed, t, startOf, innerIterations);
      if (!best || r.cost < best.cost - 1e-9) best = r;
    }
    const rounded = roundForFinalQuantities(vars, fixed, t, best, starts, innerIterations);
    const quantities = {};
    for (let i = 0; i < vars.length; i++) quantities[vars[i].id] = rounded[i];
    return { quantities, cost: costOf(vars, fixed, t, rounded) };
  }

  function evaluate(alloc) {
    let totalCost = 0;
    const results = new Array(n);
    for (let i = 0; i < n; i++) {
      results[i] = solveSlot(slots[i], alloc[i]);
      totalCost += results[i].cost;
    }
    return { totalCost, results };
  }

  // point de départ : répartition égale (toujours dans le domaine [0, total])
  let alloc = new Array(n).fill(total / n);

  if (n > 1) {
    for (let iter = 0; iter < outerIterations; iter++) {
      let move = 0;
      for (let i = 0; i < n - 1; i++) {
        // la dernière allocation N'EST JAMAIS une variable libre : elle absorbe
        // toujours exactement ce qu'il reste, ce qui GARANTIT l'égalité à
        // chaque candidat évalué, y compris avant convergence de la descente.
        let fixedSumOthers = 0;
        for (let j = 0; j < n; j++) if (j !== i && j !== n - 1) fixedSumOthers += alloc[j];

        const costAt = (x) => {
          const last = total - x - fixedSumOthers;
          if (x < 0 || x > total || last < 0) return Infinity; // hors domaine : jamais retenu
          const candidate = alloc.slice();
          candidate[i] = x;
          candidate[n - 1] = last;
          return evaluate(candidate).totalCost;
        };
        const { x } = minimize1D(costAt, 0, total, 24);
        const last = total - x - fixedSumOthers;
        if (last < 0) continue;
        move = Math.max(move, Math.abs(x - alloc[i]));
        alloc[i] = x;
        alloc[n - 1] = last;
      }
      if (move < 0.5) break;
    }
  }

  // arrondi final (résolution `roundStep`) : la dernière allocation absorbe
  // l'écart d'arrondi pour préserver l'égalité EXACTE — priorité absolue (§24).
  const roundedAlloc = alloc.map((v) => Math.round(v / roundStep) * roundStep);
  const sumRounded = roundedAlloc.reduce((s, v) => s + v, 0);
  roundedAlloc[n - 1] += total - sumRounded;

  const finalEval = evaluate(roundedAlloc);
  return { allocation: roundedAlloc, quantities: finalEval.results.map((r) => r.quantities) };
}

/**
 * Applique l'ajustement automatique sur une liste d'ingrédients (mutation locale
 * d'une copie) pour les deux personnes, en fonction des objectifs du repas.
 */
export function autoAdjust(items, foodsById, targets, options = {}) {
  const persons = options.persons || PERSONS;
  for (const person of persons) {
    const { quantities } = adjustQuantities(items, foodsById, targets[person], person, options);
    for (const it of items) {
      if (quantities[it.id] !== undefined) {
        it.qty[person] = quantities[it.id];
      }
    }
  }
  return items;
}

/**
 * Diagnostic : qu'est-ce qui manque / est en excès quand la cible n'est pas atteignable ?
 * Ne modifie rien, ne propose que de l'information.
 */
export function diagnose(macros, target, foods, tolerance = 0.05) {
  const ev = evaluate(macros, target, tolerance);
  const problems = ev.rows.filter((r) => r.status !== 'ok');
  if (!problems.length) return null;

  const suggestions = [];
  for (const p of problems) {
    const missing = p.delta < 0;
    if (p.key === 'protein' && missing) suggestions.push('protéine maigre (blanc de poulet, skyr, whey)');
    if (p.key === 'carbs' && missing) suggestions.push('féculent (riz, pâtes, pain)');
    if (p.key === 'fat' && missing) suggestions.push('matière grasse (huile, oléagineux)');
    if (p.key === 'kcal' && missing && !suggestions.length) suggestions.push('féculent ou matière grasse');
  }
  return {
    rows: problems,
    suggestions: [...new Set(suggestions)],
  };
}
