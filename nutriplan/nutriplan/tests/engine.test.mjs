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
} from '../js/core/nutrition.js';
import { buildBatchPlan, buildShoppingList } from '../js/core/derive.js';
import { seedFoods } from '../js/core/seed-foods.js';

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

/* ================================================================ CRU / CUIT */

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

test('Batch — agrégation par session, cru/cuit, exclusions', () => {
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
  check('note de préparation du poulet présente', /filets entiers/.test(poulet.note || ''));

  const riz = s1.components.find((c) => c.food.name.includes('Riz'));
  check('riz agrégé (jours 1 et 2)', riz.requiredRaw === 320, `${riz.requiredRaw} g`);

  const names = s1.components.map((c) => c.food.name);
  check('cabillaud exclu du batch', !names.some((n) => n.toLowerCase().includes('cabillaud')));
  check('œufs exclus du batch', !names.some((n) => n.includes('Œuf')));
  check('wrap exclu du batch', !names.some((n) => n.includes('Wrap')));

  const sameDayNames = s1.sameDay.map((x) => x.food.name);
  check('cabillaud signalé en cuisson du jour', sameDayNames.some((n) => n.toLowerCase().includes('cabillaud')));
  check('œufs signalés en cuisson du jour', sameDayNames.some((n) => n.includes('Œuf')));
  check('cabillaud rattaché au bon jour', s1.sameDay.find((x) => x.food.name.toLowerCase().includes('cabillaud')).dayIndex === 1);

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

  // le planning n'est jamais modifié par le batch
  check('planning intact après calcul du batch', JSON.stringify(s3.meals) === mealsBefore);
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
