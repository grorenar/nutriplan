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

console.log('\n— P3.6 : tag « non fractionnable » repris du picker de recettes dans le picker de repas');
type($('#drawer [data-search]'), 'pain croustillant');
const wasaPickerBtn = $$('#drawer [data-add]').find((b) => /Pain croustillant/i.test(b.textContent));
check('aliment non fractionnable marqué « non fractionnable » dans le picker du repas (réutilise isWholeUnitFood, comme recipes.js)',
  /non fractionnable/.test(wasaPickerBtn?.textContent || ''));
type($('#drawer [data-search]'), 'blanc de poulet');
const pouletPickerBtn = $$('#drawer [data-add]').find((b) => /Blanc de poulet/i.test(b.textContent));
check('aliment fractionnable : aucun tag « non fractionnable »', !/non fractionnable/.test(pouletPickerBtn?.textContent || ''));
type($('#drawer [data-search]'), '');

add('poulet', 'Blanc de poulet');
add('pâtes com', 'Pâtes complètes');
add('haricots', 'Haricots verts');
add('huile d', 'Huile d');
check('4 ingrédients', $$('#drawer .item').length === 4);

console.log('\n— Auto-nommage du repas depuis la composition (P2.4)');
check('nom généré automatiquement : Féculent - Protéine - Légume',
  $('#drawer [data-name]').value === 'Pâtes complètes - Blanc de poulet - Haricots verts',
  $('#drawer [data-name]').value);
check('nameAuto reste actif tant qu’aucun nom n’a été saisi à la main',
  store.getState().meals[0].nameAuto === true);

const macros = $$('#drawer .macro').slice(0, 4).map((m) => m.textContent.replace(/\s+/g, ' ').trim());
console.log(`        ${macros.join(' | ')}`);
check('macros affichées sans clic supplémentaire', macros.length === 4);
check('glucides affichés "G" et non "C"', macros.some((m) => / G$/.test(m)) && !macros.some((m) => / C$/.test(m)), macros.join(' | '));
// coloration par rôle (P1.1, décision verrouillée — evaluate()/statusFor()
// restent purement descriptifs, la fonction de coût n'est pas concernée) :
// 1015/1050 kcal (-3,3 %, plafond) → ok ; 54,7/55 P (-0,5 %, plancher : tout
// déficit, même minime, est au mieux "warn", jamais "ok") → warn ;
// 118,2/120 G (-1,5 %, souple ±5 %) → ok ; 30,8/35 L (-12 %, plafond :
// toujours "ok" sous la cible, quelle que soit la marge) → ok.
const macroBadges = $$('#drawer .macro').slice(0, 4);
check('kcal de Thomas dans la cible (plafond, léger déficit)', macroBadges[0].classList.contains('is-ok'), macroBadges[0].className);
check('protéines de Thomas signalées en léger déficit (plancher, jamais "ok" sous la cible)',
  macroBadges[1].classList.contains('is-warn'), macroBadges[1].className);
check('glucides de Thomas dans la cible (souple, ±5 %)', macroBadges[2].classList.contains('is-ok'), macroBadges[2].className);
check('lipides de Thomas dans la cible (plafond, sous la cible = toujours "ok")',
  macroBadges[3].classList.contains('is-ok'), macroBadges[3].className);

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

console.log('\n— Verrouillage automatique après modification manuelle (P1.2)');
const qty = () => $$('#drawer [data-qty]').map((i) => i.value);
const lockPressed = () => $$('#drawer [data-lock]').map((b) => b.getAttribute('aria-pressed'));
// ordre du DOM : [poulet-thomas, poulet-julie, pâtes-thomas, pâtes-julie, …]
change($$('#drawer [data-qty]')[0], '180'); // poulet, Thomas — AUCUN clic sur le cadenas
await wait();
check('la quantité modifiée manuellement est verrouillée immédiatement, sans clic sur le cadenas',
  lockPressed()[0] === 'true', lockPressed().join(','));
check('poulet à 180 g après la saisie manuelle', qty()[0] === '180', qty()[0]);
check('Thomas/Julie indépendants : la quantité de Julie pour ce même aliment n’est PAS verrouillée',
  lockPressed()[1] === 'false', lockPressed().join(','));

change($$('#drawer [data-qty]')[2], '150'); // pâtes, Thomas — également sans clic
await wait();
check('les pâtes sont à leur tour verrouillées par leur propre modification manuelle',
  lockPressed()[2] === 'true', lockPressed().join(','));
check('poulet (verrouillé) reste inchangé après la modification des pâtes', qty()[0] === '180');
check('aucun ingrédient supprimé', $$('#drawer .item').length === 4);

console.log('\n— Déverrouillage manuel puis nouvel ajustement (P1.2)');
click($$('#drawer [data-lock]')[0]); // déverrouille poulet-Thomas, désormais verrouillé automatiquement
await wait();
check('le clic sur le cadenas déverrouille bien un item verrouillé automatiquement',
  lockPressed()[0] === 'false', lockPressed().join(','));
click($('#drawer [data-adjust]'));
await wait();
check('« Ajuster maintenant » peut de nouveau modifier poulet une fois déverrouillé',
  qty()[0] !== '180', qty()[0]);
check('les pâtes (toujours verrouillées) restent, elles, inchangées', qty()[2] === '150', qty()[2]);

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
// P1.2 : le verrouillage automatique fonctionne aussi en saisie par unités
// entières (pas seulement en grammes), sans clic sur le cadenas.
check('la saisie en unités (portions/unités entières) verrouille aussi automatiquement',
  $$('#drawer .item').find((el) => /croustillant/i.test(el.textContent)).querySelector('[data-lock]').getAttribute('aria-pressed') === 'true');
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

console.log('\n— Auto-nommage : une saisie manuelle protège le nom pour toujours (P2.4)');
click($('#drawer [data-cat="all"]'));
change($('#drawer [data-name]'), 'Repas post-entraînement');
await wait();
check('nom manuel enregistré', $('#drawer [data-name]').value === 'Repas post-entraînement');
check('nameAuto désactivé dès la saisie manuelle', store.getState().meals[0].nameAuto === false);
add('carottes', 'Carottes');
await wait();
check('le nom saisi à la main survit à une modification ultérieure de la composition',
  $('#drawer [data-name]').value === 'Repas post-entraînement', $('#drawer [data-name]').value);
click($$('#drawer .item').find((el) => /Carottes/.test(el.textContent)).querySelector('[data-del]'));
await wait();

change($('#drawer [data-name]'), '');
await wait();
check('nameAuto reste désactivé après un nom volontairement vidé', store.getState().meals[0].nameAuto === false);
type($('#drawer [data-search]'), '');
add('carottes', 'Carottes');
await wait();
check('un nom volontairement vidé n’est jamais régénéré automatiquement',
  $('#drawer [data-name]').value === '', $('#drawer [data-name]').value);
click($$('#drawer .item').find((el) => /Carottes/.test(el.textContent)).querySelector('[data-del]'));
await wait();

click($('#drawer [data-close]'));
check('éditeur fermé', !$('#drawer .drawer__panel'));
check('macros visibles sur la carte du planning', $$('.meal-card .macro').length >= 8);

console.log('\n— Duplication : nom du jour affiché dans les destinations (P3.5)');
click($$('[data-dup]')[0]);
await wait();
const dupLabels = $$('[data-target]').map((cb) => cb.closest('label').textContent.replace(/\s+/g, ' ').trim());
check('le panneau de duplication propose au moins une destination', dupLabels.length > 0);
check('le nom du jour (Lundi/Mardi/…) accompagne désormais le numéro « jour X » (P3.5, réutilise dayName())',
  dupLabels.every((t) => /^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche) \(jour \d+\) — /.test(t)),
  dupLabels.join(' | '));
click($('[data-dup-cancel]'));
await wait();
check('panneau de duplication fermé sans duplication', !$('[data-dup-confirm]'));

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
// P3.3 : « Forcer quand même » supprimé (sans effet fonctionnel, cf. diagnostic P3) — l'avertissement seul suffit.
check('bouton de forçage retiré (fonctionnalité cosmétique supprimée, P3.3)', !$('[data-force]'));

click($('[data-new]'));
await wait();
type($('#drawer [data-search]'), 'flocons');
click($$('#drawer [data-add]')[0]);
await wait();
// P3.1 — petit-déjeuner : plus de sections Entrée/Plat/…, un seul intitulé fixe.
check('aucun sélecteur de section dans l’éditeur d’un petit-déjeuner (P3.1)',
  $$('#drawer [data-section-of]').length === 0);
check('intitulé unique « Petit-déjeuner » à la place des sections (P3.1)',
  $$('#drawer .section-group h4').map((h) => h.textContent).join(',') === 'Petit-déjeuner');
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
check('avertissement toujours visible (aucun mécanisme pour le masquer, P3.3)', /⚠️/.test($('#view').textContent));

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
await wait();
// P3.1 — collation : plus de sections Entrée/Plat/…, un seul intitulé fixe selon le créneau.
check('aucun sélecteur de section dans l’éditeur d’une collation (P3.1)',
  $$('#drawer [data-section-of]').length === 0);
check('intitulé « Collation 16 h » par défaut (targetSlot afternoon, P3.1)',
  $$('#drawer .section-group h4').map((h) => h.textContent).join(',') === 'Collation 16 h');

console.log('\n— Navigation 16 h / Soir directement dans l’éditeur (P3.2)');
const newSnackId = () => JSON.parse(localStorage.getItem('nutriplan.state.v1')).snacks.at(-1).id;
check('toggle 16 h actif par défaut', $$('#drawer [data-set-slot]')[0].getAttribute('aria-pressed') === 'true');
check('toggle Soir inactif par défaut', $$('#drawer [data-set-slot]')[1].getAttribute('aria-pressed') === 'false');
click($$('#drawer [data-set-slot]')[1]); // Soir
await wait();
check('éditeur resté ouvert après le changement de créneau', !!$('#drawer .drawer__panel'));
check('targetSlot passé à evening en state', newSnackId() && JSON.parse(localStorage.getItem('nutriplan.state.v1')).snacks.find((o) => o.id === newSnackId()).targetSlot === 'evening');
check('intitulé mis à jour : « Collation soir »',
  $$('#drawer .section-group h4').map((h) => h.textContent).join(',') === 'Collation soir');
check('toggle Soir désormais actif', $$('#drawer [data-set-slot]')[1].getAttribute('aria-pressed') === 'true');
check('toggle 16 h désormais inactif', $$('#drawer [data-set-slot]')[0].getAttribute('aria-pressed') === 'false');
check('même collation, aucun item dupliqué', $$('#drawer .item').length === 1);
click($$('#drawer [data-set-slot]')[0]); // retour 16 h
await wait();
check('retour 16 h → targetSlot afternoon', JSON.parse(localStorage.getItem('nutriplan.state.v1')).snacks.find((o) => o.id === newSnackId()).targetSlot === 'afternoon');
check('intitulé de nouveau « Collation 16 h »',
  $$('#drawer .section-group h4').map((h) => h.textContent).join(',') === 'Collation 16 h');

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
// verrouillées AUTOMATIQUEMENT par la saisie manuelle elle-même (P1.2,
// décision verrouillée) — plus besoin de cliquer sur le cadenas : la masse
// voulue ne doit pas bouger quand un autre ingrédient est ajouté ensuite.
check('la saisie manuelle a déjà verrouillé les pâtes (Thomas et Julie), sans clic sur le cadenas',
  pastaRow2().querySelectorAll('[data-lock]')[0].getAttribute('aria-pressed') === 'true' &&
  pastaRow2().querySelectorAll('[data-lock]')[1].getAttribute('aria-pressed') === 'true');
// on bascule la section cible sur "Entrée" avant d'ajouter un aliment léger
click($$('#drawer [data-target-section]').find((c) => c.textContent.trim() === 'Entrée'));
add('haricots', 'Haricots verts');
await wait();
const haricotsRow = () => $$('#drawer .item').find((el) => /Haricots verts/.test(el.textContent));
change(haricotsRow().querySelectorAll('[data-qty]')[0], '80');
change(haricotsRow().querySelectorAll('[data-qty]')[1], '80');
await wait();
check('les haricots sont eux aussi verrouillés automatiquement par leur propre saisie',
  haricotsRow().querySelectorAll('[data-lock]')[0].getAttribute('aria-pressed') === 'true' &&
  haricotsRow().querySelectorAll('[data-lock]')[1].getAttribute('aria-pressed') === 'true');
check('les 400 g de pâtes n’ont pas été réoptimisés après l’ajout des haricots (verrou automatique)',
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

console.log('\n— Écran Recettes : recette « portion », ingrédient non fractionnable en unité naturelle');
click($('[data-new]'));
await wait();
change($('[data-r="name"]'), 'Toast poulet St Môret');
change($('[data-r="kind"]'), 'portion');
await wait();

// Wasa (non fractionnable, 11 g/tranche) : autorisé dans une recette portion
type($('[data-ing-search]'), 'pain croustillant');
click($$('[data-ing-add]').find((b) => /Pain croustillant de seigle/i.test(b.textContent)));
await wait();
check('Wasa (non fractionnable) accepté dans une recette portion', /Pain croustillant/.test($('.drawer__body').textContent));

// bascule "grammes / tranche(s)" — réutilise EXACTEMENT le toggle de l'éditeur de repas (food.unitEntry)
let wasaToggle = $('[data-ing-unit-toggle="0"]');
check('bouton de bascule grammes/unité proposé (aliment non fractionnable)', !!wasaToggle);
if (!/tranche/i.test(wasaToggle.textContent)) { click(wasaToggle); await wait(); wasaToggle = $('[data-ing-unit-toggle="0"]'); }
check('bascule "Saisie : tranche" activée', /tranche/i.test(wasaToggle.textContent), wasaToggle.textContent);
check('unité affichée à côté du champ de saisie', /tranche/i.test($('[data-ing-qty="0"]').closest('.qty-box').textContent));

// saisie naturelle : "3" (tranches), jamais un calcul manuel en grammes
change($('[data-ing-qty="0"]'), '3');
await wait();
check('saisie "3" (unité naturelle) acceptée', $('[data-ing-qty="0"]').value === '3');

// impossibilité de saisir une fraction d'unité (§ demande) : 2,4 tranche(s) -> snappé à 2
change($('[data-ing-qty="0"]'), '2.4');
await wait();
check('2,4 tranche(s) saisies → arrondi à un nombre ENTIER de tranches (jamais de fraction d’unité)',
  $('[data-ing-qty="0"]').value === '2', $('[data-ing-qty="0"]').value);

// impossibilité de saisir arbitrairement 37 g de Wasa : bascule en grammes, 37 -> snappé au multiple de 11 g le plus proche (33 g = 3 tranches)
click($('[data-ing-unit-toggle="0"]'));
await wait();
change($('[data-ing-qty="0"]'), '37');
await wait();
check('37 g saisis pour un aliment non fractionnable (11 g/tranche) → arrondi au multiple de 11 g le plus proche (jamais 37 g)',
  $('[data-ing-qty="0"]').value === '33', $('[data-ing-qty="0"]').value);
// on repasse en unités et on refixe proprement à 3 tranches (33 g), pour la suite du scénario
click($('[data-ing-unit-toggle="0"]'));
await wait();
check('de retour en mode unité, 33 g s’affichent bien comme 3 tranches', $('[data-ing-qty="0"]').value === '3', $('[data-ing-qty="0"]').value);

// aliments fractionnables : St Môret (30 g) et poulet (80 g), saisie grammes normale, inchangée
type($('[data-ing-search]'), 'fromage frais tartinable');
click($$('[data-ing-add]').find((b) => /Fromage frais tartinable/i.test(b.textContent)));
await wait();
change($('[data-ing-qty="1"]'), '30');
type($('[data-ing-search]'), 'blanc de poulet');
click($$('[data-ing-add]').find((b) => /Blanc de poulet/i.test(b.textContent)));
await wait();
change($('[data-ing-qty="2"]'), '80');
await wait();
check('3 ingrédients dans la composition (3 tranches Wasa, 30 g St Môret, 80 g poulet)', $$('.drawer__body .items .item').length === 3);

// garde-fou : bascule portion -> weight refusée tant qu'un ingrédient non fractionnable est présent
change($('[data-r="kind"]'), 'weight');
await wait();
check('bascule "portion -> weight" refusée avec message explicite (Wasa non fractionnable présent)',
  /non fractionnable/.test(document.getElementById('toasts')?.textContent || ''));
check('le type reste "portion" après le refus', $('[data-r="kind"]').value === 'portion');

click($('[data-save]'));
await wait();
check('recette portion enregistrée', /Recette enregistrée/.test(document.getElementById('toasts')?.textContent || ''));
const savedPortionRecipe = store.getState().recipes.find((r) => r.name === 'Toast poulet St Môret');
check('grammes réellement stockés : 33 g Wasa (3 × 11 g), 30 g St Môret, 80 g poulet — issus de la saisie naturelle, sans calcul manuel',
  savedPortionRecipe?.items.map((it) => it.qty).join(',') === '33,30,80',
  savedPortionRecipe?.items.map((it) => it.qty).join(','));

console.log('\n— Éditeur de repas : recette « portion » utilisée en NOMBRE DE PORTIONS (jamais en grammes)');
click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[6]); // créneau encore vide
await wait();
// ajustement auto désactivé le temps de ce scénario : on vérifie la quantité
// TELLE QUE SAISIE/AJOUTÉE, sans interférence de l'optimiseur (qui pourrait
// légitimement proposer un autre nombre entier de portions selon la cible).
const autoBox = $('#drawer [data-auto]');
if (autoBox.checked) { autoBox.checked = false; autoBox.dispatchEvent(new window.Event('change', { bubbles: true })); }
await wait();
const addPortionRecipeBtn = () => $$('#drawer [data-add-recipe]').find((b) =>
  b.closest('.item').textContent.includes('Toast poulet St Môret'));
check('la recette portion apparaît dans le panneau "Recettes & préparations"', !!addPortionRecipeBtn());
click(addPortionRecipeBtn());
await wait();
const portionRow = () => $$('#drawer .item').find((el) => /Toast poulet St Môret/.test(el.textContent) && /recette/.test(el.textContent));
const portionQtyInput = () => portionRow().querySelectorAll('[data-qty]')[0];
check('quantité initiale = 1 portion (jamais 143 g)', portionQtyInput().value === '1', portionQtyInput().value);
check('unité affichée = "portion", jamais "g"', /portion/.test(portionRow().querySelector('.item__unit').textContent));
check('pas de saisie = 1 (increment par portion entière)', portionQtyInput().step === '1', portionQtyInput().step);
check('P2.4 — un repas composé uniquement d’une recette n’a aucun nom auto-généré (pas de catégorie alimentaire réelle)',
  $('#drawer [data-name]').value === '', $('#drawer [data-name]').value);

console.log('\n— Composition déployée pour N portions (dérivée, sans duplication de state)');
change(portionQtyInput(), '2');
await wait();
check('2 portions acceptées', portionQtyInput().value === '2');
// P1.2 : le verrouillage automatique fonctionne aussi sur un item RECETTE
// (pas seulement un aliment classique), via le même handler data-qty.
check('un item recette verrouille aussi automatiquement sa quantité par simple saisie',
  portionRow().querySelectorAll('[data-lock]')[0].getAttribute('aria-pressed') === 'true');
const compositionText = portionRow().textContent.replace(/\s+/g, ' ');
check('composition déployée pour 2 portions : 6 tranches (aliment non fractionnable, unité naturelle)',
  /6 tranche/.test(compositionText), compositionText);
check('composition déployée pour 2 portions : 60 g St Môret (aliment fractionnable, grammes)',
  /60 g Fromage frais tartinable/.test(compositionText), compositionText);
check('composition déployée pour 2 portions : 160 g poulet', /160 g Blanc de poulet/.test(compositionText), compositionText);

console.log('\n— Édition manuelle d’une quantité de recette-portion : jamais de portion fractionnaire');
change(portionQtyInput(), '2.5');
await wait();
check('2,5 portions saisies manuellement → arrondi à un nombre ENTIER de portions (correction du bug de saisie manuelle non snappée)',
  portionQtyInput().value === '3', portionQtyInput().value);
check('à 3 portions, l’unité affichée reste "portion" — jamais "3 g"',
  /portion/.test(portionRow().querySelector('.item__unit').textContent) && !/^g$/.test(portionRow().querySelector('.item__unit').textContent.trim()));
const savedItemGrams = store.getState().meals.flatMap((m) => m.items).find((it) =>
  store.getState().recipes.find((r) => r.id === it.recipeId)?.name === 'Toast poulet St Môret')?.qty.thomas;
check('grammes réellement stockés = 3 × 143 g = 429 g (multiple exact du poids d’une portion)',
  savedItemGrams === 429, `${savedItemGrams} g`);
check('composition déployée pour 3 portions : 9 tranches Wasa', /9 tranche/.test(portionRow().textContent), portionRow().textContent.replace(/\s+/g, ' '));

// on restaure le réglage global pour la suite de la suite
const autoBoxEnd = $('#drawer [data-auto]');
if (autoBoxEnd && !autoBoxEnd.checked) { autoBoxEnd.checked = true; autoBoxEnd.dispatchEvent(new window.Event('change', { bubbles: true })); }
await wait();

click($('#drawer [data-close]'));
await wait();

console.log('\n— Écran Recettes : poids de référence (baseGrams) calculé automatiquement depuis la composition');
click($('[data-view="recipes"]'));
await wait();
click($('[data-new]'));
await wait();
change($('[data-r="name"]'), 'Skyr avoine');
change($('[data-r="kind"]'), 'weight');
await wait();
type($('[data-ing-search]'), 'skyr nature');
click($$('[data-ing-add]').find((b) => /Skyr nature/i.test(b.textContent)));
await wait();
change($('[data-ing-qty="0"]'), '150');
await wait();
type($('[data-ing-search]'), 'flocons d');
click($$('[data-ing-add]').find((b) => /Flocons/i.test(b.textContent)));
await wait();
change($('[data-ing-qty="1"]'), '50');
await wait();
check('baseGrams calculé automatiquement (150 + 50 = 200 g), sans saisie manuelle',
  $('[data-r="baseGrams"]').value === '200', $('[data-r="baseGrams"]').value);

// personnalisation manuelle (ex. perte à la cuisson) : plus jamais écrasée automatiquement ensuite
change($('[data-r="baseGrams"]'), '180');
await wait();
change($('[data-ing-qty="0"]'), '160');
await wait();
check('baseGrams personnalisé (180 g) conservé après modification d’un ingrédient — jamais réécrasé automatiquement',
  $('[data-r="baseGrams"]').value === '180', $('[data-r="baseGrams"]').value);
// on repropre le scénario pour la suite : composition 150 + 50 = 200, baseGrams = 200
change($('[data-ing-qty="0"]'), '150');
await wait();
change($('[data-r="baseGrams"]'), '200');
await wait();

click($('[data-save]'));
await wait();
check('recette weight "Skyr avoine" enregistrée', /Recette enregistrée/.test(document.getElementById('toasts')?.textContent || ''));
const skyrRecipeSaved = store.getState().recipes.find((r) => r.name === 'Skyr avoine');
check('composition de référence stockée : 150 g Skyr + 50 g flocons',
  skyrRecipeSaved?.items.map((it) => it.qty).join(',') === '150,50', skyrRecipeSaved?.items.map((it) => it.qty).join(','));
check('baseGrams = 200 g', skyrRecipeSaved?.baseGrams === 200, skyrRecipeSaved?.baseGrams);

console.log('\n— Éditeur de repas : recette « weight » déployée proportionnellement (composition dérivée, jamais stockée)');
click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[7]); // dernier créneau encore vide
await wait();
const autoBoxW = $('#drawer [data-auto]');
if (autoBoxW.checked) { autoBoxW.checked = false; autoBoxW.dispatchEvent(new window.Event('change', { bubbles: true })); }
await wait();
const addSkyrBtn = () => $$('#drawer [data-add-recipe]').find((b) => b.closest('.item').textContent.includes('Skyr avoine'));
check('la recette "Skyr avoine" apparaît dans le panneau "Recettes & préparations"', !!addSkyrBtn());
click(addSkyrBtn());
await wait();
const skyrRow = () => $$('#drawer .item').find((el) => /Skyr avoine/.test(el.textContent) && /recette/.test(el.textContent));
const skyrQtyInputs = () => skyrRow().querySelectorAll('[data-qty]');
check('quantité initiale = poids de référence (200 g), affichée en grammes (jamais "portion")',
  skyrQtyInputs()[0].value === '200' && skyrRow().querySelectorAll('.item__unit')[0].textContent.trim() === 'g',
  `${skyrQtyInputs()[0].value} ${skyrRow().querySelectorAll('.item__unit')[0].textContent.trim()}`);

change(skyrQtyInputs()[0], '428');
await wait();
let skyrText = skyrRow().textContent.replace(/\s+/g, ' ');
check('428 g demandés (Thomas) — composition déployée : 321 g Skyr (428 × 150 / 200)', /321 g Skyr/.test(skyrText), skyrText);
check('428 g demandés (Thomas) — composition déployée : 107 g flocons (428 × 50 / 200)', /107 g Flocons/.test(skyrText), skyrText);

change(skyrQtyInputs()[1], '214');
await wait();
skyrText = skyrRow().textContent.replace(/\s+/g, ' ');
check('214 g demandés (Julie) — composition déployée : 160,5 g Skyr (214 × 150 / 200)', /160,5 g Skyr/.test(skyrText), skyrText);
check('214 g demandés (Julie) — composition déployée : 53,5 g flocons (214 × 50 / 200)', /53,5 g Flocons/.test(skyrText), skyrText);

change(skyrQtyInputs()[0], '100');
await wait();
skyrText = skyrRow().textContent.replace(/\s+/g, ' ');
check('conservation des proportions à une autre échelle (100 g, Thomas) : 75 g Skyr + 25 g flocons',
  /75 g Skyr/.test(skyrText) && /25 g Flocons/.test(skyrText), skyrText);

const skyrMeal = store.getState().meals.find((m) => m.items.some((it) =>
  store.getState().recipes.find((r) => r.id === it.recipeId)?.name === 'Skyr avoine'));
check('aucun nouvel item stocké dans le repas : la composition déployée est dérivée, jamais persistée',
  skyrMeal.items.length === 1, skyrMeal.items.length);
check('la quantité totale réellement stockée = 100 g (celle saisie, pas une somme déployée)',
  skyrMeal.items[0].qty.thomas === 100, skyrMeal.items[0].qty.thomas);

const autoBoxWEnd = $('#drawer [data-auto]');
if (autoBoxWEnd && !autoBoxWEnd.checked) { autoBoxWEnd.checked = true; autoBoxWEnd.dispatchEvent(new window.Event('change', { bubbles: true })); }
await wait();
click($('#drawer [data-close]'));
await wait();

console.log('\n— Courses et batch');
click($('[data-view="shopping"]'));
const line = $$('.list-row').map((l) => l.textContent.replace(/\s+/g, ' ').trim()).find((t) => /poulet/i.test(t));
console.log(`        ${line}`);
check('ligne de courses avec besoin et conditionnement', /Besoin/.test(line || ''));
const cb = $$('[data-buy]')[0];
const checkedFoodName = store.getState().foods.find((f) => f.id === cb.dataset.buy)?.name || '';
const uncheckedBuy = $$('[data-buy]')[1];
const uncheckedFoodName = store.getState().foods.find((f) => f.id === uncheckedBuy?.dataset.buy)?.name || '';
cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true }));
check('case "acheté" enregistrée', $$('[data-buy]')[0].checked === true);
check('état coché persisté en localStorage (P3.4.b)',
  JSON.parse(localStorage.getItem('nutriplan.state.v1')).shopping.purchased[cb.dataset.buy] === true);

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

console.log('\n— P3.4.b : état coché de la liste de courses reporté à l’impression');
const printedRow = (name) => $$('#print tr').find((tr) => tr.textContent.includes(name));
const checkedPrintedRow = printedRow(checkedFoodName);
check(`« ${checkedFoodName} » (coché à l’écran) imprimé avec sa case cochée`,
  !!checkedPrintedRow?.querySelector('.check.is-checked'), checkedPrintedRow?.textContent.replace(/\s+/g, ' ').trim());
const uncheckedPrintedRow = printedRow(uncheckedFoodName);
check(`« ${uncheckedFoodName} » (non coché à l’écran) reste non coché à l’impression`,
  !!uncheckedPrintedRow && !uncheckedPrintedRow.querySelector('.check.is-checked'),
  uncheckedPrintedRow?.textContent.replace(/\s+/g, ' ').trim());

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
// pâtes (Thomas) : dernier item resté verrouillé (par sa propre saisie
// manuelle, P1.2) sur ce repas — le poulet, lui, a été déverrouillé puis
// réajusté explicitement plus haut (« Déverrouillage manuel »).
check('repas conservé avec son verrou (verrouillage automatique persistant)',
  saved.meals[0].items.some((i) => i.locked.thomas === true && i.qty.thomas === 5 && i.foodId === 'f_pates_completes'));
check('ingrédient libre conservé', saved.meals[0].items.some((i) => i.free?.name === 'Curry'));

console.log('\n' + '='.repeat(60));
check('aucune erreur JavaScript', jsErrors.length === 0, jsErrors.join(' / '));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join('\n')); process.exitCode = 1; }
