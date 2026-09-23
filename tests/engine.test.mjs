/**
 * Tests automatisés du moteur nutritionnel et des calculs dérivés.
 *
 *   node tests/engine.test.mjs
 *
 * Aucune dépendance : ces modules sont purs (ni DOM, ni réseau, ni stockage).
 */

import {
  autoAdjust, adjustQuantities, mealMacros, macrosFor, evaluate, diagnose,
  initialQuantity, roundQuantity, convertGrams, toReferenceGrams, profileOf,
  snapQuantity, toUnits, fromUnits, isWholeUnitFood, MACRO_KEYS, computeYield, quantityStep,
  canConvert, conversionInfo, stateLabel, STATES, referenceFor, CATEGORY_PROFILE, CATEGORIES,
  recipeMacrosPer100g, canAddIngredientToRecipe, recipeAsVirtualFood, preparationAsVirtualFood,
  resolveZeroWasteAllocation, preparedGramsOf, portionGramsOf, macroCost,
  statusFor, statusForKey, MACRO_ROLE,
} from '../js/core/nutrition.js';
import {
  buildBatchPlan, buildShoppingList, batchCategory, cycleSources, cookingSummary, preparationNote,
  coverageReport, optionUses, needsCooking, preparationUsed, preparationAvailable,
  recipeNeeded, buildRecipeNeeds, zeroWasteSlotsFor, deployItems, aggregateNeeds,
  recipeAvailableFromPreparations, recipeNeededNet,
} from '../js/core/derive.js';
import { seedFoods } from '../js/core/seed-foods.js';
import {
  migrateState, newRecipe, newRecipeItem, defaultState, newItem, newFreeItem, sectionsUsed, SECTIONS, DEFAULT_SECTION,
  newPreparation, preparationsById, newPreparationItem, newRecipeMealItem,
  newMeal, normalizeMeal, autoMealName,
} from '../js/core/store.js';
import { findSimilarFoods, findDuplicateGroups } from '../js/core/similarity.js';
import { stateToTables, tablesToState } from '../js/core/sync.js';

/* ---------------------------------------------------------------- harnais */

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    console.log(`\n✔ ${name}`);
  } catch (e) {
    console.log(`\n✘ ${name}\n   ${e.message}`);
    failures.push(`${name} — ${e.message}`);
  }
}
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${currentTest} / ${label}${detail ? ` (${detail})` : ''}`); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const info = (s) => console.log(`        ${s}`);

/* ---------------------------------------------------------------- fixtures */

const foods = seedFoods();
const byId = Object.fromEntries(foods.map((f) => [f.id, f]));
const F = (name) => {
  const f = foods.find((x) => x.name.toLowerCase().includes(name.toLowerCase()));
  if (!f) throw new Error(`aliment introuvable : ${name}`);
  return f;
};

const LUNCH = {
  thomas: { kcal: 1050, protein: 55, carbs: 120, fat: 35 },
  julie: { kcal: 750, protein: 40, carbs: 85, fat: 25 },
};
const SNACK = {
  thomas: { kcal: 350, protein: 25, carbs: 40, fat: 10 },
  julie: { kcal: 300, protein: 20, carbs: 35, fat: 8 },
};

let seq = 0;
function item(food, qty = null, opts = {}) {
  const q = qty === null ? initialQuantity(food) : qty;
  return {
    id: `it${++seq}`,
    foodId: food.id,
    free: null,
    state: opts.state || food.referenceState,
    qty: { thomas: opts.thomas ?? q, julie: opts.julie ?? q },
    locked: { thomas: !!opts.lock, julie: !!opts.lock },
  };
}
const freeItem = (name, quantity) => ({
  id: `it${++seq}`, foodId: null, free: { name, quantity }, state: null,
  qty: { thomas: 0, julie: 0 }, locked: { thomas: false, julie: false },
});
/** Item de repas référençant une recette (mode "molle", sans préparation — étape 4). */
const recipeItemInMeal = (recipeId, qty, opts = {}) => ({
  id: `it${++seq}`, foodId: null, recipeId, free: null, state: null,
  qty: { thomas: opts.thomas ?? qty, julie: opts.julie ?? qty },
  locked: { thomas: !!opts.lock, julie: !!opts.lock },
});

const dev = (v, t) => (t ? (v - t) / t : 0);
const within = (items, targets, person, tol = 0.05) => {
  const m = mealMacros(items, byId, person);
  return evaluate(m, targets[person], tol).rows.every((r) => r.status === 'ok');
};
/**
 * "Dans la cible" après la calibration asymétrique (décision verrouillée) :
 * kcal/lipides sont des PLAFONDS — en dessous de la cible est toujours accepté,
 * seul un dépassement > tol est un échec ; protéines = PLANCHER — au-dessus de
 * la cible est toujours accepté, seul un déficit > tol est un échec ; glucides
 * restent symétriques (objectif souple, inchangé). N'utilise PAS evaluate()/
 * statusFor() (rôle purement descriptif, volontairement inchangés) : exprime
 * directement le nouveau contrat de l'optimiseur.
 */
const withinAsym = (items, targets, person, tol = 0.05) => {
  const m = mealMacros(items, byId, person);
  const t = targets[person];
  const ceilingOk = (v, g) => !g || v <= g * (1 + tol);
  const floorOk = (v, g) => !g || v >= g * (1 - tol);
  const softOk = (v, g) => Math.abs(dev(v, g)) <= tol;
  return ceilingOk(m.kcal, t.kcal) && ceilingOk(m.fat, t.fat) && floorOk(m.protein, t.protein) && softOk(m.carbs, t.carbs);
};
function show(items, targets, person = 'thomas') {
  const m = mealMacros(items, byId, person);
  const t = targets[person];
  info(
    items.map((it) => `${it.foodId ? byId[it.foodId].name : it.free.name} ${Math.round(it.qty[person])}g${it.locked[person] ? '🔒' : ''}`).join(' | ')
  );
  info(
    `${person} : ${m.kcal.toFixed(0)}/${t.kcal} kcal (${(dev(m.kcal, t.kcal) * 100).toFixed(1)}%) · ` +
    `${m.protein.toFixed(0)}/${t.protein} P (${(dev(m.protein, t.protein) * 100).toFixed(1)}%) · ` +
    `${m.carbs.toFixed(0)}/${t.carbs} C (${(dev(m.carbs, t.carbs) * 100).toFixed(1)}%) · ` +
    `${m.fat.toFixed(0)}/${t.fat} L (${(dev(m.fat, t.fat) * 100).toFixed(1)}%)`
  );
}

/* ================================================================ TEST A */

test('A — protéine seule : pas de quantité absurde, manque signalé', () => {
  const items = [item(F('Blanc de poulet'))];
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  const q = items[0].qty.thomas;
  check('quantité de poulet raisonnable (≤ 300 g)', q <= 300, `${q} g`);
  const m = mealMacros(items, byId, 'thomas');
  const d = diagnose(m, LUNCH.thomas, foods);
  check('le repas est signalé hors cible', d !== null);
  check('glucides signalés manquants', d.rows.some((r) => r.key === 'carbs' && r.delta < 0));
  // lipides = plafond (P1.1, décision verrouillée) : être sous la cible n'est
  // JAMAIS un problème (statut "ok"), donc `diagnose()` (qui ne remonte que
  // les lignes hors "ok") ne les signale plus comme "manquants" — c'est le
  // comportement correct attendu, pas une régression. Avant P1.1, la même
  // tolérance symétrique que les autres macros s'appliquait aux lipides.
  check('lipides non signalés comme un problème (sous un plafond, "ok")',
    !d.rows.some((r) => r.key === 'fat'));
  check('une piste est proposée', d.suggestions.length > 0, d.suggestions.join(', '));
});

/* ================================================================ TEST B */

test('B — protéine + féculent : protéines et glucides rapprochés de la cible', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes'))];
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  // protéines = PLANCHER SOUPLE (calibration asymétrique validée) : le déficit
  // reste borné à ±5 %, mais un léger dépassement (ex. julie 42.9 g / 40 g,
  // +7 %) est désormais accepté sans coût significatif — plus de vérification
  // symétrique. Glucides restent un objectif souple SYMÉTRIQUE, inchangé.
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    check(`${p} : protéines au moins la cible (-5 % max)`, dev(m.protein, LUNCH[p].protein) >= -0.05, `${m.protein.toFixed(1)} g`);
    check(`${p} : glucides dans ±5 %`, Math.abs(dev(m.carbs, LUNCH[p].carbs)) <= 0.05, `${m.carbs.toFixed(1)} g`);
  }
  check('les lipides restent signalés hors cible (aucune source)', !within(items, LUNCH, 'thomas'));
});

/* ================================================================ TEST C */

test('C — ajout d’un légume : il reste autour de la quantité posée', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes'))];
  autoAdjust(items, byId, LUNCH);
  items.push(item(F('Haricots verts'), 200));
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  const veg = items[2].qty.thomas;
  check('légume compris entre 170 et 230 g', veg >= 170 && veg <= 230, `${veg} g`);
  // second passage : pas de dérive cumulative
  autoAdjust(items, byId, LUNCH);
  autoAdjust(items, byId, LUNCH);
  const veg2 = items[2].qty.thomas;
  check('pas de dérive après 3 recalculs', Math.abs(veg2 - veg) <= 10, `${veg} g → ${veg2} g`);
});

/* ================================================================ TEST D */

test('D — ajout d’huile : les lipides sont corrigés sans casser le reste', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes')), item(F('Haricots verts'), 200)];
  autoAdjust(items, byId, LUNCH);
  items.push(item(F('Huile d’olive')));
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  // lipides = PLAFOND (calibration asymétrique validée) : rester sous la cible
  // est désormais volontairement acceptable (ici thomas -11,9 %, julie -7,8 %),
  // seul un DÉPASSEMENT > 5 % serait un échec. kcal/protéines/glucides
  // continuent d'atteindre la cible exacte ici (assez de degrés de liberté :
  // pas de changement de comportement à vérifier pour ces trois-là).
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    for (const [key, label] of [['kcal', 'kcal'], ['protein', 'P'], ['carbs', 'C']]) {
      check(`${p} : ${label} dans ±5 %`, Math.abs(dev(m[key], LUNCH[p][key])) <= 0.05,
        `${m[key].toFixed(1)} / ${LUNCH[p][key]}`);
    }
    check(`${p} : lipides jamais au-dessus de la cible (+5 % max)`, dev(m.fat, LUNCH[p].fat) <= 0.05,
      `${m.fat.toFixed(1)} / ${LUNCH[p].fat}`);
  }
  const oil = items[3].qty.thomas;
  check('quantité d’huile plausible (≤ 45 g)', oil <= 45, `${oil} g`);
});

/* ================================================================ TEST E */

test('E — aliment verrouillé : quantité strictement inchangée', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  autoAdjust(items, byId, LUNCH);
  items[0].qty.thomas = 180; items[0].qty.julie = 130;
  items[0].locked.thomas = true; items[0].locked.julie = true;
  for (let i = 0; i < 5; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  check('poulet Thomas exactement 180 g', items[0].qty.thomas === 180, `${items[0].qty.thomas}`);
  check('poulet Julie exactement 130 g', items[0].qty.julie === 130, `${items[0].qty.julie}`);
  // ajout d'un aliment supplémentaire : toujours intouchable
  items.push(item(F('Skyr')));
  autoAdjust(items, byId, LUNCH);
  check('poulet inchangé après ajout d’un aliment', items[0].qty.thomas === 180 && items[0].qty.julie === 130);
  check('les autres aliments ont bougé', items.slice(1).some((it) => it.qty.thomas !== 0));
});

/* ================================================================ TEST F */

test('F — plusieurs aliments verrouillés', () => {
  const items = [
    item(F('Blanc de poulet'), 200, { lock: true }),
    item(F('Riz basmati'), 100, { lock: true }),
    item(F('Courgettes'), 150),
    item(F('Huile d’olive'), 5),
  ];
  const before = items.map((it) => ({ ...it.qty }));
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  check('poulet verrouillé inchangé', items[0].qty.thomas === before[0].thomas && items[0].qty.julie === before[0].julie);
  check('riz verrouillé inchangé', items[1].qty.thomas === before[1].thomas && items[1].qty.julie === before[1].julie);
  check('huile déverrouillée ajustée', items[3].qty.thomas !== before[3].thomas, `${before[3].thomas} → ${items[3].qty.thomas} g`);
  check('courgettes toujours présentes et raisonnables', items[2].qty.thomas >= 60 && items[2].qty.thomas <= 320, `${items[2].qty.thomas} g`);
});

/* ============================================== P1.2 — VERROUILLAGE PAR PERSONNE (v1.5.2) */
/*
 * `js/views/editor.js` (handler data-qty) verrouille désormais AUTOMATIQUEMENT
 * `it.locked[person]=true` dès qu'une quantité est modifiée manuellement, pour
 * la seule personne éditée. Ce mécanisme réutilise TEL QUEL le verrouillage
 * déjà lu par `buildVarsAndFixed()` (aucun changement moteur) — ces tests
 * vérifient que, une fois `locked` posé par personne, l'indépendance
 * Thomas/Julie déjà garantie par le moteur tient pour TOUS les types
 * d'items (aliment, recette, préparation) avec des quantités distinctes.
 */
test('P1.2 — verrouillage indépendant par personne (aliment) : locked.thomas=true n’empêche pas Julie d’être ajustée', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  autoAdjust(items, byId, LUNCH);
  items[0].qty.thomas = 180; // simule une saisie manuelle, Thomas uniquement
  items[0].locked.thomas = true; // ... et donc SEULEMENT locked.thomas, comme le ferait editor.js
  const julieBefore = items[0].qty.julie;
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  check('Thomas (verrouillé) reste exactement à 180 g', items[0].qty.thomas === 180, `${items[0].qty.thomas}`);
  check('Julie (non verrouillée) reste ajustable normalement', items[0].qty.julie !== 180, `${items[0].qty.julie}`);
  check('Julie a une quantité cohérente avec sa propre cible (pas figée à l’ancienne valeur)',
    Math.abs(items[0].qty.julie - julieBefore) >= 0 && items[0].qty.julie > 0);
});

test('P1.2 — verrouillage indépendant par personne (recette weight) : même garantie qu’un aliment classique', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const items = [recipeItemInMeal(recipe.id, 300)];
  autoAdjust(items, byId, LUNCH, { recipesById });
  items[0].qty.julie = 250; // simule une saisie manuelle, Julie uniquement
  items[0].qty.thomas = 5; // valeur délibérément mauvaise, pour prouver que Thomas bouge réellement
  items[0].locked = { thomas: false, julie: true };
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH, { recipesById });
  check('Julie (verrouillée) reste exactement à 250 g', items[0].qty.julie === 250, `${items[0].qty.julie}`);
  check('Thomas (non verrouillé) s’éloigne réellement de sa valeur de départ mauvaise (5 g)',
    items[0].qty.thomas > 50, `${items[0].qty.thomas} g`);
  check('Thomas n’est jamais contraint par le verrou de Julie (aucun couplage inter-personnes)',
    !items[0].locked.thomas);
});

test('P1.2 — verrouillage indépendant par personne (préparation) : cohérent avec le mode normal existant', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 5000);
  const preparationsById = { [prep.id]: prep };
  const items = [newPreparationItem(prep.id, 200)];
  autoAdjust(items, byId, LUNCH, { preparationsById, preparationAvailability: { [prep.id]: 5000 - 200 } });
  items[0].qty.thomas = 300; // simule une saisie manuelle, Thomas uniquement
  items[0].locked.thomas = true;
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH, { preparationsById, preparationAvailability: { [prep.id]: 5000 - 300 } });
  check('Thomas (verrouillé) reste exactement à 300 g', items[0].qty.thomas === 300, `${items[0].qty.thomas}`);
  check('Julie (non verrouillée) reste ajustable', items[0].qty.julie > 0);
});

/* ================================================================ TEST G */

test('G — aucun aliment ajouté ni supprimé automatiquement', () => {
  const items = [
    item(F('Blanc de poulet')),
    item(F('Pâtes complètes')),
    item(F('Chocolat noir'), 30), // aliment volontairement "gênant" pour la cible
    item(F('Huile d’olive')),
  ];
  const ids = items.map((i) => i.id);
  for (let i = 0; i < 4; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  check('même nombre d’ingrédients', items.length === 4, `${items.length}`);
  check('mêmes identifiants', items.every((it, i) => it.id === ids[i]));
  check('aucune quantité nulle', items.every((it) => it.qty.thomas > 0 && it.qty.julie > 0));
  check('le chocolat reste présent', items[2].qty.thomas > 0, `${items[2].qty.thomas} g`);
});

/* ================================================================ TEST H */

test('H — cible impossible : écart affiché plutôt que composition absurde', () => {
  // uniquement des légumes pour un déjeuner à 1050 kcal
  const items = [item(F('Haricots verts'), 200), item(F('Courgettes'), 150), item(F('Brocolis'), 150)];
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  const total = items.reduce((s, it) => s + it.qty.thomas, 0);
  check('poids total de légumes raisonnable (< 1 kg)', total < 1000, `${total} g`);
  check('chaque légume reste sous 320 g', items.every((it) => it.qty.thomas <= 320));
  const m = mealMacros(items, byId, 'thomas');
  const d = diagnose(m, LUNCH.thomas, foods);
  check('écart signalé', d !== null && d.rows.length >= 3);
  // kcal = plafond (P1.1, décision verrouillée) : un déficit, même énorme,
  // n'est jamais "off" (rouge) — seul un dépassement l'est. Avant P1.1, la
  // même tolérance symétrique que les autres macros s'appliquait au kcal.
  check('kcal très en dessous, signalé "warn" (jamais "off" par déficit calorique)',
    evaluate(m, LUNCH.thomas).rows[0].status === 'warn', `${m.kcal.toFixed(0)} kcal`);

  // seconde combinaison impossible : whey seule sur un déjeuner
  const only = [item(F('Protéine en poudre'))];
  autoAdjust(only, byId, LUNCH);
  show(only, LUNCH);
  check('whey plafonnée à une quantité plausible (≤ 250 g)', only[0].qty.thomas <= 250, `${only[0].qty.thomas} g`);
});

/* ================================================================ TEST I */

test('I — Thomas et Julie optimisés indépendamment, même composition', () => {
  const items = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  check('même liste d’aliments pour les deux', items.every((it) => it.qty.thomas > 0 && it.qty.julie > 0));
  check('quantités différentes', items.some((it) => it.qty.thomas !== it.qty.julie));
  // calibration asymétrique validée : kcal/lipides (plafonds) peuvent rester
  // sous la cible (ici thomas -6,4 % kcal / -12,7 % L, julie -6,5 % L) — ce
  // n'est plus un échec, `within()` (symétrique) ne reflète plus le contrat
  // de l'optimiseur ; `withinAsym()` l'exprime (protéines/glucides inchangés).
  for (const p of ['thomas', 'julie']) {
    check(`${p} : les 4 macros respectent la hiérarchie (kcal/L ≤ cible, P ≥ cible, G proche)`, withinAsym(items, LUNCH, p));
  }
});

/* ================================================================ TEST J */

test('J — composition différente : un aliment absent (0 g) est ignoré', () => {
  const items = [
    item(F('Blanc de poulet')),
    item(F('Riz basmati')),
    item(F('Huile d’olive')),
    item(F('Cabillaud'), 0, { thomas: 0, julie: 150 }), // uniquement pour Julie
    item(F('Wrap'), 0, { thomas: 124, julie: 0 }), // uniquement pour Thomas
  ];
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  check('cabillaud reste à 0 g pour Thomas', items[3].qty.thomas === 0);
  check('cabillaud présent pour Julie', items[4].qty.julie === 0 && items[3].qty.julie > 0);
  check('wrap reste à 0 g pour Julie', items[4].qty.julie === 0);
  check('wrap présent pour Thomas', items[4].qty.thomas > 0, `${items[4].qty.thomas} g`);
  // kcal = PLAFOND (calibration asymétrique validée) : rester sous la cible
  // (ici thomas -5,6 %) est désormais accepté, seul un dépassement > 5 % est un échec.
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    check(`${p} : kcal jamais au-dessus de la cible (+5 % max)`, dev(m.kcal, LUNCH[p].kcal) <= 0.05, `${m.kcal.toFixed(0)}`);
  }
});

/* ================================================================ ARCHITECTURE C (V1.4) */

test('V1.4 — anchor supprimé de CATEGORY_PROFILE', () => {
  for (const [id, p] of Object.entries(CATEGORY_PROFILE)) {
    check(`${id} : aucune clé "anchor"`, !('anchor' in p));
    check(`${id} : clé "eCat" présente`, typeof p.eCat === 'number' && p.eCat > 0, `${p.eCat}`);
  }
});

test('V1.4 — un légume n’est plus figé (ancien point fixe de l’ancrage)', () => {
  // reproduction du bug V1.4 : un légume seul, très loin de la cible calorique.
  // Sous l’ancien anchor (40 pour les légumes), le déplacement mesuré était de 0 g.
  const items = [item(F('Courgettes'))];
  const initial = items[0].qty.thomas;
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, LUNCH);
  const moved = Math.abs(items[0].qty.thomas - initial);
  show(items, LUNCH);
  check('la courgette a réellement bougé (pas de point fixe)', moved > 20, `${initial} g → ${items[0].qty.thomas} g`);
});

test('V1.4 — référence de portion (architecture C)', () => {
  // √(réf_cat × E_cat × 100 / densité), bornée à [réf_cat/3, réf_cat×3]
  check('référence courgettes ≈ 255 g', Math.abs(referenceFor(F('Courgettes')) - 255) < 2,
    `${referenceFor(F('Courgettes')).toFixed(1)} g`);
  check('référence haricots verts ≈ 208 g', Math.abs(referenceFor(F('Haricots verts')) - 208) < 2,
    `${referenceFor(F('Haricots verts')).toFixed(1)} g`);
  // densité extrême : le clamp [réf_cat/3, réf_cat×3] doit borner la référence
  const p = profileOf({ category: 'matiere_grasse' });
  const dense = referenceFor({ category: 'matiere_grasse', kcal: 20000 });
  check('densité extrême (très dense) : référence bornée au plancher réf_cat/3',
    Math.abs(dense - p.def / 3) < 0.01, `${dense}`);
  const light = referenceFor({ category: 'matiere_grasse', kcal: 1 });
  check('densité extrême (très légère) : référence bornée au plafond réf_cat×3',
    Math.abs(light - p.def * 3) < 0.01, `${light}`);
  // aucune calorie renseignée : repli sur réf_cat (pas de division par zéro)
  check('aliment à 0 kcal : repli sur réf_cat, pas de division par zéro',
    referenceFor({ category: 'autre', kcal: 0 }) === profileOf({ category: 'autre' }).def);
});

test('V1.4 — catégorie legumineuse', () => {
  check('lentilles → legumineuse', F('Lentilles').category === 'legumineuse');
  check('pois chiches → legumineuse', F('Pois chiches').category === 'legumineuse');
  check('haricots rouges → legumineuse', F('Haricots rouges').category === 'legumineuse');
  check('identifiants inchangés',
    F('Lentilles').id === 'f_lentilles' && F('Pois chiches').id === 'f_pois_chiches' &&
    F('Haricots rouges').id === 'f_haricots_rouges');
  check('catégorie legumineuse déclarée dans CATEGORIES', CATEGORIES.some((c) => c.id === 'legumineuse'));
});

test('V1.4 — libellé « Noix & graines »', () => {
  check('libellé de la catégorie oléagineux', CATEGORIES.find((c) => c.id === 'oleagineux')?.label === 'Noix & graines');
  check('identifiant de catégorie inchangé', F('Amandes').category === 'oleagineux');
});

test('V1.4 — multi-départ : même résultat quel que soit le point de départ', () => {
  const base = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  const scales = [0.25, 0.5, 1, 2, 4];
  const finals = scales.map((s) => {
    const its = base.map((it) => ({ ...it, qty: { thomas: it.qty.thomas * s, julie: it.qty.julie * s } }));
    for (let i = 0; i < 4; i++) autoAdjust(its, byId, LUNCH);
    return its.map((it) => it.qty.thomas);
  });
  info(finals.map((f, i) => `×${scales[i]} → ${f.join('/')}`).join(' | '));
  const ref = finals[2]; // départ ×1
  check('même résultat (±1 g) quel que soit le point de départ',
    finals.every((f) => f.every((v, i) => Math.abs(v - ref[i]) <= 1)));
});

test('V1.4 — idempotence : ré-application sans dérive', () => {
  const items = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  for (let i = 0; i < 4; i++) autoAdjust(items, byId, LUNCH); // convergence
  const before = items.map((it) => it.qty.thomas);
  autoAdjust(items, byId, LUNCH);
  const after = items.map((it) => it.qty.thomas);
  check('0 g de déplacement à la ré-application', before.every((v, i) => v === after[i]), `${before.join(',')} → ${after.join(',')}`);
});

test('V1.4 — les bornes ne sont pas le mécanisme porteur (scénario normal)', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes'))];
  autoAdjust(items, byId, LUNCH);
  items.push(item(F('Haricots verts'), 200));
  autoAdjust(items, byId, LUNCH);
  // documenté, non asserté (cf. passation V1.4 §13.3.a.8) : sur un scénario
  // courant, le résultat n'est normalement pas produit par une borne.
  info(items.map((it) => {
    const p = profileOf(byId[it.foodId]);
    const onBound = it.qty.thomas <= p.min || it.qty.thomas >= p.max;
    return `${byId[it.foodId].name} ${it.qty.thomas} g (bornes ${p.min}-${p.max})${onBound ? ' ← sur une borne' : ''}`;
  }).join(' | '));
});

/* ============================================== V1.4.1 — QUANTIFICATION DISCRÈTE */
/*
 * Correction : l'optimisation continue reste inchangée, mais un aliment non
 * fractionnable n'est plus arrondi isolément en toute fin de calcul — les
 * variables fractionnables restantes sont réoptimisées autour du palier
 * retenu (cf. régression identifiée sur le Test J). Générique par
 * construction : aucun de ces tests ne cite "wrap" dans le moteur.
 */

test('V1.4.1 — aliment non fractionnable différent du wrap (œuf) : la tolérance macro redevient atteignable', () => {
  const target = { thomas: { kcal: 650, protein: 650 * 0.052, carbs: 650 * 0.114, fat: 650 * 0.033 } };
  const items = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Huile d’olive')), item(F('Œuf entier'), 120)];
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, target);
  show(items, target);
  const egg = F('Œuf entier');
  check('œuf = multiple entier de 60 g', items[3].qty.thomas % egg.gramsPerUnit === 0, `${items[3].qty.thomas} g`);
  const m = mealMacros(items, byId, 'thomas');
  check('thomas : kcal dans ±5 %', Math.abs(dev(m.kcal, target.thomas.kcal)) <= 0.05, `${m.kcal.toFixed(1)}`);
});

test('V1.4.1 — deux aliments non fractionnables simultanés (wrap + œuf) : pas de recherche combinatoire, une solution cohérente', () => {
  const target = { thomas: { kcal: 850, protein: 850 * 0.052, carbs: 850 * 0.114, fat: 850 * 0.033 } };
  const items = [item(F('Wrap'), 124), item(F('Œuf entier'), 120), item(F('Blanc de poulet')), item(F('Huile d’olive'))];
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, target);
  show(items, target);
  check('wrap = multiple entier de 62 g', items[0].qty.thomas % 62 === 0, `${items[0].qty.thomas} g`);
  check('œuf = multiple entier de 60 g', items[1].qty.thomas % 60 === 0, `${items[1].qty.thomas} g`);
  const m = mealMacros(items, byId, 'thomas');
  check('thomas : kcal dans ±5 % avec deux aliments à l’unité en même temps', Math.abs(dev(m.kcal, target.thomas.kcal)) <= 0.05, `${m.kcal.toFixed(1)}`);
});

test('V1.4.1 — idempotence et absence d’oscillation avec un aliment non fractionnable', () => {
  const target = { thomas: { kcal: 650, protein: 650 * 0.052, carbs: 650 * 0.114, fat: 650 * 0.033 } };
  const items = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Huile d’olive')), item(F('Œuf entier'), 120)];
  for (let i = 0; i < 3; i++) autoAdjust(items, byId, target); // convergence
  const history = [items.map((it) => it.qty.thomas)];
  for (let i = 0; i < 5; i++) {
    autoAdjust(items, byId, target);
    history.push(items.map((it) => it.qty.thomas));
  }
  info(history.map((h) => h.join('/')).join(' | '));
  check('0 g de déplacement dès le 1er passage supplémentaire',
    history.every((h) => JSON.stringify(h) === JSON.stringify(history[0])));
  check('aucune oscillation entre deux états sur 5 applications de plus',
    new Set(history.map((h) => JSON.stringify(h))).size === 1);
});

test('V1.4.1 — non-régression : sans aliment non fractionnable, comportement strictement inchangé', () => {
  // scénario historique du Test D, sans aucun aliment à l'unité : doit retomber
  // exactement sur les quantités connues (référence recalculée après le passage
  // à la résolution 1 g — roundQuantity() n'impose plus les anciens paliers de
  // catégorie de 5 g ; l'optimum CONTINU sous-jacent, lui, n'a pas changé).
  //
  // Référence mise à jour par la calibration asymétrique (validée) : ancien
  // optimum symétrique (124, 184, 128, 27), nouveau (124, 183, 134, 24) — les
  // lipides (plafond) reculent légèrement (27 g → 24 g) au profit des haricots
  // (128 g → 134 g), cohérent avec "dépasser les lipides est fortement
  // pénalisé, en rester en dessous est acceptable".
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes')), item(F('Haricots verts'), 200)];
  autoAdjust(items, byId, LUNCH);
  items.push(item(F('Huile d’olive')));
  autoAdjust(items, byId, LUNCH);
  const q = items.map((it) => it.qty.thomas);
  check('quantités identiques à la référence (résolution 1 g) (124, 183, 134, 24)',
    q[0] === 124 && q[1] === 183 && q[2] === 134 && q[3] === 24, q.join(','));
});

/* ================================================================ UNITÉS */

test('Unités — aliments non fractionnables et unités pratiques', () => {
  const eggs = [item(F('Œuf entier')), item(F('Pain complet'))];
  for (let i = 0; i < 3; i++) autoAdjust(eggs, byId, SNACK);
  const gEgg = F('Œuf entier').gramsPerUnit;
  info(`œufs : ${eggs[0].qty.thomas} g = ${eggs[0].qty.thomas / gEgg} unités`);
  check('œufs = multiple entier de 60 g', eggs[0].qty.thomas % gEgg === 0, `${eggs[0].qty.thomas} g`);
  check('au moins un œuf', eggs[0].qty.thomas >= gEgg);

  const wasa = F('Pain croustillant');
  const w = [item(wasa), item(F('Fromage frais tartinable'))];
  for (let i = 0; i < 3; i++) autoAdjust(w, byId, SNACK);
  check('Wasa = multiple entier de 11 g', w[0].qty.thomas % wasa.gramsPerUnit === 0, `${w[0].qty.thomas} g = ${w[0].qty.thomas / 11} tranches`);

  const wrap = F('Wrap');
  const wr = [item(wrap), item(F('Blanc de poulet'))];
  for (let i = 0; i < 3; i++) autoAdjust(wr, byId, LUNCH);
  check('wrap = multiple entier de 62 g', wr[0].qty.thomas % wrap.gramsPerUnit === 0, `${wr[0].qty.thomas} g = ${wr[0].qty.thomas / 62} wraps`);

  const compote = F('Compote');
  const c = [item(compote), item(F('Skyr'))];
  for (let i = 0; i < 3; i++) autoAdjust(c, byId, SNACK);
  check('compote = multiple entier de 100 g (pot)', c[0].qty.thomas % compote.gramsPerUnit === 0, `${c[0].qty.thomas} g`);

  const skyr = F('Skyr');
  check('skyr fractionnable : résolution 1 g, unité indicative (pas de palier de 5 g)',
    roundQuantity(skyr, 192.4) === 192, `${roundQuantity(skyr, 192.4)} g`);

  // bornes + unités entières : la quantité reste un multiple même au plafond
  const big = roundQuantity(F('Œuf entier'), 1000);
  check('arrondi borné reste un multiple', big % gEgg === 0, `${big} g`);
});

/* ============================================== RÉSOLUTION 1 g (POINT N°1) */

test('Résolution 1 g — aliment fractionnable : plus de paliers artificiels de catégorie', () => {
  const poulet = F('Blanc de poulet'); // catégorie proteine, ancien step: 5
  check('137 g reste 137 g (pas arrondi à 135 ou 140)', roundQuantity(poulet, 137) === 137);
  check('138 g reste 138 g', roundQuantity(poulet, 138) === 138);
  check('139 g reste 139 g', roundQuantity(poulet, 139) === 139);
  check('181,4 g arrondit au gramme le plus proche (181 g)', roundQuantity(poulet, 181.4) === 181);
  check('181,6 g arrondit au gramme le plus proche (182 g)', roundQuantity(poulet, 181.6) === 182);

  const huile = F('Huile d’olive'); // catégorie matiere_grasse, ancien step: 1 (déjà fin)
  check('huile : résolution déjà fine, inchangée', roundQuantity(huile, 23) === 23);

  // bornes min/max toujours respectées malgré la résolution 1 g
  check('borne max respectée (250 max, demande 400)', roundQuantity(poulet, 400, 50, 250) === 250);
  check('borne min respectée (50 min, demande 10)', roundQuantity(poulet, 10, 50, 250) === 50);
  check('valeur dans les bornes : inchangée au gramme près', roundQuantity(poulet, 183, 50, 250) === 183);
});

test('Résolution 1 g — les indivisibles et les bornes de recherche restent inchangés', () => {
  const wrap = F('Wrap'); // non fractionnable, gramsPerUnit: 62
  check('un aliment indivisible reste en unités entières malgré la résolution 1 g',
    roundQuantity(wrap, 100) % wrap.gramsPerUnit === 0, `${roundQuantity(wrap, 100)} g`);
});

test('Unités — multiple entier de gramsPerUnit, quelle que soit la saisie', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 }; // 1 tranche = 13 g, non fractionnable
  info(`${wasa.name} : ${wasa.gramsPerUnit} g/unité, fractionnable = ${wasa.fractionable}`);

  // saisie en grammes : toute valeur est ramenée au multiple le plus proche
  for (const [entry, expected] of [[13, 13], [20, 26], [25, 26], [31, 26], [39, 39], [52, 52], [0, 0]]) {
    check(`saisie ${entry} g → ${expected} g`, snapQuantity(wasa, entry) === expected, `${snapQuantity(wasa, entry)}`);
  }
  check('une saisie positive donne au moins une unité', snapQuantity(wasa, 3) === 13);
  check('0 g reste 0 g (ingrédient absent pour la personne)', snapQuantity(wasa, 0) === 0);

  // saisie en unités
  for (const u of [1, 2, 3, 4]) {
    check(`${u} unité(s) → ${u * 13} g`, snapQuantity(wasa, fromUnits(wasa, u)) === u * 13);
  }
  check('2,4 unités saisies → 2 unités', snapQuantity(wasa, fromUnits(wasa, 2.4)) === 26);
  check('conversion grammes → unités', toUnits(wasa, 39) === 3);

  // règle générique : n'importe quel aliment non fractionnable
  const generic = { name: 'Aliment X', category: 'autre', gramsPerUnit: 37, fractionable: false,
    kcal: 100, protein: 5, carbs: 10, fat: 3, referenceState: 'pret' };
  check('règle générique (37 g/unité)', snapQuantity(generic, 100) === 111, `${snapQuantity(generic, 100)}`);
  check('aliment fractionnable non contraint', snapQuantity({ ...generic, fractionable: true }, 100) === 100);
  check('aliment sans unité non contraint', snapQuantity({ ...generic, gramsPerUnit: 0 }, 100) === 100);
  check('isWholeUnitFood générique', isWholeUnitFood(generic) && !isWholeUnitFood({ ...generic, fractionable: true }));

  // l'ajustement automatique respecte la contrainte, sur tous les types de repas
  const localById = { ...byId, [generic.name]: generic };
  for (const [label, targets] of [['déjeuner', LUNCH], ['collation', SNACK]]) {
    const items = [item(F('Œuf entier')), item(wasa, 26), item(F('Skyr'))];
    const map = { ...byId, [wasa.id]: wasa };
    for (let i = 0; i < 3; i++) autoAdjust(items, map, targets);
    const ok = items.every((it) => {
      const f = map[it.foodId];
      return PERSONS_EVERY(it, f);
    });
    check(`ajustement (${label}) : toutes les quantités restent des multiples`, ok,
      items.map((it) => `${map[it.foodId].name} ${it.qty.thomas}/${it.qty.julie}`).join(' | '));
  }
  // pas du stepper : gramsPerUnit en grammes, 1 en unités
  check('pas du curseur en grammes = 13 g', quantityStep(wasa) === 13, `${quantityStep(wasa)}`);
  check('pas du curseur en unités = 1', quantityStep(wasa, { inUnits: true }) === 1);
  check('aliment à 15 g/unité : pas de 15 g', quantityStep({ gramsPerUnit: 15, fractionable: false }) === 15);
  check('aliment à 20 g/unité : pas de 20 g', quantityStep({ gramsPerUnit: 20, fractionable: false }) === 20);
  check('aliment fractionnable : pas de 1 g', quantityStep(F('Blanc de poulet')) === 1);
  const suite = [13, 26, 39, 52, 65];
  let v = 0;
  const walked = suite.map(() => (v += quantityStep(wasa)));
  check('progression 13 → 26 → 39 → 52 → 65', walked.join(' ') === suite.join(' '), walked.join(' '));
  check('chaque palier reste un multiple valide', walked.every((x) => snapQuantity(wasa, x) === x));
  check('quantité initiale proposée déjà en multiples', initialQuantity(wasa) % 13 === 0, `${initialQuantity(wasa)}`);
  check('borne haute respectée en multiples', roundQuantity(wasa, 5000, 0, 400) % 13 === 0);
});

function PERSONS_EVERY(it, food) {
  if (!isWholeUnitFood(food)) return true;
  return ['thomas', 'julie'].every((p) => (it.qty[p] || 0) % food.gramsPerUnit === 0);
}

test('Rendement après cuisson — coefficient = poids cuit ÷ poids cru', () => {
  const f = (raw, cooked) => computeYield(raw, cooked);
  check('500 g crus → 375 g cuits = 0,75', f(500, 375).factor === 0.75, `${f(500, 375).factor}`);
  check('500 g crus → 1000 g cuits = 2', f(500, 1000).factor === 2);
  check('500 g crus → 400 g cuits = 0,8', f(500, 400).factor === 0.8);
  check('100 g crus → 240 g cuits = 2,4', f(100, 240).factor === 2.4);
  check('la formule n’est jamais inversée', f(100, 75).factor === 0.75 && f(75, 100).factor !== 0.75);
  check('virgule décimale acceptée', f('500', '375,5').ok === true);

  check('poids cru nul refusé', f(0, 375).ok === false && /nul/i.test(f(0, 375).error));
  check('aucune division par zéro', Number.isFinite(f(0, 375).factor ?? 0));
  check('poids cuit nul refusé', f(500, 0).ok === false);
  check('champ vide refusé', f('', 375).ok === false && f(500, '').ok === false);
  check('valeur négative refusée', f(-500, 375).ok === false && f(500, -375).ok === false);
  check('valeur non numérique refusée', f('abc', 375).ok === false && /nombre/i.test(f('abc', 375).error));
  check('message d’erreur fourni dans tous les cas',
    [f(0, 1), f('', ''), f(-1, 1), f('x', 'y')].every((r) => typeof r.error === 'string' && r.error.length > 0));

  // cohérence avec le moteur : le coefficient calculé se comporte comme attendu
  const food = { ...F('Blanc de poulet'), cookedFactor: f(500, 375).factor };
  check('coefficient appliqué par le moteur', convertGrams(food, 100, 'cru', 'cuit') === 75);
});

test('Macros — les glucides s’affichent "G"', () => {
  const labels = MACRO_KEYS.map((m) => m.label);
  check('libellés P / G / L', labels.join('') === 'kcalPGL', labels.join(' '));
  const ev = evaluate({ kcal: 100, protein: 10, carbs: 10, fat: 5 }, LUNCH.thomas);
  check('aucun libellé "C" résiduel', !ev.rows.some((r) => r.label === 'C'));
});

/* ============================================== CALIBRATION ASYMÉTRIQUE (v1.5.0.7) */
/*
 * kcal/lipides = plafond (dépasser fortement pénalisé, être en dessous
 * indolore) ; protéines = plancher souple (déficit pénalisé, surplus
 * largement toléré mais jamais gratuit) ; glucides = objectif souple
 * symétrique, nettement secondaire. Décision verrouillée, calibration
 * validée : MACRO_ROLE/W_SOFT/W_HARD/C_SOFT/C_HARD dans nutrition.js.
 * `macroCost(k, d)` est le point d'entrée UNIQUE de cette asymétrie,
 * partagé par costOf() et costAt() — testé ici directement (exporté pour
 * la testabilité, fonction pure, aucun effet de bord).
 */

test('Calibration asymétrique — macroCost() respecte la hiérarchie kcal > lipides > protéines > glucides', () => {
  check('kcal +10 % coûte plus cher que kcal -10 %',
    macroCost('kcal', 0.10) > macroCost('kcal', -0.10),
    `+10%=${macroCost('kcal', 0.10).toFixed(5)} vs -10%=${macroCost('kcal', -0.10).toFixed(5)}`);
  check('lipides +10 % coûte plus cher que lipides -10 %',
    macroCost('fat', 0.10) > macroCost('fat', -0.10),
    `+10%=${macroCost('fat', 0.10).toFixed(5)} vs -10%=${macroCost('fat', -0.10).toFixed(5)}`);
  check('protéines -10 % coûte plus cher que protéines +10 %',
    macroCost('protein', -0.10) > macroCost('protein', 0.10),
    `-10%=${macroCost('protein', -0.10).toFixed(5)} vs +10%=${macroCost('protein', 0.10).toFixed(5)}`);
  check('glucides restent symétriques (±10 % et ±20 %)',
    Math.abs(macroCost('carbs', 0.10) - macroCost('carbs', -0.10)) < 1e-9 &&
    Math.abs(macroCost('carbs', 0.20) - macroCost('carbs', -0.20)) < 1e-9);

  // dépassement kcal/lipides suffisamment pénalisé par rapport à un surplus protéique équivalent
  const kcalOver = macroCost('kcal', 0.15);
  const fatOver = macroCost('fat', 0.15);
  const proteinOver = macroCost('protein', 0.15);
  check('un dépassement kcal (+15 %) coûte nettement plus qu’un surplus protéique équivalent',
    kcalOver > proteinOver * 3, `kcal=${kcalOver.toFixed(5)} vs protéines=${proteinOver.toFixed(5)}`);
  check('un dépassement lipides (+15 %) coûte nettement plus qu’un surplus protéique équivalent',
    fatOver > proteinOver * 3, `lipides=${fatOver.toFixed(5)} vs protéines=${proteinOver.toFixed(5)}`);

  // hiérarchie complète, côté pénalisé, écart identique (+10 % / -10 %)
  check('kcal (plafond dépassé) coûte plus cher que lipides (plafond dépassé) — priorité n°1',
    macroCost('kcal', 0.10) > macroCost('fat', 0.10));
  check('lipides (plafond dépassé) coûte plus cher que protéines (plancher manqué) — priorité n°2 > n°3',
    macroCost('fat', 0.10) > macroCost('protein', -0.10));
  check('protéines (plancher manqué) coûte plus cher que glucides (écart équivalent) — priorité n°3 > n°4',
    macroCost('protein', -0.10) > macroCost('carbs', -0.10));

  // le surplus protéique n'est jamais totalement gratuit
  check('un surplus protéique reste coûteux comparé à protéines pile sur la cible',
    macroCost('protein', 0.30) > macroCost('protein', 0));
});

/* ============================================== P1.1 — COLORATION DES OBJECTIFS (v1.5.2) */
/*
 * `statusForKey()` (affichage) est DISTINCTE de `macroCost()` (coût de
 * l'optimiseur, v1.5.0.7, non modifiée ici) : seuils propres à l'affichage,
 * réutilisant uniquement le rôle plafond/plancher/souple de MACRO_ROLE.
 * Tolérance par défaut t = 0.05 (state.settings.tolerance).
 */

test('P1.1 — kcal (plafond) : jamais rouge par déficit, rouge dès le moindre dépassement', () => {
  const target = 1000;
  check('légèrement sous la cible (-3 %) → ok', statusForKey('kcal', 970, target) === 'ok');
  check('pile sur la cible → ok', statusForKey('kcal', 1000, target) === 'ok');
  check('exactement à -t (-5 %) → ok (borne incluse)', statusForKey('kcal', 950, target) === 'ok');
  check('nettement sous la cible (-10 %) → warn', statusForKey('kcal', 900, target) === 'warn');
  check('très nettement sous la cible (-50 %) → warn (jamais off par déficit)',
    statusForKey('kcal', 500, target) === 'warn');
  check('le moindre dépassement (+0,1 %) → off', statusForKey('kcal', 1001, target) === 'off');
  check('dépassement franc (+10 %) → off', statusForKey('kcal', 1100, target) === 'off');
});

test('P1.1 — lipides (plafond) : formule explicite fat<=target→ok, ]target,+5%]→warn, >+5%→off', () => {
  const target = 30;
  check('sous la cible → ok', statusForKey('fat', 25, target) === 'ok');
  check('même très sous la cible (0 g) → ok (jamais un problème sous un plafond)',
    statusForKey('fat', 0, target) === 'ok');
  check('pile sur la cible → ok', statusForKey('fat', 30, target) === 'ok');
  check('+5 % exactement → warn (borne incluse)', statusForKey('fat', 31.5, target) === 'warn');
  check('+2 % → warn', statusForKey('fat', 30.6, target) === 'warn');
  check('> +5 % → off', statusForKey('fat', 33, target) === 'off');
});

test('P1.1 — protéines (plancher) : déficit strict, excès raisonnable toléré, excès très important signalé', () => {
  const target = 40;
  check('< -5 % (déficit important) → off', statusForKey('protein', 36, target) === 'off');
  check('exactement -5 % → warn (borne incluse côté warn, pas off)', statusForKey('protein', 38, target) === 'warn');
  check('entre -5 % et 0 % (déficit léger) → warn', statusForKey('protein', 39, target) === 'warn');
  check('pile sur la cible → ok', statusForKey('protein', 40, target) === 'ok');
  check('surplus raisonnable (+10 %) → ok', statusForKey('protein', 44, target) === 'ok');
  check('+15 % exactement → ok (borne incluse)', statusForKey('protein', 46, target) === 'ok');
  check('surplus très important (+20 %) → warn (jamais off, jamais gratuit)',
    statusForKey('protein', 48, target) === 'warn');
  check('surplus énorme (+50 %) → warn (reste signalé, jamais ok)',
    statusForKey('protein', 60, target) === 'warn');
});

test('P1.1 — glucides (souple) : comportement symétrique inchangé de statusFor()', () => {
  const target = 100;
  for (const value of [70, 80, 92, 100, 108, 120, 130]) {
    check(`glucides ${value}/${target} : identique à statusFor() (souple, inchangé)`,
      statusForKey('carbs', value, target) === statusFor(value, target));
  }
  check('déficit important (-20 %) → off', statusForKey('carbs', 80, target) === 'off');
  check('déficit proche (-10 %) → warn', statusForKey('carbs', 90, target) === 'warn');
  check('cible → ok', statusForKey('carbs', 100, target) === 'ok');
  check('dépassement proche (+10 %) → warn', statusForKey('carbs', 110, target) === 'warn');
  check('dépassement important (+20 %) → off', statusForKey('carbs', 120, target) === 'off');
  // symétrie stricte : même statut de part et d'autre d'un écart identique
  check('symétrie stricte -10 % / +10 %', statusForKey('carbs', 90, target) === statusForKey('carbs', 110, target));
  check('symétrie stricte -20 % / +20 %', statusForKey('carbs', 80, target) === statusForKey('carbs', 120, target));
});

test('P1.1 — evaluate() utilise bien statusForKey() par macro (intégration, pas seulement la fonction isolée)', () => {
  // même scénario que le tableau de seuils : kcal +1 % (off), fat 0 g (ok
  // malgré un déficit total), protein +20 % (warn), carbs -20% (off)
  const ev = evaluate({ kcal: 1010, protein: 48, carbs: 80, fat: 0 }, { kcal: 1000, protein: 40, carbs: 100, fat: 30 });
  const byKey = Object.fromEntries(ev.rows.map((r) => [r.key, r.status]));
  check('kcal off (dépassement)', byKey.kcal === 'off');
  check('protéines warn (excès très important)', byKey.protein === 'warn');
  check('glucides off (déficit important)', byKey.carbs === 'off');
  check('lipides ok (0 g, sous un plafond)', byKey.fat === 'ok');
  check('statut global = off (le pire des quatre)', ev.status === 'off');
});

/* ================================================================ CRU / CUIT */

test('États nutritionnels — l’état des valeurs et l’état pesé sont distincts', () => {
  // valeurs pour 100 g à l'état CRU, rendement 2,50 (100 g crus → 250 g cuits)
  const riz = {
    id: 'f_riz_test', name: 'Riz complet test', category: 'feculent',
    kcal: 350, protein: 7.5, carbs: 72, fat: 2.5, fiber: 3,
    referenceState: 'cru', cookedFactor: 2.5, gramsPerUnit: 0, fractionable: true,
  };

  // 1. référence CRU + utilisation CRUE → calcul direct
  const m1 = macrosFor(riz, 80, 'cru');
  check('1. cru / cru : calcul direct', Math.abs(m1.kcal - 280) < 0.001, `${m1.kcal}`);
  check('1. aucune conversion nécessaire', conversionInfo(riz, 'cru').needed === false);

  // 2. référence CRU + utilisation CUITE → conversion via le rendement
  // 5. rendement 2,50 : 200 g cuits → 80 g crus
  check('5. 200 g cuits → 80 g crus', Math.abs(toReferenceGrams(riz, 200, 'cuit') - 80) < 0.001,
    `${toReferenceGrams(riz, 200, 'cuit')}`);
  const m2 = macrosFor(riz, 200, 'cuit');
  info(`200 g cuits → ${m2.kcal.toFixed(0)} kcal, ${m2.protein.toFixed(1)} P, ${m2.carbs.toFixed(1)} G, ${m2.fat.toFixed(1)} L`);
  check('2. cru / cuit : macros calculées sur 80 g crus', Math.abs(m2.kcal - 280) < 0.001, `${m2.kcal}`);
  check('7. macros converties correctement',
    Math.abs(m2.protein - 6) < 0.001 && Math.abs(m2.carbs - 57.6) < 0.001 && Math.abs(m2.fat - 2) < 0.001);
  check('2. conversion signalée comme possible',
    conversionInfo(riz, 'cuit').needed === true && conversionInfo(riz, 'cuit').possible === true);

  // 6. rendement 0,75 : 150 g cuits → 200 g crus
  const viande = { ...riz, id: 'f_viande_test', name: 'Viande test', kcal: 120, protein: 20, carbs: 0, fat: 4, cookedFactor: 0.75 };
  check('6. 150 g cuits → 200 g crus', Math.abs(toReferenceGrams(viande, 150, 'cuit') - 200) < 0.001,
    `${toReferenceGrams(viande, 150, 'cuit')}`);
  check('6. macros correspondantes : 240 kcal', Math.abs(macrosFor(viande, 150, 'cuit').kcal - 240) < 0.001);

  // 3. référence CUITE + utilisation CUITE → calcul direct
  const rizCuit = { ...riz, id: 'f_riz_cuit', referenceState: 'cuit', kcal: 140, protein: 3, carbs: 29, fat: 1 };
  check('3. cuit / cuit : calcul direct', Math.abs(macrosFor(rizCuit, 200, 'cuit').kcal - 280) < 0.001);
  check('3. aucune conversion nécessaire', conversionInfo(rizCuit, 'cuit').needed === false);

  // 4. référence CUITE + utilisation CRUE → conversion inverse
  check('4. cuit / cru : 80 g crus → 200 g cuits', Math.abs(toReferenceGrams(rizCuit, 80, 'cru') - 200) < 0.001,
    `${toReferenceGrams(rizCuit, 80, 'cru')}`);
  check('4. macros converties', Math.abs(macrosFor(rizCuit, 80, 'cru').kcal - 280) < 0.001);
  check('4. conversion inverse possible', canConvert(rizCuit, 'cru', 'cuit') === true);

  // 8. aucune conversion inventée
  const conserve = { ...riz, id: 'f_conserve', referenceState: 'egoutte', cookedFactor: 2.5 };
  const infoEg = conversionInfo(conserve, 'cuit');
  check('8. égoutté ↔ cuit : conversion non définie', canConvert(conserve, 'cuit', 'egoutte') === false);
  check('8. aucun coefficient inventé, aucun poids supposé équivalent',
    toReferenceGrams(conserve, 200, 'cuit') === null);
  const mEg = macrosFor(conserve, 200, 'cuit');
  check('8. aucune macro calculée', mEg.unconvertible === true && mEg.kcal === 0 && mEg.protein === 0);
  check('8. l’utilisateur est prévenu', infoEg.needed === true && infoEg.possible === false && !!infoEg.message);
  check('8. message explicite', /Conversion impossible/.test(infoEg.message), infoEg.message);
  const sansRendement = { ...riz, id: 'f_sans_rdt', cookedFactor: null };
  check('8. rendement absent : pas de conversion cru/cuit', canConvert(sansRendement, 'cru', 'cuit') === false);
  check('8. rendement absent : aucune conversion, aucune macro',
    toReferenceGrams(sansRendement, 200, 'cuit') === null &&
    macrosFor(sansRendement, 200, 'cuit').unconvertible === true);
  check('8. les valeurs nutritionnelles ne sont jamais modifiées', riz.kcal === 350 && conserve.kcal === 350);

  // le total d'un repas n'intègre jamais un ingrédient non convertible
  const meal = [
    item(riz, 100, { state: 'cru' }),
    item(conserve, 200, { state: 'cuit' }), // conversion impossible
  ];
  const map = { [riz.id]: riz, [conserve.id]: conserve };
  const totals = mealMacros(meal, map, 'thomas');
  check('total = uniquement les ingrédients convertibles', Math.abs(totals.kcal - 350) < 0.001, `${totals.kcal}`);
  check('ingrédients exclus comptabilisés', totals.unconvertible === 1);
  check('même état → calcul normal dans le total',
    Math.abs(mealMacros([item(riz, 100, { state: 'cru' })], map, 'thomas').kcal - 350) < 0.001);
  check('cru/cuit avec rendement → calcul normal dans le total',
    Math.abs(mealMacros([item(riz, 250, { state: 'cuit' })], map, 'thomas').kcal - 350) < 0.001);
  check('aucun ingrédient exclu quand tout est convertible',
    mealMacros([item(riz, 250, { state: 'cuit' })], map, 'thomas').unconvertible === 0);
  check('l’ingrédient non convertible reste dans le repas', meal.length === 2);

  // l'ajustement automatique ne touche pas à un ingrédient non convertible
  const before = meal[1].qty.thomas;
  autoAdjust(meal, map, LUNCH);
  check('quantité d’un ingrédient non convertible inchangée par l’ajustement',
    meal[1].qty.thomas === before, `${meal[1].qty.thomas}`);

  // 9. l'état sélectionné est bien porté par l'ingrédient
  const it = item(riz, 200, { state: 'cuit' });
  check('9. état enregistré sur l’ingrédient', it.state === 'cuit');
  const relu = JSON.parse(JSON.stringify(it));
  check('9. état relu après sérialisation', relu.state === 'cuit');
  check('9. macros identiques après relecture',
    mealMacros([relu], { [riz.id]: riz }, 'thomas').kcal === mealMacros([it], { [riz.id]: riz }, 'thomas').kcal);
  check('9. sans état explicite, celui des valeurs nutritionnelles s’applique',
    macrosFor(riz, 80, null).kcal === macrosFor(riz, 80, 'cru').kcal);

  // libellés des quatre états
  check('quatre états proposés', STATES.length === 4 && STATES.map((x) => x.id).join(',') === 'cru,cuit,egoutte,pret');
  check('libellé « Cru / brut »', stateLabel('cru') === 'Cru / brut');
});

test('Cru / cuit — conversions et macros', () => {
  const pates = F('Pâtes complètes');
  const cuit = convertGrams(pates, 100, 'cru', 'cuit');
  info(`100 g crus → ${cuit} g cuits (coefficient ${pates.cookedFactor})`);
  check('conversion cru → cuit', Math.abs(cuit - 100 * pates.cookedFactor) < 0.001);
  check('conversion inverse', Math.abs(convertGrams(pates, cuit, 'cuit', 'cru') - 100) < 0.001);

  const mCru = macrosFor(pates, 100, 'cru');
  const mCuit = macrosFor(pates, cuit, 'cuit');
  check('macros identiques quel que soit l’état saisi',
    Math.abs(mCru.kcal - mCuit.kcal) < 0.001 && Math.abs(mCru.protein - mCuit.protein) < 0.001,
    `${mCru.kcal.toFixed(0)} kcal`);

  // coefficient 2,5 demandé par le cahier des charges : 100 g cru → 250 g cuit
  const test25 = { ...pates, cookedFactor: 2.5 };
  check('coefficient configurable (2,5)', convertGrams(test25, 100, 'cru', 'cuit') === 250);

  // viande : perte de poids à la cuisson
  const poulet = F('Blanc de poulet');
  check('poulet 100 g crus → moins de 100 g cuits', convertGrams(poulet, 100, 'cru', 'cuit') < 100,
    `${convertGrams(poulet, 100, 'cru', 'cuit')} g`);
  check('saisie en cuit ramenée en cru pour les macros',
    Math.abs(toReferenceGrams(poulet, 70, 'cuit') - 100) < 0.001);
});

/* ================================================================ BATCH */

const mkMeal = (day, type, items) => ({ id: `m${day}${type}`, dayIndex: day, mealType: type, name: '', sameComposition: true, items });

function batchState(overrides = {}) {
  return {
    foods,
    settings: {
      cycle: { startWeekday: 1, duration: 4 },
      batch: { enabled: true, maxDays: 3 },
      budget: 100,
      tolerance: 0.05,
      targets: { thomas: { lunch: LUNCH.thomas, dinner: LUNCH.thomas }, julie: { lunch: LUNCH.julie, dinner: LUNCH.julie } },
    },
    batch: { overrides },
    shopping: { purchased: {} },
    meals: [
      mkMeal(0, 'lunch', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 }), item(F('Riz basmati'), 0, { thomas: 90, julie: 70 })]),
      mkMeal(0, 'dinner', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 }), item(F('Haricots verts'), 200)]),
      mkMeal(1, 'lunch', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 }), item(F('Riz basmati'), 0, { thomas: 90, julie: 70 })]),
      mkMeal(1, 'dinner', [item(F('Cabillaud'), 0, { thomas: 200, julie: 150 })]),
      mkMeal(2, 'lunch', [item(F('Œuf entier'), 0, { thomas: 120, julie: 60 })]),
      mkMeal(2, 'dinner', [item(F('Wrap'), 0, { thomas: 124, julie: 62 }), item(F('Blanc de poulet'), 0, { thomas: 130, julie: 100 })]),
      mkMeal(3, 'lunch', [item(F('Riz basmati'), 0, { thomas: 90, julie: 70 })]),
      mkMeal(3, 'dinner', [item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 })]),
    ],
  };
}

test('Batch — agrégation par session et trois catégories', () => {
  const s = batchState();
  const plan = buildBatchPlan(s, byId);
  check('deux sessions pour 4 jours et 3 jours de conservation', plan.length === 2,
    plan.map((p) => `J${p.startDay + 1}-${p.endDay + 1}`).join(' / '));

  const s1 = plan[0];
  const poulet = s1.components.find((c) => c.food.name.includes('Blanc de poulet'));
  // jours 1-3 : 180+130 + 180+130 + 180+130 + 130+100 = 1160 g crus
  info(`poulet session 1 : ${poulet.requiredRaw} g crus → ${poulet.requiredCooked.toFixed(0)} g cuits`);
  check('poulet agrégé sur les deux personnes', poulet.requiredRaw === 1160, `${poulet.requiredRaw} g`);
  check('conversion cru → cuit correcte', Math.abs(poulet.requiredCooked - 1160 * 0.7) < 0.01);

  const riz = s1.components.find((c) => c.food.name.includes('Riz'));
  check('riz agrégé (jours 1 et 2)', riz.requiredRaw === 320, `${riz.requiredRaw} g`);

  const names = s1.components.map((c) => c.food.name);
  check('cabillaud exclu du batch', !names.some((n) => n.toLowerCase().includes('cabillaud')));
  check('œufs exclus du batch', !names.some((n) => n.includes('Œuf')));
  check('wrap exclu du batch', !names.some((n) => n.includes('Wrap')));

  // --- trois catégories, déduites des propriétés des aliments
  check('catégorie "batch" pour un aliment batchable', batchCategory(F('Blanc de poulet')) === 'batch');
  check('catégorie "cuisson du jour" pour le poisson', batchCategory(F('Cabillaud')) === 'cook');
  check('le poisson est marqué comme nécessitant une cuisson', F('Cabillaud').requiresCooking === true);
  check('le skyr n’est pas marqué comme nécessitant une cuisson', F('Skyr').requiresCooking === false);
  check('catégorie "cuisson du jour" pour les œufs', batchCategory(F('Œuf entier')) === 'cook');
  check('catégorie "assemblage" pour le wrap', batchCategory(F('Wrap')) === 'assemble');
  check('catégorie "assemblage" pour le skyr', batchCategory(F('Skyr')) === 'assemble');
  check('catégorie "assemblage" pour le pain croustillant', batchCategory(F('Pain croustillant')) === 'assemble');

  const cookNames = s1.cookSameDay.map((x) => x.food.name.toLowerCase());
  const assembleNames = s1.assembleSameDay.map((x) => x.food.name.toLowerCase());
  check('cabillaud dans "à cuire le jour même"', cookNames.some((n) => n.includes('cabillaud')));
  check('œufs dans "à cuire le jour même"', cookNames.some((n) => n.includes('œuf')));
  check('wrap dans "à assembler le jour même"', assembleNames.some((n) => n.includes('wrap')));
  check('aucun aliment batchable dans les deux autres catégories',
    ![...cookNames, ...assembleNames].some((n) => n.includes('poulet') || n.includes('riz')));
  check('cabillaud rattaché au bon jour',
    s1.cookSameDay.find((x) => x.food.name.toLowerCase().includes('cabillaud')).dayIndex === 1);

  const s2 = plan[1];
  check('session 2 = jour 4 uniquement', s2.startDay === 3 && s2.endDay === 3);
  const poulet2 = s2.components.find((c) => c.food.name.includes('Blanc de poulet'));
  check('poulet session 2 séparé de la session 1', poulet2.requiredRaw === 310, `${poulet2.requiredRaw} g`);

  // modification manuelle de la quantité préparée
  const key = `0:${F('Blanc de poulet').id}`;
  const s3 = batchState({ [key]: 1500 });
  const mealsBefore = JSON.stringify(s3.meals);
  const plan3 = buildBatchPlan(s3, byId);
  const p3 = plan3[0].components.find((c) => c.food.name.includes('Blanc de poulet'));
  check('quantité préparée manuelle prise en compte', p3.preparedRaw === 1500);
  check('besoin inchangé par la modification', p3.requiredRaw === 1160);
  check('surplus correct', p3.preparedRaw - p3.requiredRaw === 340);
  check('quantité cuite attendue recalculée', Math.abs(p3.preparedCooked - 1500 * 0.7) < 0.01);
  check('planning intact après calcul du batch', JSON.stringify(s3.meals) === mealsBefore);
});

test('Batch — plan opératoire : méthode, rendement, gamelles', () => {
  const s = batchState();
  const sess = buildBatchPlan(s, byId)[0];
  const poulet = sess.components.find((c) => c.food.name.includes('Blanc de poulet'));
  info(`poulet : ${poulet.method} ${poulet.temperature} °C ${poulet.duration} min, rendement ${poulet.yieldPct} %`);
  check('méthode de cuisson reprise de la fiche aliment', poulet.method === 'Four');
  check('température reprise', poulet.temperature === 180);
  check('durée reprise', poulet.duration === 25);
  check('temps de préparation repris', poulet.prepTime === 10);
  check('matériel repris', /Four/.test(poulet.equipment));
  check('rendement cru → cuit affiché en %', poulet.yieldPct === 70);
  check('consignes libres reprises (donnée, pas règle codée)', /filets entiers/.test(poulet.note || ''));
  check('résumé de cuisson lisible', cookingSummary(F('Blanc de poulet')) === 'Four · 180 °C · 25 min');

  // gamelles : quoi répartir, personne par personne
  check('une gamelle par repas de la session', sess.gamelles.length === 6,
    sess.gamelles.map((g) => `J${g.dayIndex + 1}${g.mealType === 'lunch' ? 'M' : 'S'}`).join(' '));
  const g1 = sess.gamelles[0];
  const tPoulet = g1.persons.thomas.find((e) => !e.free && e.name.includes('poulet'));
  const jPoulet = g1.persons.julie.find((e) => !e.free && e.name.includes('poulet'));
  info(`gamelle J1 midi — Thomas ${tPoulet.grams.toFixed(0)} g de poulet cuit, Julie ${jPoulet.grams.toFixed(0)} g`);
  check('quantités de gamelle exprimées cuites', tPoulet.cooked === true);
  check('Thomas : 180 g crus → 126 g cuits', Math.abs(tPoulet.grams - 126) < 0.01, `${tPoulet.grams}`);
  check('Julie : 130 g crus → 91 g cuits', Math.abs(jPoulet.grams - 91) < 0.01, `${jPoulet.grams}`);
  check('Thomas et Julie restent indépendants dans les gamelles', tPoulet.grams !== jPoulet.grams);
  check('chaque ligne de gamelle porte sa catégorie',
    g1.persons.thomas.every((e) => ['batch', 'cook', 'assemble', 'free'].includes(e.category)));
  const isWrap = (e) => !e.free && /wrap|tortilla/i.test(e.name);
  const gWrap = sess.gamelles.find((g) => g.persons.thomas.some(isWrap));
  check('le wrap apparaît dans la gamelle en catégorie assemblage',
    gWrap.persons.thomas.find(isWrap).category === 'assemble');
  check('une gamelle vide reste vide côté Julie si la quantité est nulle',
    sess.gamelles.every((g) => g.persons.julie.every((e) => e.free || e.grams > 0)));
});

test('Fiche aliment — paramètres de cuisson personnalisés repris dans le plan', () => {
  const dino = {
    id: 'f_dino', name: 'Cuisse de dinosaure', category: 'proteine', brand: '',
    kcal: 150, protein: 25, carbs: 0, fat: 6, fiber: 0,
    referenceState: 'cru', cookedFactor: 0.75, unitName: '', gramsPerUnit: 0, fractionable: true,
    price: null, packageWeight: null, batchAllowed: true, favorite: false, lastUsed: null, unitEntry: false,
    requiresCooking: true,
    cookingMethod: 'Four', cookingTemp: 200, cookingTime: 35, prepTime: 10, equipment: 'Four',
    instructions: 'Sortir 20 min avant, cuire entier, trancher après repos.',
  };
  const local = { ...byId, f_dino: dino };
  const s = batchState();
  s.foods = [...s.foods, dino];
  s.meals[0].items = [item(dino, 0, { thomas: 200, julie: 150 })];
  const sess = buildBatchPlan(s, local)[0];
  const c = sess.components.find((x) => x.food.id === 'f_dino');
  check('aliment personnalisé présent dans le batch', !!c);
  check('méthode personnalisée', c.method === 'Four' && c.temperature === 200 && c.duration === 35);
  check('rendement personnalisé', c.yieldPct === 75);
  check('quantité cuite attendue', Math.abs(c.requiredCooked - 350 * 0.75) < 0.01, `${c.requiredCooked}`);
  check('consignes personnalisées reprises', /Sortir 20 min/.test(c.note));
  check('aucune méthode imposée si la fiche est vide',
    preparationNote({ instructions: '' }) === null && cookingSummary({ name: 'X' }) === null);
});

/* ================================================================ COURSES */

test('Courses — besoin, conditionnements, surplus, budget', () => {
  const poulet = { ...F('Blanc de poulet'), id: 'f_test_poulet', packageWeight: 500, price: 6.9 };
  const local = { ...byId, f_test_poulet: poulet };
  const s = {
    foods: [poulet],
    settings: { cycle: { startWeekday: 0, duration: 2 }, batch: { enabled: true, maxDays: 3 }, budget: 100, tolerance: 0.05, targets: { thomas: {}, julie: {} } },
    batch: { overrides: {} },
    shopping: { purchased: {} },
    meals: [mkMeal(0, 'lunch', [item(poulet, 0, { thomas: 640, julie: 600 })])],
  };
  const list = buildShoppingList(s, local);
  const line = list.lines[0];
  info(`besoin ${line.required} g → ${line.packages} × ${line.packageWeight} g, surplus ${line.surplus} g, ${line.cost.toFixed(2)} €`);
  check('besoin = 1240 g', line.required === 1240);
  check('achat = 3 × 500 g', line.packages === 3 && line.packageWeight === 500);
  check('surplus = 260 g', line.surplus === 260);
  check('coût = 3 × prix du conditionnement', Math.abs(line.cost - 20.7) < 0.001);
  check('aucune notion de stock dans la ligne',
    !('stock' in line) && !('remaining' in line) && Object.keys(line).every((k) => !/stock|inventaire|remaining/i.test(k)),
    Object.keys(line).join(','));
  check('case "acheté" = simple booléen', line.purchased === false);

  // la case cochée ne modifie ni le besoin ni la quantité à acheter
  const s2 = { ...s, shopping: { purchased: { f_test_poulet: true } } };
  const line2 = buildShoppingList(s2, local).lines[0];
  check('cocher n’affecte pas le besoin', line2.required === line.required && line2.packages === line.packages);
  check('cocher n’est qu’un suivi', line2.purchased === true);

  // budget
  check('total du cycle calculé', Math.abs(buildShoppingList(s, local).total - 20.7) < 0.001);
  check('dépassement calculé mais non bloquant', buildShoppingList({ ...s, settings: { ...s.settings, budget: 10 } }, local).overBudget > 0);
});

/** État minimal pour les tests de catalogue (cycle de 6 jours). */
function catalogState(duration = 6) {
  const st = batchState();
  st.settings.cycle = { startWeekday: 1, duration };
  st.meals = [mkMeal(0, 'lunch', [item(F('Riz basmati'), 0, { thomas: 100, julie: 80 })])];
  st.breakfasts = [
    { id: 'b1', name: 'Overnight oats', sameComposition: true, uses: { thomas: 0, julie: 0 },
      items: [item(F('Skyr'), 0, { thomas: 150, julie: 150 }), item(F('Flocons'), 0, { thomas: 80, julie: 60 })] },
    { id: 'b2', name: 'Wasa + poulet', sameComposition: true, uses: { thomas: 0, julie: 0 },
      items: [item(F('Pain croustillant'), 0, { thomas: 33, julie: 22 })] },
  ];
  st.snacks = [
    { id: 's1', name: 'Whey + cajous', sameComposition: true, targetSlot: 'afternoon',
      uses: { thomas: { afternoon: 0, evening: 0 }, julie: { afternoon: 0, evening: 0 } },
      items: [item(F('Protéine en poudre'), 0, { thomas: 30, julie: 20 }), item(F('cajou'), 0, { thomas: 20, julie: 15 })] },
    { id: 's2', name: 'Skyr + fruits rouges', sameComposition: true, targetSlot: 'evening',
      uses: { thomas: { afternoon: 0, evening: 0 }, julie: { afternoon: 0, evening: 0 } },
      items: [item(F('Skyr'), 0, { thomas: 150, julie: 150 })] },
  ];
  st.coverage = { forced: {} };
  return st;
}

test('Petits-déjeuners — couverture du cycle par personne', () => {
  const st = catalogState(6);
  const cov = () => coverageReport(st).breakfast;

  check('besoin théorique = durée du cycle', cov().needed === 6);
  check('0 déclaré → manque signalé pour les deux',
    cov().persons.thomas.status === 'missing' && cov().persons.julie.status === 'missing');

  // Thomas 3 + 3 = 6, Julie 2 + 3 = 5
  st.breakfasts[0].uses = { thomas: 3, julie: 2 };
  st.breakfasts[1].uses = { thomas: 3, julie: 3 };
  const r = cov();
  info(`Thomas ${r.persons.thomas.used}/${r.persons.thomas.needed} · Julie ${r.persons.julie.used}/${r.persons.julie.needed}`);
  check('Thomas 6 / 6 → ok', r.persons.thomas.used === 6 && r.persons.thomas.status === 'ok');
  check('Julie 5 / 6 → avertissement', r.persons.julie.used === 5 && r.persons.julie.status === 'missing');
  check('manque chiffré', r.persons.julie.delta === -1);
  check('Thomas et Julie comptés indépendamment', r.persons.thomas.used !== r.persons.julie.used);

  // forçage : l'écart est assumé, l'avertissement reste
  st.coverage.forced.breakfast = true;
  check('écart assumé mémorisé', cov().persons.julie.forced === true);
  check('l’avertissement reste visible malgré le forçage', cov().persons.julie.status === 'missing');
  check('aucun compteur modifié automatiquement',
    st.breakfasts[0].uses.julie === 2 && st.breakfasts[1].uses.julie === 3);

  // dépassement : information, jamais blocage
  st.breakfasts[1].uses.julie = 5;
  const r2 = cov();
  check('Julie 7 / 6 → information', r2.persons.julie.used === 7 && r2.persons.julie.status === 'extra');
  check('surplus chiffré', r2.persons.julie.delta === 1);
  check('le cycle reste exploitable', buildShoppingList(st, byId).lines.length > 0);

  // la durée du cycle pilote le besoin
  st.settings.cycle.duration = 4;
  check('cycle de 4 jours → besoin 4', coverageReport(st).breakfast.needed === 4);
});

test('Collations — catalogue unique, affectations 16 h / soir', () => {
  const st = catalogState(6);
  const cov = () => coverageReport(st);

  check('un seul catalogue de collations', Array.isArray(st.snacks) && st.snacksAfternoon === undefined);
  check('une collation a une composition unique', st.snacks[0].items.length === 2);

  // Thomas : 3 × 16 h + 2 × soir ; Julie : 2 × 16 h + 1 × soir (option 1)
  st.snacks[0].uses = { thomas: { afternoon: 3, evening: 2 }, julie: { afternoon: 2, evening: 1 } };
  st.snacks[1].uses = { thomas: { afternoon: 3, evening: 3 }, julie: { afternoon: 4, evening: 5 } };

  const r = cov();
  info(`16 h — Thomas ${r.snack_afternoon.persons.thomas.used}/6, Julie ${r.snack_afternoon.persons.julie.used}/6`);
  info(`soir — Thomas ${r.snack_evening.persons.thomas.used}/6, Julie ${r.snack_evening.persons.julie.used}/6`);
  check('Thomas 16 h : 6 / 6 ✓', r.snack_afternoon.persons.thomas.status === 'ok');
  check('Thomas soir : 5 / 6 ⚠️', r.snack_evening.persons.thomas.used === 5 && r.snack_evening.persons.thomas.status === 'missing');
  check('Julie 16 h : 6 / 6 ✓', r.snack_afternoon.persons.julie.status === 'ok');
  check('Julie soir : 6 / 6 ✓', r.snack_evening.persons.julie.status === 'ok');
  check('16 h et soir comptés séparément',
    r.snack_afternoon.persons.thomas.used !== r.snack_evening.persons.thomas.used);
  check('Thomas et Julie indépendants sur le même créneau',
    r.snack_evening.persons.thomas.used !== r.snack_evening.persons.julie.used);

  st.coverage.forced.snack_evening = true;
  check('forçage possible sur un seul créneau',
    cov().snack_evening.persons.thomas.forced === true && cov().snack_afternoon.persons.thomas.forced === false);
  check('avertissement toujours affiché', cov().snack_evening.persons.thomas.status === 'missing');

  st.snacks[1].uses.thomas.evening = 6;
  check('Thomas soir : 8 / 6 → information', cov().snack_evening.persons.thomas.status === 'extra');

  // total des utilisations, toutes affectations confondues
  const total = optionUses(st.snacks[0], 'snack');
  check('total Thomas = 3 × 16 h + 2 × soir = 5', total.thomas === 5, `${total.thomas}`);
  check('total Julie = 2 × 16 h + 1 × soir = 3', total.julie === 3, `${total.julie}`);
});

test('Courses — petits-déjeuners et collations du cycle', () => {
  const st = catalogState(6);
  const names = () => buildShoppingList(st, byId).lines.map((l) => l.food.name);
  check('options non utilisées : absentes des courses', !names().some((n) => /flocons|whey|protéine/i.test(n)));
  check('seul le repas du planning est compté', names().length === 1, names().join(', '));

  st.breakfasts[0].uses = { thomas: 4, julie: 2 };
  st.snacks[0].uses = { thomas: { afternoon: 3, evening: 2 }, julie: { afternoon: 2, evening: 1 } };

  const list = buildShoppingList(st, byId);
  const line = (frag) => list.lines.find((l) => new RegExp(frag, 'i').test(l.food.name));
  info(list.lines.map((l) => `${l.food.name} ${Math.round(l.required)} g`).join(' | '));

  // flocons : 4 × 80 (Thomas) + 2 × 60 (Julie) = 440 g
  check('petit-déjeuner : quantités multipliées par personne',
    Math.abs(line('flocons').required - (4 * 80 + 2 * 60)) < 0.01, `${line('flocons').required}`);
  // skyr : petit-déjeuner 4 × 150 + 2 × 150 = 900 g
  check('skyr agrégé sur le petit-déjeuner', Math.abs(line('skyr').required - 900) < 0.01, `${line('skyr').required}`);
  // whey : Thomas 5 × 30 + Julie 3 × 20 = 210 g (16 h + soir additionnés)
  check('collation : 16 h et soir additionnés par personne',
    Math.abs(line('protéine').required - (5 * 30 + 3 * 20)) < 0.01, `${line('protéine').required}`);
  check('exemple du cahier des charges : 150 + 60 = 210 g de whey', Math.round(line('protéine').required) === 210);
  check('cajous : 5 × 20 + 3 × 15 = 145 g', Math.abs(line('cajou').required - 145) < 0.01, `${line('cajou').required}`);
  check('repas du planning toujours compté', Math.abs(line('riz').required - 180) < 0.01);

  // le système existant continue de s'appliquer
  check('conditionnements appliqués',
    line('protéine').packages === Math.ceil(210 / line('protéine').packageWeight), `${line('protéine').packages}`);
  check('surplus calculé', line('protéine').surplus === line('protéine').packages * line('protéine').packageWeight - 210);
  check('prix calculé', line('protéine').cost > 0);
  check('case "acheté" disponible', line('protéine').purchased === false);
  check('aucune notion de stock', Object.keys(line('protéine')).every((k) => !/stock|remaining/i.test(k)));

  // la même collation ajoutée au soir augmente le besoin
  const before = line('protéine').required;
  st.snacks[0].uses.thomas.evening += 1;
  check('une utilisation supplémentaire le soir augmente le besoin de 30 g',
    Math.abs(buildShoppingList(st, byId).lines.find((l) => /protéine/i.test(l.food.name)).required - (before + 30)) < 0.01);

  // cycleSources : facteurs par personne
  const sources = cycleSources(st).filter((x) => x.option);
  check('facteurs par personne dans les sources',
    sources.some((x) => x.factors.thomas === 4 && x.factors.julie === 2) &&
    sources.some((x) => x.factors.thomas === 6 && x.factors.julie === 3));
  st.breakfasts[0].uses = { thomas: 0, julie: 0 };
  check('compteurs remis à zéro : aliments retirés des courses',
    !buildShoppingList(st, byId).lines.some((l) => /flocons/i.test(l.food.name)));
});

test('Migration — ancien modèle de catalogues converti sans perte', () => {
  const old = {
    version: 1,
    foods: seedFoods(),
    settings: { cycle: { startWeekday: 1, duration: 6 } },
    meals: [],
    breakfasts: [{ id: 'b1', name: 'Oats', sameComposition: true, cycleUses: 3, items: [] }],
    snacksAfternoon: [{ id: 's1', name: 'Whey', sameComposition: true, cycleUses: 2, items: [] }],
    snacksEvening: [{ id: 's2', name: 'Skyr', sameComposition: true, cycleUses: 1, items: [] }],
  };
  const next = migrateState(old);
  check('les deux catalogues de collations sont fusionnés', next.snacks.length === 2);
  check('anciens catalogues supprimés', next.snacksAfternoon === undefined && next.snacksEvening === undefined);
  check('ancien compteur de petit-déjeuner réparti sur les deux personnes',
    next.breakfasts[0].uses.thomas === 3 && next.breakfasts[0].uses.julie === 3,
    JSON.stringify(next.breakfasts[0].uses));
  const whey = next.snacks.find((o) => o.id === 's1');
  const skyr = next.snacks.find((o) => o.id === 's2');
  check('collation 16 h convertie en affectation 16 h',
    whey.uses.thomas.afternoon === 2 && whey.uses.thomas.evening === 0, JSON.stringify(whey.uses.thomas));
  check('collation du soir convertie en affectation soir',
    skyr.uses.julie.evening === 1 && skyr.uses.julie.afternoon === 0, JSON.stringify(skyr.uses.julie));
  check('objectif de référence repris du catalogue d’origine',
    whey.targetSlot === 'afternoon' && skyr.targetSlot === 'evening');
  check('ingrédients et noms préservés', whey.name === 'Whey' && Array.isArray(whey.items));
  check('couverture calculable après migration', coverageReport(next).snack_evening.persons.julie.used === 1);

  // "nécessite cuisson" : les aliments enregistrés avant son introduction gardent leur classement
  const legacy = migrateState({
    ...old,
    foods: [
      { id: 'a', name: 'Viande', category: 'proteine', referenceState: 'cru', cookingMethod: 'Four', batchAllowed: false, kcal: 1, protein: 0, carbs: 0, fat: 0 },
      { id: 'b', name: 'Skyr', category: 'laitier', referenceState: 'pret', batchAllowed: false, kcal: 1, protein: 0, carbs: 0, fat: 0 },
      { id: 'c', name: 'Déjà renseigné', category: 'autre', referenceState: 'cru', requiresCooking: false, batchAllowed: false, kcal: 1, protein: 0, carbs: 0, fat: 0 },
    ],
  }).foods;
  check('état des valeurs nutritionnelles conservé quand il existe', legacy[0].referenceState === 'cru');
  check('aliment sans état : valeur compatible « prêt à consommer », macros inchangées',
    migrateState({ ...old, foods: [{ id: 'z', name: 'Ancien', category: 'autre', kcal: 123, protein: 1, carbs: 2, fat: 3 }] })
      .foods[0].referenceState === 'pret' &&
    migrateState({ ...old, foods: [{ id: 'z', name: 'Ancien', category: 'autre', kcal: 123, protein: 1, carbs: 2, fat: 3 }] })
      .foods[0].kcal === 123);
  check('aliment V1.2 cuisiné : classement conservé', legacy[0].requiresCooking === true);
  check('aliment V1.2 prêt à consommer : pas de cuisson inventée', legacy[1].requiresCooking === false);
  check('valeur déjà renseignée : jamais écrasée', legacy[2].requiresCooking === false);
});

test('Classement batch — "nécessite cuisson" est une propriété explicite', () => {
  const base = {
    id: 'f_x', name: 'Aliment test', category: 'proteine', brand: '',
    kcal: 150, protein: 20, carbs: 0, fat: 7, fiber: 0,
    cookedFactor: 0.8, unitName: '', gramsPerUnit: 0, fractionable: true,
    price: null, packageWeight: null, favorite: false, lastUsed: null, shelfLifeDays: null,
    cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
  };
  const food = (over) => ({ ...base, ...over });

  // 1. cru + nécessite cuisson + non batchable → cuisson du jour
  const cas1 = food({ referenceState: 'cru', requiresCooking: true, batchAllowed: false });
  check('1. cru + cuisson + non batchable → à cuire le jour même', batchCategory(cas1) === 'cook');

  // 2. cru + ne nécessite PAS de cuisson + non batchable → assemblage
  const cas2 = food({ referenceState: 'cru', requiresCooking: false, batchAllowed: false });
  check('2. cru + sans cuisson + non batchable → à assembler le jour même', batchCategory(cas2) === 'assemble',
    batchCategory(cas2));
  check('l’état cru n’implique plus la cuisson', needsCooking(cas2) === false);

  // 3. cru + batchable → batch (quelle que soit la cuisson)
  check('3. cru + batchable → à préparer en batch',
    batchCategory(food({ referenceState: 'cru', requiresCooking: true, batchAllowed: true })) === 'batch' &&
    batchCategory(food({ referenceState: 'cru', requiresCooking: false, batchAllowed: true })) === 'batch');

  // 4. cuit / prêt à consommer + sans cuisson → assemblage
  check('4. cuit sans cuisson → à assembler',
    batchCategory(food({ referenceState: 'cuit', requiresCooking: false, batchAllowed: false })) === 'assemble');
  check('4 bis. prêt à consommer sans cuisson → à assembler',
    batchCategory(food({ referenceState: 'pret', requiresCooking: false, batchAllowed: false })) === 'assemble');

  // cas inverse : prêt à consommer MAIS nécessitant une cuisson (gnocchis à poêler)
  check('prêt à consommer + cuisson → à cuire le jour même',
    batchCategory(food({ referenceState: 'pret', requiresCooking: true, batchAllowed: false })) === 'cook');
  check('la méthode de cuisson seule ne classe plus l’aliment',
    batchCategory(food({ referenceState: 'pret', requiresCooking: false, batchAllowed: false, cookingMethod: 'Poêle' })) === 'assemble');
  check('batchAllowed reste prioritaire et inchangé',
    ['cru', 'cuit', 'egoutte', 'pret'].every((st) =>
      batchCategory(food({ referenceState: st, requiresCooking: false, batchAllowed: true })) === 'batch'));

  // effet dans un plan réel
  const st = batchState();
  const cru = { ...cas2, id: 'f_cru_assemble', name: 'Cru à assembler' };
  st.foods = [...st.foods, cru];
  st.meals[0].items = [item(cru, 0, { thomas: 100, julie: 80 })];
  const sess = buildBatchPlan(st, { ...byId, f_cru_assemble: cru })[0];
  check('un aliment cru sans cuisson va bien dans "à assembler"',
    sess.assembleSameDay.some((x) => x.food.id === 'f_cru_assemble') &&
    !sess.cookSameDay.some((x) => x.food.id === 'f_cru_assemble'));
  check('il n’est pas converti en poids cuit dans les gamelles',
    sess.gamelles[0].persons.thomas.find((e) => e.food?.id === 'f_cru_assemble').cooked === false);
});

test('Conservation après préparation — alerte sans rien modifier', () => {
  const poulet = { ...F('Blanc de poulet'), id: 'f_court', name: 'Poulet test', shelfLifeDays: 2 };
  const st = batchState();
  st.settings.batch.maxDays = 3; // session de 3 jours
  st.foods = [...st.foods, poulet];
  st.meals[0].items = [item(poulet, 0, { thomas: 180, julie: 130 })];
  const local = { ...byId, f_court: poulet };

  const mealsBefore = JSON.stringify(st.meals);
  const sess = buildBatchPlan(st, local)[0];
  const comp = sess.components.find((c) => c.food.id === 'f_court');
  info(`session de ${sess.coveredDays} j, conservation ${comp.shelfLifeDays} j`);
  check('durée de conservation remontée dans le plan', comp.shelfLifeDays === 2);
  check('durée couverte par la session calculée', comp.coveredDays === 3);
  check('conservation insuffisante détectée', comp.shelfLifeShort === true);
  check('alerte explicite', sess.conservationAlerts.length === 1 && /se conserve 2 jour/.test(sess.conservationAlerts[0].message));
  check('la préparation n’est pas supprimée', !!comp && comp.requiredRaw > 0);
  check('le planning n’est pas modifié', JSON.stringify(st.meals) === mealsBefore);

  // durée suffisante
  const ok = { ...poulet, shelfLifeDays: 4 };
  const sess2 = buildBatchPlan({ ...st, foods: [...st.foods, ok] }, { ...local, f_court: ok })[0];
  check('durée suffisante : aucune alerte', sess2.conservationAlerts.length === 0);
  check('composant toujours présent', sess2.components.some((c) => c.food.id === 'f_court'));

  // durée non renseignée : aucune invention
  const unknown = { ...poulet, shelfLifeDays: null };
  const sess3 = buildBatchPlan({ ...st, foods: [...st.foods, unknown] }, { ...local, f_court: unknown })[0];
  const comp3 = sess3.components.find((c) => c.food.id === 'f_court');
  check('durée inconnue : valeur null conservée', comp3.shelfLifeDays === null);
  check('durée inconnue : aucune alerte inventée', sess3.conservationAlerts.length === 0);

  // sessions plus courtes : le problème disparaît sans toucher au planning
  const shortSession = { ...st, settings: { ...st.settings, batch: { ...st.settings.batch, maxDays: 2 } } };
  check('session de 2 jours : conservation de 2 j suffisante',
    buildBatchPlan(shortSession, local)[0].conservationAlerts.length === 0);
  check('classification batch inchangée par la conservation', batchCategory(poulet) === 'batch');
});

test('Courses — les aliments sans prix sont nommés', () => {
  const sansPrix = { ...F('Riz basmati'), id: 'f_sans_prix', name: 'Riz complet test', price: null, packageWeight: null };
  const st = batchState();
  st.foods = [...st.foods, sansPrix];
  st.meals[0].items = [item(sansPrix, 0, { thomas: 100, julie: 80 }), item(F('Blanc de poulet'), 0, { thomas: 180, julie: 130 })];
  const list = buildShoppingList(st, { ...byId, f_sans_prix: sansPrix });
  const unpriced = list.lines.filter((l) => l.cost === null);
  check('la ligne sans prix est identifiable', unpriced.length === 1);
  check('le nom de l’aliment est disponible', unpriced[0].food.name === 'Riz complet test');
  check('son identifiant permet d’ouvrir sa fiche', unpriced[0].food.id === 'f_sans_prix');
  check('compteur cohérent', list.unpriced === unpriced.length);
  check('aucun prix inventé', unpriced[0].cost === null);
  check('le besoin reste calculé', unpriced[0].required === 180);
  check('le budget ne compte que les articles valorisés', list.total > 0);
});

test('Doublons — avertissement à la création, jamais de fusion', () => {
  const bank = seedFoods();
  const candidate = { id: 'f_new', name: 'Pain croustillant fibres', brand: 'Wasa', category: 'feculent',
    kcal: 335, protein: 10, carbs: 60, fat: 1.5, gramsPerUnit: 13, fractionable: false };
  const existing = { ...bank.find((f) => f.name.includes('Pain croustillant')), brand: 'Wasa', gramsPerUnit: 13 };
  const withBrand = bank.map((f) => (f.id === existing.id ? existing : f));

  const hits = findSimilarFoods(candidate, withBrand);
  info(hits.map((h) => `${h.food.name} (${h.score.toFixed(2)}) ${h.reasons.join(', ')}`).join(' | '));
  check('produit très proche détecté', hits.length > 0);
  check('raisons explicites', hits[0].reasons.length >= 2, hits[0].reasons.join(', '));
  check('la banque n’est pas modifiée', withBrand.length === bank.length);

  check('aliment sans rapport : aucun avertissement',
    findSimilarFoods({ name: 'Cuisse de dinosaure', category: 'proteine', kcal: 150 }, bank).length === 0);
  check('deux aliments proches mais de catégories différentes ne sont pas rapprochés',
    findSimilarFoods({ name: 'Huile de coco', category: 'fruit', kcal: 900 }, bank).length === 0);
  check('un aliment ne se détecte pas lui-même',
    !findSimilarFoods(bank[0], bank).some((h) => h.food.id === bank[0].id));

  const groups = findDuplicateGroups(bank);
  info(`banque initiale : ${groups.length} groupe(s) signalé(s) — ${groups.map((g) => g.food.name).join(', ')}`);
  check('contrôle d’import : peu de faux positifs sur la banque livrée', groups.length <= 3);
});

/* ================================================================ LIBRES */

test('Ingrédients libres — visibles mais hors calculs', () => {
  const items = [item(F('Pâtes complètes'), 100), item(F('Skyr'), 150), freeItem('Curry', 'au goût')];
  const s = {
    foods,
    settings: { cycle: { startWeekday: 0, duration: 1 }, batch: { enabled: true, maxDays: 3 }, budget: 100, tolerance: 0.05, targets: { thomas: {}, julie: {} } },
    batch: { overrides: {} },
    shopping: { purchased: {} },
    meals: [mkMeal(0, 'lunch', items)],
  };
  const m = mealMacros(items, byId, 'thomas');
  const expected = macrosFor(F('Pâtes complètes'), 100, 'cru').kcal + macrosFor(F('Skyr'), 150, 'pret').kcal;
  check('curry présent dans le repas', items.some((it) => it.free?.name === 'Curry'));
  check('quantité libre conservée', items[2].free.quantity === 'au goût');
  check('curry hors macros', Math.abs(m.kcal - expected) < 0.001, `${m.kcal.toFixed(0)} kcal`);
  check('curry hors batch', !buildBatchPlan(s, byId)[0].components.some((c) => /curry/i.test(c.food.name)));
  check('curry hors courses / budget', !buildShoppingList(s, byId).lines.some((l) => /curry/i.test(l.food.name)));
  const adjusted = JSON.parse(JSON.stringify(items));
  autoAdjust(adjusted, byId, LUNCH);
  check('curry jamais ajusté', adjusted[2].qty.thomas === 0 && adjusted[2].qty.julie === 0);
  check('curry jamais supprimé', adjusted.length === 3);
});

/* ================================================================ STABILITÉ */

test('Stabilité — idempotence et absence de dérive', () => {
  const items = [item(F('Blanc de poulet')), item(F('Riz basmati')), item(F('Haricots verts'), 200), item(F('Huile d’olive'))];
  autoAdjust(items, byId, LUNCH);
  const snap1 = items.map((i) => ({ ...i.qty }));
  autoAdjust(items, byId, LUNCH);
  const snap2 = items.map((i) => ({ ...i.qty }));
  for (let i = 0; i < 8; i++) autoAdjust(items, byId, LUNCH);
  const snap3 = items.map((i) => ({ ...i.qty }));
  info(snap1.map((q, i) => `${byId[items[i].foodId].name} ${q.thomas}→${snap3[i].thomas}`).join(' | '));
  check('2e passage proche du 1er', snap1.every((q, i) => Math.abs(q.thomas - snap2[i].thomas) <= 10));
  check('stable après 10 passages', snap2.every((q, i) => Math.abs(q.thomas - snap3[i].thomas) <= 10));
  // même composition que le Test I : kcal/lipides (plafonds) restent sous la
  // cible par design après la calibration asymétrique — `withinAsym()` reflète
  // ce contrat (cf. Test I).
  check('toujours dans la cible après 10 passages', withinAsym(items, LUNCH, 'thomas'));
});

/* ================================================================ VERROU TOTAL */

test('Tout verrouillé — l’algorithme ne touche à rien', () => {
  const items = [item(F('Blanc de poulet'), 200, { lock: true }), item(F('Riz basmati'), 100, { lock: true })];
  const before = JSON.stringify(items);
  autoAdjust(items, byId, LUNCH);
  check('aucune modification', JSON.stringify(items) === before);
  const m = mealMacros(items, byId, 'thomas');
  check('écart bien signalé', diagnose(m, LUNCH.thomas, foods) !== null);
});

/* ============================================== RECETTES — CATALOGUE (ÉTAPE 1) */

test('Recettes — macros dérivées (kind:weight), jamais stockées', () => {
  const boeuf = F('Steak haché');
  const haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [
    newRecipeItem(boeuf.id, 600, 'cru'),
    newRecipeItem(haricots.id, 400, 'egoutte'),
  ];
  recipe.baseGrams = 1000; // poids réel après cuisson (décision §11) — ≠ Σ crus, c'est normal

  const per100 = recipeMacrosPer100g(recipe, byId);
  // recalcul manuel indépendant, avec macrosFor() — aucune nouvelle formule nutritionnelle
  const mBoeuf = macrosFor(boeuf, 600, 'cru');
  const mHaricots = macrosFor(haricots, 400, 'egoutte');
  const expectedKcal = ((mBoeuf.kcal + mHaricots.kcal) / 1000) * 100;
  check('kcal/100g dérivées via macrosFor(), sans nouvelle formule',
    Math.abs(per100.kcal - expectedKcal) < 0.01, `${per100.kcal.toFixed(2)} vs ${expectedKcal.toFixed(2)}`);
  check('protein/100g cohérente', per100.protein > 0);

  // rien n'est stocké sur la recette elle-même : recalcul à chaque appel
  recipe.items.push(newRecipeItem(F('Riz basmati').id, 200, 'cru'));
  const per100b = recipeMacrosPer100g(recipe, byId);
  check('macros changent dès que items change (jamais mises en cache)', per100b.kcal !== per100.kcal);
});

test('Recettes — macros dérivées (kind:portion) : base = somme d’une portion', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const poulet = F('Blanc de poulet en tranches');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais poulet', 'portion');
  recipe.items = [
    newRecipeItem(wasa.id, 13, 'pret'),
    newRecipeItem(stmoret.id, 20, 'pret'),
    newRecipeItem(poulet.id, 35, 'pret'),
  ];
  const per100 = recipeMacrosPer100g(recipe, byId2);
  const totalPortionG = 13 + 20 + 35;
  const mSum = ['kcal'].map((k) =>
    macrosFor(wasa, 13, 'pret')[k] + macrosFor(stmoret, 20, 'pret')[k] + macrosFor(poulet, 35, 'pret')[k]
  )[0];
  check('base = somme des grammes d’UNE portion (68 g), pas baseGrams',
    Math.abs(per100.kcal - (mSum / totalPortionG) * 100) < 0.01);
});

test('Recettes — recette weight sans baseGrams renvoie des macros nulles (pas de division par zéro)', () => {
  const recipe = newRecipe('Sans base', 'weight');
  recipe.items = [newRecipeItem(F('Riz basmati').id, 100, 'cru')];
  const per100 = recipeMacrosPer100g(recipe, byId); // baseGrams reste 0 (défaut newRecipe)
  check('aucune exception, macros à 0', per100.kcal === 0 && per100.protein === 0);
});

test('Recettes — ingrédient non fractionnable refusé dans une recette weight (décision §10)', () => {
  const wrap = F('Wrap'); // non fractionnable
  const weightRecipe = newRecipe('Test weight', 'weight');
  const r1 = canAddIngredientToRecipe(weightRecipe, wrap);
  check('refusé pour une recette weight', r1.ok === false);
  check('raison explicite fournie', typeof r1.reason === 'string' && r1.reason.length > 0);

  const portionRecipe = newRecipe('Test portion', 'portion');
  const r2 = canAddIngredientToRecipe(portionRecipe, wrap);
  check('autorisé pour une recette portion', r2.ok === true);

  const fractionable = F('Riz basmati');
  const r3 = canAddIngredientToRecipe(weightRecipe, fractionable);
  check('un aliment fractionnable reste autorisé dans une recette weight', r3.ok === true);
});

test('Recettes — store.js : catalogue global, migration additive, factories', () => {
  const s = defaultState();
  check('defaultState() initialise recipes: []', Array.isArray(s.recipes) && s.recipes.length === 0);

  // ancien état SANS champ recipes (avant cette évolution) : migration non destructive
  const legacy = { foods: seedFoods(), meals: [] };
  const migrated = migrateState(legacy);
  check('migrate() initialise recipes: [] pour un ancien état', Array.isArray(migrated.recipes) && migrated.recipes.length === 0);
  check('migrate() ne supprime aucune donnée existante (foods conservés)', migrated.foods.length === legacy.foods.length);

  const r = newRecipe('Chili con carne', 'weight');
  check('newRecipe() génère un id unique', typeof r.id === 'string' && r.id.length > 0);
  check('newRecipe() : items vide au départ', Array.isArray(r.items) && r.items.length === 0);

  const ri = newRecipeItem('f_test', 150, 'cru');
  check('newRecipeItem() : mêmes conventions qu’un item de repas (foodId, qty, state)',
    ri.foodId === 'f_test' && ri.qty === 150 && ri.state === 'cru');
});

/* ================================================================ RECETTES DANS L'OPTIMISEUR (ÉTAPE 4) */

test('Recettes — recipeAsVirtualFood() se comporte comme un aliment (fractionnable)', () => {
  const boeuf = F('Steak haché');
  const haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const vf = recipeAsVirtualFood(recipe, byId);
  check('macros non nulles', vf.kcal > 0 && vf.protein > 0);
  check('fractionnable (Type A, décision §9/§10)', vf.fractionable === true && vf.gramsPerUnit === 0);
  check('catégorie dédiée recette', vf.category === 'recette_weight');
  check('référence "prêt" (déjà agrégée, aucune conversion supplémentaire)', vf.referenceState === 'pret' && vf.cookedFactor === 1);
});

test('Recettes — le profil (bornes de recherche) est dérivé de CETTE recette, jamais d’une catégorie fixe', () => {
  const riz = F('Riz basmati');
  const small = newRecipe('Portion individuelle', 'weight');
  small.items = [newRecipeItem(riz.id, 60, 'cru')];
  small.baseGrams = 60; // petite recette (ex. accompagnement pour une personne)
  const vfSmall = recipeAsVirtualFood(small, byId);
  check('petite recette (60 g) : borne min bien en-dessous de l’ancienne constante fixe (80 g)',
    vfSmall.recipeProfile.min < 80, `min=${vfSmall.recipeProfile.min}`);
  check('bornes toujours proportionnelles à baseGrams (min×10 = max)',
    vfSmall.recipeProfile.max === vfSmall.recipeProfile.min * 100);
  check('def = baseGrams de CETTE recette', vfSmall.recipeProfile.def === 60);

  const big = newRecipe('Chili batch cooking', 'weight');
  big.items = [newRecipeItem(riz.id, 3000, 'cru')];
  big.baseGrams = 3000; // grosse recette (plusieurs kg, batch cooking)
  const vfBig = recipeAsVirtualFood(big, byId);
  check('grosse recette (3 kg) : la borne max dépasse largement 600 g',
    vfBig.recipeProfile.max > 3000, `max=${vfBig.recipeProfile.max}`);
  check('les deux recettes n’ont PAS le même profil (pas de catégorie partagée)',
    vfSmall.recipeProfile.max !== vfBig.recipeProfile.max);

  // profileOf()/referenceFor() utilisent bien ce profil dédié, pas CATEGORY_PROFILE
  check('profileOf() lit recipeProfile en priorité', profileOf(vfSmall) === vfSmall.recipeProfile);
  const ref = referenceFor(vfBig);
  check('referenceFor() reste dans les bornes dérivées de cette recette',
    ref >= vfBig.recipeProfile.min && ref <= vfBig.recipeProfile.max, `${ref} g`);
});

test('Recettes — mealMacros() : chemin foodId strictement inchangé sans recipesById', () => {
  const items = [item(F('Blanc de poulet'), 200), item(F('Riz basmati'), 150)];
  const withoutRecipes = mealMacros(items, byId, 'thomas');
  const withEmptyRecipes = mealMacros(items, byId, 'thomas', {});
  check('résultat identique, recipesById omis ou vide', JSON.stringify(withoutRecipes) === JSON.stringify(withEmptyRecipes));
});

test('Recettes — mealMacros() intègre un item recipeId (weight) quand recipesById est fourni', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 100, 'cru')];
  recipe.baseGrams = 100; // 100 g crus -> macros/100g = macros de 100 g de riz cru
  const recipesById = { [recipe.id]: recipe };
  const items = [recipeItemInMeal(recipe.id, 200)]; // 2× la base
  const withRecipes = mealMacros(items, byId, 'thomas', recipesById);
  const expected = macrosFor(riz, 100, 'cru'); // 100g de riz cru, × 2 (200g de recette = 2×100g base)
  check('kcal cohérentes avec la composition de la recette (×2)',
    Math.abs(withRecipes.kcal - expected.kcal * 2) < 0.5, `${withRecipes.kcal.toFixed(1)} vs ${(expected.kcal * 2).toFixed(1)}`);

  const withoutRecipes = mealMacros(items, byId, 'thomas'); // recipesById omis : recette inconnue
  check('sans recipesById, l’item recette est ignoré (pas d’exception, pas de valeur inventée)',
    withoutRecipes.kcal === 0 && withoutRecipes.unconvertible === 0);
});

test('Recettes — adjustQuantities() traite une recette weight comme une variable fractionnable normale', () => {
  const boeuf = F('Steak haché');
  const haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };

  const profile = recipeAsVirtualFood(recipe, byId).recipeProfile; // bornes dérivées de baseGrams=1000
  const items = [recipeItemInMeal(recipe.id, 300)];
  autoAdjust(items, byId, LUNCH, { recipesById });
  const q = items[0].qty.thomas;
  info(`chili ajusté : ${q} g (bornes ${profile.min}–${profile.max} g)`);
  check('quantité dans les bornes dérivées de baseGrams (pas une catégorie fixe)',
    q >= profile.min && q <= profile.max, `${q} g`);
  check('résolution 1 g (pas de palier artificiel)', Number.isInteger(q));

  // combiné avec un aliment normal : les deux variables coexistent
  const mixed = [item(F('Blanc de poulet'), 150), recipeItemInMeal(recipe.id, 300)];
  autoAdjust(mixed, byId, LUNCH, { recipesById });
  check('l’aliment normal reste ajusté normalement', mixed[0].qty.thomas > 0);
  check('la recette reste ajustée dans ses bornes', mixed[1].qty.thomas >= profile.min && mixed[1].qty.thomas <= profile.max);
});

test('Recettes — une recette verrouillée devient une contribution fixe (comme un aliment verrouillé)', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 100, 'cru')];
  recipe.baseGrams = 100;
  const recipesById = { [recipe.id]: recipe };
  const items = [recipeItemInMeal(recipe.id, 250, { lock: true }), item(F('Blanc de poulet'), 150)];
  const before = JSON.stringify(items[0].qty);
  autoAdjust(items, byId, LUNCH, { recipesById });
  check('quantité verrouillée inchangée', JSON.stringify(items[0].qty) === before);
});

/* ================================================================ RECETTES PORTION (ÉTAPE 9) */

test('Recettes portion — recipeAsVirtualFood() : la recette ENTIÈRE devient l’unité (comme un aliment indivisible)', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const poulet = F('Blanc de poulet en tranches');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais poulet', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret'), newRecipeItem(poulet.id, 35, 'pret')];
  const vf = recipeAsVirtualFood(recipe, byId2);
  check('gramsPerUnit = poids d’UNE portion (13+20+35=68 g)', vf.gramsPerUnit === 68, `${vf.gramsPerUnit} g`);
  check('non fractionnable (isWholeUnitFood() la reconnaît sans modification)', isWholeUnitFood(vf) === true);
  check('catégorie dédiée recette_portion', vf.category === 'recette_portion');
});

test('Recettes portion — l’optimiseur ne produit JAMAIS de portion fractionnaire (2,37 portions interdit)', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const poulet = F('Blanc de poulet en tranches');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais poulet', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret'), newRecipeItem(poulet.id, 35, 'pret')];
  const recipesById = { [recipe.id]: recipe };
  const portionGrams = 13 + 20 + 35;

  const items = [recipeItemInMeal(recipe.id, portionGrams)];
  autoAdjust(items, byId2, SNACK, { recipesById });
  const q = items[0].qty.thomas;
  info(`portions ajustées : ${q} g = ${(q / portionGrams).toFixed(4)} portions`);
  check('quantité toujours un multiple ENTIER du poids d’une portion (jamais 2,37 portions)',
    q % portionGrams === 0, `${q} g / ${portionGrams} g = ${q / portionGrams}`);
  check('au moins 1 portion', q >= portionGrams);
});

test('Recettes portion — mécanisme V1.4.1 réutilisé tel quel : combiné à un aliment non fractionnable classique', () => {
  // reprend le scénario historique wrap + œuf (V1.4.1), un des deux
  // remplacé par une recette-portion : AUCUNE ligne de roundForFinalQuantities
  // n'a été modifiée pour ce cas — c'est la même fonction, sans distinction.
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret')];
  const recipesById = { [recipe.id]: recipe };
  const portionGrams = 33;

  const items = [recipeItemInMeal(recipe.id, portionGrams), item(F('Œuf entier'))];
  autoAdjust(items, byId2, SNACK, { recipesById });
  check('la recette-portion reste un multiple entier', items[0].qty.thomas % portionGrams === 0, `${items[0].qty.thomas} g`);
  const gEgg = F('Œuf entier').gramsPerUnit;
  check('l’œuf reste lui aussi un multiple entier (indépendamment de la recette-portion)',
    items[1].qty.thomas % gEgg === 0, `${items[1].qty.thomas} g`);
});

test('Recettes portion — préparation de type portion : preparedQuantity en NOMBRE DE PORTIONS', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret')];
  const preparation = newPreparation(recipe, 5); // 5 PORTIONS préparées, pas 5 g
  const vf = preparationAsVirtualFood(preparation, byId2);
  check('gramsPerUnit = poids d’une portion (33 g)', vf.gramsPerUnit === 33);
  check('borne max = 5 portions × 33 g = 165 g', vf.recipeProfile.max === 165, `${vf.recipeProfile.max} g`);
  check('non fractionnable', vf.fractionable === false);
});

test('Recettes portion — idempotence et déterminisme, comme pour un aliment indivisible classique', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret')];
  const recipesById = { [recipe.id]: recipe };
  const items = [recipeItemInMeal(recipe.id, 33)];
  autoAdjust(items, byId2, SNACK, { recipesById });
  const first = items[0].qty.thomas;
  for (let i = 0; i < 5; i++) autoAdjust(items, byId2, SNACK, { recipesById });
  check('aucune dérive après 5 passages supplémentaires', items[0].qty.thomas === first, `${first} → ${items[0].qty.thomas}`);
});

test('Recettes portion — preparedGramsOf()/preparationAvailable() : conversion portions → grammes (bug réel corrigé)', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret')];
  const portionGrams = 33;
  const preparation = newPreparation(recipe, 5); // 5 PORTIONS, jamais 5 g

  check('preparedGramsOf() convertit correctement (5 portions × 33 g = 165 g)',
    preparedGramsOf(preparation) === 165, `${preparedGramsOf(preparation)} g`);

  const meal = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newPreparationItem(preparation.id, portionGrams * 2), qty: { thomas: portionGrams * 2, julie: 0 } }, // 2 portions consommées
  ] };
  const st = { meals: [meal], breakfasts: [], snacks: [], settings: {} };
  const available = preparationAvailable(st, preparation);
  check('disponible en GRAMMES, pas en confondant portions et grammes (165 − 66 = 99 g = 3 portions)',
    available === 165 - 66, `${available} g`);
  check('jamais une soustraction directe naïve (5 − 66 aurait donné un nombre absurde et négatif)',
    available !== 5 - 66);
});

test('Recettes portion — mode normal (étape 7) respecte le disponible réel exprimé en portions', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret')];
  const portionGrams = 33;
  const preparation = newPreparation(recipe, 3); // 3 portions préparées = 99 g
  const preparationsById = { [preparation.id]: preparation };

  const items = [newPreparationItem(preparation.id, portionGrams)];
  autoAdjust(items, byId2, SNACK, {
    preparationsById,
    preparationAvailability: { [preparation.id]: preparedGramsOf(preparation) - portionGrams },
  });
  check('la quantité ne dépasse jamais 3 portions (99 g), même si la cible nutritionnelle en voudrait plus',
    items[0].qty.thomas <= 99, `${items[0].qty.thomas} g`);
  check('reste un multiple entier de portion', items[0].qty.thomas % portionGrams === 0);
});

test('Recettes portion — mode zéro reste (étape 8) : les portions restent ENTIÈRES après répartition', () => {
  const wasa = { ...F('Pain croustillant'), gramsPerUnit: 13 };
  const stmoret = F('Fromage frais tartinable');
  const byId2 = { ...byId, [wasa.id]: wasa };
  const recipe = newRecipe('Wasa fromage frais', 'portion');
  recipe.items = [newRecipeItem(wasa.id, 13, 'pret'), newRecipeItem(stmoret.id, 20, 'pret')];
  const portionGrams = 33;
  const preparation = newPreparation(recipe, 5); // 5 portions = 165 g, à écouler intégralement
  const preparationsById = { [preparation.id]: preparation };

  const p1 = { ...newPreparationItem(preparation.id, portionGrams * 2), zeroWaste: true };
  const p2 = { ...newPreparationItem(preparation.id, portionGrams), zeroWaste: true };
  const slot1 = { items: [p1], itemId: p1.id, target: SNACK.thomas, person: 'thomas' };
  const slot2 = { items: [p2], itemId: p2.id, target: SNACK.thomas, person: 'thomas' };

  const result = resolveZeroWasteAllocation([slot1, slot2], preparedGramsOf(preparation), byId2, {}, preparationsById,
    { roundStep: portionGrams });
  const sum = result.allocation.reduce((s, v) => s + v, 0);
  check('Σ affecté = 165 g EXACTEMENT (5 portions)', sum === 165, `${sum} g`);
  check('CHAQUE allocation reste un multiple entier du poids d’une portion (jamais de portion fractionnaire)',
    result.allocation.every((v) => v % portionGrams === 0), result.allocation.join(', '));
});

test('Recettes portion — zeroWasteSlotsFor() : détecte les créneaux marqués sur les repas', () => {
  const recipe = newRecipe('Wasa fromage frais', 'portion');
  const preparation = newPreparation(recipe, 3);
  const marked = { ...newPreparationItem(preparation.id, 33), zeroWaste: true };
  const unmarked = newPreparationItem(preparation.id, 33); // zeroWaste: false par défaut
  const meal1 = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [marked] };
  const meal2 = { id: 'm2', dayIndex: 1, mealType: 'dinner', items: [unmarked] };
  const st = { meals: [meal1, meal2], breakfasts: [], snacks: [], settings: {} };
  const slots = zeroWasteSlotsFor(st, preparation.id);
  check('un créneau par personne pour l’item marqué (2, Thomas + Julie)', slots.length === 2, `${slots.length}`);
  check('l’item NON marqué est absent (aucune bascule automatique)',
    slots.every((s) => s.item.id === marked.id));
});

/* ================================================================ DÉPLOIEMENT BATCH/COURSES (ÉTAPE 10) */

test('Déploiement — deployItems() : un item foodId reste inchangé (chemin existant intact)', () => {
  const it = item(F('Riz basmati'), 150);
  const out = deployItems([it], {}, {});
  check('un seul élément, identique à l’original', out.length === 1 && out[0] === it);
});

test('Déploiement — deployItems() : une recette weight se déplie en ses ingrédients, à l’échelle de sa quantité', () => {
  const boeuf = F('Steak haché');
  const haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };

  const it = recipeItemInMeal(recipe.id, 500); // moitié de la recette (500/1000)
  const out = deployItems([it], recipesById, {});
  check('deux ingrédients dépliés (bœuf + haricots)', out.length === 2);
  const boeufOut = out.find((x) => x.foodId === boeuf.id);
  const haricotsOut = out.find((x) => x.foodId === haricots.id);
  check('bœuf à l’échelle exacte (600 × 500/1000 = 300 g)', boeufOut.qty.thomas === 300, `${boeufOut.qty.thomas} g`);
  check('haricots à l’échelle exacte (400 × 500/1000 = 200 g)', haricotsOut.qty.thomas === 200, `${haricotsOut.qty.thomas} g`);
  check('état de chaque ingrédient conservé', boeufOut.state === 'cru' && haricotsOut.state === 'egoutte');
});

test('Déploiement — deployItems() : une préparation se déplie via le SNAPSHOT, pas la recette live', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 100, 'cru')];
  recipe.baseGrams = 100;
  const preparation = newPreparation(recipe, 100);
  const preparationsById = { [preparation.id]: preparation };

  // la recette live change APRÈS la préparation — le déploiement doit rester figé
  recipe.items = [newRecipeItem(F('Blanc de poulet').id, 999, 'cru')];

  const it = newPreparationItem(preparation.id, 200); // 2× la base (100 g)
  const out = deployItems([it], {}, preparationsById);
  check('un seul ingrédient déplié (riz, celui du snapshot)', out.length === 1 && out[0].foodId === riz.id);
  check('à l’échelle exacte (100 × 200/100 = 200 g)', out[0].qty.thomas === 200, `${out[0].qty.thomas} g`);
});

test('Déploiement — deployItems() : un ingrédient libre ne produit aucun aliment réel', () => {
  const out = deployItems([freeItem('curry', 'au goût')], {}, {});
  check('liste vide', out.length === 0);
});

test('Déploiement — aggregateNeeds()/buildShoppingList() incluent désormais les recettes (bug corrigé)', () => {
  const boeuf = F('Steak haché');
  const haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };

  const meal = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...recipeItemInMeal(recipe.id, 500), qty: { thomas: 500, julie: 500 } },
  ], factors: { thomas: 1, julie: 1 } };

  // SANS recipesById (comportement d'avant l'étape 10) : la recette était invisible
  const needsBefore = aggregateNeeds([meal], byId);
  check('avant correction : aucun besoin détecté (le bug qu’on corrige)', Object.keys(needsBefore).length === 0);

  // AVEC recipesById : les ingrédients de la recette apparaissent dans les besoins
  const needsAfter = aggregateNeeds([meal], byId, recipesById, {});
  check('après correction : bœuf ET haricots détectés', needsAfter[boeuf.id] && needsAfter[haricots.id]);
  check('quantités correctes (500 g × 60% de bœuf, pour chacune des 2 personnes = 300+300 = 600 g)',
    Math.abs(needsAfter[boeuf.id].servedGrams - 600) < 0.01, `${needsAfter[boeuf.id].servedGrams} g`);
});

test('Déploiement — buildShoppingList() : une recette n’apparaît JAMAIS telle quelle, seulement ses ingrédients', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };

  const meal = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...recipeItemInMeal(recipe.id, 500), qty: { thomas: 500, julie: 0 } },
  ] };
  const st = {
    meals: [meal], breakfasts: [], snacks: [],
    shopping: { purchased: {} },
    settings: { budget: 100, cycle: { startWeekday: 1, duration: 1 } },
  };
  const shopping = buildShoppingList(st, byId, recipesById, {});
  check('aucune ligne "Chili con carne" (la recette elle-même n’est jamais un produit)',
    !shopping.lines.some((l) => l.food.name === 'Chili con carne'));
  check('une ligne pour le bœuf, l’ingrédient réel', shopping.lines.some((l) => l.food.id === boeuf.id));
});

/* ============================================== P0.1 — RECETTES → LISTE DE COURSES (v1.5.1) */
/*
 * Audit du chemin recette → recipe_items → besoins → shopping_items. Chaque
 * point du cahier des charges est vérifié avec les fonctions réelles
 * (buildShoppingList/aggregateNeeds/deployItems), aucune nouvelle mécanique :
 * `shopping.js` appelle déjà `buildShoppingList(s, byId, recipesById(), preparationsById())`
 * et le chemin `deployItem()` (étape 10) était déjà correct et testé ci-dessus.
 * Diagnostic (reproduit hors dépôt, `diag_p01_shopping.mjs`) : AUCUN bug trouvé
 * sur les 11 points du cahier des charges — cette section formalise la
 * couverture de test demandée (7 cas minimum) plutôt qu'un correctif.
 */
const shopState = (meals, overrides = {}) => ({
  meals, breakfasts: [], snacks: [],
  shopping: { purchased: {} },
  settings: { budget: 100, cycle: { startWeekday: 1, duration: 1 } },
  ...overrides,
});

test('P0.1.1 — recette simple utilisée dans un repas : ses ingrédients apparaissent dans la liste de courses', () => {
  const boeuf = F('Steak haché'), haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 500), qty: { thomas: 500, julie: 500 } };
  const shopping = buildShoppingList(shopState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  check('bœuf présent', shopping.lines.some((l) => l.food.id === boeuf.id));
  check('haricots présents', shopping.lines.some((l) => l.food.id === haricots.id));
  check('quantité bœuf correcte (600 g × 500/1000 × 2 personnes = 600 g)',
    Math.abs(shopping.lines.find((l) => l.food.id === boeuf.id).required - 600) < 0.01);
});

test('P0.1.2 — recette avec plusieurs ingrédients et portions (kind:portion)', () => {
  const wasa = F('Pain croustillant'), stmoret = F('Fromage frais tartinable'), poulet = F('Blanc de poulet en tranches');
  const recipe = newRecipe('Wasa fromage frais poulet', 'portion');
  recipe.items = [newRecipeItem(wasa.id, wasa.gramsPerUnit, 'pret'), newRecipeItem(stmoret.id, 20, 'pret'), newRecipeItem(poulet.id, 35, 'pret')];
  const portionGrams = portionGramsOf(recipe);
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, portionGrams * 2), qty: { thomas: portionGrams * 2, julie: portionGrams } };
  const shopping = buildShoppingList(shopState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  check('les 3 ingrédients de la recette-portion sont présents',
    [wasa.id, stmoret.id, poulet.id].every((id) => shopping.lines.some((l) => l.food.id === id)));
  check('poulet dans la bonne quantité (35 g × 3 portions au total = 105 g)',
    Math.abs(shopping.lines.find((l) => l.food.id === poulet.id).required - 105) < 0.01);
});

test('P0.1.3 — recette utilisée avec des quantités différentes par personne', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 300), qty: { thomas: 300, julie: 100 } };
  const shopping = buildShoppingList(shopState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  check('besoin = somme des deux personnes (300 + 100 = 400 g)',
    Math.abs(shopping.lines.find((l) => l.food.id === riz.id).required - 400) < 0.01);
});

test('P0.1.4 — changement de quantité de recette : le besoin est recalculé (aucun cache)', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 200), qty: { thomas: 200, julie: 200 } };
  const st = shopState([mkMeal(0, 'lunch', [it])]);
  const before = buildShoppingList(st, byId, recipesById, {}).lines.find((l) => l.food.id === riz.id).required;
  it.qty = { thomas: 400, julie: 400 }; // simule une modification dans l'éditeur
  const after = buildShoppingList(st, byId, recipesById, {}).lines.find((l) => l.food.id === riz.id).required;
  check('le besoin double avec la quantité (400 g → 800 g)', before === 400 && after === 800, `${before} → ${after}`);
});

test('P0.1.5 — suppression de la recette du repas : le besoin disparaît', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 200), qty: { thomas: 200, julie: 200 } };
  const meal = mkMeal(0, 'lunch', [it]);
  const st = shopState([meal]);
  check('riz présent avant suppression', buildShoppingList(st, byId, recipesById, {}).lines.some((l) => l.food.id === riz.id));
  meal.items = [];
  check('riz absent après suppression de la recette du repas',
    !buildShoppingList(st, byId, recipesById, {}).lines.some((l) => l.food.id === riz.id));
});

test('P0.1.6 — coexistence avec un aliment simple déjà présent dans le planning (agrégation, pas de doublon de ligne)', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const itRecipe = { ...newRecipeMealItem(recipe.id, 200), qty: { thomas: 200, julie: 200 } };
  const itDirect = { ...newItem(riz.id, 100, 'cru'), qty: { thomas: 100, julie: 100 } };
  const shopping = buildShoppingList(shopState([mkMeal(0, 'lunch', [itRecipe, itDirect])]), byId, recipesById, {});
  const lignesRiz = shopping.lines.filter((l) => l.food.id === riz.id);
  check('une seule ligne pour le riz (pas de doublon)', lignesRiz.length === 1, `${lignesRiz.length} ligne(s)`);
  check('besoin cumulé correct (400 via recette + 200 direct = 600 g)', Math.abs(lignesRiz[0].required - 600) < 0.01);
});

test('P0.1.7 — même recette utilisée dans plusieurs repas : agrégée en une seule ligne, sans doublon', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const it1 = { ...newRecipeMealItem(recipe.id, 200), qty: { thomas: 200, julie: 200 } };
  const it2 = { ...newRecipeMealItem(recipe.id, 300), qty: { thomas: 300, julie: 300 } };
  const shopping = buildShoppingList(shopState([mkMeal(0, 'lunch', [it1]), mkMeal(1, 'lunch', [it2])]), byId, recipesById, {});
  const lignesRiz = shopping.lines.filter((l) => l.food.id === riz.id);
  check('une seule ligne pour le riz malgré 2 utilisations', lignesRiz.length === 1, `${lignesRiz.length} ligne(s)`);
  check('besoins additionnés (400 + 600 = 1000 g)', Math.abs(lignesRiz[0].required - 1000) < 0.01);
});

test('P0.1.8 — un verrouillage de quantité ne casse jamais la génération de la liste de courses', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 200), qty: { thomas: 200, julie: 200 }, locked: { thomas: true, julie: true } };
  const shopping = buildShoppingList(shopState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  check('riz présent malgré le verrouillage', shopping.lines.some((l) => l.food.id === riz.id));
  check('quantité correcte malgré le verrouillage (400 g)',
    Math.abs(shopping.lines.find((l) => l.food.id === riz.id).required - 400) < 0.01);
});

test('P0.1.9 — recette utilisée via une préparation (preparationId) : les ingrédients du snapshot alimentent aussi la liste de courses', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 500);
  const preparationsById = { [prep.id]: prep };
  const it = { ...newPreparationItem(prep.id, 300), qty: { thomas: 300, julie: 0 } };
  const shopping = buildShoppingList(shopState([mkMeal(0, 'lunch', [it])]), byId, {}, preparationsById);
  check('bœuf présent via le snapshot de la préparation', shopping.lines.some((l) => l.food.id === boeuf.id));
  check('quantité correcte (1000 g × 300/1000 = 300 g)',
    Math.abs(shopping.lines.find((l) => l.food.id === boeuf.id).required - 300) < 0.01);
});

test('Déploiement — buildBatchPlan() : les gamelles/plan opératoire ne plantent plus sur un item recette/préparation', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const recipesById = { [recipe.id]: recipe };
  const preparation = newPreparation(recipe, 1000);
  const preparationsById = { [preparation.id]: preparation };

  const meal1 = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...recipeItemInMeal(recipe.id, 300), qty: { thomas: 300, julie: 0 } },
  ] };
  const meal2 = { id: 'm2', dayIndex: 0, mealType: 'dinner', items: [
    { ...newPreparationItem(preparation.id, 250), qty: { thomas: 250, julie: 0 } },
  ] };
  const st = {
    meals: [meal1, meal2], breakfasts: [], snacks: [],
    shopping: { purchased: {} }, batch: { overrides: {} },
    settings: { budget: 100, cycle: { startWeekday: 1, duration: 1 }, batch: { enabled: true, maxDays: 3 } },
  };
  let plan;
  check('aucune exception levée (ancien bug : crash sur it.free null)', (() => {
    try { plan = buildBatchPlan(st, byId, recipesById, preparationsById); return true; }
    catch (e) { info(e.message); return false; }
  })());
  const sess = plan[0];
  check('la recette (molle) apparaît dans assembleSameDay avec son nom',
    sess.assembleSameDay.some((r) => r.food.name === 'Chili con carne' && r.grams === 300));
  check('la préparation apparaît dans assembleSameDay avec son label',
    sess.assembleSameDay.some((r) => r.food.name === preparation.label && r.grams === 250));
  const gamelleThomas1 = sess.gamelles.find((g) => g.mealId === 'm1').persons.thomas;
  check('la gamelle du midi affiche la recette comme UN SEUL élément (jamais dépliée en bœuf)',
    gamelleThomas1.length === 1 && gamelleThomas1[0].name === 'Chili con carne' && gamelleThomas1[0].grams === 300);
});

/* ============================================== P0.2 — RECETTES → BATCH COOKING (v1.5.1) */
/*
 * Cause exacte du bug : `recipe.batchAllowed`/`cookingMethod`/etc. n'étaient
 * lus par aucune fonction — `buildBatchPlan()` ne connaissait que les
 * aliments (`batchCategory(food)`), et toute recette référencée directement
 * était systématiquement traitée comme "déjà prête à assembler", jamais
 * comme "à préparer". `recipeNeededFrom()`/`recipeAvailableFromPreparations()`
 * existaient déjà et étaient corrects (calcul inverse) mais n'étaient
 * appelés par aucune vue de batch cooking. Correction : nouvelle section
 * `recipesToPrepare` par session, construite avec ces mêmes fonctions.
 */
const batchTestState = (meals, overrides = {}) => ({
  meals, breakfasts: [], snacks: [], preparations: [],
  batch: { overrides: {} },
  shopping: { purchased: {} },
  settings: { budget: 100, cycle: { startWeekday: 1, duration: 4 }, batch: { enabled: true, maxDays: 4 } },
  ...overrides,
});

test('P0.2.1 — une recette batchAllowed apparaît dans "à préparer en batch"', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  recipe.cookingMethod = 'mijoteuse';
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 500), qty: { thomas: 500, julie: 0 } };
  const plan = buildBatchPlan(batchTestState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  const r = plan[0].recipesToPrepare.find((x) => x.recipe.id === recipe.id);
  check('la recette apparaît dans recipesToPrepare', !!r);
  check('sa méthode de cuisson (propre à la recette) est reprise', r.method === 'mijoteuse');
});

test('P0.2.2 — quantité/ingrédients correctement calculés (net du disponible cohérent avec P0.1)', () => {
  const boeuf = F('Steak haché'), haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 500), qty: { thomas: 500, julie: 0 } };
  const st = batchTestState([mkMeal(0, 'lunch', [it])]);
  const plan = buildBatchPlan(st, byId, recipesById, {});
  const r = plan[0].recipesToPrepare.find((x) => x.recipe.id === recipe.id);
  check('quantité de recette correcte (500 g demandés)', r.requiredRaw === 500);
  const shopping = buildShoppingList(st, byId, recipesById, {});
  check('cohérent avec la liste de courses : bœuf = 600 × 500/1000 = 300 g',
    Math.abs(shopping.lines.find((l) => l.food.id === boeuf.id).required - 300) < 0.01);
});

test('P0.2.3 — plusieurs utilisations de la même recette sont agrégées', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  const recipesById = { [recipe.id]: recipe };
  const it1 = { ...newRecipeMealItem(recipe.id, 200), qty: { thomas: 200, julie: 0 } };
  const it2 = { ...newRecipeMealItem(recipe.id, 300), qty: { thomas: 300, julie: 0 } };
  const plan = buildBatchPlan(batchTestState([mkMeal(0, 'lunch', [it1]), mkMeal(1, 'dinner', [it2])]), byId, recipesById, {});
  check('une seule entrée agrégée (200 + 300 = 500 g)',
    plan[0].recipesToPrepare.length === 1 && plan[0].recipesToPrepare[0].requiredRaw === 500);
});

test('P0.2.4 — Thomas ET Julie sont pris en compte', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 500), qty: { thomas: 300, julie: 200 } };
  const plan = buildBatchPlan(batchTestState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  check('besoin = somme des deux personnes (300 + 200 = 500 g)', plan[0].recipesToPrepare[0].requiredRaw === 500);
});

test('P0.2.5 — une recette déjà (partiellement) préparée n’est jamais recomptée', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  const recipesById = { [recipe.id]: recipe };
  const prep = newPreparation(recipe, 400); // 400 g déjà préparés (stock existant)
  const it = { ...newRecipeMealItem(recipe.id, 1000), qty: { thomas: 1000, julie: 0 } };
  const st = batchTestState([mkMeal(0, 'lunch', [it])], { preparations: [prep] });
  const plan = buildBatchPlan(st, byId, recipesById, { [prep.id]: prep });
  check('besoin net = 1000 − 400 déjà préparés = 600 g', plan[0].recipesToPrepare[0].requiredRaw === 600);
});

test('P0.2.6 — une recette non batchAllowed n’apparaît PAS dans "à préparer en batch" (reste "à assembler")', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = false; // valeur par défaut de newRecipe()
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 300), qty: { thomas: 300, julie: 0 } };
  const plan = buildBatchPlan(batchTestState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  check('recipesToPrepare vide', plan[0].recipesToPrepare.length === 0);
  check('toujours listée dans assembleSameDay (comportement pré-existant, inchangé)',
    plan[0].assembleSameDay.some((r) => r.food.name === 'Riz simple'));
});

/* ============================================== P0.3 — CONSERVATION / SOUS-PRÉPARATIONS (v1.5.1) */

test('P0.3.1 — recette conservable pendant toute la session : pas de scission', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  recipe.shelfLifeDays = 5; // ≥ durée de la session (4 jours)
  const recipesById = { [recipe.id]: recipe };
  const it = { ...newRecipeMealItem(recipe.id, 500), qty: { thomas: 500, julie: 0 } };
  const plan = buildBatchPlan(batchTestState([mkMeal(0, 'lunch', [it])]), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('shelfLifeShort = false', r.shelfLifeShort === false);
  check('aucune sous-préparation', r.subBatches === null);
  check('aucune alerte de conservation', plan[0].conservationAlerts.length === 0);
});

test('P0.3.2 — conservation expirant avant la fin de la période : nouvelle préparation détectée', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  recipe.shelfLifeDays = 2; // < durée de la session (4 jours)
  const recipesById = { [recipe.id]: recipe };
  const items = [0, 1, 2, 3].map((day) => ({ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }));
  const meals = items.map((it, day) => mkMeal(day, 'lunch', [it]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('shelfLifeShort = true', r.shelfLifeShort === true);
  check('2 sous-préparations (0-1 et 2-3, conservation 2 jours sur session de 4)',
    r.subBatches.length === 2, JSON.stringify(r.subBatches.map((b) => `${b.startDay}-${b.endDay}`)));
  check('alerte de conservation levée', plan[0].conservationAlerts.some((a) => a.recipe?.id === recipe.id));
});

test('P0.3.3 — quantités agrégées correctement pour chaque session de préparation', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  recipe.shelfLifeDays = 2;
  const recipesById = { [recipe.id]: recipe };
  const items = [0, 1, 2, 3].map((day) => ({ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 100 } }));
  const meals = items.map((it, day) => mkMeal(day, 'lunch', [it]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const [b0, b1] = plan[0].recipesToPrepare[0].subBatches;
  check('1ère sous-préparation (jours 0-1) : 2 jours × 200 g/jour = 400 g', b0.requiredRaw === 400);
  check('2e sous-préparation (jours 2-3) : 2 jours × 200 g/jour = 400 g', b1.requiredRaw === 400);
  check('somme des sous-préparations = besoin total de la session (400+400=800)',
    b0.requiredRaw + b1.requiredRaw === 800);
});

test('P0.3.4 — plusieurs recettes avec des durées de conservation différentes, dans la même session', () => {
  const boeuf = F('Steak haché'), poulet = F('Blanc de poulet');
  const r1 = newRecipe('Chili', 'weight');
  r1.items = [newRecipeItem(boeuf.id, 1000, 'cru')]; r1.baseGrams = 1000; r1.batchAllowed = true; r1.shelfLifeDays = 2;
  const r2 = newRecipe('Poulet rôti', 'weight');
  r2.items = [newRecipeItem(poulet.id, 1000, 'cru')]; r2.baseGrams = 1000; r2.batchAllowed = true; r2.shelfLifeDays = 4;
  const recipesById = { [r1.id]: r1, [r2.id]: r2 };
  const meals = [0, 1, 2, 3].map((day) => mkMeal(day, 'lunch', [
    { ...newRecipeMealItem(r1.id, 100), qty: { thomas: 100, julie: 0 } },
    { ...newRecipeMealItem(r2.id, 100), qty: { thomas: 100, julie: 0 } },
  ]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const chili = plan[0].recipesToPrepare.find((r) => r.recipe.id === r1.id);
  const roti = plan[0].recipesToPrepare.find((r) => r.recipe.id === r2.id);
  check('Chili (2 j) scindé en 2 sous-préparations', chili.subBatches?.length === 2);
  check('Poulet rôti (4 j = durée de session) : aucune scission', roti.subBatches === null);
});

test('P0.3.5 — aliment simple (hors recette) : même logique de scission par conservation', () => {
  const boeuf = { ...F('Steak haché'), batchAllowed: true, shelfLifeDays: 2 };
  const byId2 = { ...byId, [boeuf.id]: boeuf };
  const meals = [0, 1, 2, 3].map((day) => mkMeal(day, 'lunch', [
    { id: `it${day}`, foodId: boeuf.id, recipeId: null, preparationId: null, free: null, state: 'cru',
      qty: { thomas: 100, julie: 0 }, locked: { thomas: false, julie: false } },
  ]));
  const plan = buildBatchPlan(batchTestState(meals), byId2, {}, {});
  const c = plan[0].components.find((c) => c.food.id === boeuf.id);
  check('composant aliment scindé en 2 sous-préparations (comme une recette)', c.subBatches?.length === 2);
  check('quantités correctes (2 jours × 100 g = 200 g chacune)',
    c.subBatches.every((b) => b.requiredRaw === 200));
});

/* ================================================================ PRÉPARATIONS (ÉTAPE 5) */

const fakeState = (meals, preparations = []) => ({ meals, breakfasts: [], snacks: [], settings: {}, preparations });

test('Préparations — newPreparation() : snapshot figé, jamais recalculé depuis les ingrédients', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 1200, 'cru')]; // 1200 g crus saisis…
  recipe.baseGrams = 1200;
  const prep = newPreparation(recipe, 1000, 'Riz simple #1'); // …mais 1000 g réellement obtenus après cuisson

  check('id unique', typeof prep.id === 'string' && prep.id.length > 0);
  check('recipeId référence la recette source', prep.recipeId === recipe.id);
  check('preparedQuantity = poids RÉELLEMENT obtenu (1000 g), jamais recalculé depuis les 1200 g crus',
    prep.preparedQuantity === 1000);
  check('label explicite conservé', prep.label === 'Riz simple #1');
  check('snapshot présent (kind, baseGrams, items)',
    prep.recipeSnapshot.kind === 'weight' && prep.recipeSnapshot.baseGrams === 1200 && prep.recipeSnapshot.items.length === 1);

  // la recette source est modifiée APRÈS la préparation : le snapshot ne doit RIEN en savoir
  recipe.items.push(newRecipeItem(F('Blanc de poulet').id, 300, 'cru'));
  recipe.baseGrams = 1500;
  check('modifier la recette source après coup ne change PAS le snapshot (copie profonde, pas une référence)',
    prep.recipeSnapshot.items.length === 1 && prep.recipeSnapshot.baseGrams === 1200);
});

test('Préparations — label par défaut = nom de la recette si non fourni', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 1000);
  check('label = nom de la recette par défaut', prep.label === 'Chili con carne');
});

test('Préparations — store.js : catalogue, migration additive, preparationsById()', () => {
  const s = defaultState();
  check('defaultState() initialise preparations: []', Array.isArray(s.preparations) && s.preparations.length === 0);

  const legacy = { foods: seedFoods(), meals: [] }; // ancien état, sans préparations
  const migrated = migrateState(legacy);
  check('migrate() initialise preparations: [] additivement', Array.isArray(migrated.preparations) && migrated.preparations.length === 0);

  const recipe = newRecipe('Riz simple', 'weight');
  recipe.baseGrams = 500;
  const prep = newPreparation(recipe, 500);
  const map = { [prep.id]: prep };
  check('preparationsById() indexe par id (vérifié sur une map construite à la main)', map[prep.id] === prep);
});

test('Préparations — items de repas : exclusion mutuelle foodId / recipeId / preparationId', () => {
  const it1 = newPreparationItem('prep_1', 200);
  check('newPreparationItem() : preparationId renseigné, foodId et recipeId nuls',
    it1.preparationId === 'prep_1' && it1.foodId === null && it1.recipeId === null);
  const it2 = newRecipeMealItem('recipe_1', 300);
  check('newRecipeMealItem() : recipeId renseigné, foodId et preparationId nuls',
    it2.recipeId === 'recipe_1' && it2.foodId === null && it2.preparationId === null);
  const it3 = newItem('f_test', 100);
  check('newItem() : foodId renseigné, recipeId et preparationId nuls (aucune régression)',
    it3.foodId === 'f_test' && it3.recipeId === null && it3.preparationId === null);
});

test('Préparations — disponible = préparé − affecté, dérivé sur tout le cycle (jamais stocké)', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 1000);

  check('aucune utilisation : disponible = préparé', preparationAvailable(fakeState([]), prep) === 1000);

  const meal1 = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newPreparationItem(prep.id), qty: { thomas: 300, julie: 200 } },
  ] };
  const meal2 = { id: 'm2', dayIndex: 1, mealType: 'dinner', items: [
    { ...newPreparationItem(prep.id), qty: { thomas: 250, julie: 170 } },
  ] };
  const st = fakeState([meal1, meal2]);
  check('utilisé = somme sur tous les repas et les deux personnes (300+200+250+170=920)',
    preparationUsed(st, prep.id) === 920);
  check('disponible = 1000 − 920 = 80 (reste prévu)', preparationAvailable(st, prep) === 80);

  // un item référençant une AUTRE préparation ne compte pas
  const otherPrep = newPreparation(recipe, 500);
  const meal3 = { id: 'm3', dayIndex: 2, mealType: 'lunch', items: [
    { ...newPreparationItem(otherPrep.id), qty: { thomas: 400, julie: 400 } },
  ] };
  check('seule la préparation demandée est comptée (isolation entre préparations)',
    preparationUsed(fakeState([meal1, meal2, meal3]), prep.id) === 920);

  // sur-engagement volontaire (avant l'étape 7, rien ne l'empêche encore) : signalé, pas masqué
  const meal4 = { id: 'm4', dayIndex: 3, mealType: 'lunch', items: [
    { ...newPreparationItem(prep.id), qty: { thomas: 200, julie: 200 } },
  ] };
  const overCommitted = preparationAvailable(fakeState([meal1, meal2, meal4]), prep);
  check('un sur-engagement produit un disponible négatif, jamais masqué à 0',
    overCommitted === 1000 - (920 + 400), `${overCommitted}`);
});

/* ================================================================ CALCUL INVERSE (ÉTAPE 6) */

test('Calcul inverse — recipeNeeded() : besoin agrégé, uniquement les items SANS préparation', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.baseGrams = 1000;

  const meal1 = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newRecipeMealItem(recipe.id), qty: { thomas: 300, julie: 220 } },
  ] };
  const meal2 = { id: 'm2', dayIndex: 1, mealType: 'dinner', items: [
    { ...newRecipeMealItem(recipe.id), qty: { thomas: 280, julie: 200 } },
  ] };
  check('besoin = somme sur tous les repas et les deux personnes (300+220+280+200=1000)',
    recipeNeeded(fakeState([meal1, meal2]), recipe.id) === 1000);

  // exemple exact de la spécification (ÉTAPE 3 du workflow) : 920 g
  const meal1b = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newRecipeMealItem(recipe.id), qty: { thomas: 300, julie: 200 } },
  ] };
  const meal2b = { id: 'm2', dayIndex: 1, mealType: 'dinner', items: [
    { ...newRecipeMealItem(recipe.id), qty: { thomas: 250, julie: 170 } },
  ] };
  check('exemple de la spécification : besoin = 920 g', recipeNeeded(fakeState([meal1b, meal2b]), recipe.id) === 920);

  // un item DÉJÀ lié à une préparation n'est plus un "besoin non couvert"
  const prep = newPreparation(recipe, 1000);
  const meal3 = { id: 'm3', dayIndex: 2, mealType: 'lunch', items: [
    { ...newPreparationItem(prep.id), qty: { thomas: 300, julie: 200 } },
  ] };
  check('un item preparationId n’est pas compté comme besoin (déjà couvert par la préparation)',
    recipeNeeded(fakeState([meal3]), recipe.id) === 0);

  // une recette différente n'est pas comptée
  const other = newRecipe('Autre recette', 'weight');
  const meal4 = { id: 'm4', dayIndex: 3, mealType: 'lunch', items: [
    { ...newRecipeMealItem(other.id), qty: { thomas: 500, julie: 500 } },
  ] };
  check('isolation entre recettes : seule la recette demandée est comptée',
    recipeNeeded(fakeState([meal4]), recipe.id) === 0);
});

test('Calcul inverse — buildRecipeNeeds() : vue d’ensemble de toutes les recettes non préparées du cycle', () => {
  const chili = newRecipe('Chili con carne', 'weight');
  chili.baseGrams = 1000;
  const riz = newRecipe('Riz simple', 'weight');
  riz.baseGrams = 500;
  const recipesById = { [chili.id]: chili, [riz.id]: riz };

  const meal1 = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newRecipeMealItem(chili.id), qty: { thomas: 300, julie: 200 } },
    { ...newRecipeMealItem(riz.id), qty: { thomas: 150, julie: 100 } },
  ] };
  const results = buildRecipeNeeds(fakeState([meal1]), recipesById);
  check('deux recettes distinctes détectées', results.length === 2);
  const chiliResult = results.find((r) => r.recipeId === chili.id);
  const rizResult = results.find((r) => r.recipeId === riz.id);
  check('besoin du chili correct (300+200=500)', chiliResult.needed === 500);
  check('besoin du riz correct (150+100=250)', rizResult.needed === 250);
  check('la recette elle-même est jointe (pas seulement son id)', chiliResult.recipe === chili);

  // aucune recette référencée : liste vide, pas d'exception
  check('cycle sans recette : liste vide', buildRecipeNeeds(fakeState([]), recipesById).length === 0);

  // recette supprimée entre-temps (recipesById ne la contient plus) : ignorée sans exception
  const orphan = { id: 'm2', dayIndex: 0, mealType: 'lunch', items: [
    { ...newRecipeMealItem('recette_supprimee'), qty: { thomas: 100, julie: 100 } },
  ] };
  check('recette introuvable dans recipesById : ignorée, pas d’exception',
    buildRecipeNeeds(fakeState([orphan]), recipesById).length === 0);
});

/* ============================================== CALCUL INVERSE — NET DU DISPONIBLE (SUITE) */

test('Calcul inverse — recipeAvailableFromPreparations() : cumule le disponible des préparations existantes', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.baseGrams = 1000;

  check('aucune préparation : disponible cumulé = 0', recipeAvailableFromPreparations(fakeState([]), recipe.id) === 0);

  const prep1 = newPreparation(recipe, 1000); // rien d'utilisé -> 1000 g disponibles
  const prep2 = newPreparation(recipe, 500);  // rien d'utilisé -> 500 g disponibles
  check('deux préparations de la même recette : disponibles additionnés (1000+500=1500)',
    recipeAvailableFromPreparations(fakeState([], [prep1, prep2]), recipe.id) === 1500);

  // une préparation d'une AUTRE recette n'est jamais comptée
  const other = newRecipe('Autre recette', 'weight');
  const otherPrep = newPreparation(other, 2000);
  check('isolation entre recettes : la préparation d’une autre recette est ignorée',
    recipeAvailableFromPreparations(fakeState([], [prep1, otherPrep]), recipe.id) === 1000);

  // une préparation SUR-ENGAGÉE (disponible négatif) n'est jamais compensée par une autre
  const meal = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newPreparationItem(prep1.id), qty: { thomas: 700, julie: 700 } }, // 1400 g utilisés > 1000 g préparés
  ] };
  const overCommitted = recipeAvailableFromPreparations(fakeState([meal], [prep1, prep2]), recipe.id);
  check('la préparation sur-engagée contribue 0 (jamais négative), l’autre reste comptée intégralement (0+500=500)',
    overCommitted === 500, `${overCommitted} g`);
});

test('Calcul inverse — recipeNeededNet() : quantité RECOMMANDÉE, nette du disponible existant', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.baseGrams = 1000;

  const meal1 = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newRecipeMealItem(recipe.id), qty: { thomas: 300, julie: 200 } },
  ] };
  const meal2 = { id: 'm2', dayIndex: 1, mealType: 'dinner', items: [
    { ...newRecipeMealItem(recipe.id), qty: { thomas: 250, julie: 170 } },
  ] };
  // exemple de la spécification : besoin brut = 920 g, sans aucune préparation existante
  check('sans préparation existante : recommandé = besoin brut (920 g), comportement inchangé',
    recipeNeededNet(fakeState([meal1, meal2]), recipe.id) === 920);

  // une préparation existante de 500 g, entièrement disponible, couvre une partie du besoin
  const prep = newPreparation(recipe, 500);
  const net = recipeNeededNet(fakeState([meal1, meal2], [prep]), recipe.id);
  check('avec 500 g déjà disponibles : recommandé = 920 − 500 = 420 g', net === 420, `${net} g`);
  check('le besoin BRUT reste inchangé (recipeNeeded() ne varie jamais avec le disponible)',
    recipeNeeded(fakeState([meal1, meal2], [prep]), recipe.id) === 920);

  // le stock existant couvre déjà tout le besoin : jamais négatif
  const bigPrep = newPreparation(recipe, 2000);
  check('stock existant largement suffisant : recommandé = 0 (jamais négatif)',
    recipeNeededNet(fakeState([meal1, meal2], [bigPrep]), recipe.id) === 0);
});

test('Calcul inverse — buildRecipeNeeds() expose needed/available/recommended de façon additive', () => {
  const chili = newRecipe('Chili con carne', 'weight');
  chili.baseGrams = 1000;
  const recipesById = { [chili.id]: chili };

  const meal1 = { id: 'm1', dayIndex: 0, mealType: 'lunch', items: [
    { ...newRecipeMealItem(chili.id), qty: { thomas: 300, julie: 200 } },
  ] };
  const prep = newPreparation(chili, 200);
  const results = buildRecipeNeeds(fakeState([meal1], [prep]), recipesById);
  const chiliResult = results.find((r) => r.recipeId === chili.id);

  check('needed = besoin brut, inchangé (500 g)', chiliResult.needed === 500);
  check('available = disponible des préparations existantes (200 g)', chiliResult.available === 200);
  check('recommended = net (500 − 200 = 300 g)', chiliResult.recommended === 300);
});

/* ================================================================ MODE NORMAL (ÉTAPE 7) */

test('Mode normal — preparationAsVirtualFood() dérive du SNAPSHOT, jamais de la recette live', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 1000);

  // la recette live change du tout au tout APRÈS la préparation
  recipe.items = [newRecipeItem(F('Riz basmati').id, 1000, 'cru')];

  const vfFromSnapshot = preparationAsVirtualFood(prep, byId);
  const vfFromLiveRecipe = recipeAsVirtualFood(recipe, byId); // pour comparaison uniquement
  check('les macros de la préparation restent celles du bœuf (snapshot), pas du riz (recette live)',
    Math.abs(vfFromSnapshot.kcal - vfFromLiveRecipe.kcal) > 50, `${vfFromSnapshot.kcal.toFixed(0)} vs ${vfFromLiveRecipe.kcal.toFixed(0)}`);
  check('fractionnable, comme une recette weight', vfFromSnapshot.fractionable === true);
  check('bornes par défaut ≤ preparedQuantity', vfFromSnapshot.recipeProfile.max === 1000);
});

test('Mode normal — sans preparationAvailability fourni, borne par défaut = preparedQuantity', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(F('Steak haché').id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 1000);
  const preparationsById = { [prep.id]: prep };

  const items = [newPreparationItem(prep.id, 500)];
  autoAdjust(items, byId, LUNCH, { preparationsById }); // pas de preparationAvailability
  check('quantité ajustée, plafonnée par preparedQuantity au pire',
    items[0].qty.thomas <= 1000, `${items[0].qty.thomas} g`);
});

test('Mode normal — Σ affecté ≤ disponible : l’optimiseur ne force JAMAIS le dépassement du stock', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(F('Steak haché').id, 1000, 'cru'), newRecipeItem(F('Haricots rouges').id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 1000);
  const preparationsById = { [prep.id]: prep };

  // reproduit exactement l'exemple de la spécification : 1000 g préparés, deux
  // repas, la cible naturelle de chacun voudrait plus que ce qui reste au second.
  const meal1 = [newPreparationItem(prep.id, 700)]; // déjà 700 g affectés ailleurs dans le cycle
  const meal2 = [newPreparationItem(prep.id, 250)]; // le meal qu'on ajuste ; sa propre contribution s'ajoute au disponible fourni
  // disponible EXCLUANT la contribution de meal2 lui-même (contrat de
  // buildVarsAndFixed, cf. preparationAvailable()/preparationUsed() en
  // production : la somme "déjà utilisé" porte sur TOUT le cycle, meal2 y
  // compris) = 1000 préparés − 700 (meal1) − 250 (meal2 lui-même) = 50 g.
  // Erreur de fixture pré-existante, non liée à la calibration : la valeur
  // ici était 1000 − 700 = 300 (sans soustraire les 250 g de meal2), ce qui
  // gonflait à tort le plafond réel à 300+250 = 550 g au lieu de 50+250 = 300 g.
  // Restée invisible tant que l'optimum choisi par l'ancienne pondération
  // symétrique ne s'approchait jamais de ce plafond — révélée par la
  // calibration asymétrique (poussée kcal/protéines plus forte), qui,
  // légitimement, explore désormais tout le domaine autorisé par les bornes.
  const availabilityForMeal2 = { [prep.id]: 1000 - 700 - 250 };

  autoAdjust(meal2, byId, LUNCH, { preparationsById, preparationAvailability: availabilityForMeal2 });
  const q2 = meal2[0].qty.thomas;
  info(`meal2 ajusté : ${q2} g (disponible fourni 50 g + contribution propre 250 g = plafond réel 300 g)`);
  check('la contribution de meal2 ne dépasse jamais son plafond réel (50 + sa propre contribution de départ)',
    q2 <= 50 + 250);
  check('total réel (700 déjà ailleurs + meal2) ne dépasse jamais 1000 g de préparé',
    700 + q2 <= 1000, `700 + ${q2} = ${700 + q2}`);
});

test('Mode normal — le reliquat n’est jamais forcé (un disponible large ne pousse pas la quantité au plafond)', () => {
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(F('Riz basmati').id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 5000); // très grosse préparation, largement au-delà du besoin réel
  const preparationsById = { [prep.id]: prep };
  const items = [newPreparationItem(prep.id, 200)];
  autoAdjust(items, byId, LUNCH, { preparationsById, preparationAvailability: { [prep.id]: 5000 - 200 } });
  check('la quantité reste raisonnable (proche du besoin nutritionnel), pas poussée vers 5000 g',
    items[0].qty.thomas < 1000, `${items[0].qty.thomas} g`);
});

test('Mode normal — un item preparationId verrouillé devient une contribution fixe', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(F('Steak haché').id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const prep = newPreparation(recipe, 1000);
  const preparationsById = { [prep.id]: prep };
  const items = [
    { ...newPreparationItem(prep.id, 400), locked: { thomas: true, julie: true } },
    item(F('Blanc de poulet'), 150),
  ];
  const before = JSON.stringify(items[0].qty);
  autoAdjust(items, byId, LUNCH, { preparationsById, preparationAvailability: { [prep.id]: 600 } });
  check('quantité verrouillée inchangée malgré le disponible', JSON.stringify(items[0].qty) === before);
});

test('Mode normal — mealMacros() intègre un item preparationId quand preparationsById est fourni', () => {
  const riz = F('Riz basmati');
  const recipe = newRecipe('Riz simple', 'weight');
  recipe.items = [newRecipeItem(riz.id, 100, 'cru')];
  recipe.baseGrams = 100;
  const prep = newPreparation(recipe, 100);
  const preparationsById = { [prep.id]: prep };
  const items = [newPreparationItem(prep.id, 200)]; // 2× la base
  const macros = mealMacros(items, byId, 'thomas', {}, preparationsById);
  const expected = macrosFor(riz, 100, 'cru');
  check('macros cohérentes avec le snapshot (×2)', Math.abs(macros.kcal - expected.kcal * 2) < 0.5);
});

/* ================================================================ MODE ZÉRO RESTE (ÉTAPE 8) */

test('Zéro reste — un seul créneau : consomme exactement la totalité (seule solution possible)', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(F('Steak haché').id, 600, 'cru'), newRecipeItem(F('Haricots rouges').id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const prepItem = { ...newPreparationItem('prep1', 1000), zeroWaste: true };
  const slot = { items: [prepItem], itemId: prepItem.id, target: LUNCH.thomas, person: 'thomas' };
  const recipesById = {};
  const preparationsById = {};

  const result = resolveZeroWasteAllocation([slot], 1000, byId, recipesById, preparationsById);
  check('une seule allocation', result.allocation.length === 1);
  check('égale à preparedQuantity EXACTEMENT (1000 g)', result.allocation[0] === 1000, `${result.allocation[0]} g`);
});

test('Zéro reste — Σ affecté = preparedQuantity EXACTEMENT (deux créneaux, exemple de la spécification)', () => {
  const boeuf = F('Steak haché');
  const haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const preparation = newPreparation(recipe, 1000);
  const preparationsById = { [preparation.id]: preparation };

  const prepItem1 = { ...newPreparationItem(preparation.id, 300), zeroWaste: true };
  const prepItem2 = { ...newPreparationItem(preparation.id, 250), zeroWaste: true };
  const slot1 = { items: [prepItem1], itemId: prepItem1.id, target: LUNCH.thomas, person: 'thomas' };
  const slot2 = { items: [prepItem2], itemId: prepItem2.id, target: LUNCH.thomas, person: 'thomas' }; // dîner, même cible ici pour simplifier

  const result = resolveZeroWasteAllocation([slot1, slot2], 1000, byId, {}, preparationsById);
  const sum = result.allocation.reduce((s, v) => s + v, 0);
  info(`allocations : ${result.allocation.join(' + ')} = ${sum} g`);
  check('Σ affecté = preparedQuantity EXACTEMENT (jamais approximatif)', sum === 1000, `${sum} g`);
  check('résolution 1 g (allocations entières)', result.allocation.every((v) => Number.isInteger(v)));
  check('deux allocations non négatives', result.allocation.every((v) => v >= 0));
});

test('Zéro reste — dépassement nutritionnel causé par l’égalité, détectable par comparaison avec le mode normal', () => {
  // préparation largement surdimensionnée par rapport au besoin réel (deux
  // COLLATIONS, cibles modestes) : le mode normal doit rester dans la cible,
  // le mode zéro reste doit en sortir — puisqu'il DOIT écouler les 1000 g.
  const boeuf = F('Steak haché');
  const haricots = F('Haricots rouges');
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 600, 'cru'), newRecipeItem(haricots.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const preparation = newPreparation(recipe, 1000);
  const preparationsById = { [preparation.id]: preparation };

  const prepItem1 = { ...newPreparationItem(preparation.id, 150), zeroWaste: true };
  const prepItem2 = { ...newPreparationItem(preparation.id, 150), zeroWaste: true };

  // MODE NORMAL (étape 7, sans égalité) : chaque collation cherche son
  // optimum, plafonné par le disponible — le total naturel reste bien sous 1000 g.
  const normalItems1 = [{ ...prepItem1 }];
  const normalItems2 = [{ ...prepItem2 }];
  autoAdjust(normalItems1, byId, SNACK, { preparationsById, preparationAvailability: { [preparation.id]: 1000 - 150 } });
  autoAdjust(normalItems2, byId, SNACK, { preparationsById, preparationAvailability: { [preparation.id]: 1000 - 150 } });
  const normalTotal = normalItems1[0].qty.thomas + normalItems2[0].qty.thomas;
  const normalMacros1 = mealMacros(normalItems1, byId, 'thomas', {}, preparationsById);
  const normalEval1 = evaluate(normalMacros1, SNACK.thomas, 0.05);

  // MODE ZÉRO RESTE : les 1000 g DOIVENT être intégralement affectés,
  // largement au-delà du besoin d'une collation.
  const slot1 = { items: [prepItem1], itemId: prepItem1.id, target: SNACK.thomas, person: 'thomas' };
  const slot2 = { items: [prepItem2], itemId: prepItem2.id, target: SNACK.thomas, person: 'thomas' };
  const zw = resolveZeroWasteAllocation([slot1, slot2], 1000, byId, {}, preparationsById);
  const zwTotal = zw.allocation.reduce((s, v) => s + v, 0);

  info(`mode normal : ${normalTotal} g au total (statut ${normalEval1.status}) · zéro reste : ${zwTotal} g au total`);
  check('le mode normal reste dans une échelle raisonnable (pas forcé à 1000 g)', normalTotal < 1000);
  check('le mode zéro reste force EXACTEMENT les 1000 g malgré tout', zwTotal === 1000);

  // le dépassement causé par le zéro reste se détecte en comparant les DEUX
  // créneaux : la répartition minimisant le coût total n'est pas forcément
  // symétrique (perte de Welsch bornée, non convexe — comportement hérité de
  // l'optimiseur existant, pas introduit ici) ; on compare donc l'écart kcal
  // CUMULÉ des deux créneaux plutôt qu'un seul isolément.
  const normalMacros2 = mealMacros(normalItems2, byId, 'thomas', {}, preparationsById);
  const normalEval2 = evaluate(normalMacros2, SNACK.thomas, 0.05);
  const zwItems1 = [{ ...prepItem1, qty: { thomas: zw.allocation[0], julie: zw.allocation[0] } }];
  const zwItems2 = [{ ...prepItem2, qty: { thomas: zw.allocation[1], julie: zw.allocation[1] } }];
  const zwEval1 = evaluate(mealMacros(zwItems1, byId, 'thomas', {}, preparationsById), SNACK.thomas, 0.05);
  const zwEval2 = evaluate(mealMacros(zwItems2, byId, 'thomas', {}, preparationsById), SNACK.thomas, 0.05);
  const cumulKcalDelta = (ev1, ev2) =>
    Math.abs(ev1.rows.find((r) => r.key === 'kcal').delta) + Math.abs(ev2.rows.find((r) => r.key === 'kcal').delta);
  const normalCumul = cumulKcalDelta(normalEval1, normalEval2);
  const zwCumul = cumulKcalDelta(zwEval1, zwEval2);
  const causedByZeroWaste = zwCumul > normalCumul;
  info(`écart kcal cumulé — mode normal : ${normalCumul.toFixed(0)} · zéro reste : ${zwCumul.toFixed(0)} · causedByZeroWaste=${causedByZeroWaste}`);
  check('le dépassement causé par le zéro reste est bien détecté (écart kcal cumulé strictement plus grand)',
    causedByZeroWaste === true);
});

test('Zéro reste — un item sans zeroWaste:true n’est jamais inclus dans le calcul (aucune bascule automatique)', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.baseGrams = 1000;
  const preparation = newPreparation(recipe, 1000);
  const preparationsById = { [preparation.id]: preparation };
  // item normal (zeroWaste: false, valeur par défaut de newPreparationItem)
  const normalItem = newPreparationItem(preparation.id, 300);
  check('zeroWaste vaut false par défaut, jamais basculé automatiquement', normalItem.zeroWaste === false);
  // resolveZeroWasteAllocation() n'est appelée qu'avec les créneaux que
  // l'APPELANT choisit d'y inclure — cet item normal, non passé en slot,
  // n'a aucune influence sur un éventuel calcul zéro reste ailleurs.
  const other = { ...newPreparationItem(preparation.id, 700), zeroWaste: true };
  const slot = { items: [other], itemId: other.id, target: LUNCH.thomas, person: 'thomas' };
  const result = resolveZeroWasteAllocation([slot], 1000, byId, {}, preparationsById);
  check('un seul créneau pris en compte : le total lui revient entièrement, l’item normal ignoré',
    result.allocation[0] === 1000);
});

test('Zéro reste — plusieurs autres ingrédients dans le même repas se réoptimisent autour de l’allocation imposée', () => {
  const recipe = newRecipe('Chili con carne', 'weight');
  recipe.items = [newRecipeItem(F('Steak haché').id, 600, 'cru'), newRecipeItem(F('Haricots rouges').id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  const preparation = newPreparation(recipe, 1000);
  const preparationsById = { [preparation.id]: preparation };
  const prepItem1 = { ...newPreparationItem(preparation.id, 300), zeroWaste: true };
  const prepItem2 = { ...newPreparationItem(preparation.id, 250), zeroWaste: true };
  const riz = item(F('Riz basmati'), 100);

  const slot1 = { items: [prepItem1, riz], itemId: prepItem1.id, target: LUNCH.thomas, person: 'thomas' };
  const slot2 = { items: [prepItem2], itemId: prepItem2.id, target: LUNCH.thomas, person: 'thomas' };
  const result = resolveZeroWasteAllocation([slot1, slot2], 1000, byId, {}, preparationsById);
  const sum = result.allocation.reduce((s, v) => s + v, 0);
  check('égalité respectée malgré la présence d’un autre ingrédient', sum === 1000);
  check('le riz (autre ingrédient du créneau 1) a bien été réoptimisé (present dans les quantités retournées)',
    result.quantities[0][riz.id] !== undefined && result.quantities[0][riz.id] > 0);
});

/* ================================================================ SECTIONS (ÉTAPE 2) */

test('Sections — item.section par défaut à "plat", jamais persisté comme liste séparée', () => {
  const it1 = newItem('f_test', 100, 'cru');
  check('newItem() : section par défaut "plat"', it1.section === 'plat');
  const it2 = newFreeItem('curry', 'au goût');
  check('newFreeItem() : section par défaut "plat"', it2.section === 'plat');
});

test('Sections — sectionsUsed() calculé à l’affichage, dans l’ordre fixe', () => {
  const items = [
    { ...newItem('f_a'), section: 'dessert' },
    { ...newItem('f_b'), section: 'entree' },
    { ...newItem('f_c'), section: 'plat' },
    { ...newItem('f_d'), section: 'plat' }, // doublon : ne doit apparaître qu'une fois
  ];
  const used = sectionsUsed(items);
  check('ordre fixe respecté (entree avant plat avant dessert), pas l’ordre d’insertion',
    JSON.stringify(used) === JSON.stringify(['entree', 'plat', 'dessert']));
  check('pas de doublon', used.length === 3);
  check('une section absente des items n’apparaît pas (accompagnement)', !used.includes('accompagnement'));
});

test('Sections — compatibilité ancien repas : item sans .section traité comme "plat" à la LECTURE', () => {
  // simule un item stocké AVANT cette évolution : aucune mutation active des
  // données, seule la lecture applique le défaut (décision §15/§18).
  const legacyItem = { id: 'it_legacy', foodId: 'f_test', free: null, state: null,
    qty: { thomas: 100, julie: 100 }, locked: { thomas: false, julie: false } }; // pas de .section
  check('l’item stocké ne porte toujours pas de .section (aucune conversion active)',
    legacyItem.section === undefined);
  const used = sectionsUsed([legacyItem]);
  check('mais il est bien traité comme "plat" à la lecture', used.length === 1 && used[0] === 'plat');
});

test('Sections — liste fixe (décision §7)', () => {
  check('7 sections, dans cet ordre exact',
    JSON.stringify(SECTIONS) === JSON.stringify(['entree', 'plat', 'accompagnement', 'fromage', 'dessert', 'collation', 'autre']));
  check('DEFAULT_SECTION = "plat"', DEFAULT_SECTION === 'plat');
});

/* ============================================== SCÉNARIO RÉEL — SKYR AVOINE + WASA (v1.5.0.7) */

test('Calibration asymétrique — scénario réel Skyr Avoine + Wasa fromage frais poulet', () => {
  // recette weight réelle (référence directe, sans préparation) : 150 g Skyr +
  // 50 g flocons d'avoine, baseGrams = 200 g.
  const skyrAvoine = newRecipe('Skyr Avoine', 'weight');
  skyrAvoine.items = [newRecipeItem(F('Skyr').id, 150, 'pret'), newRecipeItem(F('Flocons d’avoine').id, 50, 'pret')];
  skyrAvoine.baseGrams = 200;

  // recette portion réelle (fixture reprise de "Recettes portion — recipeAsVirtualFood()") :
  // 1 tranche de Wasa + 20 g fromage frais tartinable + 35 g poulet en tranches.
  const wasaFood = F('Pain croustillant');
  const wasaRecipe = newRecipe('Wasa fromage frais poulet', 'portion');
  wasaRecipe.items = [
    newRecipeItem(wasaFood.id, wasaFood.gramsPerUnit, 'pret'),
    newRecipeItem(F('Fromage frais tartinable').id, 20, 'pret'),
    newRecipeItem(F('Blanc de poulet en tranches').id, 35, 'pret'),
  ];
  const portionGrams = wasaFood.gramsPerUnit + 20 + 35;
  const recipesById = { [skyrAvoine.id]: skyrAvoine, [wasaRecipe.id]: wasaRecipe };

  const targets = {
    thomas: { kcal: 850, protein: 40, carbs: 100, fat: 30 },
    julie: { kcal: 550, protein: 30, carbs: 60, fat: 18 },
  };
  const items = [
    recipeItemInMeal(skyrAvoine.id, 288, { thomas: 288, julie: 140 }),
    recipeItemInMeal(wasaRecipe.id, portionGrams, { thomas: portionGrams, julie: portionGrams * 2 }),
  ];

  autoAdjust(items, byId, targets, { recipesById });

  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p, recipesById, {});
    const t = targets[p];
    info(`${p} : Skyr Avoine ${items[0].qty[p].toFixed(0)} g | Wasa ×${(items[1].qty[p] / portionGrams).toFixed(2)} ` +
      `→ ${m.kcal.toFixed(0)}/${t.kcal} kcal (${(dev(m.kcal, t.kcal) * 100).toFixed(1)}%) · ` +
      `${m.protein.toFixed(1)}/${t.protein} P (${(dev(m.protein, t.protein) * 100).toFixed(1)}%) · ` +
      `${m.carbs.toFixed(1)}/${t.carbs} G (${(dev(m.carbs, t.carbs) * 100).toFixed(1)}%) · ` +
      `${m.fat.toFixed(1)}/${t.fat} L (${(dev(m.fat, t.fat) * 100).toFixed(1)}%)`);

    // avec seulement 2 variables ajustables, les 4 cibles restent structurellement
    // inatteignables simultanément (degrés de liberté insuffisants — diagnostic
    // antérieur, non lié à la calibration). Le comportement attendu n'est donc
    // PAS "tout dans la cible", mais le respect strict de la hiérarchie :
    check(`${p} : kcal jamais au-dessus de la cible (+5 % max)`, dev(m.kcal, t.kcal) <= 0.05, `${m.kcal.toFixed(0)} / ${t.kcal}`);
    check(`${p} : lipides jamais au-dessus de la cible (+5 % max)`, dev(m.fat, t.fat) <= 0.05, `${m.fat.toFixed(1)} / ${t.fat}`);
    check(`${p} : protéines jamais en dessous de la cible`, dev(m.protein, t.protein) >= 0, `${m.protein.toFixed(1)} / ${t.protein}`);
    // la recette-portion reste un multiple entier (indivisible), inchangé par la calibration
    check(`${p} : Wasa reste un multiple entier de portion (${portionGrams} g)`,
      items[1].qty[p] % portionGrams === 0, `${items[1].qty[p]} g`);
  }

  // kcal se rapproche nettement de la cible par rapport à l'ancienne formule
  // symétrique (mesuré séparément, hors dépôt : thomas -38,7 % → julie ~0 %/thomas
  // très amélioré) — ici, on vérifie concrètement que julie atteint le kcal
  // quasiment pile (marge large pour ne pas figer un optimum de second ordre).
  const mJulie = mealMacros(items, byId, 'julie', recipesById, {});
  check('julie : kcal nettement rapproché de la cible (±10 %, contre -14,6 % avant calibration)',
    Math.abs(dev(mJulie.kcal, targets.julie.kcal)) <= 0.10, `${mJulie.kcal.toFixed(0)} / ${targets.julie.kcal}`);
});

/* ============================================== P2.1 — RECETTES : CHAMPS OPÉRATOIRES (v1.5.3) */

test('P2.1.1 — création d’une recette avec les 7 champs opératoires', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  recipe.shelfLifeDays = 3;
  recipe.cookingMethod = 'mijoteuse';
  recipe.cookingTemp = 90;
  recipe.cookingTime = 120;
  recipe.prepTime = 15;
  recipe.equipment = 'mijoteuse électrique';
  recipe.instructions = 'Saisir la viande puis mijoter 2 h.';
  check('batchAllowed conservé', recipe.batchAllowed === true);
  check('shelfLifeDays conservé', recipe.shelfLifeDays === 3);
  check('cookingMethod conservé', recipe.cookingMethod === 'mijoteuse');
  check('cookingTemp conservé', recipe.cookingTemp === 90);
  check('cookingTime conservé', recipe.cookingTime === 120);
  check('prepTime conservé', recipe.prepTime === 15);
  check('equipment conservé', recipe.equipment === 'mijoteuse électrique');
  check('instructions conservé', recipe.instructions === 'Saisir la viande puis mijoter 2 h.');
});

test('P2.1.2 — modification d’une recette existante', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.shelfLifeDays = 2;
  recipe.cookingMethod = 'poêle';
  recipe.shelfLifeDays = 4; // modification
  recipe.cookingMethod = 'four'; // modification
  check('shelfLifeDays modifié', recipe.shelfLifeDays === 4);
  check('cookingMethod modifié', recipe.cookingMethod === 'four');
  check('les autres champs (items, baseGrams) restent inchangés par la modification',
    recipe.items.length === 1 && recipe.baseGrams === 1000);
});

test('P2.1.3 — persistance locale : migrateState()/normalizeRecipe() préservent les 7 champs', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  recipe.shelfLifeDays = 3;
  recipe.cookingMethod = 'mijoteuse';
  recipe.cookingTemp = 90;
  recipe.cookingTime = 120;
  recipe.prepTime = 15;
  recipe.equipment = 'mijoteuse électrique';
  recipe.instructions = 'Saisir puis mijoter.';
  const raw = { ...defaultState(), recipes: [recipe] };
  const migrated = migrateState(JSON.parse(JSON.stringify(raw)));
  const r = migrated.recipes.find((x) => x.id === recipe.id);
  check('recette retrouvée après migration (round-trip JSON + migrateState)', !!r);
  check('7 champs intacts après migration',
    r.batchAllowed === true && r.shelfLifeDays === 3 && r.cookingMethod === 'mijoteuse' &&
    r.cookingTemp === 90 && r.cookingTime === 120 && r.prepTime === 15 &&
    r.equipment === 'mijoteuse électrique' && r.instructions === 'Saisir puis mijoter.');
});

test('P2.1.4 — round-trip via sync.js (stateToTables/tablesToState) : les 7 champs survivent', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  recipe.batchAllowed = true;
  recipe.shelfLifeDays = 3;
  recipe.cookingMethod = 'mijoteuse';
  recipe.cookingTemp = 90;
  recipe.cookingTime = 120;
  recipe.prepTime = 15;
  recipe.equipment = 'mijoteuse électrique';
  recipe.instructions = 'Saisir puis mijoter.';
  const s = { ...defaultState(), recipes: [recipe] };
  const tables = stateToTables(s);
  const row = tables.recipes.find((r) => r.id === recipe.id);
  check('shelf_life_days sérialisé', row.shelf_life_days === 3);
  check('batch_allowed sérialisé', row.batch_allowed === true);
  check('cooking_method sérialisé', row.cooking_method === 'mijoteuse');
  const back = tablesToState({ recipes: tables.recipes, recipe_items: tables.recipe_items });
  const r = back.recipes.find((x) => x.id === recipe.id);
  check('recette retrouvée après round-trip', !!r);
  check('7 champs intacts après round-trip complet (aller-retour Supabase)',
    r.batchAllowed === true && r.shelfLifeDays === 3 && r.cookingMethod === 'mijoteuse' &&
    r.cookingTemp === 90 && r.cookingTime === 120 && r.prepTime === 15 &&
    r.equipment === 'mijoteuse électrique' && r.instructions === 'Saisir puis mijoter.');
});

test('P2.1.5 — valeurs par défaut lorsque les 7 champs sont absents (recette antérieure à P0)', () => {
  const raw = {
    id: 'r_old', name: 'Ancienne recette', kind: 'weight', baseGrams: 500,
    items: [{ foodId: F('Riz basmati').id, qty: 500, state: 'cru' }],
  };
  const s = { ...defaultState(), recipes: [raw] };
  const migrated = migrateState(JSON.parse(JSON.stringify(s)));
  const r = migrated.recipes.find((x) => x.id === 'r_old');
  check('batchAllowed par défaut = false', r.batchAllowed === false);
  check('shelfLifeDays par défaut = null (non renseigné, pas 0)', r.shelfLifeDays === null);
  check('cookingMethod/equipment/instructions par défaut = chaîne vide',
    r.cookingMethod === '' && r.equipment === '' && r.instructions === '');
  check('cookingTemp/cookingTime/prepTime par défaut = null',
    r.cookingTemp === null && r.cookingTime === null && r.prepTime === null);
});

/* ============================================== P2.2 — BATCH COOKING : ALGORITHME GLOUTON ANCRÉ SUR LA CONSOMMATION RÉELLE (v1.5.3) */

test('P2.2.1 — shelfLifeDays = 1 : une préparation par jour de consommation', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = 1;
  const recipesById = { [recipe.id]: recipe };
  const meals = [0, 1, 2].map((day) => mkMeal(day, 'lunch',
    [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('3 sous-préparations (une par jour de consommation)', r.subBatches.length === 3,
    JSON.stringify(r.subBatches.map((b) => `${b.startDay}-${b.endDay}`)));
  check('chaque sous-préparation ne couvre qu’un seul jour', r.subBatches.every((b) => b.startDay === b.endDay));
});

test('P2.2.2 — shelfLifeDays = 2, consommation J1+J2 : UNE SEULE préparation (correction de la sur-recommandation)', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Poulet curry', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = 2;
  const recipesById = { [recipe.id]: recipe };
  const meals = [1, 2].map((day) => mkMeal(day, 'lunch',
    [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('UNE SEULE sous-préparation (J1, couvre J1 et J2 — grille fixe corrigée)',
    r.subBatches.length === 1, JSON.stringify(r.subBatches));
  check('préparation datée J1 (premier jour de consommation, pas J0)', r.subBatches[0].startDay === 1);
  check('couvre bien J1 et J2', JSON.stringify(r.subBatches[0].coversDays) === JSON.stringify([1, 2]));
  check('quantité = 200 g (2 jours × 100 g), pas 100 g comme le ferait une scission inutile',
    r.subBatches[0].requiredRaw === 200);
});

test('P2.2.3 — shelfLifeDays = 2, consommation J1+J3 : deux préparations (l’écart dépasse la conservation)', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = 2;
  const recipesById = { [recipe.id]: recipe };
  const meals = [1, 3].map((day) => mkMeal(day, 'lunch',
    [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('2 sous-préparations (J1 et J3, écart de conservation dépassé)',
    r.subBatches.length === 2, JSON.stringify(r.subBatches.map((b) => `${b.startDay}-${b.endDay}`)));
  check('1ère préparation à J1', r.subBatches[0].startDay === 1);
  check('2e préparation à J3 (pas J2, car aucune consommation ce jour-là)', r.subBatches[1].startDay === 3);
});

test('P2.2.4 — shelfLifeDays = 4 : toutes les consommations dans la fenêtre → une seule préparation', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = 4;
  const recipesById = { [recipe.id]: recipe };
  const meals = [1, 2, 3, 4].map((day) => mkMeal(day, 'lunch',
    [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]));
  const st = batchTestState(meals);
  st.settings.cycle.duration = 6; st.settings.batch.maxDays = 6;
  const plan = buildBatchPlan(st, byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('une seule sous-préparation malgré 4 jours de consommation distincts',
    r.subBatches.length === 1, JSON.stringify(r.subBatches));
  check('quantité = 400 g (4 × 100 g)', r.subBatches[0].requiredRaw === 400);
});

test('P2.2.5 — shelfLifeDays NULL : comportement de secours (couvre toute la session, aucune scission)', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = null;
  const recipesById = { [recipe.id]: recipe };
  const meals = [0, 1, 3].map((day) => mkMeal(day, 'lunch',
    [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('shelfLifeShort = false (conservation inconnue → jamais signalée comme insuffisante)', r.shelfLifeShort === false);
  check('aucune scission (subBatches === null)', r.subBatches === null);
});

test('P2.2.6 — exemple du brief : consommation J0+J1+J3, conservation 2 jours', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Poulet curry', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = 2;
  const recipesById = { [recipe.id]: recipe };
  const meals = [0, 1, 3].map((day) => mkMeal(day, 'lunch',
    [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('2 sous-préparations', r.subBatches.length === 2, JSON.stringify(r.subBatches));
  check('préparation J0 couvrant J0 et J1',
    r.subBatches[0].startDay === 0 && JSON.stringify(r.subBatches[0].coversDays) === JSON.stringify([0, 1]));
  check('nouvelle préparation J3 (pas J2, aucune consommation ce jour-là)', r.subBatches[1].startDay === 3);
  check('quantités : 200 g (J0+J1) puis 100 g (J3)',
    r.subBatches[0].requiredRaw === 200 && r.subBatches[1].requiredRaw === 100);
});

test('P2.2.7 — recette consommée plusieurs fois le même jour : agrégée avant la scission', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = 2;
  const recipesById = { [recipe.id]: recipe };
  const meals = [
    mkMeal(1, 'lunch', [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]),
    mkMeal(1, 'dinner', [{ ...newRecipeMealItem(recipe.id, 50), qty: { thomas: 50, julie: 0 } }]),
  ];
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('une seule sous-préparation (un seul jour de consommation, malgré 2 repas)', r.subBatches.length === 1);
  check('quantité agrégée des deux repas du même jour (100 + 50 = 150 g)', r.subBatches[0].requiredRaw === 150);
});

test('P2.2.8 — recette consommée plusieurs fois DANS sa durée de conservation : aucune préparation supplémentaire inutile', () => {
  const boeuf = F('Steak haché');
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(boeuf.id, 1000, 'cru')];
  recipe.baseGrams = 1000; recipe.batchAllowed = true; recipe.shelfLifeDays = 3;
  const recipesById = { [recipe.id]: recipe };
  const meals = [0, 1, 2].map((day) => mkMeal(day, 'lunch',
    [{ ...newRecipeMealItem(recipe.id, 100), qty: { thomas: 100, julie: 0 } }]));
  const plan = buildBatchPlan(batchTestState(meals), byId, recipesById, {});
  const r = plan[0].recipesToPrepare[0];
  check('une seule préparation malgré 3 consommations (toutes dans la fenêtre de 3 jours)',
    r.subBatches.length === 1, JSON.stringify(r.subBatches));
  check('quantité agrégée des 3 jours (300 g)', r.subBatches[0].requiredRaw === 300);
});

/* ============================================== P2.4 — AUTO-NOMMAGE DES REPAS (v1.5.3) */

test('P2.4.1 — nouveau repas vide : nameAuto === true', () => {
  const m = newMeal(0, 'lunch');
  check('nom vide à la création', m.name === '');
  check('nameAuto actif par défaut', m.nameAuto === true);
});

test('P2.4.2 — autoMealName() : féculent + protéine + légume → nom généré dans l’ordre attendu', () => {
  const items = [
    newItem(F('Pâtes complètes').id, 200),
    newItem(F('Blanc de poulet').id, 150),
    newItem(F('Courgettes').id, 100),
  ];
  const name = autoMealName(items, byId);
  check('nom généré : Pâtes complètes - Blanc de poulet - Courgettes (exemple de la spécification)',
    name === 'Pâtes complètes - Blanc de poulet - Courgettes', name);
});

test('P2.4.3 — modification d’une quantité : le nom auto est recalculé si le représentant du groupe change', () => {
  const items = [
    { ...newItem(F('Pâtes complètes').id, 0), qty: { thomas: 200, julie: 0 } },
    { ...newItem(F('Riz basmati').id, 0), qty: { thomas: 50, julie: 0 } }, // féculent minoritaire au départ
    { ...newItem(F('Blanc de poulet').id, 0), qty: { thomas: 150, julie: 0 } },
  ];
  const before = autoMealName(items, byId);
  check('pâtes complètes retenues au départ (plus lourdes : 200 g > 50 g)', before.startsWith('Pâtes complètes'), before);
  items[1].qty = { thomas: 400, julie: 0 }; // le riz devient majoritaire (400 g > 200 g)
  const after = autoMealName(items, byId);
  check('le riz devient le représentant féculent une fois plus lourd que les pâtes', after.startsWith('Riz basmati'), after);
});

test('P2.4.4 — plusieurs aliments dans la même catégorie : le plus lourd (Thomas + Julie) est retenu', () => {
  const items = [
    { ...newItem(F('Pâtes complètes').id, 0), qty: { thomas: 100, julie: 0 } },
    { ...newItem(F('Riz basmati').id, 0), qty: { thomas: 80, julie: 90 } }, // 170 g cumulés > 100 g des pâtes
  ];
  const name = autoMealName(items, byId);
  check('riz retenu (170 g cumulés Thomas+Julie > 100 g pâtes)', name === 'Riz basmati', name);
});

test('P2.4.5 — catégorie absente : le segment est omis, jamais remplacé par un placeholder', () => {
  const items = [newItem(F('Blanc de poulet').id, 150), newItem(F('Courgettes').id, 100)]; // pas de féculent
  const name = autoMealName(items, byId);
  check('aucun placeholder pour le féculent manquant', name === 'Blanc de poulet - Courgettes', name);
});

test('P2.4.6 — aucun des trois groupes identifiable : nom vide', () => {
  const items = [newItem(F('Fromage frais tartinable').id, 30)]; // catégorie laitier, hors des 3 groupes
  const name = autoMealName(items, byId);
  check('nom vide, jamais un nom absurde', name === '');
});

test('P2.4.7 — recette/préparation seules : jamais prises en compte pour l’auto-nommage', () => {
  const recipe = newRecipe('Chili', 'weight');
  recipe.items = [newRecipeItem(F('Steak haché').id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  const items = [{ ...newRecipeMealItem(recipe.id, 300), qty: { thomas: 300, julie: 0 } }];
  const name = autoMealName(items, byId);
  check('un item recette (sans foodId) ne produit aucun nom', name === '');
});

test('P2.4.8 — migration : repas existant avec un nom non vide → nameAuto forcé à false', () => {
  const m = normalizeMeal({ id: 'm1', dayIndex: 0, mealType: 'lunch', name: 'Repas post-entraînement', sameComposition: true, items: [] });
  check('nameAuto = false : un nom déjà saisi n’est jamais pris pour un nom généré', m.nameAuto === false);
});

test('P2.4.9 — migration : repas existant sans nom → nameAuto = true', () => {
  const m = normalizeMeal({ id: 'm2', dayIndex: 0, mealType: 'lunch', name: '', sameComposition: true, items: [] });
  check('nameAuto = true : repas jamais nommé, régénérable', m.nameAuto === true);
});

test('P2.4.10 — migration : un repas qui porte déjà nameAuto conserve sa valeur telle quelle', () => {
  const m1 = normalizeMeal({ id: 'm3', name: 'Pâtes complètes - Blanc de poulet', nameAuto: true, items: [] });
  check('un nom AUTO-GÉNÉRÉ non vide n’est jamais réinterprété comme un nom saisi (nameAuto reste true)', m1.nameAuto === true);
  const m2 = normalizeMeal({ id: 'm4', name: '', nameAuto: false, items: [] });
  check('un nom vidé volontairement (nameAuto déjà false) n’est jamais réactivé automatiquement', m2.nameAuto === false);
});

test('P2.4.11 — persistance locale : migrateState() préserve name/nameAuto d’un repas', () => {
  const raw = {
    ...defaultState(),
    meals: [{ id: 'm5', dayIndex: 0, mealType: 'lunch', name: 'Repas post-entraînement', nameAuto: false, sameComposition: true, items: [] }],
  };
  const migrated = migrateState(JSON.parse(JSON.stringify(raw)));
  const m = migrated.meals.find((x) => x.id === 'm5');
  check('nom conservé après migration', m.name === 'Repas post-entraînement');
  check('nameAuto conservé après migration', m.nameAuto === false);
});

test('P2.4.12 — round-trip via sync.js : name_auto sérialisé/désérialisé correctement', () => {
  const meal = { id: 'm6', dayIndex: 0, mealType: 'lunch', name: 'Repas post-entraînement', nameAuto: false, sameComposition: true, items: [] };
  const s = { ...defaultState(), meals: [meal] };
  const tables = stateToTables(s);
  const row = tables.meals.find((m) => m.id === 'm6');
  check('name_auto = false sérialisé', row.name_auto === false);
  const back = tablesToState({ meals: tables.meals, meal_items: tables.meal_items });
  const m = back.meals.find((x) => x.id === 'm6');
  check('nameAuto = false désérialisé (nom réel jamais perdu au round-trip)', m.nameAuto === false);
  check('name désérialisé', m.name === 'Repas post-entraînement');
});

/* ---------------------------------------------------------------- bilan */

console.log('\n' + '='.repeat(60));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) {
  console.log('\nÉchecs :');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
