/**
 * Calculs dérivés du cycle : batch cooking, liste de courses, budget, suggestions.
 * Aucune de ces fonctions ne modifie le planning.
 */

import {
  convertGrams, toReferenceGrams, PERSONS, mealMacros, preparedGramsOf, portionGramsOf,
  MEAL_TYPES, resolveZeroWasteAllocation,
} from './nutrition.js';
import { dayName } from './util.js';

/** Utilisations totales d'une option de catalogue, par personne. */
export function optionUses(option, kind) {
  if (kind === 'breakfast') {
    return { thomas: Number(option.uses?.thomas) || 0, julie: Number(option.uses?.julie) || 0 };
  }
  const total = (p) => (Number(option.uses?.[p]?.afternoon) || 0) + (Number(option.uses?.[p]?.evening) || 0);
  return { thomas: total('thomas'), julie: total('julie') };
}

/**
 * Sources d'un cycle : les repas du planning (déjeuners/dîners) + les options
 * de catalogue effectivement utilisées. Les catalogues restent indépendants des
 * jours : seuls leurs compteurs d'utilisation les font entrer dans le cycle.
 * Chaque source porte un facteur PAR PERSONNE, car Thomas et Julie peuvent
 * utiliser une même option un nombre de fois différent.
 */
export function cycleSources(state) {
  const sources = state.meals.map((m) => ({
    items: m.items,
    factors: { thomas: 1, julie: 1 },
    meal: m,
    dayIndex: m.dayIndex,
    mealType: m.mealType,
  }));

  for (const [key, kind] of [['breakfasts', 'breakfast'], ['snacks', 'snack']]) {
    for (const option of state[key] || []) {
      const factors = optionUses(option, kind);
      if (factors.thomas > 0 || factors.julie > 0) sources.push({ items: option.items, factors, option, kind });
    }
  }
  return sources;
}

/**
 * Déplie UN item en ses aliments réels : un item `foodId` est retourné tel
 * quel ; un item `recipeId`/`preparationId` est développé en une contribution
 * par ingrédient de la recette (ou du snapshot figé pour une préparation), à
 * l'échelle de SA propre quantité par personne — jamais stocké, recalculé à
 * chaque appel. Un ingrédient libre ne produit rien (pas d'aliment réel).
 * Étape 10 : c'est le SEUL endroit qui traduit une recette/préparation en
 * aliments — `buildBatchPlan`/`buildShoppingList`/`aggregateNeeds` restent
 * ignorants du concept de recette, exactement comme `meal-volume.js`.
 */
function deployItem(it, recipesById, preparationsById) {
  if (it.foodId) return [it];
  let composition;
  let base;
  if (it.recipeId) {
    const recipe = recipesById[it.recipeId];
    if (!recipe) return [];
    composition = recipe.items;
    base = recipe.kind === 'portion' ? portionGramsOf(recipe) : Number(recipe.baseGrams) || 0;
  } else if (it.preparationId) {
    const prep = preparationsById[it.preparationId];
    if (!prep?.recipeSnapshot) return [];
    composition = prep.recipeSnapshot.items;
    base = prep.recipeSnapshot.kind === 'portion' ? portionGramsOf(prep.recipeSnapshot) : Number(prep.recipeSnapshot.baseGrams) || 0;
  } else {
    return []; // ingrédient libre : aucun aliment réel à en tirer
  }
  if (!(base > 0)) return [];
  return (composition || []).map((ri) => ({
    foodId: ri.foodId,
    state: ri.state,
    qty: {
      thomas: (Number(ri.qty) || 0) * ((it.qty?.thomas || 0) / base),
      julie: (Number(ri.qty) || 0) * ((it.qty?.julie || 0) / base),
    },
  }));
}

/** Déplie une liste d'items — voir `deployItem()`. */
export function deployItems(items, recipesById = {}, preparationsById = {}) {
  const out = [];
  for (const it of items) out.push(...deployItem(it, recipesById, preparationsById));
  return out;
}

/**
 * Besoins agrégés par aliment sur une liste de sources.
 * Le facteur est appliqué PAR PERSONNE avant agrégation : les quantités de
 * Thomas et de Julie peuvent différer et leurs nombres d'utilisations aussi.
 * `recipesById`/`preparationsById` (optionnels, `{}` par défaut) : les items
 * recette/préparation sont dépliés en aliments réels avant agrégation —
 * chemin additif, sans effet sur le comportement existant pour un item foodId.
 */
export function aggregateNeeds(sources, foodsById, recipesById = {}, preparationsById = {}) {
  const out = {}; // foodId -> { food, refGrams, servedGrams, uses, days:Set }
  for (const source of sources) {
    const factors = source.factors || { thomas: source.factor ?? 1, julie: source.factor ?? 1 };
    const maxFactor = Math.max(factors.thomas || 0, factors.julie || 0);
    const flatItems = deployItems(source.items, recipesById, preparationsById);
    for (const it of flatItems) {
      if (!it.foodId) continue;
      const food = foodsById[it.foodId];
      if (!food) continue;
      const served = PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0) * (factors[p] || 0), 0);
      if (!served) continue;
      const state = it.state || food.referenceState;
      const ref = toReferenceGrams(food, served, state);
      // conversion non définie entre l'état pesé et celui des valeurs de l'aliment :
      // on n'invente pas de poids, l'ingrédient est signalé dans l'éditeur
      if (ref === null) continue;
      if (!out[food.id]) out[food.id] = { food, refGrams: 0, servedGrams: 0, uses: 0, days: new Set() };
      out[food.id].refGrams += ref;
      out[food.id].servedGrams += served;
      out[food.id].uses += maxFactor;
      if (source.dayIndex !== undefined) out[food.id].days.add(source.dayIndex);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Préparations — stock dérivé (étape 5)                               */
/* ------------------------------------------------------------------ */

/**
 * Quantité déjà affectée à une préparation, sur tout le cycle et les deux
 * personnes — même principe d'agrégation par facteur que `aggregateNeeds()`
 * (un item dans une option de catalogue réutilisée N fois pèse N fois plus).
 */
export function preparationUsed(state, preparationId) {
  let used = 0;
  for (const source of cycleSources(state)) {
    const factors = source.factors || { thomas: source.factor ?? 1, julie: source.factor ?? 1 };
    for (const it of source.items) {
      if (it.preparationId !== preparationId) continue;
      used += PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0) * (factors[p] || 0), 0);
    }
  }
  return used;
}

/**
 * Disponible = référence − déjà affecté sur le cycle COURANT. Toujours
 * dérivé, jamais stocké tel quel (décision verrouillée) : la RÉFÉRENCE est
 * `preparedGramsOf()` tant qu'aucun reset n'a eu lieu, ou `remainingAtReset`
 * (P4) une fois qu'un reset a figé le stock réellement restant à cet
 * instant-là — `preparationUsed()` ne compte alors que les usages du
 * nouveau cycle (state.meals ayant été vidé par resetCycle()), donc le
 * disponible ne revient jamais artificiellement au `preparedQuantity`
 * d'origine après un reset. Peut être négatif : un sur-engagement n'est pas
 * masqué ici (rien n'empêche encore le dépassement avant l'étape 7, qui fera
 * de cette valeur une contrainte réelle sur l'optimiseur).
 */
export function preparationAvailable(state, preparation) {
  // toujours en GRAMMES (l'unité de stockage réelle des item.qty) : pour une
  // préparation `kind:'portion'`, preparedQuantity est en PORTIONS — la
  // comparer directement à preparationUsed() (grammes) serait faux.
  const baseline = preparation.remainingAtReset ?? preparedGramsOf(preparation);
  return baseline - preparationUsed(state, preparation.id) - preparationWasted(preparation);
}

/**
 * Quantité jetée (« Jeter les restes », P1) depuis le dernier `resetCycle()`
 * — jamais la somme de TOUT l'historique : `resetCycle()` fige déjà le
 * disponible restant (pertes comprises, puisque `preparationAvailable()` les
 * soustrait) dans `remainingAtReset`, puis avance `lastResetAt` ; resommer
 * les pertes d'AVANT ce point les décompterait une seconde fois. L'historique
 * complet (`preparation.losses`) n'est jamais effacé (trace conservée), seule
 * la fenêtre prise en compte ici avance à chaque reset.
 */
export function preparationWasted(preparation) {
  const since = preparation.lastResetAt || preparation.createdAt || '';
  return (preparation.losses || [])
    .filter((l) => l.at >= since)
    .reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
}

/**
 * Créneaux "zéro reste" d'une préparation : un par (item `zeroWaste:true` qui
 * la référence, personne), sur les REPAS uniquement pour cette version —
 * volontairement PAS les options de petit-déjeuner/collation, dont le
 * facteur d'utilisation (une option peut être réutilisée N fois dans le
 * cycle) rendrait "Σ allocation = preparedQuantity" incorrect sans que le
 * solveur en soit informé ; un repas a toujours un facteur de 1. Limite
 * assumée, pas un oubli.
 */
export function zeroWasteSlotsFor(state, preparationId) {
  const slots = [];
  for (const meal of state.meals) {
    for (const it of meal.items) {
      if (it.preparationId !== preparationId || !it.zeroWaste) continue;
      for (const person of PERSONS) slots.push({ meal, item: it, person });
    }
  }
  return slots;
}

/**
 * Affectations actuelles d'une préparation (P1) : une ligne par item qui la
 * référence, qu'il vienne d'un repas classique ou d'une option de catalogue
 * — même source que `preparationUsed()` (`cycleSources()`), pour ne jamais
 * diverger de la quantité réellement décomptée. Chaque ligne porte assez
 * d'information pour localiser et modifier l'item EN PLACE (jamais en
 * créer un second) : `kind`/`mealId`/`optionId`/`itemId`.
 */
export function preparationAssignments(state, preparationId, startWeekday) {
  const out = [];
  for (const source of cycleSources(state)) {
    for (const it of source.items) {
      if (it.preparationId !== preparationId) continue;
      const qtyByPerson = { thomas: Number(it.qty?.thomas) || 0, julie: Number(it.qty?.julie) || 0 };
      if (source.meal) {
        out.push({
          kind: 'meal', itemId: it.id, mealId: source.meal.id, optionId: null, slot: null,
          label: `${dayName(startWeekday, source.dayIndex)} — ${MEAL_TYPES[source.mealType]}`,
          qtyByPerson,
        });
      } else {
        const typeKey = source.kind === 'breakfast' ? 'breakfast' : (source.option.targetSlot === 'evening' ? 'snack_evening' : 'snack_afternoon');
        out.push({
          kind: source.kind, itemId: it.id, mealId: null, optionId: source.option.id, slot: source.option.targetSlot || null,
          label: `${MEAL_TYPES[typeKey]} — « ${source.option.name || 'Sans nom'} »`,
          qtyByPerson,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Répartition guidée d'une préparation — stock (étape P4)             */
/* ------------------------------------------------------------------ */

/**
 * Cibles sélectionnables pour répartir une préparation (P4) : un candidat
 * par repas classique du cycle (identité de jour réelle, `dayIndex` +
 * `mealType`), et un candidat par occurrence PAR OPTION de petit-déjeuner/
 * collation effectivement utilisée dans le cycle — jamais par jour, une
 * option n'ayant pas de jour propre dans ce modèle (catalogue unique,
 * décision verrouillée). Une collation utilisée à la fois 16 h et le soir
 * produit deux candidats distincts, un par créneau, chacun avec son propre
 * nombre d'utilisations — c'est ce nombre qui, multiplié par la quantité par
 * service choisie par l'utilisateur, donne la quantité réellement prélevée
 * sur le stock (cf. `planPreparationDistribution()`).
 */
export function distributionCandidates(state, startWeekday) {
  const meals = state.meals
    .map((m) => ({
      mealId: m.id,
      dayIndex: m.dayIndex,
      mealType: m.mealType,
      label: `${dayName(startWeekday, m.dayIndex)} — ${MEAL_TYPES[m.mealType]}`,
    }))
    .sort((a, b) => a.dayIndex - b.dayIndex || (a.mealType === 'lunch' ? -1 : 1));

  const catalog = [];
  for (const o of state.breakfasts || []) {
    const usesCount = (Number(o.uses?.thomas) || 0) + (Number(o.uses?.julie) || 0);
    if (usesCount > 0) {
      catalog.push({
        kind: 'breakfast', optionId: o.id, slot: null, usesCount,
        label: `${MEAL_TYPES.breakfast} — « ${o.name || 'Sans nom'} »`,
      });
    }
  }
  for (const o of state.snacks || []) {
    for (const [slot, typeKey] of [['afternoon', 'snack_afternoon'], ['evening', 'snack_evening']]) {
      const usesCount = (Number(o.uses?.thomas?.[slot]) || 0) + (Number(o.uses?.julie?.[slot]) || 0);
      if (usesCount > 0) {
        catalog.push({
          kind: 'snack', optionId: o.id, slot, usesCount,
          label: `${MEAL_TYPES[typeKey]} — « ${o.name || 'Sans nom'} »`,
        });
      }
    }
  }
  return { meals, catalog };
}

/**
 * Calcule (SANS RIEN ÉCRIRE — fonction pure, cohérente avec le reste de ce
 * fichier) le plan de répartition d'une préparation sur une sélection de
 * repas classiques et d'options de petit-déjeuner/collation (P4).
 *
 * `resolveZeroWasteAllocation()` (nutrition.js, INCHANGÉE) ne reçoit JAMAIS
 * les options de catalogue : leur quantité par service est une saisie
 * directe de l'utilisateur (cf. diagnostic P4 §6 — une option n'a pas
 * d'identité de jour, "Σ allocation = quantité" n'a pas de sens pour elle).
 * Le solveur ne reçoit que le RELIQUAT (`amount − catalogTotal`) à répartir
 * sur les repas classiques sélectionnés : la somme qu'il produit ne peut
 * donc, par construction, jamais dépasser ce reliquat — jamais de
 * vérification a posteriori, une garantie structurelle (§7/§9 de la
 * validation).
 *
 * `picks = { amount, mealPicks: [{mealId, item}], catalogPicks: [{kind,
 * optionId, slot, usesCount, perServiceQty}] }` — `item` d'un `mealPick` est
 * un item préparation DÉJÀ CONSTRUIT par l'appelant (`newPreparationItem()`,
 * store.js) avec `qty:{thomas:0,julie:0}` : cette fonction ne connaît pas
 * `store.js` (derive.js n'importe jamais de store.js, pour éviter tout cycle
 * d'imports), elle se contente de lui attribuer une quantité.
 *
 * Retour : `{ ok:false, reason }` ou `{ ok:true, catalogWrites, mealWrites }`
 *   catalogWrites = [{ kind, optionId, slot, qty }]
 *   mealWrites    = [{ mealId, item, qtyByPerson: {thomas,julie}, otherQuantities }]
 *     `otherQuantities` = { itemId: {thomas?, julie?} } — quantités
 *     réoptimisées des AUTRES items déjà présents dans ce repas, produites
 *     par `resolveZeroWasteAllocation()` elle-même (aucun second calcul).
 */
export function planPreparationDistribution(state, foodsById, recipesById, preparationsById, preparationId, picks) {
  const prep = state.preparations.find((p) => p.id === preparationId);
  if (!prep) return { ok: false, reason: 'Préparation introuvable.' };

  const disponible = preparationAvailable(state, prep);
  const amount = Math.max(0, Number(picks.amount) || 0);
  if (!(amount > 0)) return { ok: false, reason: 'Indique une quantité à répartir supérieure à 0.' };
  if (amount > disponible + 1e-6) {
    return { ok: false, reason: `Cette sélection nécessite ${Math.round(amount)} g pour ${Math.round(disponible)} g disponibles.` };
  }

  const catalogPicks = (picks.catalogPicks || []).filter((c) => Number(c.perServiceQty) > 0);
  const catalogTotal = catalogPicks.reduce(
    (sum, c) => sum + Number(c.perServiceQty) * Math.max(0, Number(c.usesCount) || 0), 0
  );
  if (catalogTotal > amount + 1e-6) {
    return {
      ok: false,
      reason: `Les collations/petits-déjeuners sélectionnés nécessitent ${Math.round(catalogTotal)} g, plus que les ${Math.round(amount)} g à répartir.`,
    };
  }

  const mealPicks = picks.mealPicks || [];
  const remainder = amount - catalogTotal;
  if (remainder > 1e-6 && !mealPicks.length) {
    return { ok: false, reason: `${Math.round(remainder)} g resteraient sans repas sélectionné pour les recevoir.` };
  }
  if (remainder <= 1e-6 && mealPicks.length) {
    return { ok: false, reason: 'Aucune quantité ne reste pour les repas sélectionnés : retire-les ou augmente la quantité à répartir.' };
  }

  const catalogWrites = catalogPicks.map((c) => ({ kind: c.kind, optionId: c.optionId, slot: c.slot, qty: Number(c.perServiceQty) }));

  let mealWrites = [];
  if (remainder > 1e-6) {
    const roundStep = prep.recipeSnapshot?.kind === 'portion' ? portionGramsOf(prep.recipeSnapshot) : 1;
    const resolved = mealPicks.map(({ mealId, item }) => {
      const meal = state.meals.find((m) => m.id === mealId);
      return { meal, item };
    });
    if (resolved.some((r) => !r.meal)) return { ok: false, reason: 'Un des repas sélectionnés est introuvable.' };

    // un créneau par (repas, personne) — EXACTEMENT la même construction que
    // `zeroWasteSlotsFor()` (item ajouté à la liste COMPLÈTE des items du
    // repas) : les AUTRES ingrédients de chaque repas se réoptimisent autour
    // de l'allocation, au sein même de `resolveZeroWasteAllocation()` —
    // aucune deuxième passe de réajustement n'est ajoutée ici, c'est le
    // mécanisme déjà existant qui s'en charge, tel quel.
    const slots = [];
    const slotOf = []; // { mealIdx, person } — pour ranger le résultat par repas
    resolved.forEach(({ meal, item }, mealIdx) => {
      const items = [...meal.items, item];
      for (const person of PERSONS) {
        slots.push({ items, itemId: item.id, target: state.settings.targets[person][meal.mealType], person });
        slotOf.push({ mealIdx, person });
      }
    });
    const result = resolveZeroWasteAllocation(slots, remainder, foodsById, recipesById, preparationsById, { roundStep });

    mealWrites = resolved.map(({ meal, item }, mealIdx) => {
      const qtyByPerson = {};
      const otherQuantities = {}; // itemId existant -> { thomas, julie }
      slotOf.forEach((s, i) => {
        if (s.mealIdx !== mealIdx) return;
        qtyByPerson[s.person] = result.allocation[i];
        for (const [itemId, qty] of Object.entries(result.quantities[i])) {
          otherQuantities[itemId] = otherQuantities[itemId] || {};
          otherQuantities[itemId][s.person] = qty;
        }
      });
      return { mealId: meal.id, item, qtyByPerson, otherQuantities };
    });
  }

  return { ok: true, catalogWrites, mealWrites };
}

/* ------------------------------------------------------------------ */
/* Calcul inverse — besoin d'une recette non encore préparée (étape 6) */
/* ------------------------------------------------------------------ */

/**
 * Besoin total BRUT d'une recette, agrégé sur une liste de sources (mêmes
 * conventions que `aggregateNeeds()` : `source.items` + `source.factors`,
 * un repas ayant toujours un facteur de 1) et les deux personnes : somme des
 * items qui la référencent SANS préparation encore matérialisée (mode
 * "molle" — la recette n'est pas encore cuisinée). Un item déjà lié à une
 * préparation (`preparationId` renseigné) n'est pas un besoin non couvert :
 * son suivi passe par `preparationUsed()`, pas par cette fonction. Ne tient
 * PAS compte du disponible d'une préparation existante de cette recette —
 * c'est `recipeNeededNet()` qui fait cette soustraction ; cette fonction
 * reste le besoin brut, purement additif, comme `aggregateNeeds()` pour les
 * aliments. `sources` peut être `cycleSources(state)` (cycle entier) OU une
 * liste de repas déjà filtrée par session (batch cooking, étape P0.2/P0.3) —
 * chemin additif, aucun appelant existant n'est affecté.
 */
export function recipeNeededFrom(sources, recipeId) {
  let needed = 0;
  for (const source of sources) {
    const factors = source.factors || { thomas: source.factor ?? 1, julie: source.factor ?? 1 };
    for (const it of source.items) {
      if (it.recipeId !== recipeId || it.preparationId) continue;
      needed += PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0) * (factors[p] || 0), 0);
    }
  }
  return needed;
}

/** Besoin brut d'une recette sur le CYCLE ENTIER — voir `recipeNeededFrom()`. */
export function recipeNeeded(state, recipeId) {
  return recipeNeededFrom(cycleSources(state), recipeId);
}

/**
 * Disponible cumulé de toutes les préparations EXISTANTES de cette recette.
 * Seules les contributions POSITIVES sont sommées : une préparation
 * sur-engagée (disponible négatif) n'est jamais compensée par une autre —
 * chaque préparation reste un stock indépendant, jamais un pot commun.
 * Réutilise `preparationAvailable()` telle quelle, aucune nouvelle mécanique.
 */
export function recipeAvailableFromPreparations(state, recipeId) {
  let total = 0;
  for (const prep of state.preparations || []) {
    if (prep.recipeId !== recipeId) continue;
    total += Math.max(0, preparationAvailable(state, prep));
  }
  return total;
}

/**
 * Quantité RECOMMANDÉE à préparer : le besoin brut (`recipeNeeded`), net du
 * disponible déjà existant sur des préparations de cette même recette —
 * raffinement du calcul inverse, auparavant différé (spécification §20).
 * Jamais négatif : rien à préparer si le stock existant couvre déjà tout.
 * `recipeNeeded()` reste inchangée et continue de donner le besoin BRUT.
 */
export function recipeNeededNet(state, recipeId) {
  return Math.max(0, recipeNeeded(state, recipeId) - recipeAvailableFromPreparations(state, recipeId));
}

/**
 * Vue d'ensemble : pour chaque recette référencée sans préparation quelque
 * part dans le cycle, le besoin total agrégé — base du calcul inverse
 * (ÉTAPE 3 de la spécification : « Besoin total estimé / Quantité recommandée
 * à préparer »). `needed` = besoin brut (inchangé) ; `available` = disponible
 * déjà existant sur des préparations de cette recette ; `recommended` = net
 * des deux (§20). L'utilisateur choisit ensuite la quantité réelle à préparer
 * via `newPreparation()` ; rien n'est décidé ni matérialisé automatiquement.
 */
export function buildRecipeNeeds(state, recipesById) {
  const ids = new Set();
  for (const source of cycleSources(state)) {
    for (const it of source.items) if (it.recipeId && !it.preparationId) ids.add(it.recipeId);
  }
  return [...ids]
    .map((recipeId) => {
      const needed = recipeNeeded(state, recipeId);
      const available = recipeAvailableFromPreparations(state, recipeId);
      return { recipe: recipesById[recipeId], recipeId, needed, available, recommended: Math.max(0, needed - available) };
    })
    .filter((x) => x.recipe); // recette supprimée entre-temps : ignorée, pas d'exception
}

/* ------------------------------------------------------------------ */
/* Couverture du cycle (petits-déjeuners et collations)                */
/* ------------------------------------------------------------------ */

export const COVERAGE_SLOTS = [
  { key: 'breakfast', kind: 'breakfast', label: 'Petits-déjeuners' },
  { key: 'snack_afternoon', kind: 'snack', slot: 'afternoon', label: 'Collations 16 h' },
  { key: 'snack_evening', kind: 'snack', slot: 'evening', label: 'Collations du soir' },
];

/**
 * Couverture du cycle : nombre d'options déclarées face au nombre théorique
 * (un par jour de cycle et par personne). Purement informatif : rien n'est
 * ajouté, choisi ni corrigé automatiquement.
 */
export function coverageReport(state) {
  const needed = state.settings.cycle.duration;
  const report = {};

  for (const slot of COVERAGE_SLOTS) {
    const rows = {};
    for (const person of PERSONS) {
      let used = 0;
      if (slot.kind === 'breakfast') {
        for (const o of state.breakfasts || []) used += Number(o.uses?.[person]) || 0;
      } else {
        for (const o of state.snacks || []) used += Number(o.uses?.[person]?.[slot.slot]) || 0;
      }
      const delta = used - needed;
      rows[person] = {
        used,
        needed,
        delta,
        status: delta === 0 ? 'ok' : delta < 0 ? 'missing' : 'extra',
      };
    }
    report[slot.key] = { ...slot, needed, persons: rows };
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Batch cooking                                                       */
/* ------------------------------------------------------------------ */

/** Découpe le cycle en sessions de batch (règle de conservation). */
export function batchSessions(settings) {
  const duration = settings.cycle.duration;
  const span = Math.max(1, settings.batch.maxDays);
  const sessions = [];
  for (let start = 0; start < duration; start += span) {
    const end = Math.min(duration, start + span) - 1;
    sessions.push({ index: sessions.length, startDay: start, endDay: end });
  }
  return sessions;
}

/**
 * L'aliment demande-t-il une cuisson ?
 * C'est une propriété EXPLICITE de la fiche aliment (requiresCooking) : elle
 * n'est jamais déduite de l'état de référence. Un aliment cru peut très bien
 * être consommé tel quel, et un aliment prêt à consommer peut demander une
 * cuisson (gnocchis à poêler, par exemple).
 */
export const needsCooking = (food) => Boolean(food?.requiresCooking);

/**
 * Trois catégories, déduites uniquement des propriétés de l'aliment :
 *   batchAllowed = true                          → batch    (à préparer en batch)
 *   batchAllowed = false et requiresCooking = true → cook     (à cuire le jour même)
 *   requiresCooking = false                      → assemble (à assembler le jour même)
 * L'état de référence n'intervient pas dans ce classement.
 */
export function batchCategory(food) {
  if (!food) return 'assemble';
  if (food.batchAllowed) return 'batch';
  return needsCooking(food) ? 'cook' : 'assemble';
}

export const BATCH_CATEGORY_LABEL = {
  batch: 'À préparer en batch',
  cook: 'À cuire le jour même',
  assemble: 'À assembler le jour même',
};

/** Consignes de préparation saisies dans la fiche aliment (jamais codées en dur). */
export function preparationNote(food) {
  return food?.instructions ? String(food.instructions) : null;
}

/** Résumé lisible de la méthode de cuisson d'un aliment. */
export function cookingSummary(food) {
  if (!food) return null;
  const parts = [];
  if (food.cookingMethod) parts.push(food.cookingMethod);
  if (food.cookingTemp) parts.push(`${food.cookingTemp} °C`);
  if (food.cookingTime) parts.push(`${food.cookingTime} min`);
  return parts.length ? parts.join(' · ') : null;
}

/** Quantité telle qu'elle sera servie dans la gamelle (cuite si l'aliment se cuit). */
function servedGrams(food, qty, itemState) {
  const state = itemState || food.referenceState;
  if (needsCooking(food) && food.referenceState === 'cru') return convertGrams(food, qty, state, 'cuit');
  return qty;
}

/**
 * Regroupe les jours de consommation réels (`consumptionDays`, triés, sans
 * doublon) en lots glouton ancrés sur la conservation (P2.2) : chaque lot
 * démarre au premier jour non couvert, et couvre tous les jours de
 * consommation suivants jusqu'à `prepDay + shelfLifeDays - 1` inclus.
 * `shelfLifeDays === 0` → une préparation par jour de consommation (aucune
 * conservation). Remplace l'ancienne grille fixe (`splitDayRange`, ancrée sur
 * le début de session plutôt que sur la consommation réelle), qui pouvait
 * recommander des préparations inutiles.
 */
function groupConsumptionDays(consumptionDays, shelfLifeDays) {
  if (shelfLifeDays === 0) return consumptionDays.map((day) => ({ startDay: day, endDay: day, days: [day] }));
  const groups = [];
  let i = 0;
  while (i < consumptionDays.length) {
    const prepDay = consumptionDays[i];
    const limitDay = prepDay + shelfLifeDays - 1;
    let j = i;
    while (j + 1 < consumptionDays.length && consumptionDays[j + 1] <= limitDay) j += 1;
    groups.push({ startDay: prepDay, endDay: consumptionDays[j], days: consumptionDays.slice(i, j + 1) });
    i = j + 1;
  }
  return groups;
}

/**
 * Sous-préparations d'un composant (aliment OU recette) dont la conservation
 * (`shelfLifeDays`) est plus courte que la session (P0.3/P2.2) : au lieu
 * d'une simple alerte, la session est effectivement scindée en préparations
 * distinctes, chacune avec son propre besoin (recalculé via `computeRaw`,
 * restreint aux repas concernés — même mécanisme d'agrégation que le reste,
 * aucune nouvelle formule). Les tranches sont ancrées sur les jours de
 * consommation RÉELS (P2.2), pas sur une grille fixe démarrant en début de
 * session : une recette consommée deux fois dans sa durée de conservation ne
 * déclenche jamais plus d'une préparation pour ces deux consommations.
 * Besoin BRUT par tranche (comme les composants aliments, qui n'ont jamais
 * eu de notion de stock déjà disponible) : la soustraction du disponible
 * existant (recettes uniquement, cf. `recipeAvailableFromPreparations`) reste
 * au niveau de la session entière, pas répartie entre tranches — on ignore SI
 * le stock existant a été consommé plutôt en début ou en fin de session,
 * information que le modèle actuel ne représente pas.
 */
function computeSubBatches(shelfLifeDays, coveredDays, sessionIndex, startDay, endDay, keyPart, meals, computeRaw, overrides) {
  // shelfLifeDays === null (non renseigné) : Number(null) vaut 0, donc FINI — sans
  // l'exclusion explicite ci-dessous, une conservation inconnue serait traitée
  // comme une conservation de 0 jour (scission quotidienne) au lieu du
  // comportement de secours attendu (couvre toute la session, cf. P2.2).
  if (shelfLifeDays === null || shelfLifeDays === undefined) return null;
  if (!(Number.isFinite(Number(shelfLifeDays)) && Number(shelfLifeDays) < coveredDays)) return null;
  const shelfLife = Math.max(0, Math.floor(Number(shelfLifeDays)));
  const consumptionDays = [...new Set(
    meals.filter((m) => computeRaw([m]) > 0).map((m) => m.dayIndex)
  )].sort((a, b) => a - b);
  if (!consumptionDays.length) return [];
  return groupConsumptionDays(consumptionDays, shelfLife).map((g) => {
    const chunkMeals = meals.filter((m) => g.days.includes(m.dayIndex));
    const requiredRaw = computeRaw(chunkMeals);
    const key = `${sessionIndex}:${g.startDay}-${g.endDay}:${keyPart}`;
    const preparedRaw = overrides[key] ?? requiredRaw;
    return { key, startDay: g.startDay, endDay: g.endDay, requiredRaw, preparedRaw, coversDays: g.days };
  });
}

/**
 * Plan de batch cooking : composants aliments ET recettes agrégés par
 * session, plan opératoire de préparation, et détail des gamelles à remplir.
 * Cette fonction ne modifie jamais le planning : elle le lit.
 */
export function buildBatchPlan(state, foodsById, recipesById = {}, preparationsById = {}) {
  const sessions = batchSessions(state.settings);
  return sessions.map((s) => {
    // nombre de jours que la préparation de cette session doit couvrir
    const coveredDays = s.endDay - s.startDay + 1;
    const meals = state.meals.filter((m) => m.dayIndex >= s.startDay && m.dayIndex <= s.endDay);
    const needs = aggregateNeeds(meals, foodsById, recipesById, preparationsById);

    // ---- A. aliments à préparer en batch
    const components = [];
    for (const entry of Object.values(needs)) {
      const { food, refGrams } = entry;
      if (batchCategory(food) !== 'batch') continue;
      const cooked = needsCooking(food) && food.referenceState === 'cru'
        ? convertGrams(food, refGrams, 'cru', 'cuit')
        : refGrams;
      const key = `${s.index}:${food.id}`;
      const prepared = state.batch.overrides[key];
      const preparedRaw = prepared ?? refGrams;
      components.push({
        key,
        food,
        requiredRaw: refGrams,
        requiredCooked: cooked,
        preparedRaw,
        preparedCooked: needsCooking(food) && food.referenceState === 'cru'
          ? convertGrams(food, preparedRaw, 'cru', 'cuit')
          : preparedRaw,
        yieldPct: Math.round((Number(food.cookedFactor) || 1) * 100),
        method: food.cookingMethod || '',
        temperature: food.cookingTemp ?? null,
        duration: food.cookingTime ?? null,
        prepTime: food.prepTime ?? null,
        equipment: food.equipment || '',
        note: preparationNote(food),
        summary: cookingSummary(food),
        needsCooking: needsCooking(food),
        // durée de conservation renseignée dans la fiche aliment (null = inconnue)
        shelfLifeDays: food.shelfLifeDays ?? null,
        coveredDays,
        shelfLifeShort:
          Number.isFinite(Number(food.shelfLifeDays)) && food.shelfLifeDays !== null
            ? Number(food.shelfLifeDays) < coveredDays
            : false,
        subBatches: computeSubBatches(
          food.shelfLifeDays, coveredDays, s.index, s.startDay, s.endDay, food.id, meals,
          (chunkMeals) => aggregateNeeds(chunkMeals, foodsById, recipesById, preparationsById)[food.id]?.refGrams || 0,
          state.batch.overrides
        ),
      });
    }
    components.sort((a, b) => b.requiredRaw - a.requiredRaw);

    // ---- A'. recettes à préparer en batch (P0.2 — chemin réel, plus un simple
    // affichage : une recette référencée directement (recipeId, sans
    // préparation — "molle", pas encore cuisinée) et marquée batchAllowed sur
    // SA PROPRE fiche devient ici un composant à part entière, au lieu de
    // disparaître (déployée en ingrédients bruts) ou d'être traitée comme
    // "déjà assemblée" plus bas. Net du disponible déjà préparé pour cette
    // recette — réutilise recipeAvailableFromPreparations() telle quelle,
    // donc une recette déjà (ou partiellement) préparée n'est jamais recomptée.
    const recipeIdsHere = new Set();
    for (const meal of meals) {
      for (const it of meal.items) if (it.recipeId && !it.preparationId) recipeIdsHere.add(it.recipeId);
    }
    const recipesToPrepare = [...recipeIdsHere]
      .map((recipeId) => recipesById[recipeId])
      .filter((r) => r && r.batchAllowed)
      .map((recipe) => {
        const neededSession = recipeNeededFrom(meals, recipe.id);
        const available = recipeAvailableFromPreparations(state, recipe.id);
        const requiredRaw = Math.max(0, neededSession - available);
        const key = `${s.index}:recipe:${recipe.id}`;
        const prepared = state.batch.overrides[key];
        const preparedRaw = prepared ?? requiredRaw;

        // Détail des ingrédients NÉCESSAIRES À LA PRÉPARATION de cette recette,
        // à l'échelle de ce qui va réellement être préparé (preparedRaw) — pas
        // seulement la composition de référence de la fiche recette. Lecture
        // seule, dérivée de recipe.items ; aucune nouvelle mécanique numérique
        // (même principe d'échelle que recipeAsVirtualFood()/preparedGramsOf()).
        const referenceBase = recipe.kind === 'portion' ? portionGramsOf(recipe) : (Number(recipe.baseGrams) || 0);
        const scale = referenceBase > 0 ? preparedRaw / referenceBase : 0;
        const ingredients = (recipe.items || [])
          .map((ri) => ({
            food: foodsById[ri.foodId],
            qty: (Number(ri.qty) || 0) * scale,
            state: ri.state,
          }))
          .filter((ing) => ing.food);

        // Vers quelles gamelles de CETTE session ce besoin est réparti (lecture
        // seule — cet écran ne modifie jamais le planning) : une recette
        // référencée directement (recipeId, sans préparation) dans un repas.
        const destinations = meals
          .map((meal) => {
            const qty = meal.items
              .filter((it) => it.recipeId === recipe.id && !it.preparationId)
              .reduce((sum, it) => sum + PERSONS.reduce((s2, p) => s2 + (it.qty?.[p] || 0), 0), 0);
            return qty > 0 ? { mealId: meal.id, dayIndex: meal.dayIndex, mealType: meal.mealType, name: meal.name || '', qty } : null;
          })
          .filter(Boolean);

        return {
          key,
          recipe,
          requiredRaw,
          preparedRaw,
          ingredients,
          destinations,
          method: recipe.cookingMethod || '',
          temperature: recipe.cookingTemp ?? null,
          duration: recipe.cookingTime ?? null,
          prepTime: recipe.prepTime ?? null,
          equipment: recipe.equipment || '',
          note: recipe.instructions ? String(recipe.instructions) : null,
          shelfLifeDays: recipe.shelfLifeDays ?? null,
          coveredDays,
          shelfLifeShort:
            Number.isFinite(Number(recipe.shelfLifeDays)) && recipe.shelfLifeDays !== null
              ? Number(recipe.shelfLifeDays) < coveredDays
              : false,
          subBatches: computeSubBatches(
            recipe.shelfLifeDays, coveredDays, s.index, s.startDay, s.endDay, `recipe:${recipe.id}`, meals,
            (chunkMeals) => recipeNeededFrom(chunkMeals, recipe.id), state.batch.overrides
          ),
        };
      })
      .filter((c) => c.requiredRaw > 0 || c.preparedRaw > 0);
    recipesToPrepare.sort((a, b) => b.requiredRaw - a.requiredRaw);

    // ---- B et C : par repas concerné (une recette/préparation n'est jamais
    // dépliée ici — contrairement à aggregateNeeds/buildShoppingList — une
    // gamelle affiche "Chili con carne 300 g", jamais ses ingrédients séparés ;
    // elle est déjà considérée "prête à assembler", comme un plat déjà cuit).
    // Une recette désormais listée dans `recipesToPrepare` (ci-dessus) reste
    // AUSSI ici : ce sont deux vues complémentaires (ce qu'il faut cuisiner
    // vs. dans quelle gamelle ça atterrit), jamais une redondance de calcul —
    // ni l'une ni l'autre ne déplient les ingrédients.
    const cookSameDay = [];
    const assembleSameDay = [];
    for (const meal of meals) {
      for (const it of meal.items) {
        if (it.recipeId || it.preparationId) {
          const total = PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0), 0);
          if (!total) continue;
          const label = it.preparationId ? preparationsById[it.preparationId]?.label : recipesById[it.recipeId]?.name;
          if (!label) continue;
          assembleSameDay.push({
            food: { name: label }, dayIndex: meal.dayIndex, mealType: meal.mealType,
            grams: total, summary: null, note: null,
          });
          continue;
        }
        const food = it.foodId && foodsById[it.foodId];
        if (!food) continue;
        const cat = batchCategory(food);
        if (cat === 'batch') continue;
        const total = PERSONS.reduce((sum, p) => sum + (it.qty?.[p] || 0), 0);
        if (!total) continue;
        const row = {
          food,
          dayIndex: meal.dayIndex,
          mealType: meal.mealType,
          grams: toReferenceGrams(food, total, it.state || food.referenceState) ?? total,
          summary: cookingSummary(food),
          note: preparationNote(food),
        };
        (cat === 'cook' ? cookSameDay : assembleSameDay).push(row);
      }
    }

    // ---- gamelles : ce qu'il faut répartir, personne par personne
    const gamelles = meals.map((meal) => ({
      mealId: meal.id,
      dayIndex: meal.dayIndex,
      mealType: meal.mealType,
      name: meal.name || '',
      persons: Object.fromEntries(
        PERSONS.map((person) => [
          person,
          meal.items
            .map((it) => {
              if (it.recipeId || it.preparationId) {
                const label = it.preparationId ? preparationsById[it.preparationId]?.label : recipesById[it.recipeId]?.name;
                const qty = it.qty?.[person] || 0;
                if (!label || !qty) return null;
                return { free: false, food: null, name: label, category: 'assemble', grams: qty, cooked: false };
              }
              if (!it.foodId) {
                return it.free ? { free: true, name: it.free.name, quantity: it.free.quantity, category: 'free' } : null;
              }
              const food = foodsById[it.foodId];
              const qty = it.qty?.[person] || 0;
              if (!food || !qty) return null;
              return {
                free: false,
                food,
                name: food.name,
                category: batchCategory(food),
                grams: servedGrams(food, qty, it.state),
                cooked: needsCooking(food) && food.referenceState === 'cru',
              };
            })
            .filter(Boolean),
        ])
      ),
    }));

    // alertes : composant (aliment ou recette) dont la conservation ne couvre
    // pas la session. `subBatches` (calculé ci-dessus) donne déjà le calendrier
    // concret de reprise ; l'alerte reste un résumé visible en tête de session.
    // Purement informatif : rien n'est supprimé, le planning n'est pas modifié.
    const conservationAlerts = [...components, ...recipesToPrepare]
      .filter((c) => c.shelfLifeShort)
      .map((c) => ({
        food: c.food,
        recipe: c.recipe,
        shelfLifeDays: Number(c.shelfLifeDays),
        coveredDays,
        subBatchCount: c.subBatches?.length ?? null,
        message:
          `${c.food ? c.food.name : c.recipe.name} se conserve ${c.shelfLifeDays} jour(s) après préparation, ` +
          `mais cette session couvre ${coveredDays} jour(s) : ${c.subBatches?.length ?? 0} préparations nécessaires.`,
      }));

    return {
      ...s, coveredDays, components, recipesToPrepare, cookSameDay, assembleSameDay, gamelles,
      conservationAlerts, mealCount: meals.length,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Liste de courses                                                    */
/* ------------------------------------------------------------------ */

export function buildShoppingList(state, foodsById, recipesById = {}, preparationsById = {}) {
  const needs = aggregateNeeds(cycleSources(state), foodsById, recipesById, preparationsById);
  const lines = Object.values(needs).map((entry) => {
    const { food, refGrams } = entry;
    const pack = Number(food.packageWeight) > 0 ? Number(food.packageWeight) : null;
    const packages = pack ? Math.ceil(refGrams / pack) : null;
    const buyGrams = pack ? packages * pack : refGrams;
    const price = Number(food.price) > 0 ? Number(food.price) : null;
    let cost = null;
    if (price !== null) cost = pack ? packages * price : (price * refGrams) / 1000;
    return {
      food,
      required: refGrams,
      packages,
      packageWeight: pack,
      buyGrams,
      surplus: buyGrams - refGrams,
      cost,
      purchased: !!state.shopping.purchased[food.id],
    };
  });
  lines.sort((a, b) => a.food.category.localeCompare(b.food.category) || a.food.name.localeCompare(b.food.name));
  const total = lines.reduce((s, l) => s + (l.cost || 0), 0);
  const unpriced = lines.filter((l) => l.cost === null).length;
  return { lines, total, unpriced, budget: state.settings.budget, overBudget: total - state.settings.budget };
}

/* ------------------------------------------------------------------ */
/* Suggestions d'optimisation du cycle (jamais appliquées automatiquement) */
/* ------------------------------------------------------------------ */

export function optimizeSuggestions(state, foodsById, recipesById = {}, preparationsById = {}) {
  const needs = aggregateNeeds(cycleSources(state), foodsById, recipesById, preparationsById);
  const entries = Object.values(needs);
  const suggestions = [];

  const repeated = entries.filter((e) => e.uses >= 3 && e.food.batchAllowed);
  for (const e of repeated) {
    suggestions.push({
      kind: 'batch',
      text: `${e.food.name} apparaît ${e.uses} fois — bon candidat au batch cooking.`,
    });
  }

  const oneOff = entries.filter((e) => e.uses === 1 && ['legume', 'feculent', 'proteine'].includes(e.food.category));
  for (const e of oneOff.slice(0, 6)) {
    suggestions.push({
      kind: 'variety',
      text: `${e.food.name} n'est utilisé qu'une fois — le remplacer par un aliment déjà présent réduirait les courses.`,
    });
  }

  suggestions.push({
    kind: 'info',
    text: `${entries.length} aliments différents dans le cycle.`,
  });

  // budget + substitutions moins chères dans la même catégorie
  const shopping = buildShoppingList(state, foodsById, recipesById, preparationsById);
  if (shopping.overBudget > 0) {
    suggestions.push({
      kind: 'budget',
      text: `Budget estimé ${shopping.total.toFixed(2)} € — dépassement de ${shopping.overBudget.toFixed(2)} €.`,
    });
    const pricePerKg = (f) =>
      Number(f.price) > 0 && Number(f.packageWeight) > 0 ? (f.price / f.packageWeight) * 1000 : null;
    const expensive = shopping.lines
      .filter((l) => l.cost !== null)
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 4);
    for (const line of expensive) {
      const mine = pricePerKg(line.food);
      if (mine === null) continue;
      const alt = Object.values(foodsById)
        .filter((f) => f.id !== line.food.id && f.category === line.food.category && pricePerKg(f) !== null)
        .filter((f) => pricePerKg(f) < mine * 0.75)
        .sort((a, b) => pricePerKg(a) - pricePerKg(b))[0];
      if (alt) {
        suggestions.push({
          kind: 'substitution',
          text: `${line.food.name} (${(mine / 1).toFixed(2)} €/kg) → ${alt.name} (${pricePerKg(alt).toFixed(2)} €/kg) : substitution possible, à valider manuellement.`,
        });
      }
    }
  } else {
    suggestions.push({
      kind: 'budget',
      text: `Budget estimé ${shopping.total.toFixed(2)} € — dans l'objectif de ${state.settings.budget} €.`,
    });
  }
  return suggestions;
}

/* ------------------------------------------------------------------ */
/* Totaux journaliers (indicatif)                                      */
/* ------------------------------------------------------------------ */

export function dayTotals(state, foodsById, dayIndex, person, recipesById = {}, preparationsById = {}) {
  const meals = state.meals.filter((m) => m.dayIndex === dayIndex);
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const m of meals) {
    const macros = mealMacros(m.items, foodsById, person, recipesById, preparationsById);
    total.kcal += macros.kcal;
    total.protein += macros.protein;
    total.carbs += macros.carbs;
    total.fat += macros.fat;
  }
  return total;
}
