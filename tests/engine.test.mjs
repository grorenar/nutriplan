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
  canConvert, conversionInfo, stateLabel, STATES,
} from '../js/core/nutrition.js';
import {
  buildBatchPlan, buildShoppingList, batchCategory, cycleSources, cookingSummary, preparationNote,
  coverageReport, optionUses, needsCooking,
} from '../js/core/derive.js';
import { seedFoods } from '../js/core/seed-foods.js';
import { migrateState } from '../js/core/store.js';
import { findSimilarFoods, findDuplicateGroups } from '../js/core/similarity.js';

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

const dev = (v, t) => (t ? (v - t) / t : 0);
const within = (items, targets, person, tol = 0.05) => {
  const m = mealMacros(items, byId, person);
  return evaluate(m, targets[person], tol).rows.every((r) => r.status === 'ok');
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
  check('lipides signalés manquants', d.rows.some((r) => r.key === 'fat' && r.delta < 0));
  check('une piste est proposée', d.suggestions.length > 0, d.suggestions.join(', '));
});

/* ================================================================ TEST B */

test('B — protéine + féculent : protéines et glucides rapprochés de la cible', () => {
  const items = [item(F('Blanc de poulet')), item(F('Pâtes complètes'))];
  autoAdjust(items, byId, LUNCH);
  show(items, LUNCH);
  show(items, LUNCH, 'julie');
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    check(`${p} : protéines dans ±5 %`, Math.abs(dev(m.protein, LUNCH[p].protein)) <= 0.05, `${m.protein.toFixed(1)} g`);
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
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    for (const [key, label] of [['kcal', 'kcal'], ['protein', 'P'], ['carbs', 'C'], ['fat', 'L']]) {
      check(`${p} : ${label} dans ±5 %`, Math.abs(dev(m[key], LUNCH[p][key])) <= 0.05,
        `${m[key].toFixed(1)} / ${LUNCH[p][key]}`);
    }
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
  check('kcal très en dessous, signalé "off"', evaluate(m, LUNCH.thomas).rows[0].status === 'off', `${m.kcal.toFixed(0)} kcal`);

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
  for (const p of ['thomas', 'julie']) {
    check(`${p} : les 4 macros dans ±5 %`, within(items, LUNCH, p));
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
  for (const p of ['thomas', 'julie']) {
    const m = mealMacros(items, byId, p);
    check(`${p} : kcal dans ±5 %`, Math.abs(dev(m.kcal, LUNCH[p].kcal)) <= 0.05, `${m.kcal.toFixed(0)}`);
  }
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
  check('skyr fractionnable : arrondi au pas de 5 g, unité indicative', roundQuantity(skyr, 192) % 5 === 0, `${roundQuantity(skyr, 192)} g`);

  // bornes + unités entières : la quantité reste un multiple même au plafond
  const big = roundQuantity(F('Œuf entier'), 1000);
  check('arrondi borné reste un multiple', big % gEgg === 0, `${big} g`);
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
  check('toujours dans la cible après 10 passages', within(items, LUNCH, 'thomas'));
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

/* ---------------------------------------------------------------- bilan */

console.log('\n' + '='.repeat(60));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) {
  console.log('\nÉchecs :');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
