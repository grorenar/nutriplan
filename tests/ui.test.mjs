/**
 * Test d'interface de bout en bout (jsdom) : on charge index.html, on clique
 * réellement dans l'application et on vérifie ce qui s'affiche.
 *
 *   npm i jsdom && node tests/ui.test.mjs
 *
 * jsdom n'est utilisé que pour les tests : l'application elle-même n'a
 * aucune dépendance.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let JSDOM;
try { ({ JSDOM } = await import('jsdom')); }
catch { console.log('jsdom absent — test ignoré (npm i jsdom pour l’exécuter)'); process.exit(0); }

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const dom = new JSDOM(fs.readFileSync(join(root, 'index.html'), 'utf8'), {
  url: 'https://example.org/', pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location;
globalThis.confirm = () => true;
globalThis.Blob = window.Blob;
globalThis.CustomEvent = window.CustomEvent;
globalThis.URL = window.URL;
window.print = () => { printed++; };
let printed = 0;

let passed = 0;
const failures = [];
const check = (label, cond, detail = '') => {
  if (cond) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(label); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const jsErrors = [];
window.addEventListener('error', (e) => jsErrors.push(e.message));

const app = await import(join(root, 'js/app.js'));
const store = await import(join(root, 'js/core/store.js')); // même instance de module que celle utilisée par app.js
document.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise((r) => setTimeout(r, 50));

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const change = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
const wait = () => new Promise((r) => setTimeout(r, 20));

console.log('\n— Démarrage');
check('8 entrées de navigation (Recettes ajoutée)', $$('#nav button').length === 8);
check('8 créneaux de repas pour un cycle de 4 jours', $$('.meal-card').length === 8);
check('état de synchronisation affiché', /Mode local/.test($('#status').textContent));

console.log('\n— Composition d’un déjeuner');
click($$('[data-edit]')[0]);
check('éditeur ouvert', !!$('#drawer .drawer__panel'));
const add = (search, label) => {
  type($('#drawer [data-search]'), search);
  const btn = $$('#drawer [data-add]').find((b) => b.textContent.includes(label));
  if (!btn) throw new Error(`aliment introuvable : ${label}`);
  click(btn);
};
add('poulet', 'Blanc de poulet');
add('pâtes com', 'Pâtes complètes');
add('haricots', 'Haricots verts');
add('huile d', 'Huile d');
check('4 ingrédients', $$('#drawer .item').length === 4);
const macros = $$('#drawer .macro').slice(0, 4).map((m) => m.textContent.replace(/\s+/g, ' ').trim());
console.log(`        ${macros.join(' | ')}`);
check('macros affichées sans clic supplémentaire', macros.length === 4);
check('glucides affichés "G" et non "C"', macros.some((m) => / G$/.test(m)) && !macros.some((m) => / C$/.test(m)), macros.join(' | '));
check('les 4 macros de Thomas sont dans la cible',
  $$('#drawer .macro').slice(0, 4).every((m) => m.classList.contains('is-ok')));

console.log('\n— État pesé dans le repas');
const pastaRow = $$('#drawer .item').find((el) => /Pâtes complètes/.test(el.textContent));
const stateSel = pastaRow.querySelector('[data-state]');
check('les quatre états sont proposés', stateSel.options.length === 4);
check('état par défaut = état des valeurs nutritionnelles', stateSel.value === 'cru');
const kcalBefore = Number((pastaRow.textContent.match(/(\d+) kcal/) || [])[1]);
change(stateSel, 'cuit');
await wait();
const pastaCooked = $$('#drawer .item').find((el) => /Pâtes complètes/.test(el.textContent));
check('état enregistré et relu', pastaCooked.querySelector('[data-state]').value === 'cuit');
check('conversion signalée via le rendement', /rendement/.test(pastaCooked.textContent));
check('macros recalculées sur le poids cuit',
  Number((pastaCooked.textContent.match(/(\d+) kcal/) || [])[1]) < kcalBefore);
change(pastaCooked.querySelector('[data-state]'), 'egoutte');
await wait();
const pastaDrained = $$('#drawer .item').find((el) => /Pâtes complètes/.test(el.textContent));
check('conversion impossible signalée à l’utilisateur',
  /Conversion impossible/.test(pastaDrained.textContent));
check('aucune macro calculée pour cet ingrédient',
  /— kcal · — P · — G · — L/.test(pastaDrained.textContent),
  (pastaDrained.textContent.match(/[—\d]+ kcal/) || [''])[0]);
check('ingrédient exclu du total du repas',
  /exclu\(s\) du total/.test($('#drawer .drawer__body').textContent));
const totalDrained = Number(($('#drawer .macro')?.textContent.match(/(\d+)/) || [])[1]);
change(pastaDrained.querySelector('[data-state]'), 'cru');
await wait();
const totalBack = Number(($('#drawer .macro')?.textContent.match(/(\d+)/) || [])[1]);
check('le total remonte une fois un état convertible choisi', totalBack > totalDrained,
  `${totalDrained} → ${totalBack}`);
check('plus aucun avertissement de conversion',
  !/Conversion impossible/.test($('#drawer .drawer__body').textContent));

console.log('\n— Verrouillage');
const qty = () => $$('#drawer [data-qty]').map((i) => i.value);
change($$('#drawer [data-qty]')[0], '180');
click($$('#drawer [data-lock]')[0]);
const lockedValue = qty()[0];
check('poulet à 180 g après verrouillage', lockedValue === '180', lockedValue);
change($$('#drawer [data-qty]')[2], '150');
check('poulet inchangé après modification des pâtes', qty()[0] === '180');
check('aucun ingrédient supprimé', $$('#drawer .item').length === 4);

console.log('\n— « Ajuster maintenant » avec ajustement automatique désactivé');
// le panneau ne recrée que son contenu à chaque rendu : on requête l'élément
// à chaque fois plutôt que de garder une référence, qui deviendrait périmée.
if ($('#drawer [data-auto]').checked) click($('#drawer [data-auto]'));
await wait();
check('ajustement automatique décoché', $('#drawer [data-auto]').checked === false);
// on modifie une quantité déverrouillée : sans ajustement auto, rien ne bouge d'autre
change($$('#drawer [data-qty]')[2], '5');
await wait();
const beforeAdjust = qty();
check('aucun réajustement automatique pendant la saisie (auto désactivé)', qty()[2] === '5');
click($('#drawer [data-adjust]'));
await wait();
const afterAdjust = qty();
check('« Ajuster maintenant » modifie réellement les quantités malgré autoAdjust=false',
  beforeAdjust.some((v, i) => v !== afterAdjust[i]), `${beforeAdjust.join(',')} → ${afterAdjust.join(',')}`);
check('toast de confirmation affiché',
  /Quantités ajustées/.test(document.getElementById('toasts')?.textContent || ''));
click($('#drawer [data-auto]'));
await wait();
check('ajustement automatique réactivé', $('#drawer [data-auto]').checked === true);

console.log('\n— Ingrédient libre');
$('#drawer [data-free-name]').value = 'Curry';
$('#drawer [data-free-qty]').value = 'au goût';
click($('#drawer [data-free-add]'));
check('curry ajouté au repas', $$('#drawer .item').length === 5 && /Curry/.test($('#drawer').textContent));
check('curry marqué hors macros', /non compté dans les macros/.test($('#drawer').textContent));

console.log('\n— Saisie protégée de la synchronisation');
check('modale ouverte → saisie considérée en cours', app.isEditing() === true);
const searchField = $('#drawer [data-search]');
searchField.focus();
check('champ actif dans la modale → saisie en cours', app.isEditing() === true);
searchField.blur();
check('modale toujours ouverte → saisie toujours protégée', app.isEditing() === true);

console.log('\n— Stabilité de la recherche');
const panelBefore = $('#drawer .drawer__panel');
const searchEl = $('#drawer [data-search]');
type(searchEl, '');
searchEl.focus();
for (const chunk of ['s', 'k', 'y']) type(searchEl, searchEl.value + chunk);
check('le champ de recherche garde le focus', document.activeElement === $('#drawer [data-search]'));
check('la fenêtre n’est pas reconstruite', $('#drawer .drawer__panel') === panelBefore);
check('le texte saisi est conservé', $('#drawer [data-search]').value === 'sky', $('#drawer [data-search]').value);
check('seuls les résultats changent', $$('#drawer [data-add]').every((b) => /skyr/i.test(b.textContent)));
type($('#drawer [data-search]'), '');

console.log('\n— Saisie en unités et multiples stricts');
type($('#drawer [data-search]'), 'croustillant');
click($$('#drawer [data-add]')[0]);
const wasaRow = $$('#drawer .item').find((el) => /croustillant/i.test(el.textContent));
check('aliment à l’unité ajouté', !!wasaRow);
check('mention des multiples affichée', /multiples de 11 g/.test(wasaRow.textContent));
check('état pesé affiché à côté de la quantité',
  /État pesé/.test(wasaRow.textContent) && !!wasaRow.querySelector('[data-state]'));
click(wasaRow.querySelector('[data-unit-toggle]')); // passage en grammes
const wasaGram = $$('#drawer .item').find((el) => /croustillant/i.test(el.textContent)).querySelector('[data-qty]');
check('pas du curseur = poids d’une unité', wasaGram.getAttribute('step') === '11', wasaGram.getAttribute('step'));
click($$('#drawer .item').find((el) => /croustillant/i.test(el.textContent)).querySelector('[data-unit-toggle]'));
const wasaInput = wasaRow.querySelector('[data-qty]');
check('saisie en unités par défaut', wasaInput.dataset.unitmode === '1');
change(wasaInput, '3');
let wasaQty = () => {
  const st = JSON.parse(localStorage.getItem('nutriplan.state.v1'));
  const it = st.meals[0].items.find((i) => /wasa|croustillant/.test(i.foodId));
  return it ? it.qty.thomas : null;
};
check('3 tranches = 33 g stockés', wasaQty() === 33, `${wasaQty()} g`);
click(wasaRow.querySelector('[data-unit-toggle]'));
const wasaRow2 = $$('#drawer .item').find((el) => /croustillant/i.test(el.textContent));
check('bascule en grammes', wasaRow2.querySelector('[data-qty]').dataset.unitmode === '0');
change(wasaRow2.querySelector('[data-qty]'), '25');
check('25 g saisis → 22 g (multiple de 11)', wasaQty() === 22, `${wasaQty()} g`);
click($$('#drawer .item').find((el) => /croustillant/i.test(el.textContent)).querySelector('[data-del]'));

console.log('\n— Aliments récents');
type($('#drawer [data-search]'), ''); // la recherche filtre aussi l'onglet Récents
click($('#drawer [data-cat="recent"]'));
check('les aliments utilisés apparaissent dans "Récents"',
  $$('#drawer [data-add]').some((b) => b.textContent.includes('Blanc de poulet')));

click($('#drawer [data-close]'));
check('éditeur fermé', !$('#drawer .drawer__panel'));
check('macros visibles sur la carte du planning', $$('.meal-card .macro').length >= 8);

console.log('\n— Détection de doublons : popup bloquante');
click($('[data-view="foods"]'));
await wait();
const foodCount = () => JSON.parse(localStorage.getItem('nutriplan.state.v1')).foods.length;
const before = foodCount();

// 1. aucun similaire → création directe, aucune popup
click($('[data-new]'));
const setField = (name, v) => { const el = $(`[data-f="${name}"]`); el.value = v; };
setField('name', 'Cuisse de dinosaure');
setField('kcal', '150');
click($('[data-save]'));
await wait();
check('aucun similaire : aucune popup', !$('.modal'));
check('aucun similaire : création directe', foodCount() === before + 1);
check('aucun toast de doublon', !/similaire/i.test(document.getElementById('toasts')?.textContent || ''));

// 2. similaire détecté → popup affichée
click($('[data-new]'));
setField('name', 'Blanc de poulet');
setField('kcal', '110');
click($('[data-save]'));
await wait();
check('similaire détecté : popup affichée', !!$('.modal'));
check('popup centrée et bloquante', !!$('.modal__panel') && !!$('[data-similar-confirm]'));
check('l’élément existant est présenté avec ses macros',
  /Blanc de poulet/.test($('.modal').textContent) && /kcal/.test($('.modal').textContent));
check('l’élément en cours de création est rappelé', /en train de créer/.test($('.modal').textContent));
check('aucun message de doublon en bas de fenêtre',
  !/similaire/i.test(document.getElementById('toasts')?.textContent || ''));
check('rien n’est créé tant que l’utilisateur n’a pas répondu', foodCount() === before + 1);

// 3. Annuler → élément non créé
click($('[data-similar-cancel]'));
await wait();
check('Annuler : popup fermée', !$('.modal'));
check('Annuler : aucun aliment créé', foodCount() === before + 1);
check('Annuler : la saisie reste disponible', $('[data-f="name"]')?.value === 'Blanc de poulet');

// 4. Créer quand même → élément créé
click($('[data-save]'));
await wait();
check('la popup réapparaît à la nouvelle tentative', !!$('.modal'));
click($('[data-similar-confirm]'));
await wait();
check('Créer quand même : aliment créé', foodCount() === before + 2, `${foodCount()}`);
check('Créer quand même : popup fermée et formulaire refermé', !$('.modal') && !$('[data-f="name"]'));
const foodsNow = JSON.parse(localStorage.getItem('nutriplan.state.v1')).foods;
check('aucun aliment fusionné ni supprimé',
  foodsNow.filter((f) => f.name === 'Blanc de poulet').length === 2, `${foodsNow.length} aliments`);

// 5. plusieurs similaires → tous listés
click($('[data-new]'));
setField('name', 'Blanc de poulet');
setField('kcal', '110');
click($('[data-save]'));
await wait();
const listed = ($('.modal').textContent.match(/Blanc de poulet/g) || []).length;
check('plusieurs similaires listés dans la popup', listed >= 3, `${listed} mentions`);
click($('[data-similar-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Fiche aliment : rendement et conservation');
click($('[data-view="foods"]'));
await wait();
click($$('[data-edit]')[0]);
await wait();
check('champ nommé « Rendement après cuisson »', /Rendement après cuisson/.test($('#view').textContent));
check('aide à la formule affichée', /poids cuit ÷ poids cru/.test($('#view').textContent));
check('champ de conservation présent', !!$('[data-f="shelfLifeDays"]'));
check('champ « État des valeurs nutritionnelles »', /État des valeurs nutritionnelles/.test($('#view').textContent));
check('option « Cru / brut » proposée',
  [...$('[data-f="referenceState"]').options].some((o) => o.textContent === 'Cru / brut'));
check('case « Nécessite une cuisson » présente', !!$('[data-f="requiresCooking"]'));
check('indépendance vis-à-vis de l’état de référence expliquée',
  /Indépendant de l.état de référence/.test($('#view').textContent));
$('[data-f="shelfLifeDays"]').value = '3';
click($('[data-yield-open]'));
await wait();
check('modale de calcul ouverte', !!$('[data-yield-run]'));
$('[data-yield-raw]').value = '500';
$('[data-yield-cooked]').value = '375';
click($('[data-yield-run]'));
await wait();
check('rendement calculé affiché', /Rendement calculé : 0,75/.test($('#view').textContent));
check('équivalence affichée', /100 g cru → 75 g cuit/.test($('#view').textContent));
click($('[data-yield-apply]'));
await wait();
check('rendement reporté dans la fiche', $('[data-f="cookedFactor"]').value === '0.75', $('[data-f="cookedFactor"]').value);
check('la saisie en cours est conservée', $('[data-f="shelfLifeDays"]').value === '3');
const editedName = $('[data-f="name"]').value;
click($('[data-save]'));
await wait();
const savedFood = JSON.parse(localStorage.getItem('nutriplan.state.v1')).foods.find((f) => f.name === editedName);
check('rendement enregistré', savedFood.cookedFactor === 0.75, `${savedFood.cookedFactor}`);
check('« nécessite une cuisson » enregistré', typeof savedFood.requiresCooking === 'boolean');
check('conservation enregistrée', savedFood.shelfLifeDays === 3, `${savedFood.shelfLifeDays}`);

// erreurs de saisie dans la modale
click($$('[data-edit]')[0]);
await wait();
click($('[data-yield-open]'));
await wait();
$('[data-yield-raw]').value = '0';
$('[data-yield-cooked]').value = '375';
click($('[data-yield-run]'));
await wait();
check('poids cru nul : erreur affichée, aucun résultat',
  /nul/i.test($('#view').textContent) && !/Rendement calculé/.test($('#view').textContent));
click($('[data-yield-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Catalogues, couverture et courses');
click($('[data-view="breakfasts"]'));
await wait();
check('couverture affichée pour les deux personnes', /Couverture du cycle/.test($('#view').textContent));
check('besoin théorique = durée du cycle', /0 \/ 4/.test($('#view').textContent), $('#view').textContent.slice(0, 120));
check('avertissement de manque affiché', /⚠️/.test($('#view').textContent));
check('bouton de forçage proposé', !!$('[data-force]'));

click($('[data-new]'));
await wait();
type($('#drawer [data-search]'), 'flocons');
click($$('#drawer [data-add]')[0]);
click($('#drawer [data-close]'));
await wait();
click($('[data-view="shopping"]'));
await wait();
check('option non utilisée : absente des courses', !/flocons/i.test($('#view').textContent));

click($('[data-view="breakfasts"]'));
await wait();
const plusFor = (person) =>
  $$(`[data-uses][data-person="${person}"][data-delta="1"]`)[0];
click(plusFor('thomas'));
click(plusFor('thomas'));
click(plusFor('julie'));
await wait();
const bState = () => JSON.parse(localStorage.getItem('nutriplan.state.v1')).breakfasts[0];
check('compteurs indépendants Thomas / Julie', bState().uses.thomas === 2 && bState().uses.julie === 1,
  JSON.stringify(bState().uses));
check('couverture mise à jour', /2 \/ 4/.test($('#view').textContent));
click($('[data-force]'));
await wait();
check('écart assumé mémorisé', JSON.parse(localStorage.getItem('nutriplan.state.v1')).coverage.forced.breakfast === true);
check('avertissement toujours visible après forçage', /⚠️/.test($('#view').textContent));

click($('[data-view="shopping"]'));
await wait();
check('option utilisée : présente dans les courses', /flocons/i.test($('#view').textContent));

console.log('\n— Collations : catalogue unique 16 h / soir');
click($('[data-view="snacks"]'));
await wait();
check('un seul catalogue de collations', !/Collations 16 h.*Collations du soir/s.test($('#view').textContent.slice(0, 200)) && /Couverture du cycle/.test($('#view').textContent));
check('libellés 16 h et Soir', /16 h/.test($('#view').textContent) && /Soir/.test($('#view').textContent));
click($('[data-new]'));
await wait();
type($('#drawer [data-search]'), 'cajou');
click($$('#drawer [data-add]')[0]);
click($('#drawer [data-close]'));
await wait();
const snackPlus = (person, slot) =>
  $$(`[data-uses][data-person="${person}"][data-slot="${slot}"][data-delta="1"]`)[0];
click(snackPlus('thomas', 'afternoon'));
click(snackPlus('thomas', 'afternoon'));
click(snackPlus('thomas', 'evening'));
click(snackPlus('julie', 'evening'));
await wait();
const sState = () => JSON.parse(localStorage.getItem('nutriplan.state.v1')).snacks[0];
check('affectations 16 h / soir enregistrées séparément',
  sState().uses.thomas.afternoon === 2 && sState().uses.thomas.evening === 1 && sState().uses.julie.evening === 1,
  JSON.stringify(sState().uses));
click($('[data-view="shopping"]'));
await wait();
check('collation utilisée : présente dans les courses', /cajou/i.test($('#view').textContent));

console.log('\n— Volume par section (étape 3 : indépendant du reste du repas)');
click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[1]); // un créneau encore vide, distinct de celui déjà composé
await wait();
// section cible par défaut = "Plat" : de grosses quantités de pâtes crues (cookedFactor 2.4)
// suffisent, une fois cuites, à dépasser le seuil "extrêmement volumineux" (> 900 g) à elles seules.
add('pâtes com', 'Pâtes complètes');
await wait();
const pastaRow2 = () => $$('#drawer .item').find((el) => /Pâtes complètes/.test(el.textContent));
change(pastaRow2().querySelectorAll('[data-qty]')[0], '400');
change(pastaRow2().querySelectorAll('[data-qty]')[1], '400');
await wait();
// verrouillées (pas seulement épinglées pour cette passe) : la masse voulue ne
// doit pas bouger quand un autre ingrédient est ajouté ensuite.
click(pastaRow2().querySelectorAll('[data-lock]')[0]);
click(pastaRow2().querySelectorAll('[data-lock]')[1]);
await wait();
// on bascule la section cible sur "Entrée" avant d'ajouter un aliment léger
click($$('#drawer [data-target-section]').find((c) => c.textContent.trim() === 'Entrée'));
add('haricots', 'Haricots verts');
await wait();
const haricotsRow = () => $$('#drawer .item').find((el) => /Haricots verts/.test(el.textContent));
change(haricotsRow().querySelectorAll('[data-qty]')[0], '80');
change(haricotsRow().querySelectorAll('[data-qty]')[1], '80');
await wait();
click(haricotsRow().querySelectorAll('[data-lock]')[0]);
click(haricotsRow().querySelectorAll('[data-lock]')[1]);
await wait();
check('les 400 g de pâtes n’ont pas été réoptimisés après l’ajout des haricots (verrou)',
  pastaRow2().querySelectorAll('[data-qty]')[0].value === '400');
const summary = $('#drawer .drawer__body').textContent;
check('le PLAT est signalé volumineux', /Plat — .*volumineux/.test(summary), summary.match(/Plat — [^—]*/)?.[0]);
check('l’ENTRÉE n’est PAS signalée (masse trop faible)', !/Entrée — .*volumineux/.test(summary));
check('deux groupes de section affichés, dans l’ordre fixe (Entrée avant Plat)',
  $$('#drawer .section-group h4').map((h) => h.textContent).join(',') === 'Entrée,Plat');
// déplacer l'item d'entrée vers "Plat" : un seul champ modifié (item.section)
const entreeRow = $$('#drawer .item').find((el) => /Haricots verts/.test(el.textContent));
change(entreeRow.querySelector('[data-section-of]'), 'plat');
await wait();
check('un item déplacé de section change immédiatement de groupe',
  $$('#drawer .section-group h4').map((h) => h.textContent).join(',') === 'Plat');
click($('#drawer [data-close]'));
await wait();

console.log('\n— Recettes & préparations (étape 7 : mode normal, Σ affecté ≤ disponible)');
// aucun écran de création de recette n'existe encore dans l'UI (limite connue,
// signalée) : on seed directement la recette via store.js, comme le ferait un
// futur écran « Recettes ».
const beef = store.getState().foods.find((f) => /Steak haché/.test(f.name));
const beans = store.getState().foods.find((f) => /Haricots rouges/.test(f.name));
store.update((s) => {
  const recipe = store.newRecipe('Chili con carne', 'weight');
  recipe.items = [store.newRecipeItem(beef.id, 600, 'cru'), store.newRecipeItem(beans.id, 400, 'egoutte')];
  recipe.baseGrams = 1000;
  s.recipes.push(recipe);
});
await wait();

click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[2]); // encore un créneau vide, distinct des deux précédents
await wait();
check('le panneau "Recettes & préparations" liste la recette créée',
  /Chili con carne/.test($('#drawer .drawer__body').textContent));
click($('#drawer [data-add-recipe]'));
await wait();
check('un item "recette" (référence molle, sans préparation) est ajouté',
  /recette/.test($$('#drawer .item').find((el) => /Chili con carne/.test(el.textContent))?.textContent || ''));
check('libellé "pas encore préparée"', /pas encore préparée/.test($('#drawer .drawer__body').textContent));

// matérialisation : création d'une préparation de 1000 g
const qtyInput = $('#drawer [data-new-prep-qty]');
type(qtyInput, '1000');
click($('#drawer [data-new-prep]'));
await wait();
check('toast de confirmation de création', /Préparation.*créée/.test(document.getElementById('toasts')?.textContent || ''));
check('la préparation apparaît avec son disponible (1000 g / 1000 g)',
  /Disponible : 1000 g \/ 1000 g préparés/.test($('#drawer .drawer__body').textContent));

// utilisation dans CE repas
click($('#drawer [data-use-preparation]'));
await wait();
const usedRow = $$('#drawer .item').find((el) => /préparation/.test(el.textContent) && /Chili con carne/.test(el.textContent));
check('un item "préparation" (utilisation ferme) est ajouté', !!usedRow);
// le disponible est un stock PARTAGÉ entre Thomas ET Julie (§7) : les deux
// quantités de ce même item y contribuent, pas seulement celle de Thomas.
const usedQtyThomas = Number(usedRow.querySelectorAll('[data-qty]')[0].value);
const usedQtyJulie = Number(usedRow.querySelectorAll('[data-qty]')[1].value);
const usedQty = usedQtyThomas + usedQtyJulie;
check('quantité initiale non nulle', usedQty > 0);
check('le disponible affiché a diminué en conséquence dans le panneau',
  new RegExp(`Disponible : ${1000 - usedQty} g / 1000 g préparés`).test($('#drawer .drawer__body').textContent),
  `thomas=${usedQtyThomas} julie=${usedQtyJulie}`);

click($('#drawer [data-close]'));
await wait();

// le disponible réduit est bien PARTAGÉ : visible depuis un AUTRE repas
click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[3]);
await wait();
check('le disponible reflète l’utilisation faite dans l’AUTRE repas (stock partagé entre repas)',
  new RegExp(`Disponible : ${1000 - usedQty} g / 1000 g préparés`).test($('#drawer .drawer__body').textContent));
click($('#drawer [data-close]'));
await wait();

console.log('\n— Mode zéro reste (étape 8 : Σ affecté = preparedQuantity, jamais approximatif)');
// une préparation DÉDIÉE, distincte de celle du bloc précédent (qui a déjà
// un item en mode normal) : évite de mélanger les deux régimes dans ce test.
const riz = store.getState().foods.find((f) => /Riz basmati/i.test(f.name));
store.update((s) => {
  const recipe = store.newRecipe('Riz simple', 'weight');
  recipe.items = [store.newRecipeItem(riz.id, 500, 'cru')];
  recipe.baseGrams = 500;
  s.recipes.push(recipe);
  s.preparations.push(store.newPreparation(recipe, 1000, 'Riz simple #1'));
});
await wait();

click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[4]);
await wait();
const rizPrepUseBtn = () => $$('#drawer [data-use-preparation]').find((b) =>
  b.closest('.item').textContent.includes('Riz simple'));
click(rizPrepUseBtn());
await wait();
const rizRow1 = () => $$('#drawer .item').find((el) => /Riz simple/.test(el.textContent) && /préparation/.test(el.textContent));
click(rizRow1().querySelector('[data-zero-waste]'));
await wait();
check('la case "mode zéro reste" est cochée sur ce créneau', rizRow1().querySelector('[data-zero-waste]').checked);
click($('#drawer [data-close]'));
await wait();

click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[5]);
await wait();
click($$('#drawer [data-use-preparation]').find((b) => b.closest('.item').textContent.includes('Riz simple')));
await wait();
const rizRow2 = () => $$('#drawer .item').find((el) => /Riz simple/.test(el.textContent) && /préparation/.test(el.textContent));
click(rizRow2().querySelector('[data-zero-waste]'));
await wait();

const zeroWasteBtn = () => $$('#drawer [data-zero-waste-apply]').find((b) =>
  b.closest('.item').textContent.includes('Riz simple'));
check('le bouton "Répartir en zéro reste" est actif (2 créneaux marqués)', !zeroWasteBtn().disabled);
click(zeroWasteBtn());
await wait();
check('toast confirmant la répartition, avec le total affecté',
  /Zéro reste appliqué : 1000 g \/ 1000 g affectés/.test(document.getElementById('toasts')?.textContent || ''),
  document.getElementById('toasts')?.textContent || '');

// vérification indépendante, directement sur l'état : Σ EXACTEMENT 1000 g
const finalState = store.getState();
const rizPrep = finalState.preparations.find((p) => p.label === 'Riz simple #1');
let sumAllocated = 0;
for (const meal of finalState.meals) {
  for (const it of meal.items) {
    if (it.preparationId === rizPrep.id && it.zeroWaste) sumAllocated += it.qty.thomas + it.qty.julie;
  }
}
check('Σ affecté (les deux créneaux, les deux personnes) = preparedQuantity EXACTEMENT',
  sumAllocated === 1000, `${sumAllocated} g`);

click($('#drawer [data-close]'));
await wait();

console.log('\n— Fin de saisie');
check('aucune modale ouverte et aucun champ actif → synchronisation autorisée',
  app.isEditing() === false, String(app.isEditing()));
const anyInput = $('#view input');
if (anyInput) {
  anyInput.focus();
  check('champ de la vue actif → saisie en cours', app.isEditing() === true);
  anyInput.blur();
  check('champ quitté → synchronisation de nouveau autorisée', app.isEditing() === false);
}

console.log('\n— Navigation complète');
for (const id of ['foods', 'recipes', 'breakfasts', 'snacks', 'batch', 'shopping', 'settings']) {
  click($(`[data-view="${id}"]`));
  await wait();
  check(`vue ${id} rendue`, $('#view').textContent.length > 50, `${$('#title').textContent}`);
}

console.log('\n— Écran Recettes (création via l’UI, pas seulement via store.js)');
click($('[data-view="recipes"]'));
await wait();
click($('[data-new]'));
await wait();
change($('[data-r="name"]'), 'Riz aux légumes');
change($('[data-r="kind"]'), 'weight');
change($('[data-r="baseGrams"]'), '800');
await wait();
type($('[data-ing-search]'), 'riz basmati');
click($$('[data-ing-add]').find((b) => /Riz basmati/i.test(b.textContent)));
await wait();
check('l’ingrédient ajouté apparaît dans la composition', /Riz basmati/.test($('.drawer__body').textContent));
change($('[data-ing-qty="0"]'), '600');
await wait();

// refus d'un ingrédient non fractionnable dans une recette weight (décision verrouillée)
type($('[data-ing-search]'), 'wrap');
const wrapBtn = $$('[data-ing-add]').find((b) => /Wrap/i.test(b.textContent));
click(wrapBtn);
await wait();
check('un aliment non fractionnable est refusé dans une recette weight, avec message explicite',
  /non fractionnable/.test(document.getElementById('toasts')?.textContent || ''));
check('il n’a PAS été ajouté à la composition malgré le clic',
  !/Wrap/.test($$('.drawer__body .items')[0]?.textContent || ''));

click($('[data-save]'));
await wait();
check('toast de confirmation', /Recette enregistrée/.test(document.getElementById('toasts')?.textContent || ''));
check('la recette apparaît dans la liste', /Riz aux légumes/.test($('#view').textContent));
check('type et référence affichés', /Au poids/.test($('#view').textContent) && /800 g/.test($('#view').textContent));

console.log('\n— Courses et batch');
click($('[data-view="shopping"]'));
const line = $$('.list-row').map((l) => l.textContent.replace(/\s+/g, ' ').trim()).find((t) => /poulet/i.test(t));
console.log(`        ${line}`);
check('ligne de courses avec besoin et conditionnement', /Besoin/.test(line || ''));
const cb = $$('[data-buy]')[0];
cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true }));
check('case "acheté" enregistrée', $$('[data-buy]')[0].checked === true);

// aliments sans prix : nommés et cliquables (on vide le prix via la fiche)
click($('[data-view="foods"]'));
await wait();
type($('[data-q]'), 'haricots verts');
click($$('[data-edit]')[0]);
await wait();
const sansPrixNom = $('[data-f="name"]').value;
$('[data-f="price"]').value = '';
$('[data-f="packageWeight"]').value = '';
click($('[data-save]'));
await wait();
click($('[data-view="shopping"]'));
await wait();
check('aliment sans prix nommé dans l’avertissement',
  /Prix non renseigné/.test($('#view').textContent) && $('#view').textContent.includes(sansPrixNom), sansPrixNom);
const openBtn = $$('[data-open-food]').find((b) => b.textContent.includes(sansPrixNom));
check('lien vers la fiche disponible', !!openBtn);
click(openBtn);
await wait();
check('la fiche de l’aliment s’ouvre dans Aliments',
  $('#title').textContent === 'Banque alimentaire' && $('[data-f="name"]')?.value === sansPrixNom);
click($('[data-form-cancel]'));
await wait();

click($('[data-view="batch"]'));
const prep = $$('[data-prep]')[0];
check('composants de batch listés', !!prep);
change(prep, '1500');
check('quantité préparée modifiable', $$('[data-prep]')[0].value === '1500');
check('note de préparation du poulet affichée', /filets entiers/.test($('#view').textContent));
check('trois catégories affichées',
  /À préparer en batch/.test($('#view').textContent) &&
  /À cuire le jour même/.test($('#view').textContent) &&
  /À assembler le jour même/.test($('#view').textContent));
check('plan opératoire : méthode et température', /Four/.test($('#view').textContent) && /180 °C/.test($('#view').textContent));
check('détail des gamelles présent', /Détail des gamelles/.test($('#view').textContent));

console.log('\n— Impression');
click($('#print-btn'));
click($('#modal [data-print-all]'));
click($('#modal [data-print-go]'));
check('catalogues imprimés avec leurs utilisations', /Couverture du cycle/.test($('#print').textContent) && /Utilisations/.test($('#print').textContent));
check('document d’impression généré', $('#print').innerHTML.length > 1000);
check('état pesé indiqué à côté des quantités imprimées',
  /\d+ g (cru \/ brut|cuit|égoutté|prêt à consommer)/i.test($('#print').textContent),
  ($('#print').textContent.match(/\d+ g [a-zé\s\/]+/i) || [''])[0].trim());
check('window.print() appelé', printed === 1);

console.log('\n— Paramètres');
click($('[data-view="settings"]'));
await wait();
change($('[data-duration]'), '6');
await wait();
click($('[data-view="planning"]'));
check('cycle passé à 6 jours', $$('.day').length === 6);
click($('[data-view="settings"]'));
await wait();
check('mode local expliqué dans le compte', /Mode local uniquement/.test($('#view').textContent));

console.log('\n— Persistance locale');
const saved = JSON.parse(localStorage.getItem('nutriplan.state.v1'));
check('état écrit dans localStorage', !!saved && saved.foods.length > 50);
check('repas conservé avec son verrou',
  saved.meals[0].items.some((i) => i.locked.thomas === true && i.qty.thomas === 180));
check('ingrédient libre conservé', saved.meals[0].items.some((i) => i.free?.name === 'Curry'));

console.log('\n' + '='.repeat(60));
check('aucune erreur JavaScript', jsErrors.length === 0, jsErrors.join(' / '));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join('\n')); process.exitCode = 1; }
