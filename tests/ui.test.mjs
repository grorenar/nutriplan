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
const derive = await import(join(root, 'js/core/derive.js')); // lecture seule, pour valider les quantités affichées sans reparser le texte rendu
const sync = await import(join(root, 'js/core/sync.js'));
const scannerLib = await import(join(root, 'js/core/barcode-scanner.js')); // même instance que celle utilisée par foods.js
// js/config.js contient volontairement les vraies clés Supabase du projet
// (nécessaire à l'app déployée, aucune étape de build pour en injecter une
// autre) : sans ce point d'injection réservé aux tests, ce fichier — qui
// démarre l'application ENTIÈRE via app.js, contrairement à autosync.test.mjs
// qui injecte son propre client factice — déclencherait de vraies requêtes
// réseau vers esm.sh puis vers le projet Supabase réel dès le premier rendu.
sync.__forceUnconfigured(true);
document.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise((r) => setTimeout(r, 50));

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
// contenu du DERNIER toast — jamais un delta de children.length : sur une
// suite aussi longue, les timers d'expiration (2,6 s puis 3,1 s) des toasts
// précédents peuvent retirer des éléments PENDANT l'exécution, rendant tout
// delta de compte instable (observé réellement sur cette suite).
const lastToastText = () => [...document.querySelectorAll('#toasts .toast')].at(-1)?.textContent || '';
const change = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
// dispatché directement SUR l'élément backdrop lui-même (jamais sur un
// descendant) : e.target doit être le backdrop pour que son handler
// (`e.target.dataset.xBackdrop !== undefined`) le reconnaisse comme "clic
// extérieur" — c'est le même mousedown qu'un vrai clic hors du panneau.
const mousedown = (el) => el.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
const escapeKey = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const wait = () => new Promise((r) => setTimeout(r, 20));

console.log('\n— Démarrage');
check('9 entrées de navigation (Préparations ajoutée, P4)', $$('#nav button').length === 9);
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
check('le panneau "Recettes & préparations" liste la recette créée (sans préparation : menu déroulant)',
  /Chili con carne/.test($('#drawer .drawer__body').textContent));
const chiliSelect = $('#drawer [data-add-recipe-select]');
check('recette sans aucune préparation existante : proposée dans le menu déroulant, pas en ligne directe', !!chiliSelect);
const chiliOpt = [...chiliSelect.options].find((o) => /Chili con carne/.test(o.textContent));
chiliSelect.value = chiliOpt.value;
chiliSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
click($('#drawer [data-add-recipe-from-select]'));
await wait();
check('un item "recette" (référence molle, sans préparation) est ajouté',
  /recette/.test($$('#drawer .item').find((el) => /Chili con carne/.test(el.textContent))?.textContent || ''));
check('libellé "pas encore préparée"', /pas encore préparée/.test($('#drawer .drawer__body').textContent));
click($('#drawer [data-close]'));
await wait();

// matérialisation (P1 : désormais via l'écran Préparations, plus depuis
// l'éditeur de repas — on seed directement via store.js, comme le fait déjà
// le bloc « Mode zéro reste » juste en dessous pour « Riz simple »).
check('« Créer une préparation » bien retiré de l’éditeur de repas (P1.E)', !document.querySelector('[data-new-prep]'));
store.update((s) => {
  const r = s.recipes.find((x) => x.name === 'Chili con carne');
  s.preparations.push(store.newPreparation(r, 1000));
});
await wait();

click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]')[2]);
await wait();
check('la préparation matérialisée apparaît avec son disponible (1000 g / 1000 g)',
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
for (const id of ['foods', 'recipes', 'breakfasts', 'snacks', 'preparations', 'batch', 'shopping', 'settings']) {
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

console.log('\n— Écran Recettes : recherche d’ingrédient, frappe caractère par caractère (régression « clipping »)');
// Reproduit une VRAIE saisie clavier (un événement `input` par caractère,
// contrairement à type()/change() qui posent la valeur finale en un seul
// coup) : avant correctif, [data-ing-search] appelait render(root) — qui
// reconstruit tout #view, y compris .drawer__panel — à chaque caractère,
// rejouant son animation CSS d'entrée (slide-in) en boucle et faisant perdre
// le focus/curseur du champ de recherche à chaque frappe.
click($('[data-new]'));
await wait();
const panelBeforeTyping = $('.drawer__panel');
const searchBeforeTyping = $('[data-ing-search]');
searchBeforeTyping.focus();
for (const ch of 'riz') {
  searchBeforeTyping.value += ch;
  searchBeforeTyping.dispatchEvent(new window.Event('input', { bubbles: true }));
}
check('le panneau du formulaire n’est PAS recréé à chaque frappe (pas de rejeu de l’animation d’entrée)',
  $('.drawer__panel') === panelBeforeTyping);
check('le champ de recherche n’est PAS recréé à chaque frappe (identité DOM stable)',
  $('[data-ing-search]') === searchBeforeTyping);
check('le focus reste sur le champ de recherche après plusieurs frappes', document.activeElement === searchBeforeTyping);
check('les résultats sont bien filtrés par la saisie frappée caractère par caractère',
  $$('[data-ing-add]').some((b) => /Riz/i.test(b.textContent)));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Écran Recettes : validation d’un champ (Tab/blur) et sélection d’un ingrédient (régression « clipping », 2e cause)');
// Le premier correctif (ci-dessus) ne couvrait que la frappe dans la
// recherche d'ingrédient. Mais `change` sur n'importe quel champ `[data-r]`
// (déclenché par un Tab ou un blur), ainsi que la sélection d'un ingrédient
// dans la liste, appelaient AUSSI render(root) — même symptôme : le tiroir
// entier (.drawer__panel) était recréé, rejouant l'animation CSS d'entrée,
// ET l'avancement natif du focus au Tab vers le champ suivant était
// interrompu (le champ visé par le navigateur disparaissait avant d'être
// focalisé, le focus retombait sur <body>).
click($('[data-new]'));
await wait();
const panelBeforeValidation = $('.drawer__panel');
const kindSelectBeforeValidation = $('[data-r="kind"]');
const nameField = $('[data-r="name"]');
nameField.value = 'Gratin de courgettes';
nameField.focus();
// simule le blur déclenché par un Tab quittant le champ du nom : `change`
// est le même événement que le navigateur émettrait dans ce cas.
nameField.dispatchEvent(new window.Event('change', { bubbles: true }));
check('le panneau n’est PAS recréé après la validation (Tab/blur) du champ Nom',
  $('.drawer__panel') === panelBeforeValidation);
check('le champ Type n’est PAS recréé après la validation du champ Nom (identité DOM stable, pertinent pour l’avancement du focus au Tab)',
  $('[data-r="kind"]') === kindSelectBeforeValidation);
check('la valeur saisie dans Nom est bien conservée dans le brouillon après validation',
  $('[data-r="name"]').value === 'Gratin de courgettes');

const panelBeforeSelect = $('.drawer__panel');
type($('[data-ing-search]'), 'courgette');
await wait();
const courgetteBtn = $$('[data-ing-add]').find((b) => / courgette/i.test(b.textContent));
if (courgetteBtn) click(courgetteBtn);
else click($$('[data-ing-add]')[0]); // selon le catalogue de test, se replie sur le premier résultat
await wait();
check('le panneau n’est PAS recréé immédiatement après la sélection d’un ingrédient',
  $('.drawer__panel') === panelBeforeSelect);
check('l’ingrédient sélectionné apparaît bien dans la composition (la mise à jour fonctionnelle est conservée)',
  $('.drawer__body .items').textContent.trim().length > 0 && !/Aucun ingrédient/.test($('.drawer__body .items').textContent));

// répète avec un second ingrédient : même garantie à chaque ajout, pas
// seulement au premier.
const panelBeforeSecondAdd = $('.drawer__panel');
const itemCountBefore = $$('.drawer__body .items .item').length;
type($('[data-ing-search]'), 'poulet');
await wait();
const secondBtn = $$('[data-ing-add]')[0];
if (secondBtn) click(secondBtn);
await wait();
check('le panneau n’est toujours pas recréé après un second ajout d’ingrédient',
  $('.drawer__panel') === panelBeforeSecondAdd);
check('le second ingrédient a bien été ajouté (un item de plus dans la composition)',
  $$('.drawer__body .items .item').length === itemCountBefore + 1);
click($('[data-form-cancel]'));
await wait();

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
// recette sans aucune préparation existante : proposée via le menu déroulant (item C)
const portionRecipeSelect = $('#drawer [data-add-recipe-select]');
const portionOpt = [...portionRecipeSelect.options].find((o) => /Toast poulet St Môret/.test(o.textContent));
check('la recette portion apparaît dans le menu déroulant "Recettes & préparations"', !!portionOpt);
portionRecipeSelect.value = portionOpt.value;
portionRecipeSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
click($('#drawer [data-add-recipe-from-select]'));
await wait();
const portionRow = () => $$('#drawer .item').find((el) => /Toast poulet St Môret/.test(el.textContent) && /recette/.test(el.textContent));
const portionQtyInput = () => portionRow().querySelectorAll('[data-qty]')[0];
check('quantité initiale = 1 portion (jamais 143 g)', portionQtyInput().value === '1', portionQtyInput().value);
check('unité affichée = "portion", jamais "g"', /portion/.test(portionRow().querySelector('.item__unit').textContent));
check('pas de saisie = 1 (increment par portion entière)', portionQtyInput().step === '1', portionQtyInput().step);
check('P2.4 — un repas composé uniquement d’une recette : son nom sert de repli (jamais de catégorie alimentaire réelle, mais jamais "Sans nom" non plus)',
  $('#drawer [data-name]').value === 'Toast poulet St Môret', $('#drawer [data-name]').value);

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
const skyrSelect = $('#drawer [data-add-recipe-select]');
const skyrOpt = [...skyrSelect.options].find((o) => /Skyr avoine/.test(o.textContent));
check('la recette "Skyr avoine" apparaît dans le menu déroulant "Recettes & préparations"', !!skyrOpt);
skyrSelect.value = skyrOpt.value;
skyrSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
click($('#drawer [data-add-recipe-from-select]'));
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

console.log('\n— P4 : écran « Préparations » — stock et assistant de répartition');
const p4Beef = store.getState().foods.find((f) => /Steak haché/.test(f.name));
let p4PrepId;
store.update((s) => {
  const recipe = store.newRecipe('Bœuf effiloché P4', 'weight');
  recipe.items = [store.newRecipeItem(p4Beef.id, 1000, 'cru')];
  recipe.baseGrams = 1000;
  s.recipes.push(recipe);
  const prep = store.newPreparation(recipe, 1000);
  p4PrepId = prep.id;
  s.preparations.push(prep);
});
await wait();

click($('[data-view="preparations"]'));
await wait();
check('écran Préparations accessible depuis la navigation', $('#title').textContent === 'Préparations');
check('la préparation apparaît comme un stock : Préparé/Affecté/Disponible',
  /Préparé/.test($('#view').textContent) && /Affecté/.test($('#view').textContent) && /Disponible/.test($('#view').textContent));
check('disponible initial = 1 000 g (rien encore affecté)', /1\s?000 g/.test($('#view').textContent));

click($$('[data-open-distribute]').find((b) => b.dataset.openDistribute === p4PrepId));
await wait();
check('assistant ouvert avec le disponible affiché', /Disponible : 1\s?000 g/.test($('#view').textContent));
check('champ « combien répartir » pré-rempli au disponible', $('[data-wizard-amount]').value === '1000');
check('0 repas sélectionné au départ', /0 repas sélectionné/.test($('#view').textContent));

// les deux derniers créneaux de la liste correspondent aux jours ajoutés par
// l'extension du cycle à 6 jours (encore vides) — sans risque d'interférer
// avec les repas déjà utilisés par les sections précédentes de ce test.
check('des libellés « Jour — Type » réels sont proposés (réutilise dayName(), P3.5)',
  $$('[data-pick-meal]').some((cb) => /^(Lundi|Mardi|Mercredi|Jeudi|Vendredi|Samedi|Dimanche) — /.test(cb.closest('label').textContent.trim())));
// re-requêter à chaque clic : render(root) reconstruit le DOM à chaque
// changement (même motif que le reste du fichier, ex. pastaRow2()) — une
// référence capturée avant un premier clic serait détachée pour le second.
const p4LastMealIds = () => $$('[data-pick-meal]').slice(-2).map((cb) => cb.dataset.pickMeal);
const [p4MealA, p4MealB] = p4LastMealIds();
click($$('[data-pick-meal]').find((cb) => cb.dataset.pickMeal === p4MealA));
await wait();
click($$('[data-pick-meal]').find((cb) => cb.dataset.pickMeal === p4MealB));
await wait();
check('2 repas sélectionnés (compteur mis à jour)', /2 repas sélectionné/.test($('#view').textContent));
check('bouton Répartir activé (sélection cohérente)', !$('[data-wizard-submit]').disabled);

click($('[data-wizard-submit]'));
await wait();
check('résultat affiché immédiatement, sans fermeture silencieuse', /Répartition terminée/.test($('#view').textContent));
check('1 000 g affectés annoncés dans le résumé', /1\s?000 g/.test($('#view').textContent));
check('macros affichées dans le résumé (réutilise mealMacros()/evaluate())', /kcal/.test($('#view').textContent));

const p4Saved = () => JSON.parse(localStorage.getItem('nutriplan.state.v1'));
check('disponible retombé à 0 après répartition complète (persisté)',
  p4Saved().meals.filter((m) => m.items.some((it) => it.preparationId === p4PrepId))
    .reduce((sum, m) => sum + m.items.filter((it) => it.preparationId === p4PrepId).reduce((s, it) => s + it.qty.thomas + it.qty.julie, 0), 0) === 1000);
check('les items créés portent zeroWaste:true (compatibilité avec l’ancien mécanisme, P4 §16)',
  p4Saved().meals.some((m) => m.items.some((it) => it.preparationId === p4PrepId && it.zeroWaste === true)));

console.log('\n— P4 : sur-engagement bloqué (jamais de stock négatif)');
let p4Prep2Id;
store.update((s) => {
  const recipe = store.newRecipe('Curry léger P4', 'weight');
  recipe.items = [store.newRecipeItem(p4Beef.id, 500, 'cru')];
  recipe.baseGrams = 500;
  s.recipes.push(recipe);
  const prep = store.newPreparation(recipe, 500);
  p4Prep2Id = prep.id;
  s.preparations.push(prep);
});
await wait();
click($('[data-view="preparations"]'));
await wait();
click($$('[data-open-distribute]').find((b) => b.dataset.openDistribute === p4Prep2Id));
await wait();
change($('[data-wizard-amount]'), '700'); // > 500 g disponibles
await wait();
check('message explicite de dépassement affiché', /nécessite 700 g pour 500 g disponibles/.test($('#view').textContent));
check('bouton Répartir désactivé : impossible de valider un dépassement', $('[data-wizard-submit]').disabled);
const p4BeforeOverCommit = JSON.stringify(p4Saved().preparations.find((p) => p.id === p4Prep2Id));
click($('[data-wizard-cancel]'));
await wait();
check('annulation : aucune écriture, préparation strictement inchangée',
  JSON.stringify(p4Saved().preparations.find((p) => p.id === p4Prep2Id)) === p4BeforeOverCommit);

console.log('\n— P4 : « + Utiliser dans un repas » (assignation directe, sans assistant)');
// préparation DÉDIÉE, isolée des scénarios précédents/suivants (sur-engagement,
// puis reset) pour ne pas fausser leurs quantités attendues.
let p4Prep3Id;
store.update((s) => {
  const recipe = store.newRecipe('Riz P4', 'weight');
  recipe.items = [store.newRecipeItem(p4Beef.id, 400, 'cru')];
  recipe.baseGrams = 400;
  s.recipes.push(recipe);
  const prep = store.newPreparation(recipe, 400);
  p4Prep3Id = prep.id;
  s.preparations.push(prep);
});
await wait();
click($('[data-view="preparations"]'));
await wait();
click($$('[data-open-quick-use]').find((b) => b.dataset.openQuickUse === p4Prep3Id));
await wait();
check('formulaire rapide ouvert avec un repas proposé par défaut', !!$('[data-quickuse-meal]') && !!$('[data-quickuse-qty]'));
const p4QuickMealId = $('[data-quickuse-meal]').value;
// comme l'existant « + Utiliser » de l'éditeur (data-use-preparation,
// newPreparationItem() symétrique), 100 g saisis affectent 100 g à CHAQUE
// personne — 200 g au total prélevés sur le stock (400 − 200 = 200 g).
change($('[data-quickuse-qty]'), '100');
click($('[data-quickuse-confirm]'));
await wait();
check('toast de confirmation', /ajoutée au repas/i.test(document.getElementById('toasts')?.textContent || ''));
check('item préparation ajouté au repas choisi (100 g pour chaque personne, motif symétrique existant)',
  p4Saved().meals.find((m) => m.id === p4QuickMealId)?.items.some((it) => it.preparationId === p4Prep3Id && it.qty.thomas === 100 && it.qty.julie === 100));
click($('[data-view="preparations"]'));
await wait();
check('disponible réduit en conséquence (400 − 100×2 = 200 g)', /200 g/.test($('#view').textContent));

console.log('\n— P1 : écran « Préparations » — création depuis une recette, affectations éditables, pertes');
const p1Saved = () => JSON.parse(localStorage.getItem('nutriplan.state.v1'));

click($('[data-view="recipes"]'));
await wait();
click($('[data-new]'));
await wait();
change($('[data-r="name"]'), 'Curry P1 test');
change($('[data-r="kind"]'), 'weight');
await wait();
type($('[data-ing-search]'), 'riz basmati');
click($$('[data-ing-add]').find((b) => /Riz basmati/i.test(b.textContent)));
await wait();
click($('[data-save]'));
await wait();

click($('[data-view="preparations"]'));
await wait();
check('bouton "Nouvelle préparation" présent', !!$('[data-open-create]'));
click($('[data-open-create]'));
await wait();
check('panneau de création ouvert (sélecteur de recette)', !!$('[data-create-recipe]'));
// sélectionne explicitement la recette qu'on vient de créer
const recipeSelect = $('[data-create-recipe]');
const curryOption = [...recipeSelect.options].find((o) => /Curry P1 test/.test(o.textContent));
change(recipeSelect, curryOption.value);
await wait();
check('ingrédients de référence affichés avant toute saisie de quantité', /Riz basmati/.test($('.drawer__body').textContent));
change($('[data-create-qty]'), '500');
await wait();
check('aperçu des quantités nécessaires affiché après saisie (réutilise deployItems(), aucun second calcul)',
  /nécessaires pour/.test($('.drawer__body').textContent) && /Riz basmati/.test($('.drawer__body').textContent));
click($('[data-create-confirm]'));
await wait();
check('préparation créée et visible comme un stock (Préparé/Affecté/Disponible)',
  /Préparé/.test($('#view').textContent) && /Curry P1 test/.test($('#view').textContent));
check('500 g annoncés comme préparés', /500 g/.test($('#view').textContent));

const p1PrepId = p1Saved().preparations.find((p) => p.label === 'Curry P1 test').id;

// distribue une partie sur un repas, puis vérifie l'édition en place (P1.B)
click($$('[data-open-distribute]').find((b) => b.dataset.openDistribute === p1PrepId));
await wait();
change($('[data-wizard-amount]'), '200');
await wait();
click($$('[data-pick-meal]')[0]);
await wait();
check('bouton Répartir activé', !$('[data-wizard-submit]').disabled);
click($('[data-wizard-submit]'));
await wait();

const toggleBtn = $$('[data-toggle-assignments]').find((b) => b.dataset.toggleAssignments === p1PrepId);
check('bouton "Voir les affectations" proposé après répartition', !!toggleBtn);
click(toggleBtn);
await wait();
const assignmentQtyInput = $('[data-assignment-qty]');
check('affectation listée avec une quantité modifiable', !!assignmentQtyInput);
const p1ItemCountOf = (s) => s.meals.reduce((n, m) => n + m.items.filter((it) => it.preparationId === p1PrepId).length, 0);
const p1ItemCountBefore = p1ItemCountOf(p1Saved());
change(assignmentQtyInput, '120');
await wait();
check('toast de mise à jour (édition en place, aucun doublon)', /mise à jour/i.test(document.getElementById('toasts')?.textContent || ''));
const p1ItemCountAfter = p1ItemCountOf(p1Saved());
check('aucun item supplémentaire créé (même nombre d’items qu’avant l’édition)', p1ItemCountAfter === p1ItemCountBefore);
check('la quantité totale de l’affectation reflète bien la nouvelle valeur (120 g)',
  p1Saved().meals.some((m) => m.items.some((it) => it.preparationId === p1PrepId && Math.round((it.qty.thomas || 0) + (it.qty.julie || 0)) === 120)));

console.log('\n— P1 : « Jeter une quantité partielle » — flux distinct, sur-engagement bloqué');
const discardBtn = $$('[data-open-discard-partial]').find((b) => b.dataset.openDiscardPartial === p1PrepId);
click(discardBtn);
await wait();
check('panneau "Jeter une quantité partielle" ouvert (flux distinct du jet total)', !!$('[data-discard-qty]'));
const prepBeforeDiscard = p1Saved().preparations.find((p) => p.id === p1PrepId);
const dispoBeforeDiscard = derive.preparationAvailable(p1Saved(), prepBeforeDiscard);
change($('[data-discard-qty]'), String(Math.round(dispoBeforeDiscard + 100))); // au-delà du disponible
await wait();
check('bouton de confirmation désactivé : refuse de jeter plus que le disponible', $('[data-discard-partial-confirm]').disabled);
change($('[data-discard-qty]'), '50');
await wait();
check('bouton de confirmation activé pour une quantité valide', !$('[data-discard-partial-confirm]').disabled);
click($('[data-discard-partial-confirm]'));
await wait();
check('confirmation bloquante affichée (P1, remplace confirm() natif)', !!$('[data-action-confirm]'));
click($('[data-action-confirm]'));
await wait();
check('toast de confirmation de la perte', /perte enregistrée/i.test(document.getElementById('toasts')?.textContent || ''));
check('la perte est tracée (préparation, quantité, date) et affichée', /Jeté/.test($('#view').textContent));
const prepAfterPartialDiscard = p1Saved().preparations.find((p) => p.id === p1PrepId);
check('un seul enregistrement de perte, avec la bonne quantité et une date', prepAfterPartialDiscard.losses.length === 1 && prepAfterPartialDiscard.losses[0].qty === 50 && !!prepAfterPartialDiscard.losses[0].at);
check('le disponible a bien diminué de la quantité jetée (et seulement elle)',
  Math.round(derive.preparationAvailable(p1Saved(), prepAfterPartialDiscard)) === Math.round(dispoBeforeDiscard - 50));
check('l’affectation déjà en place n’a pas été touchée par le jet des restes', p1ItemCountAfter === p1ItemCountOf(p1Saved()));
const dispoAfterPartialDiscard = derive.preparationAvailable(p1Saved(), prepAfterPartialDiscard);
check('la préparation reste visible dans la liste active (stock encore positif)', $$('[data-open-discard-confirm]').some((b) => b.dataset.openDiscardConfirm === p1PrepId));

console.log('\n— P1 : « Jeter les restes » — jet total en un seul dialogue (2 clics), masquage des préparations épuisées');
const fullDiscardBtn = () => $$('[data-open-discard-confirm]').find((b) => b.dataset.openDiscardConfirm === p1PrepId);
check('clic 1 : bouton "Jeter les restes" présent et distinct du jet partiel', !!fullDiscardBtn());
click(fullDiscardBtn());
await wait();
check('une seule confirmation apparaît directement, aucun panneau intermédiaire',
  !!$('[data-discard-confirm-ok]') && !$('[data-discard-qty]'));
check('le dialogue précise la préparation et la quantité réellement disponible',
  new RegExp(`${Math.round(dispoAfterPartialDiscard)} g`).test($('.modal__panel')?.textContent || ''), $('.modal__panel')?.textContent);
check('le message précise le caractère irréversible', /irréversible/.test($('.modal__panel')?.textContent || ''));

// Annuler : aucune donnée modifiée
const beforeCancelSnapshot = JSON.stringify(p1Saved().preparations.find((p) => p.id === p1PrepId));
click($('[data-discard-confirm-cancel]'));
await wait();
check('"Annuler" ferme le dialogue sans modifier les données', !$('.modal__panel'));
check('stock strictement inchangé après annulation', JSON.stringify(p1Saved().preparations.find((p) => p.id === p1PrepId)) === beforeCancelSnapshot);

// clic 2 : confirmer le jet total
click(fullDiscardBtn());
await wait();
click($('[data-discard-confirm-ok]'));
await wait();
check('toast de confirmation', /jeté/i.test(document.getElementById('toasts')?.textContent || ''));
const prepAfterFullDiscard = p1Saved().preparations.find((p) => p.id === p1PrepId);
check('disponible retombé à 0 (toute la quantité restante a été jetée, pas plus)',
  Math.abs(derive.preparationAvailable(p1Saved(), prepAfterFullDiscard)) < 1e-6);
check('la perte totale est tracée en plus de la perte partielle précédente (historique jamais écrasé)', prepAfterFullDiscard.losses.length === 2);
check('la préparation n’est PAS supprimée des données (conservée, juste masquée)',
  p1Saved().preparations.some((p) => p.id === p1PrepId));

// épuisée : masquée de la liste active, mais reste consultable (pas de suppression silencieuse)
check('préparation épuisée masquée de la liste active', !fullDiscardBtn());
const exhaustedToggle = $('[data-toggle-exhausted]');
check('section "préparations épuisées" proposée', !!exhaustedToggle);
click(exhaustedToggle);
await wait();
check('préparation épuisée retrouvable dans la section repliée (données non perdues)', !!fullDiscardBtn());
check('ses actions restent désactivées (non resélectionnable pour une nouvelle distribution)', fullDiscardBtn().disabled);
check('ses affectations restent consultables (bouton "Voir les affectations" toujours présent)',
  !!$$('[data-toggle-assignments]').find((b) => b.dataset.toggleAssignments === p1PrepId));

console.log('\n— P1 : l’éditeur de repas ne crée plus de préparation (retiré, P1.E)');
click($('[data-view="planning"]'));
await wait();
click($$('.meal-card button').find((b) => /Modifier/i.test(b.textContent)));
await wait();
check('« Créer une préparation » retiré de l’éditeur de repas', !$('[data-new-prep]') && !$('[data-new-prep-recipe]') && !$('[data-new-prep-qty]'));
click($('#drawer [data-close]'));
await wait();

console.log('\n— P2 : confirmation de fermeture d’un formulaire non sauvegardé — Aliments (création)');
click($('[data-view="foods"]'));
await wait();
type($('[data-q]'), ''); // réinitialise le filtre de recherche laissé par un test antérieur (« haricots verts »)
await wait();
click($('[data-new]'));
await wait();
// nombre de toasts AVANT (pas leur texte : un toast bien plus ancien peut
// s'auto-supprimer tout seul pendant ce test — cf. util.js, retrait après
// 3,1 s — ce qui n'a rien à voir avec cette action et rendrait la
// comparaison par texte non fiable ; seul un NOUVEAU toast nous concerne ici).
const toastCountBeforeClose = document.getElementById('toasts')?.children.length || 0;
// régression : le panneau (.drawer__panel) ne doit JAMAIS être recréé ni à
// l'ouverture du dialogue de confirmation, ni à sa fermeture via « Non,
// retour » — avant correctif, foods.js reconstruisait tout #view à chaque
// render(), rejouant l'animation d'entrée du tiroir sur ces deux actions
// (même cause que le clipping déjà corrigé dans recipes.js, jamais
// reproduit côté Aliments jusqu'ici).
const foodsPanelBeforeDialog = $('.drawer__panel');
type($('[data-f="name"]'), 'Aliment Clipping Test P2');
mousedown($('[data-form-backdrop]'));
await wait();
check('dialogue affiché après clic extérieur avec saisie', !!$('[data-unsaved-stay]'));
check('le panneau n’est PAS recréé par l’ouverture du dialogue de confirmation', $('.drawer__panel') === foodsPanelBeforeDialog);
check('aucune notification parallèle (un seul mécanisme de confirmation)',
  (document.getElementById('toasts')?.children.length || 0) <= toastCountBeforeClose);
check('formulaire toujours ouvert, saisie conservée', $('[data-f="name"]')?.value === 'Aliment Clipping Test P2');

click($('[data-unsaved-stay]'));
await wait();
check('"Non, retour" : formulaire conservé avec la saisie', $('[data-f="name"]')?.value === 'Aliment Clipping Test P2');
check('le panneau n’est PAS recréé par « Non, retour » (identité DOM stable)', $('.drawer__panel') === foodsPanelBeforeDialog);

mousedown($('[data-form-backdrop]'));
await wait();
click($('[data-unsaved-discard]'));
await wait();
check('"Oui, tant pis" : formulaire fermé', !$('[data-f="name"]'));
check('aucun aliment créé (modifications abandonnées)', !/Aliment Clipping Test P2/.test($('#view').textContent));

console.log('\n— P2 : formulaire vierge / Échap / sauvegarde réussie — Aliments');
click($('[data-new]'));
await wait();
mousedown($('[data-form-backdrop]'));
await wait();
check('formulaire VIERGE : fermeture immédiate sans dialogue', !$('[data-f="name"]') && !$('[data-unsaved-stay]'));

click($('[data-new]'));
await wait();
type($('[data-f="name"]'), 'Aliment Sauvegarde Reussie P2');
click($('[data-save]'));
await wait();
check('sauvegarde réussie : formulaire fermé sans dialogue', !$('[data-f="name"]') && !$('[data-unsaved-stay]'));
check('aliment bien enregistré', /Aliment Sauvegarde Reussie P2/.test($('#view').textContent));

const foodEditBtn = $$('[data-edit]').find((b) => b.closest('tr')?.textContent.includes('Aliment Sauvegarde Reussie P2'));
click(foodEditBtn);
await wait();
mousedown($('[data-form-backdrop]'));
await wait();
check('édition SANS modification : fermeture directe (valeurs initiales jamais vues comme un changement)', !$('[data-unsaved-stay]') && !$('[data-f="name"]'));

click(foodEditBtn);
await wait();
const foodEditPanelRef = $('.drawer__panel'); // édition, pas création : vérifie aussi ce cas précis
type($('[data-f="brand"]'), 'MarqueTestP2');
escapeKey();
await wait();
check('Échap avec modification réelle : dialogue affiché', !!$('[data-unsaved-stay]'));
check('édition : le panneau n’est pas recréé par l’ouverture du dialogue (Échap)', $('.drawer__panel') === foodEditPanelRef);
escapeKey(); // Échap sur le dialogue == « Non, retour » (action sûre par défaut)
await wait();
check('Échap sur le dialogue = "Non, retour" : formulaire toujours ouvert', !!$('[data-f="brand"]'));
check('saisie conservée après ce retour', $('[data-f="brand"]')?.value === 'MarqueTestP2');
check('édition : le panneau n’est pas recréé par « Non, retour » (Échap)', $('.drawer__panel') === foodEditPanelRef);

click($('[data-form-cancel]'));
await wait();
check('bouton X avec modification : dialogue affiché', !!$('[data-unsaved-stay]'));
click($('[data-unsaved-discard]'));
await wait();
check('bouton X -> "Oui, tant pis" : ferme sans enregistrer la modification', !$('[data-f="brand"]'));
check('la marque n’a PAS été enregistrée', !/MarqueTestP2/.test($('#view').textContent));

console.log('\n— P2 : confirmation de fermeture d’un formulaire non sauvegardé — Recettes (création/édition)');
click($('[data-view="recipes"]'));
await wait();
click($('[data-new]'));
await wait();
change($('[data-r="name"]'), 'Recette Clipping Test P2');
mousedown($('[data-form-backdrop]'));
await wait();
check('dialogue affiché après clic extérieur avec saisie (recette)', !!$('[data-unsaved-stay]'));
check('formulaire toujours ouvert, saisie conservée (recette)', $('[data-r="name"]')?.value === 'Recette Clipping Test P2');

click($('[data-unsaved-discard]'));
await wait();
check('"Oui, tant pis" ferme sans créer la recette', !$('[data-r="name"]'));
check('recette NON créée', !/Recette Clipping Test P2/.test($('#view').textContent));

click($('[data-new]'));
await wait();
mousedown($('[data-form-backdrop]'));
await wait();
check('formulaire recette VIERGE : fermeture immédiate sans dialogue', !$('[data-r="name"]') && !$('[data-unsaved-stay]'));

// régression : le correctif « clipping » (panneau jamais recréé pendant la
// saisie) doit tenir avec la nouvelle garde P2 par-dessus.
click($('[data-new]'));
await wait();
const panelRef = $('.drawer__panel');
const r2NameInput2 = $('[data-r="name"]');
r2NameInput2.value = 'X';
r2NameInput2.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait();
check('le panneau n’est pas recréé par une saisie suivie d’un blur (régression clipping)', $('.drawer__panel') === panelRef);
escapeKey();
await wait();
check('Échap avec modification (recette) : dialogue affiché', !!$('[data-unsaved-stay]'));
click($('[data-unsaved-discard]'));
await wait();

console.log('\n— Persistance locale');
const saved = JSON.parse(localStorage.getItem('nutriplan.state.v1'));
check('état écrit dans localStorage', !!saved && saved.foods.length > 50);
// pâtes (Thomas) : dernier item resté verrouillé (par sa propre saisie
// manuelle, P1.2) sur ce repas — le poulet, lui, a été déverrouillé puis
// réajusté explicitement plus haut (« Déverrouillage manuel »).
check('repas conservé avec son verrou (verrouillage automatique persistant)',
  saved.meals[0].items.some((i) => i.locked.thomas === true && i.qty.thomas === 5 && i.foodId === 'f_pates_completes'));
check('ingrédient libre conservé', saved.meals[0].items.some((i) => i.free?.name === 'Curry'));

// P4 : réinitialisation du cycle — DESTRUCTIVE (vide s.meals), volontairement
// exécutée en tout dernier, après toutes les assertions de persistance
// ci-dessus qui dépendent des repas existants (verrou, ingrédient libre).
console.log('\n— P4 : réinitialisation du cycle — le stock restant est conservé, jamais republié en entier');
// 500 g disponibles, on en affecte 200 -> 300 g restants avant reset
click($('[data-view="preparations"]'));
await wait();
click($$('[data-open-distribute]').find((b) => b.dataset.openDistribute === p4Prep2Id));
await wait();
change($('[data-wizard-amount]'), '200');
await wait();
click($$('[data-pick-meal]')[$$('[data-pick-meal]').length - 1]);
await wait();
click($('[data-wizard-submit]'));
await wait();
const p4SavedFinal = () => JSON.parse(localStorage.getItem('nutriplan.state.v1'));
check('200 g affectés, 300 g restants avant reset',
  p4SavedFinal().preparations.find((p) => p.id === p4Prep2Id) &&
  p4SavedFinal().meals.some((m) => m.items.some((it) => it.preparationId === p4Prep2Id)));

click($('[data-view="settings"]'));
await wait();
click($('[data-reset-cycle]'));
await wait();
check('confirmation bloquante affichée avant réinitialisation (P1)', !!$('[data-action-confirm]'));
click($('[data-action-confirm]'));
await wait();
const afterReset1 = p4SavedFinal().preparations.find((p) => p.id === p4Prep2Id);
check('remainingAtReset figé à 300 g (500 préparés − 200 affectés), jamais republié à 500 g',
  afterReset1.remainingAtReset === 300, `remainingAtReset=${afterReset1.remainingAtReset}`);
check('les repas du cycle sont bien vidés (planning réinitialisé)', p4SavedFinal().meals.every((m) => !m.items.some((it) => it.preparationId === p4Prep2Id)));

click($('[data-view="preparations"]'));
await wait();
check('l’écran Préparations affiche 300 g disponibles après reset, pas 500 g', /300 g/.test($('#view').textContent));

// deuxième reset successif, sans nouvelle affectation : le stock ne doit pas bouger
click($('[data-view="settings"]'));
await wait();
click($('[data-reset-cycle]'));
await wait();
click($('[data-action-confirm]'));
await wait();
const afterReset2 = p4SavedFinal().preparations.find((p) => p.id === p4Prep2Id);
check('deux resets successifs sans nouvel usage : remainingAtReset stable à 300 g',
  afterReset2.remainingAtReset === 300, `remainingAtReset=${afterReset2.remainingAtReset}`);

console.log('\n— Préparations : bouton « Annuler » (doublon d’attribut data-*-cancel avec « Fermer »)');
let p5Prep;
store.update((s) => {
  const recipe = store.newRecipe('Annuler Bug Test', 'weight');
  recipe.items = [store.newRecipeItem(p4Beef.id, 300, 'cru')];
  recipe.baseGrams = 300;
  s.recipes.push(recipe);
  const prep = store.newPreparation(recipe, 300);
  p5Prep = prep;
  s.preparations.push(prep);
});
await wait();
click($('[data-view="preparations"]'));
await wait();

// panneau de création : « Fermer » (en-tête) et « Annuler » (pied) partagent
// data-create-cancel — seul le second doit être testé ici (le premier est
// déjà couvert ailleurs par les tests de fermeture de panneau).
click($('[data-open-create]'));
await wait();
const createCancelBtns = $$('[data-create-cancel]');
check('panneau de création : deux boutons portent data-create-cancel (Fermer + Annuler)', createCancelBtns.length === 2);
click(createCancelBtns[createCancelBtns.length - 1]);
await wait();
check('panneau de création fermé via le bouton « Annuler » du pied', !$('[data-create-qty]'));

// assistant de répartition
click($$('[data-open-distribute]').find((b) => b.dataset.openDistribute === p5Prep.id));
await wait();
const wizardCancelBtns = $$('[data-wizard-cancel]');
check('assistant de répartition : deux boutons portent data-wizard-cancel', wizardCancelBtns.length === 2);
click(wizardCancelBtns[wizardCancelBtns.length - 1]);
await wait();
check('assistant fermé via le bouton « Annuler » du pied', !$('[data-wizard-amount]'));

// jet partiel
click($$('[data-open-discard-partial]').find((b) => b.dataset.openDiscardPartial === p5Prep.id));
await wait();
const discardCancelBtns = $$('[data-discard-cancel]');
check('jet partiel : deux boutons portent data-discard-cancel', discardCancelBtns.length === 2);
click(discardCancelBtns[discardCancelBtns.length - 1]);
await wait();
check('panneau de jet partiel fermé via le bouton « Annuler » du pied', !$('[data-discard-qty]'));

console.log('\n— Préparations : suppression définitive (« Supprimer la préparation »)');
const p5Saved = () => JSON.parse(localStorage.getItem('nutriplan.state.v1'));

// cas 1 : stock à 0 -> message simple, sans ligne de perte
click($$('[data-open-discard-confirm]').find((b) => b.dataset.openDiscardConfirm === p5Prep.id));
await wait();
click($('[data-discard-confirm-ok]'));
await wait();
check('préparation épuisée après jet total (stock à 0)',
  derive.preparationAvailable(store.getState(), p5Saved().preparations.find((p) => p.id === p5Prep.id)) === 0);
// la section "épuisées" peut déjà être dépliée par un test précédent (état de
// vue persistant au niveau du module) — ne (re)basculer que si nécessaire.
if (!$$('[data-open-delete-prep]').some((b) => b.dataset.openDeletePrep === p5Prep.id)) {
  click($('[data-toggle-exhausted]'));
  await wait();
}
const deleteBtnZero = $$('[data-open-delete-prep]').find((b) => b.dataset.openDeletePrep === p5Prep.id);
check('bouton « Supprimer la préparation » présent sur la carte épuisée', !!deleteBtnZero);
click(deleteBtnZero);
await wait();
check('modale de suppression : message simple (pas de mention de perte) quand le stock est à 0',
  /va être supprimée/.test($('.modal__panel').textContent) && !/disponibles/.test($('.modal__panel').textContent));
click($('[data-delete-prep-ok]'));
await wait();
check('préparation réellement retirée de state.preparations après confirmation',
  !p5Saved().preparations.some((p) => p.id === p5Prep.id));

// cas 2 : stock > 0 -> avertissement de perte, annulation ne modifie rien
let p5Prep2;
store.update((s) => {
  const recipe = store.newRecipe('Annuler Bug Test Stock', 'weight');
  recipe.items = [store.newRecipeItem(p4Beef.id, 400, 'cru')];
  recipe.baseGrams = 400;
  s.recipes.push(recipe);
  const prep = store.newPreparation(recipe, 400);
  p5Prep2 = prep;
  s.preparations.push(prep);
});
await wait();
click($('[data-view="preparations"]'));
await wait();
click($$('[data-open-delete-prep]').find((b) => b.dataset.openDeletePrep === p5Prep2.id));
await wait();
check('modale de suppression : avertissement affiché quand le stock est > 0',
  /400 g/.test($('.modal__panel').textContent) && /disponibles/.test($('.modal__panel').textContent) && /seront perdus/.test($('.modal__panel').textContent));
click($('[data-delete-prep-cancel]'));
await wait();
check('« Annuler » referme sans toucher aux données : la préparation existe toujours',
  p5Saved().preparations.some((p) => p.id === p5Prep2.id));
click($$('[data-open-delete-prep]').find((b) => b.dataset.openDeletePrep === p5Prep2.id));
await wait();
click($('[data-delete-prep-ok]'));
await wait();
check('confirmation : la préparation est supprimée malgré le stock restant (perte assumée)',
  !p5Saved().preparations.some((p) => p.id === p5Prep2.id));

// cas 3 : suppression bloquée tant que des affectations existent, puis chaîne complète avec la recette
let p5Recipe3Id, p5Prep3;
store.update((s) => {
  const recipe = store.newRecipe('Chaine Suppression Test', 'weight');
  recipe.items = [store.newRecipeItem(p4Beef.id, 250, 'cru')];
  recipe.baseGrams = 250;
  s.recipes.push(recipe);
  p5Recipe3Id = recipe.id;
  const prep = store.newPreparation(recipe, 250);
  p5Prep3 = prep;
  s.preparations.push(prep);
});
await wait();
click($('[data-view="preparations"]'));
await wait();
click($$('[data-open-distribute]').find((b) => b.dataset.openDistribute === p5Prep3.id));
await wait();
change($('[data-wizard-amount]'), '100');
await wait();
click($$('[data-pick-meal]')[0]);
await wait();
click($('[data-wizard-submit]'));
await wait();
click($$('[data-open-delete-prep]').find((b) => b.dataset.openDeletePrep === p5Prep3.id));
await wait();
check('suppression bloquée par une affectation vivante : aucune modale ouverte',
  !$('.modal__panel'));
check('un toast explicite apparaît pour signaler le blocage',
  /affectation/i.test(lastToastText()));
check('la préparation affectée existe toujours', p5Saved().preparations.some((p) => p.id === p5Prep3.id));

// retirer l'affectation puis vérifier la chaîne complète : suppression préparation -> suppression recette devient possible
click($('[data-toggle-assignments]'));
await wait();
const removeAssignBtn = $('[data-assignment-remove]');
if (removeAssignBtn) { click(removeAssignBtn); await wait(); }
click($('[data-view="recipes"]'));
await wait();
const recipeRow3 = $$('tr').find((tr) => tr.textContent.includes('Chaine Suppression Test'));
click(recipeRow3?.querySelector('[data-edit]'));
await wait();
click($('[data-delete]'));
await wait();
check('suppression de la recette toujours bloquée tant que la préparation existe (même sans affectation)',
  p5Saved().recipes.some((r) => r.id === p5Recipe3Id));
const closeBtnRecipe3 = $('[data-form-cancel]') || $$('button').find((b) => /^Fermer$/.test(b.textContent.trim()));
if (closeBtnRecipe3) click(closeBtnRecipe3);
await wait();
if ($('[data-unsaved-discard]')) { click($('[data-unsaved-discard]')); await wait(); }

click($('[data-view="preparations"]'));
await wait();
click($$('[data-open-delete-prep]').find((b) => b.dataset.openDeletePrep === p5Prep3.id));
await wait();
click($('[data-delete-prep-ok]'));
await wait();
check('préparation supprimée après retrait de son affectation', !p5Saved().preparations.some((p) => p.id === p5Prep3.id));

click($('[data-view="recipes"]'));
await wait();
const recipeRow3b = $$('tr').find((tr) => tr.textContent.includes('Chaine Suppression Test'));
click(recipeRow3b?.querySelector('[data-edit]'));
await wait();
click($('[data-delete]'));
await wait();
check('confirmation bloquante affichée avant suppression (P1)', !!$('[data-action-confirm]'));
click($('[data-action-confirm]'));
await wait();
check('la suppression de la recette devient possible une fois la préparation supprimée',
  !p5Saved().recipes.some((r) => r.id === p5Recipe3Id));

console.log('\n— Éditeur de repas : panneau « Recettes & préparations » — recettes avec stock en priorité, sinon menu déroulant');
let p6RecipeNoStockId, p6RecipeWithStockId, p6MealId;
store.update((s) => {
  const r1 = store.newRecipe('Sans Stock CDE', 'weight');
  r1.items = [store.newRecipeItem(p4Beef.id, 400, 'cru')];
  r1.baseGrams = 400;
  s.recipes.push(r1);
  p6RecipeNoStockId = r1.id;

  const r2 = store.newRecipe('Avec Stock CDE', 'weight');
  r2.items = [store.newRecipeItem(p4Beef.id, 400, 'cru')];
  r2.baseGrams = 400;
  s.recipes.push(r2);
  p6RecipeWithStockId = r2.id;
  s.preparations.push(store.newPreparation(r2, 300));

  const meal = s.meals.find((m) => m.dayIndex === 0 && m.mealType === 'lunch');
  p6MealId = meal.id;
});
await wait();
click($('[data-view="planning"]'));
await wait();
click($$('[data-edit]').find((b) => b.dataset.edit === p6MealId));
await wait();

check('recette AVEC stock disponible : ligne d’action directe présente (+ Utiliser)',
  $$('#drawer [data-use-preparation]').some((btn) => btn.closest('.item').textContent.includes('Avec Stock CDE')));
check('recette AVEC stock disponible : absente du menu déroulant « sans préparation »',
  !$$('#drawer [data-add-recipe-select] option').some((o) => /Avec Stock CDE/.test(o.textContent)));
const dropdownSelect = $('[data-add-recipe-select]');
check('recette SANS stock disponible : présente dans le menu déroulant', !!dropdownSelect && [...dropdownSelect.options].some((o) => /Sans Stock CDE/.test(o.textContent)));
check('recette SANS stock disponible : pas de ligne « + Utiliser » dédiée (pas de préparation la concernant)',
  !$$('[data-use-preparation]').some((btn) => {
    const prep = store.getState().preparations.find((p) => p.id === btn.dataset.usePreparation);
    return prep?.recipeId === p6RecipeNoStockId;
  }));

const optNoStock = [...dropdownSelect.options].find((o) => /Sans Stock CDE/.test(o.textContent));
dropdownSelect.value = optNoStock.value;
dropdownSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
click($('[data-add-recipe-from-select]'));
await wait();
check('ajout via le menu déroulant : l’item recette est bien ajouté au repas',
  store.getState().meals.find((m) => m.id === p6MealId).items.some((it) => it.recipeId === p6RecipeNoStockId));

console.log('\n— Auto-nommage des repas : la recette sert de repli, jamais prioritaire sur le nommage par composition');
check('aucun féculent/protéine/légume catégorisé dans ce repas (seule une recette le compose) : le nom de la recette sert de repli',
  store.getState().meals.find((m) => m.id === p6MealId).name === 'Sans Stock CDE');
click($('[data-view="planning"]'));
await wait();
check('le nom auto-généré (repli recette) est bien affiché sur l’écran de planning', /Sans Stock CDE/.test($('#view').textContent));

console.log('\n— Écran batch : détail des ingrédients d’une recette à préparer + répartition vers les gamelles');
store.update((s) => {
  const r3 = store.newRecipe('Batch Detail CDE', 'weight');
  r3.items = [store.newRecipeItem(p4Beef.id, 1000, 'cru')];
  r3.baseGrams = 1000;
  r3.batchAllowed = true;
  s.recipes.push(r3);
  const meal = s.meals.find((m) => m.dayIndex === 0 && m.mealType === 'dinner');
  meal.items.push({ ...store.newRecipeMealItem(r3.id, 500), qty: { thomas: 500, julie: 0 } });
});
await wait();
click($('[data-view="batch"]'));
await wait();
check('« Recettes à préparer en batch » affichée avec la nouvelle recette', /Recettes à préparer en batch/.test($('#view').textContent) && /Batch Detail CDE/.test($('#view').textContent));
// toujours visible désormais (jamais repliée derrière un <details> qu'on manque facilement)
check('bloc « Recette totale à préparer » affiché sans avoir besoin de le déplier', /Recette totale à préparer/.test($('#view').textContent));
const batchRow = $$('td').find((td) => /Batch Detail CDE/.test(td.textContent));
check('ingrédient mis à l’échelle affiché (500 g, 500/1000 de la référence)', /500 g.*Steak haché|Steak haché.*500 g/.test(batchRow.textContent.replace(/\s+/g, ' ')));
check('répartition dans les gamelles affichée', /Répartition dans les gamelles/.test($('#view').textContent));

console.log('\n— Écran batch : recette « portion » NON batchable (assemblée le jour même) — même détail d’ingrédients');
store.update((s) => {
  const r4 = store.newRecipe('Skyr Flocons Test', 'portion');
  // 1 portion = somme des quantités de la composition (portionGramsOf(), nutrition.js) — ici 330 g,
  // comme la fiche recette réelle qui a motivé ce correctif.
  r4.items = [store.newRecipeItem(p4Beef.id, 330, 'cru')];
  s.recipes.push(r4);
  const meal = s.meals.find((m) => m.dayIndex === 1 && m.mealType === 'lunch');
  // qty est toujours stockée en GRAMMES dans le modèle (même pour une recette
  // « portion » — la conversion vers un nombre de portions n'est qu'un
  // affichage, cf. editor.js/toUnits()) : 4 portions × 330 g = 1320 g.
  // Jamais marquée batchAllowed : doit tomber dans « à assembler le jour même ».
  meal.items.push({ ...store.newRecipeMealItem(r4.id, 1320), qty: { thomas: 1320, julie: 0 } });
});
await wait();
click($('[data-view="batch"]'));
await wait();
const skyrLi = $$('li').find((li) => li.querySelector('ul') && /Skyr Flocons Test/.test(li.textContent));
check('« Skyr Flocons Test » apparaît avec son détail d’ingrédients, assemblée le jour même (jamais marquée batchAllowed)', !!skyrLi);
check('ingrédient mis à l’échelle affiché (4 portions × 330 g = 1,32 kg de Steak haché, pas la recette seule)',
  !!skyrLi && /1,32\s*kg.*Steak haché|Steak haché.*1,32\s*kg/.test(skyrLi.textContent.replace(/\s+/g, ' ')));

console.log('\n— Chantier P0 : suppression d’un aliment référencé dans une recette (composition live)');
click($('[data-view="foods"]'));
await wait();
click($('[data-new]'));
await wait();
type($('[data-f="name"]'), 'Pomme P0 Test');
click($('[data-save]'));
await wait();
const pommeP0 = store.getState().foods.find((f) => f.name === 'Pomme P0 Test');
let recetteP0Id;
store.update((s) => {
  const r = store.newRecipe('Compote P0 Test', 'weight');
  r.items = [store.newRecipeItem(pommeP0.id, 500, 'cru')];
  r.baseGrams = 500;
  s.recipes.push(r);
  recetteP0Id = r.id;
});
await wait();
const pommeRow = () => $$('tr').find((tr) => tr.textContent.includes('Pomme P0 Test'));
click(pommeRow().querySelector('[data-edit]'));
await wait();
click($('[data-delete]'));
await wait();
check('suppression bloquée : un toast explicite nomme la recette qui l’utilise', /Compote P0 Test/.test(lastToastText()));
check('l’aliment existe toujours', store.getState().foods.some((f) => f.id === pommeP0.id));

console.log('\n— Chantier P0 : suppression d’un aliment présent UNIQUEMENT dans le recipeSnapshot figé d’une préparation');
let farineP0, prepP0Id;
store.update((s) => {
  const farine = {
    id: 'food_farine_p0_test', name: 'Farine P0 Test', category: 'feculent', referenceState: 'cru',
    kcal: 364, protein: 10, carbs: 76, fat: 1, fiber: 3, cookedFactor: 1,
    brand: '', unitName: '', gramsPerUnit: 0, fractionable: true, price: null, packageWeight: null,
    batchAllowed: false, favorite: false, lastUsed: null, shelfLifeDays: null, requiresCooking: false,
    cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
  };
  s.foods.push(farine);
  farineP0 = farine;
  const r = store.newRecipe('Pain P0 Test', 'weight');
  r.items = [store.newRecipeItem(farine.id, 300, 'cru')];
  r.baseGrams = 300;
  s.recipes.push(r);
  const prep = store.newPreparation(r, 300);
  prepP0Id = prep.id;
  s.preparations.push(prep);
  // la recette LIVE évolue ensuite (la farine n'y figure plus) — seul le
  // recipeSnapshot de la préparation, volontairement figé, la référence encore.
  r.items = [store.newRecipeItem(pommeP0.id, 300, 'cru')];
});
await wait();
check('la recette live ne référence plus la farine (remplacée)', !store.getState().recipes.find((r) => r.name === 'Pain P0 Test').items.some((it) => it.foodId === farineP0.id));
check('le recipeSnapshot de la préparation la référence toujours (figé à la création)', store.getState().preparations.find((p) => p.id === prepP0Id).recipeSnapshot.items.some((it) => it.foodId === farineP0.id));
click($('[data-view="foods"]'));
await wait();
const farineRow = () => $$('tr').find((tr) => tr.textContent.includes('Farine P0 Test'));
click(farineRow().querySelector('[data-edit]'));
await wait();
click($('[data-delete]'));
await wait();
check('suppression bloquée par le recipeSnapshot figé d’une préparation (pas seulement les recettes live)',
  /Pain P0 Test/.test(lastToastText()));
check('l’aliment existe toujours', store.getState().foods.some((f) => f.id === farineP0.id));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier P0 : suppression d’une recette référencée directement (sans préparation) dans un repas');
let recetteP0bId, mealP0Id;
store.update((s) => {
  const r = store.newRecipe('Salade P0 Test', 'weight');
  r.items = [store.newRecipeItem(pommeP0.id, 200, 'cru')];
  r.baseGrams = 200;
  s.recipes.push(r);
  recetteP0bId = r.id;
  const meal = s.meals.find((m) => m.dayIndex === 0 && m.mealType === 'dinner');
  meal.items.push({ ...store.newRecipeMealItem(r.id, 200), qty: { thomas: 200, julie: 0 } });
  mealP0Id = meal.id;
});
await wait();
click($('[data-view="recipes"]'));
await wait();
const saladeRow = () => $$('tr').find((tr) => tr.textContent.includes('Salade P0 Test'));
click(saladeRow().querySelector('[data-edit]'));
await wait();
click($('[data-delete]'));
await wait();
check('suppression bloquée : référence directe (sans préparation) dans un repas détectée',
  /encore utilisée directement/.test(lastToastText()));
check('la recette existe toujours', store.getState().recipes.some((r) => r.id === recetteP0bId));
// on retire la référence, puis la suppression doit réussir
store.update((s) => {
  const meal = s.meals.find((m) => m.id === mealP0Id);
  meal.items = meal.items.filter((it) => it.recipeId !== recetteP0bId);
});
await wait();
click(saladeRow().querySelector('[data-edit]'));
await wait();
click($('[data-delete]'));
await wait();
click($('[data-action-confirm]')); // confirmation bloquante (P1, remplace confirm() natif)
await wait();
check('une fois la référence retirée, la suppression de la recette réussit', !store.getState().recipes.some((r) => r.id === recetteP0bId));

console.log('\n— Chantier P0 : duplication d’un repas — nameAuto suit le nom copié');
let srcManualId, dstEmptyId, srcAutoId, dstEmpty2Id;
store.update((s) => {
  const r = store.newRecipe('Risotto P0 Dup', 'weight');
  r.items = [store.newRecipeItem(pommeP0.id, 300, 'cru')];
  r.baseGrams = 300;
  s.recipes.push(r);

  const empties = s.meals.filter((m) => m.items.length === 0);
  const srcManual = empties[0];
  srcManual.items = [{ ...store.newRecipeMealItem(r.id, 300), qty: { thomas: 300, julie: 0 } }];
  srcManual.name = 'Déjeuner de Thomas (nom manuel)';
  srcManual.nameAuto = false;
  srcManualId = srcManual.id;
  dstEmptyId = empties[1].id;

  const srcAuto = empties[2];
  srcAuto.items = [{ ...store.newRecipeMealItem(r.id, 300), qty: { thomas: 300, julie: 0 } }];
  srcAuto.name = 'Risotto P0 Dup';
  srcAuto.nameAuto = true;
  srcAutoId = srcAuto.id;
  dstEmpty2Id = empties[3].id;
});
await wait();
click($('[data-view="planning"]'));
await wait();
click($$('[data-dup]').find((b) => b.dataset.dup === srcManualId));
await wait();
click($$('[data-target]').find((cb) => cb.dataset.target === dstEmptyId));
await wait();
click($('[data-dup-confirm]'));
await wait();
const dstManual = () => store.getState().meals.find((m) => m.id === dstEmptyId);
check('un nom manuel (nameAuto:false) copié reste nameAuto:false dans la destination', dstManual().nameAuto === false);
check('le nom copié est identique à la source', dstManual().name === 'Déjeuner de Thomas (nom manuel)');

click($$('[data-dup]').find((b) => b.dataset.dup === srcAutoId));
await wait();
click($$('[data-target]').find((cb) => cb.dataset.target === dstEmpty2Id));
await wait();
click($('[data-dup-confirm]'));
await wait();
const dstAuto = () => store.getState().meals.find((m) => m.id === dstEmpty2Id);
check('un nom auto-généré (nameAuto:true) copié reste nameAuto:true dans la destination (régénérable sur SA composition)', dstAuto().nameAuto === true);

console.log('\n— Chantier P0 : « Vider ce repas » réinitialise nameAuto à true (équivalent newMeal())');
click($$('[data-clear]').find((b) => b.dataset.clear === dstEmptyId));
await wait();
check('confirmation bloquante affichée avant de vider le repas (P1)', !!$('[data-action-confirm]'));
click($('[data-action-confirm]'));
await wait();
const dstCleared = () => store.getState().meals.find((m) => m.id === dstEmptyId);
check('repas vidé : items vides', dstCleared().items.length === 0);
check('repas vidé : nom vide', dstCleared().name === '');
check('repas vidé : nameAuto repasse à true (un nom manuel ne reste jamais bloqué après un vidage complet)', dstCleared().nameAuto === true);

console.log('\n— Chantier P1 : export/import JSON — cycle complet (export → modif → import → comparaison)');
let exportedJsonP1, p1xRecipeId, p1xPrepId;
store.update((s) => {
  const r = store.newRecipe('Risotto P1 Export', 'weight');
  r.items = [store.newRecipeItem(pommeP0.id, 300, 'cru')];
  r.baseGrams = 300;
  s.recipes.push(r);
  p1xRecipeId = r.id;
  const prep = store.newPreparation(r, 300);
  p1xPrepId = prep.id;
  s.preparations.push(prep);
});
await wait();
exportedJsonP1 = store.exportJSON();
const exportedParsed = JSON.parse(exportedJsonP1);
check('export : schemaVersion présent', Number.isFinite(exportedParsed.schemaVersion));
check('export : recettes et préparations incluses (pas seulement les aliments)',
  exportedParsed.recipes.some((r) => r.id === p1xRecipeId) && exportedParsed.preparations.some((p) => p.id === p1xPrepId));

// modification locale APRÈS l'export, pour vérifier que l'import restaure
// bien l'état exporté (et efface ce qui a été fait depuis)
let foodAjouteApresExportId;
store.update((s) => {
  const f = { ...s.foods[0], id: 'food_ajoute_apres_export_p1', name: 'Ajouté Après Export P1' };
  s.foods.push(f);
  foodAjouteApresExportId = f.id;
  s.recipes = s.recipes.filter((r) => r.id !== p1xRecipeId);
});
await wait();
check('modification locale bien appliquée avant import (aliment ajouté, recette supprimée)',
  store.getState().foods.some((f) => f.id === foodAjouteApresExportId) && !store.getState().recipes.some((r) => r.id === p1xRecipeId));

store.importJSON(exportedJsonP1);
await wait();
check('import : l’aliment ajouté APRÈS l’export a disparu (remplacement complet, pas une fusion)',
  !store.getState().foods.some((f) => f.id === foodAjouteApresExportId));
check('import : la recette présente AU MOMENT de l’export est restaurée', store.getState().recipes.some((r) => r.id === p1xRecipeId));
check('import : la préparation est restaurée avec son recipeSnapshot intact', store.getState().preparations.find((p) => p.id === p1xPrepId)?.recipeSnapshot?.items?.length === 1);

console.log('\n— Chantier P1 : export/import JSON — validation des fichiers malformés');
check('JSON syntaxiquement invalide : erreur explicite, aucun crash', (() => {
  try { store.importJSON('{ ceci n’est pas du JSON'); return false; }
  catch (e) { return /JSON valide/.test(e.message); }
})());
check('JSON valide mais pas une sauvegarde (tableau à la racine) : erreur explicite', (() => {
  try { store.importJSON('[1,2,3]'); return false; }
  catch (e) { return /pas une sauvegarde/.test(e.message); }
})());
check('objet JSON valide mais sans "foods" : erreur explicite', (() => {
  try { store.importJSON('{"hello":"world"}'); return false; }
  catch (e) { return /banque alimentaire absente/.test(e.message); }
})());
check('schemaVersion plus récent que celui connu par le code : import refusé, rien n’est modifié', (() => {
  const before = JSON.stringify(store.getState());
  try {
    store.importJSON(JSON.stringify({ foods: [], schemaVersion: 999 }));
    return false;
  } catch (e) {
    return /version plus récente/.test(e.message) && JSON.stringify(store.getState()) === before;
  }
})());
check('un export SANS schemaVersion (antérieur à son introduction) reste importable', (() => {
  const { schemaVersion, ...withoutVersion } = exportedParsed;
  store.importJSON(JSON.stringify(withoutVersion));
  return store.getState().recipes.some((r) => r.id === p1xRecipeId);
})());

console.log('\n— Chantier P1 : sauvegarde locale de secours (backupLocal / restoreBackup)');
check('aucune sauvegarde de secours avant le premier appel à backupLocal()', store.backupInfo() === null);
const stateBeforeBackup = JSON.stringify(store.getState());
check('backupLocal() réussit et retourne true', store.backupLocal() === true);
check('backupInfo() renvoie désormais une date', typeof store.backupInfo()?.savedAt === 'string' && !isNaN(Date.parse(store.backupInfo().savedAt)));

// modification locale APRÈS la sauvegarde — restoreBackup() doit l'annuler
let markerAjouteApresBackupId;
store.update((s) => {
  const f = { ...s.foods[0], id: 'food_marker_apres_backup_p1', name: 'Marker Après Backup P1' };
  s.foods.push(f);
  markerAjouteApresBackupId = f.id;
});
await wait();
check('la modification locale est bien appliquée avant restauration', store.getState().foods.some((f) => f.id === markerAjouteApresBackupId));
store.restoreBackup();
await wait();
check('restoreBackup() annule la modification faite après la sauvegarde', !store.getState().foods.some((f) => f.id === markerAjouteApresBackupId));
check('restoreBackup() restaure exactement l’état sauvegardé (hors horodatage meta)',
  JSON.stringify({ ...store.getState(), meta: undefined }) === JSON.stringify({ ...JSON.parse(stateBeforeBackup), meta: undefined }));

console.log('\n— Chantier P1 : erreurs de stockage local — ne doivent jamais faire planter l’application');
// localStorage (jsdom comme les navigateurs) traite une AFFECTATION directe
// de propriété (`localStorage.setItem = …`) comme un setItem('setItem', …)
// littéral plutôt que comme un remplacement de méthode — il faut passer par
// le prototype partagé pour réellement intercepter l'appel.
const StorageProto = Object.getPrototypeOf(localStorage);
const originalSetItem = StorageProto.setItem;
StorageProto.setItem = () => { throw new Error('QuotaExceededError (simulé)'); };
check('backupLocal() : une erreur de stockage est absorbée, retourne false (pas d’exception non interceptée)', store.backupLocal() === false);
StorageProto.setItem = originalSetItem;

console.log('\n— Chantier P1 : restoreBackup() sans sauvegarde disponible — erreur explicite, pas un crash silencieux');
localStorage.removeItem('nutriplan.state.v1.backup');
check('backupInfo() redevient null après suppression de la sauvegarde', store.backupInfo() === null);
check('restoreBackup() lève une erreur explicite quand aucune sauvegarde n’existe', (() => {
  try { store.restoreBackup(); return false; }
  catch (e) { return /[Aa]ucune sauvegarde/.test(e.message); }
})());

console.log('\n— Chantier P1 : garde « modifications non sauvegardées » sur le panneau de création de préparation');
let p1dRecipeId;
store.update((s) => {
  const r = store.newRecipe('Tarte P1D Test', 'weight');
  r.items = [store.newRecipeItem(pommeP0.id, 400, 'cru')];
  r.baseGrams = 400;
  s.recipes.push(r);
  p1dRecipeId = r.id;
});
await wait();
click($('[data-view="preparations"]'));
await wait();

// formulaire VIERGE (recette par défaut, aucune quantité saisie) : fermeture directe
click($('[data-open-create]'));
await wait();
check('panneau de création ouvert', !!$('[data-create-qty]'));
click($('[data-create-cancel]'));
await wait();
check('formulaire vierge : fermeture immédiate sans dialogue', !$('[data-create-qty]') && !$('[data-unsaved-stay]'));

// quantité saisie puis tentative de fermeture : dialogue affiché
click($('[data-open-create]'));
await wait();
change($('[data-create-qty]'), '350');
await wait();
click($('[data-create-cancel]'));
await wait();
check('quantité saisie : dialogue de confirmation affiché', !!$('[data-unsaved-stay]'));
check('le panneau reste ouvert derrière le dialogue (pas fermé silencieusement)', !!$('[data-create-qty]'));

// "Non, retour" : la saisie est conservée
click($('[data-unsaved-stay]'));
await wait();
check('« Non, retour » : saisie conservée', $('[data-create-qty]').value === '350');
check('dialogue refermé', !$('[data-unsaved-stay]'));

// "Oui, tant pis" : ferme sans créer de préparation
click($('[data-create-cancel]'));
await wait();
click($('[data-unsaved-discard]'));
await wait();
check('« Oui, tant pis » : panneau fermé', !$('[data-create-qty]'));
check('aucune préparation créée pour "Tarte P1D Test"', !store.getState().preparations.some((p) => p.recipeId === p1dRecipeId));

// changer de recette (même sans quantité) compte comme une modification
click($('[data-open-create]'));
await wait();
const otherRecipeOpt = [...$('[data-create-recipe]').options].find((o) => o.value !== $('[data-create-recipe]').value);
if (otherRecipeOpt) {
  change($('[data-create-recipe]'), otherRecipeOpt.value);
  await wait();
  click($('[data-create-cancel]'));
  await wait();
  check('changer de recette sans rouvrir avec quantité : dialogue affiché (sélection perdue sinon)', !!$('[data-unsaved-stay]'));
  click($('[data-unsaved-discard]'));
  await wait();
}

// création réussie : aucune confirmation après coup
click($('[data-open-create]'));
await wait();
change($('[data-create-recipe]'), p1dRecipeId);
await wait();
change($('[data-create-qty]'), '400');
await wait();
click($('[data-create-confirm]'));
await wait();
check('création réussie : panneau fermé directement, sans dialogue', !$('[data-create-qty]') && !$('[data-unsaved-stay]'));
check('préparation bien créée', store.getState().preparations.some((p) => p.recipeId === p1dRecipeId));

console.log('\n— Chantier P1 : suppression d’une option de catalogue — confirmation bloquante (remplace confirm() natif)');
click($('[data-view="breakfasts"]'));
await wait();
const breakfastCountBefore = store.getState().breakfasts.length;
check('au moins une option de petit-déjeuner existante (créée plus tôt dans la suite)', breakfastCountBefore > 0);
const delBtn = $('[data-del]');
check('bouton de suppression présent', !!delBtn);
click(delBtn);
await wait();
check('confirmation bloquante affichée, aucune suppression immédiate', !!$('[data-action-confirm]') && store.getState().breakfasts.length === breakfastCountBefore);
click($('[data-action-cancel]'));
await wait();
check('« Annuler » : option toujours présente', store.getState().breakfasts.length === breakfastCountBefore);
click($('[data-del]'));
await wait();
click($('[data-action-confirm]'));
await wait();
check('confirmation : option bien supprimée', store.getState().breakfasts.length === breakfastCountBefore - 1);

console.log('\n— Chantier P1 : Paramètres — « Rétablir les objectifs par défaut » (confirmation bloquante)');
click($('[data-view="settings"]'));
await wait();
store.update((s) => { s.settings.targets.thomas.day.kcal = 1234; });
await wait();
click($('[data-reset-targets]'));
await wait();
check('confirmation affichée, rien modifié avant confirmation', !!$('[data-action-confirm]') && store.getState().settings.targets.thomas.day.kcal === 1234);
click($('[data-action-cancel]'));
await wait();
check('« Annuler » : objectif inchangé', store.getState().settings.targets.thomas.day.kcal === 1234);
click($('[data-reset-targets]'));
await wait();
click($('[data-action-confirm]'));
await wait();
check('confirmation : objectifs rétablis par défaut', store.getState().settings.targets.thomas.day.kcal !== 1234);

console.log('\n— Chantier P3 : écran Aliments — fusion de doublons détectés (parcours complet)');
let foodKeepId, foodAwayId, recipeMergeId;
store.update((s) => {
  const base = s.foods[0];
  const keep = { ...base, id: 'food_p3merge_keep', name: 'Yaourt Nature P3 Fusion', brand: 'MarqueTest' };
  const away = { ...base, id: 'food_p3merge_away', name: 'Yaourt Nature P3 Fusion', brand: 'MarqueTest' };
  s.foods.push(keep, away);
  foodKeepId = keep.id;
  foodAwayId = away.id;
  const r = store.newRecipe('Recette P3 Fusion', 'weight');
  r.items = [store.newRecipeItem(away.id, 150, 'cru')];
  r.baseGrams = 150;
  s.recipes.push(r);
  recipeMergeId = r.id;
});
await wait();
click($('[data-view="foods"]'));
await wait();
const toggleDup = $('[data-toggle-duplicates]');
check('bouton "Voir les doublons possibles" affiché', !!toggleDup);
click(toggleDup);
await wait();
const groupCard = () => $$('[data-merge-group]').find((b) => {
  const card = b.closest('.card');
  return /Yaourt Nature P3 Fusion/.test(card.textContent);
});
check('groupe de doublons affiché avec les deux aliments', !!groupCard());
// coche explicitement l'aliment à conserver (celui créé en premier dans ce test)
const keepRadio = $$('[data-merge-keep]').find((r) => r.value === foodKeepId);
check('case à cocher pour choisir l’aliment à conserver', !!keepRadio);
click(keepRadio);
await wait();
click(groupCard());
await wait();
check('confirmation bloquante affichée avant toute fusion', !!$('[data-action-confirm]'));
check('rien fusionné avant confirmation : les deux aliments existent toujours', store.getState().foods.some((f) => f.id === foodAwayId));
click($('[data-action-cancel]'));
await wait();
check('« Annuler » : aucune fusion, les deux aliments existent toujours', store.getState().foods.some((f) => f.id === foodAwayId) && store.getState().foods.some((f) => f.id === foodKeepId));

click(groupCard());
await wait();
click($('[data-action-confirm]'));
await wait();
check('confirmation : l’aliment choisi pour être fusionné a disparu', !store.getState().foods.some((f) => f.id === foodAwayId));
check('l’aliment conservé existe toujours', store.getState().foods.some((f) => f.id === foodKeepId));
check('la référence de la recette a bien été redirigée vers l’aliment conservé',
  store.getState().recipes.find((r) => r.id === recipeMergeId).items[0].foodId === foodKeepId);
check('toast confirmant la fusion avec un résumé', /[Ff]usion/.test(lastToastText()));

console.log('\n— Chantier P4 : écran Aliments — la section « Doublons » reste à jour après un ajout (cache de performance)');
let laterAwayId;
store.update((s) => {
  const keepFoodNow = s.foods.find((f) => f.id === foodKeepId);
  const laterAway = { ...keepFoodNow, id: 'food_p4later_away' };
  s.foods.push(laterAway);
  laterAwayId = laterAway.id;
});
await wait();
// la banque a changé APRÈS le premier calcul des groupes (déjà déclenché par
// le rendu initial de cet écran) : le cache (getDuplicateGroups(), foods.js)
// doit recalculer plutôt que de renvoyer un résultat figé.
const toggleDup2 = $('[data-toggle-duplicates]');
if (toggleDup2 && !/Masquer/.test(toggleDup2.textContent)) { click(toggleDup2); await wait(); }
check('un aliment ajouté APRÈS un premier calcul apparaît bien dans les groupes (cache correctement invalidé)',
  $$('[data-merge-keep]').some((r) => r.value === laterAwayId));

console.log('\n— Chantier P4 : confirmation bloquante (confirm-action.js) — fermeture au clavier (Échap)');
let recetteP4Id;
store.update((s) => {
  const base = s.foods[0];
  const r = store.newRecipe('Recette P4 Échap Test', 'weight');
  r.items = [store.newRecipeItem(base.id, 100, 'cru')];
  r.baseGrams = 100;
  s.recipes.push(r); // jamais référencée ailleurs : la suppression doit proposer directement la confirmation bloquante
  recetteP4Id = r.id;
  s.foods = s.foods.filter((f) => f.id !== laterAwayId);
});
await wait();
click($('[data-view="recipes"]'));
await wait();
const p4Row = () => $$('tr').find((tr) => tr.textContent.includes('Recette P4 Échap Test'));
click(p4Row().querySelector('[data-edit]'));
await wait();
click($('[data-delete]'));
await wait();
check('confirmation bloquante affichée avant le test Échap', !!$('[data-action-confirm]'));
escapeKey();
await wait();
check('Échap ferme la confirmation bloquante sans déclencher l’action', !$('[data-action-confirm]'));
check('Échap n’a pas supprimé la recette (annulation, pas confirmation)', store.getState().recipes.some((r) => r.id === recetteP4Id));

console.log('\n— Chantier Open Food Facts : recherche par code-barres (produit trouvé, préremplissage, enregistrement)');
const realFetch = globalThis.fetch;
const jsonRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
click($('[data-view="foods"]'));
await wait();
click($('[data-new]'));
await wait();
check('bouton de recherche Open Food Facts affiché pour un NOUVEL aliment', !!$('[data-off-open]'));
click($('[data-off-open]'));
await wait();
check('panneau de recherche OFF ouvert', !!$('[data-off-backdrop]'));
type($('[data-off-barcode]'), '3017620422003');
globalThis.fetch = async (url) => {
  // chemin stable que OFF_PROXY_URL soit configuré (js/config.js) ou non.
  check('endpoint code-barres appelé (pas la recherche texte)', /\/product\/3017620422003\.json/.test(url));
  return jsonRes({
    status: 1, code: '3017620422003',
    product: {
      product_name_fr: 'Pâte à tartiner Test OFF', brands: 'MarqueOFF,AutreMarque', quantity: '400 g',
      nutriments: { 'energy-kcal_100g': 539, proteins_100g: 6.3, carbohydrates_100g: 57.5, fat_100g: 30.9, sugars_100g: 56.3, salt_100g: 0.107 },
      nutriscore_grade: 'E', url: 'https://world.openfoodfacts.org/product/3017620422003',
    },
  });
};
click($('[data-off-barcode-go]'));
await wait();
check('produit trouvé affiché', /Pâte à tartiner Test OFF/.test($('[data-off-backdrop]').textContent));
check('marque affichée (une seule, la première)', /MarqueOFF/.test($('[data-off-backdrop]').textContent) && !/AutreMarque/.test($('[data-off-backdrop]').textContent));
click($('[data-off-use]'));
await wait();
check('panneau OFF refermé après sélection', !$('[data-off-backdrop]'));
check('nom préremplit le formulaire', $('[data-f="name"]').value === 'Pâte à tartiner Test OFF');
check('marque préremplie', $('[data-f="brand"]').value === 'MarqueOFF');
check('kcal prérempli', Number($('[data-f="kcal"]').value) === 539);
check('code-barres prérempli (chaîne, pas un nombre affiché différemment)', $('[data-f="barcode"]').value === '3017620422003');
check('sucres (valeur complémentaire OFF) préremplis', Number($('[data-f="sugars"]').value) === 56.3);
check('fibre ABSENTE sur la fiche OFF reste vide, jamais forcée à 0', $('[data-f="fiber"]').value === '');
// Ce produit n'a pas de categories_tags OFF (fiche incomplète) : aucune
// suggestion fiable de catégorie n'est possible -> le champ reste à sa
// valeur par défaut (« Autre »), jamais une catégorie inventée.
check('aucune catégorie OFF fournie -> reste à la valeur par défaut, jamais inventée', $('[data-f="category"]').value === 'autre');
change($('[data-f="category"]'), 'autre'); // toujours modifiable manuellement, comme avant
click($('[data-save]'));
await wait();
const createdOff = store.getState().foods.find((f) => f.barcode === '3017620422003');
check('aliment enregistré avec son code-barres', !!createdOff);
check('toast de confirmation', /enregistré/i.test(lastToastText()));
globalThis.fetch = realFetch;

console.log('\n— Chantier Open Food Facts : code-barres déjà présent dans la banque (doublon fort, jamais silencieux)');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
type($('[data-off-barcode]'), '3017620422003'); // même code que l'aliment déjà créé ci-dessus
globalThis.fetch = async () => jsonRes({
  status: 1, code: '3017620422003',
  product: { product_name: 'Pâte à tartiner Test OFF', nutriments: {} },
});
click($('[data-off-barcode-go]'));
await wait();
check('doublon détecté : proposition d’ouvrir la fiche existante plutôt que d’en créer une seconde', !!$('[data-off-open-existing]'));
click($('[data-off-open-existing]'));
await wait();
check('la fiche EXISTANTE est ouverte (édition), pas une nouvelle création', $('.drawer__head h3')?.textContent.includes('Modifier'));
check('toujours un seul aliment pour ce code-barres', store.getState().foods.filter((f) => f.barcode === '3017620422003').length === 1);
globalThis.fetch = realFetch;
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Open Food Facts : code-barres absent de la base (pas une erreur, saisie manuelle possible)');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
type($('[data-off-barcode]'), '0000000000000');
globalThis.fetch = async () => jsonRes({ status: 0, code: '0000000000000', status_verbose: 'product not found' });
click($('[data-off-barcode-go]'));
await wait();
check('message "non trouvé" affiché, jamais présenté comme une erreur', /[Aa]ucun produit trouvé/.test($('[data-off-backdrop]').textContent));
check('pas de blocage : le formulaire de saisie manuelle reste utilisable', !!$('[data-f="name"]'));
globalThis.fetch = realFetch;
click($('[data-off-cancel]'));
await wait();
check('retour en saisie manuelle : le panneau OFF se ferme, le formulaire de création reste ouvert', !$('[data-off-backdrop]') && !!$('[data-f="name"]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Open Food Facts : recherche par nom/marque — plusieurs résultats, sélection explicite, jamais de création automatique');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
globalThis.fetch = async (url) => {
  // chemin stable que OFF_PROXY_URL soit configuré ou non — jamais le même
  // chemin que la fiche produit par code-barres.
  check('endpoint de recherche texte (distinct de la fiche produit par code-barres)', /\/search\?/.test(url) && /q=/.test(url) && !/\/product\//.test(url));
  return jsonRes({
    count: 2,
    hits: [
      { code: '1111111111111', product_name: 'Yaourt OFF Test A', brands: 'MarqueA', nutriments: { 'energy-kcal_100g': 60 } },
      { code: '2222222222222', product_name: 'Yaourt OFF Test B', brands: 'MarqueB', nutriments: { 'energy-kcal_100g': 45 } },
    ],
  });
};
type($('[data-off-name]'), 'yaourt off test');
await new Promise((r) => setTimeout(r, 600)); // au-delà du délai de temporisation (debounce) de la recherche
check('deux résultats affichés, aucune création automatique', /Yaourt OFF Test A/.test($('[data-off-backdrop]').textContent) && /Yaourt OFF Test B/.test($('[data-off-backdrop]').textContent));
check('aucun aliment créé avant sélection explicite', !store.getState().foods.some((f) => f.name.startsWith('Yaourt OFF Test')));
const useButtons = () => $$('[data-off-use]');
check('un bouton de sélection par résultat', useButtons().length === 2);
click(useButtons().find((b) => b.dataset.offUse === '2222222222222'));
await wait();
check('le BON résultat sélectionné préremplit le formulaire (pas le premier par défaut)', $('[data-f="name"]').value === 'Yaourt OFF Test B' && Number($('[data-f="kcal"]').value) === 45);
globalThis.fetch = realFetch;
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Open Food Facts : une réponse périmée (recherche précédente) n’écrase jamais une recherche plus récente');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
let resolveSlow;
let fastCalled = false;
globalThis.fetch = async (url) => {
  if (/q=lent/.test(url)) {
    return new Promise((resolve) => { resolveSlow = () => resolve(jsonRes({ count: 1, hits: [{ code: '1', product_name: 'RÉSULTAT PÉRIMÉ', nutriments: {} }] })); });
  }
  fastCalled = true;
  return jsonRes({ count: 1, hits: [{ code: '2', product_name: 'RÉSULTAT RÉCENT', nutriments: {} }] });
};
type($('[data-off-name]'), 'lent');
await new Promise((r) => setTimeout(r, 600)); // déclenche la recherche "lente", encore en attente
type($('[data-off-name]'), 'rapide');
await new Promise((r) => setTimeout(r, 600)); // la recherche "rapide" part et se résout en premier
check('la recherche la plus récente s’est bien exécutée', fastCalled);
resolveSlow?.(); // la réponse "périmée" arrive maintenant, après la plus récente
await wait();
check('seul le résultat de la recherche la plus récente est affiché', /RÉSULTAT RÉCENT/.test($('[data-off-backdrop]').textContent));
check('la réponse périmée n’a PAS écrasé l’affichage', !/RÉSULTAT PÉRIMÉ/.test($('[data-off-backdrop]').textContent));
globalThis.fetch = realFetch;
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Open Food Facts : erreur réseau — message explicite, jamais un blocage silencieux');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
type($('[data-off-barcode]'), '1234567890123');
globalThis.fetch = async () => { throw new TypeError('network down'); };
click($('[data-off-barcode-go]'));
await wait();
check('message d’erreur réseau explicite affiché', /[Cc]onnexion.*[Oo]pen Food Facts/.test($('[data-off-backdrop]').textContent) || /réseau/i.test($('[data-off-backdrop]').textContent));
check('bouton « Réessayer » proposé', !!$('[data-off-retry]'));
globalThis.fetch = realFetch;
click($('[data-off-cancel]'));
await wait();
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Open Food Facts : remplace une saisie manuelle déjà en cours seulement après confirmation');
click($('[data-new]'));
await wait();
type($('[data-f="name"]'), 'Saisie manuelle déjà commencée');
click($('[data-off-open]'));
await wait();
type($('[data-off-barcode]'), '5555555555555');
globalThis.fetch = async () => jsonRes({
  status: 1, code: '5555555555555',
  product: { product_name: 'Produit OFF qui écraserait la saisie', nutriments: { 'energy-kcal_100g': 100 } },
});
click($('[data-off-barcode-go]'));
await wait();
click($('[data-off-use]'));
await wait();
check('une confirmation est demandée avant d’écraser une saisie manuelle déjà en cours', !!$('[data-action-confirm]'));
check('rien n’est encore remplacé tant que la confirmation n’a pas eu lieu', $('[data-f="name"]')?.value === 'Saisie manuelle déjà commencée' || !$('[data-f="name"]'));
click($('[data-action-confirm]'));
await wait();
check('après confirmation explicite, les données OFF remplacent bien la saisie', $('[data-f="name"]').value === 'Produit OFF qui écraserait la saisie');
globalThis.fetch = realFetch;
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Open Food Facts : catégorie suggérée depuis les categories_tags, toujours modifiable');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
type($('[data-off-barcode]'), '7777777777777');
globalThis.fetch = async () => jsonRes({
  status: 1, code: '7777777777777',
  product: {
    product_name: 'Yaourt nature Test Catégorie', categories_tags: ['en:yogurts', 'en:dairies'],
    nutriments: { 'energy-kcal_100g': 60 },
  },
});
click($('[data-off-barcode-go]'));
await wait();
check('catégorie suggérée affichée sur la fiche produit avant même sélection', /Catégorie suggérée : Produit laitier/.test($('[data-off-backdrop]').textContent));
click($('[data-off-use]'));
await wait();
check('catégorie correctement préremplie dans le formulaire (laitier)', $('[data-f="category"]').value === 'laitier');
check('indication que la catégorie est une suggestion modifiable', /Suggestion Open Food Facts/.test($('[data-form-backdrop]').textContent));
// L'utilisateur reste libre de modifier la suggestion AVANT enregistrement —
// et ce choix manuel doit être conservé, jamais silencieusement rétabli.
change($('[data-f="category"]'), 'matiere_grasse');
type($('[data-f="name"]'), 'Yaourt nature Test Catégorie (corrigé)');
click($('[data-save]'));
await wait();
const createdCatOverride = store.getState().foods.find((f) => f.barcode === '7777777777777');
check('le choix manuel de catégorie (différent de la suggestion) est bien celui enregistré', createdCatOverride?.category === 'matiere_grasse');
globalThis.fetch = realFetch;

console.log('\n— Chantier Open Food Facts : la modification d’un aliment EXISTANT n’est jamais affectée par la catégorisation automatique');
click($('[data-edit="' + createdCatOverride.id + '"]'));
await wait();
check('aucun bouton de recherche Open Food Facts en modification (uniquement à la création)', !$('[data-off-open]'));
check('la catégorie enregistrée (choix manuel précédent) reste intacte à l’ouverture', $('[data-f="category"]').value === 'matiere_grasse');
check('aucune indication de suggestion sur un aliment déjà enregistré en modification', !/Suggestion Open Food Facts/.test($('[data-form-backdrop]').textContent));
click($('[data-form-cancel]'));
await wait();

/* ------------------------------------------------------------------ */
/* Lecture de code-barres par caméra — AUCUNE caméra/bibliothèque réelle : */
/* tout est injecté via __setTestLib()/__setTestDevices() (barcode-scanner.js). */
/* ------------------------------------------------------------------ */

/** Simule @zxing/browser : une entrée par appel à decodeFromVideoDevice(), avec son propre compteur d'arrêt. */
function makeFakeScannerLib({ onStart, withTorch = false } = {}) {
  const calls = [];
  let torchOn = null; // état réel du flash côté "matériel" simulé — null tant que jamais activé/désactivé
  // getKind() : reproduit l'API réelle d'Exception (@zxing/library) — c'est ce
  // signal, pas instanceof, que barcode-scanner.js utilise pour reconnaître
  // une exception "normale" de lecture (rien dans le cadre à cet instant).
  class FakeException extends Error { getKind() { return this.constructor.kind; } }
  class NotFoundException extends FakeException { static kind = 'NotFoundException'; }
  class ChecksumException extends FakeException { static kind = 'ChecksumException'; }
  class FormatException extends FakeException { static kind = 'FormatException'; }
  class FakeReader {
    constructor(hints) { this.hints = hints; }
    async decodeFromVideoDevice(deviceId, videoElement, callback) {
      if (onStart) await onStart(deviceId); // permet de simuler un rejet (erreur caméra)
      const entry = { deviceId, videoElement, stopCount: 0 };
      const controls = {
        stop: () => { entry.stopCount++; },
        streamVideoSettingsGet: () => ({ deviceId: deviceId || 'env-camera' }),
        // switchTorch n'existe QUE si le matériel la supporte (même convention
        // que la vraie bibliothèque @zxing/browser — cf. barcode-scanner.js,
        // hasTorch() teste la seule PRÉSENCE de cette méthode).
        ...(withTorch ? { switchTorch: async (on) => { torchOn = on; } } : {}),
      };
      entry.emit = (result, error) => callback(result, error, controls);
      calls.push(entry);
      return controls;
    }
  }
  Object.defineProperty(calls, 'torchState', { get: () => torchOn });
  const lib = {
    BrowserMultiFormatOneDReader: FakeReader,
    DecodeHintType: { POSSIBLE_FORMATS: 'POSSIBLE_FORMATS' },
    BarcodeFormat: { EAN_13: 'EAN_13', EAN_8: 'EAN_8', UPC_A: 'UPC_A', UPC_E: 'UPC_E', CODE_128: 'CODE_128' },
    NotFoundException, ChecksumException, FormatException,
  };
  return { lib, calls };
}

const realMediaDevices = window.navigator.mediaDevices;
const stubCameraSupport = () => { window.navigator.mediaDevices = { getUserMedia: async () => ({ getVideoTracks: () => [] }) }; };
const restoreCameraSupport = () => { window.navigator.mediaDevices = realMediaDevices; };

console.log('\n— Chantier Scanner caméra : bouton absent quand la caméra n’est pas prise en charge (repli recherche manuelle intact)');
restoreCameraSupport();
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
check('aucun bouton « Scanner » proposé sans support caméra', !$('[data-off-scan-open]'));
check('la recherche OFF manuelle reste pleinement utilisable malgré l’absence de caméra', !$('[data-off-barcode]')?.disabled);
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : détection réussie -> transmise telle quelle à la recherche OFF déjà existante');
stubCameraSupport();
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
check('bouton « Scanner un code-barres » proposé (caméra prise en charge)', !!$('[data-off-scan-open]'));
{
  const { lib, calls } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  check('panneau scanner ouvert, flux vidéo affiché', !!$('#scanner-video'));
  check('instruction de positionnement affichée une fois le flux démarré', /Positionne le code-barres/.test($('[data-scanner-backdrop]').textContent));
  check('aucun deviceId explicite au premier démarrage (repli caméra arrière géré par la bibliothèque)', calls[0].deviceId === undefined);

  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount++;
    check('endpoint code-barres appelé après détection caméra (pas la recherche texte)', /\/product\/00012345678905\.json/.test(url));
    return jsonRes({
      status: 1, code: '00012345678905',
      product: { product_name: 'Produit scanné Test', nutriments: { 'energy-kcal_100g': 42 } },
    });
  };
  // code-barres AVEC un zéro initial : jamais perdu entre la caméra et la recherche OFF.
  calls[0].emit({ getText: () => '00012345678905' }, undefined);
  await wait();
  check('le scanner s’est refermé après une détection réussie', !$('[data-scanner-backdrop]'));
  check('la caméra a bien été arrêtée (plus aucune piste active)', calls[0].stopCount >= 1);
  check('le panneau OFF reste ouvert, avec le résultat trouvé (recherche existante réutilisée, jamais dupliquée)', /Produit scanné Test/.test($('[data-off-backdrop]').textContent));
  check('une seule recherche OFF déclenchée pour une seule détection', fetchCount === 1);
  check('aucune création automatique : le formulaire n’est pas encore rempli tant que « Utiliser ce produit » n’a pas été cliqué', $('[data-f="name"]').value !== 'Produit scanné Test');
  click($('[data-off-use]'));
  await wait();
  check('code-barres transmis AVEC son zéro initial jusqu’au formulaire', $('[data-f="barcode"]').value === '00012345678905');
  check('nom prérempli via le parcours OFF existant (aucune logique dupliquée)', $('[data-f="name"]').value === 'Produit scanné Test');
  globalThis.fetch = realFetch;
  scannerLib.__setTestLib(null);
}
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : "rien dans le cadre" (frames sans code lisible) ne déclenche jamais d’erreur affichée');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  const { lib, calls } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  // simule plusieurs frames consécutives sans code lisible — le cas le plus
  // fréquent en usage réel, qui a justement révélé en navigateur réel que ce
  // module devait reconnaître ces exceptions par leur "kind" et non par
  // instanceof (deux modules ZXing chargés séparément -> classes distinctes).
  calls[0].emit(undefined, new lib.NotFoundException());
  calls[0].emit(undefined, new lib.ChecksumException());
  calls[0].emit(undefined, new lib.FormatException());
  await wait();
  check('le scanner reste actif après plusieurs "rien détecté"', !!$('[data-scanner-backdrop]'));
  check('aucun message d’erreur affiché pour un "rien dans le cadre" normal', !/Impossible de démarrer/.test($('[data-scanner-backdrop]')?.textContent || ''));
  check('la caméra n’a pas été arrêtée par une fausse alerte', calls[0].stopCount === 0);
  scannerLib.__setTestLib(null);
}
click($('[data-scanner-close]'));
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : prévention des détections répétées (une seule recherche OFF même avec plusieurs résultats émis)');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  const { lib, calls } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount++; return jsonRes({ status: 1, code: '1111111111111', product: { product_name: 'X', nutriments: {} } }); };
  calls[0].emit({ getText: () => '1111111111111' }, undefined);
  calls[0].emit({ getText: () => '2222222222222' }, undefined); // frame en vol pendant l’arrêt
  await wait();
  check('une seule recherche OFF déclenchée malgré deux détections émises coup sur coup', fetchCount === 1);
  globalThis.fetch = realFetch;
  scannerLib.__setTestLib(null);
}
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : permission refusée -> message clair, repli vers la saisie manuelle, rien n’est perdu');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
type($('[data-off-name]'), 'Saisie déjà commencée avant le scan');
{
  const { lib } = makeFakeScannerLib({
    onStart: () => { const e = new Error('refusé'); e.name = 'NotAllowedError'; throw e; },
  });
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  check('message d’erreur caméra compréhensible affiché (pas de jargon)', /refusé/i.test($('[data-scanner-backdrop]').textContent));
  check('bouton « Réessayer » proposé', !!$('[data-scanner-retry]'));
  check('bouton de repli vers la saisie manuelle proposé', !!$('[data-scanner-manual]'));
  click($('[data-scanner-manual]'));
  await wait();
  check('scanner refermé, retour au panneau OFF', !$('[data-scanner-backdrop]') && !!$('[data-off-backdrop]'));
  check('la saisie déjà en cours dans le panneau OFF n’a pas été perdue', $('[data-off-name]').value === 'Saisie déjà commencée avant le scan');
  scannerLib.__setTestLib(null);
}
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : absence de caméra détectée (NotFoundError) -> message distinct, jamais une exception');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  const { lib } = makeFakeScannerLib({
    onStart: () => { const e = new Error('absente'); e.name = 'NotFoundError'; throw e; },
  });
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  check('message spécifique à l’absence de caméra', /aucune caméra/i.test($('[data-scanner-backdrop]').textContent));
  scannerLib.__setTestLib(null);
}
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : changement de caméra — arrête l’ancien flux avant d’en ouvrir un nouveau, jamais deux flux actifs');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  scannerLib.__setTestDevices([
    { deviceId: 'cam-back', label: 'Caméra arrière (environment facing)' },
    { deviceId: 'cam-front', label: 'Caméra avant (user facing)' },
  ]);
  const { lib, calls } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  const videoEl = $('#scanner-video');
  videoEl.__marker = 'original-video-node';
  const select = $('[data-scanner-camera]');
  check('sélecteur de caméra affiché (plusieurs caméras disponibles)', !!select);
  const optionLabels = select ? [...select.options].map((o) => o.textContent) : [];
  check('caméra arrière correctement identifiée', optionLabels.includes('Caméra arrière'));
  check('caméra avant correctement identifiée', optionLabels.includes('Caméra avant'));
  change(select, 'cam-front');
  await wait();
  check('l’ancien flux a bien été arrêté avant le changement', calls[0].stopCount >= 1);
  check('un nouveau flux démarré avec le device explicitement choisi', calls.length === 2 && calls[1].deviceId === 'cam-front');
  check('le second flux n’est démarré qu’APRÈS l’arrêt du premier (jamais deux flux actifs en même temps)', calls[0].stopCount >= 1);
  check('le même élément vidéo est réutilisé (jamais recréé au changement de caméra)', $('#scanner-video')?.__marker === 'original-video-node');
  scannerLib.__setTestDevices(null);
  scannerLib.__setTestLib(null);
}
click($('[data-scanner-close]'));
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : simplifie la liste des caméras sur un iPhone multi-objectifs (jamais la liste brute)');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  // Reproduit exactement le cas réel signalé (capture d'écran utilisateur,
  // iPhone récent) : iOS expose chaque objectif comme une caméra séparée,
  // plus des périphériques virtuels combinant plusieurs objectifs.
  scannerLib.__setTestDevices([
    { deviceId: 'front-1', label: 'Caméra avant' },
    { deviceId: 'triple-1', label: 'Triple caméra arrière' },
    { deviceId: 'dualwide-1', label: 'Double caméra grand angle arrière' },
    { deviceId: 'ultrawide-1', label: 'Caméra ultra grand angle arrière' },
    { deviceId: 'dual-1', label: 'Double caméra arrière' },
    { deviceId: 'back-1', label: 'Caméra arrière' },
    { deviceId: 'front-2', label: 'Caméra avant' },
    { deviceId: 'tele-1', label: 'Caméra arrière de longue focale' },
  ]);
  const { lib } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  const select = $('[data-scanner-camera]');
  check('sélecteur réduit à 2 choix (jamais les 8 caméras brutes du téléphone)', select?.options.length === 2);
  const options = select ? [...select.options] : [];
  check('« Caméra arrière » proposée (libellé français reconnu, plus de faux négatif)', options.some((o) => o.textContent === 'Caméra arrière'));
  check('« Caméra avant » proposée (libellé français reconnu)', options.some((o) => o.textContent === 'Caméra avant'));
  const backOption = options.find((o) => o.textContent === 'Caméra arrière');
  check('la caméra arrière choisie est la Triple caméra (changement d’objectif automatique, comme l’app Appareil photo)', backOption?.value === 'triple-1');
  scannerLib.__setTestDevices(null);
  scannerLib.__setTestLib(null);
}
click($('[data-scanner-close]'));
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : sur ordinateur (aucune notion avant/arrière), la liste reste telle quelle');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  scannerLib.__setTestDevices([
    { deviceId: 'webcam-1', label: 'HD Pro Webcam C920' },
    { deviceId: 'webcam-2', label: 'Logitech BRIO' },
  ]);
  const { lib } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  const select = $('[data-scanner-camera]');
  check('les deux webcams restent proposées telles quelles (aucune simplification arbitraire sans notion avant/arrière)', select?.options.length === 2);
  scannerLib.__setTestDevices(null);
  scannerLib.__setTestLib(null);
}
click($('[data-scanner-close]'));
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : flash/torche — proposé seulement si le matériel le permet, jamais activé automatiquement');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  const { lib, calls } = makeFakeScannerLib({ withTorch: true });
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  check('bouton flash proposé (caméra compatible)', !!$('[data-scanner-torch]'));
  check('flash éteint par défaut, jamais activé automatiquement au démarrage', /Activer le flash/.test($('[data-scanner-torch]').textContent));
  click($('[data-scanner-torch]'));
  await wait();
  check('le flash est bien activé après le clic', /Flash activé/.test($('[data-scanner-torch]').textContent) && calls.torchState === true);
  click($('[data-scanner-torch]'));
  await wait();
  check('un second clic désactive le flash', /Activer le flash/.test($('[data-scanner-torch]').textContent) && calls.torchState === false);
  scannerLib.__setTestLib(null);
}
click($('[data-scanner-close]'));
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : pas de bouton flash quand le matériel ne le permet pas');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  const { lib } = makeFakeScannerLib(); // withTorch non précisé -> switchTorch absent, comme une caméra sans flash
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  check('aucun bouton flash proposé (matériel non compatible)', !$('[data-scanner-torch]'));
  scannerLib.__setTestLib(null);
}
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : fermeture (bouton, puis Échap) — caméra arrêtée, saisie en cours jamais perdue');
click($('[data-new]'));
await wait();
type($('[data-f="name"]'), 'Nom déjà saisi dans le formulaire principal');
click($('[data-off-open]'));
await wait();
type($('[data-off-name]'), 'Recherche déjà en cours');
{
  const { lib, calls } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  click($('[data-scanner-close]'));
  await wait();
  check('fermeture par le bouton : caméra arrêtée', calls[0].stopCount >= 1);
  check('fermeture par le bouton : panneau OFF toujours ouvert avec sa saisie intacte', $('[data-off-name]').value === 'Recherche déjà en cours');
  check('le formulaire principal n’a pas été réinitialisé', $('[data-f="name"]').value === 'Nom déjà saisi dans le formulaire principal');
  scannerLib.__setTestLib(null);
}
{
  const { lib, calls } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait();
  check('Échap coupe la caméra', calls[0].stopCount >= 1);
  check('Échap referme uniquement le scanner (pas tout le formulaire)', !$('[data-scanner-backdrop]') && !!$('[data-off-backdrop]'));
  check('la saisie du panneau OFF survit à la fermeture par Échap', $('[data-off-name]').value === 'Recherche déjà en cours');
  scannerLib.__setTestLib(null);
}
click($('[data-off-cancel]'));
click($('[data-form-cancel]'));
await wait();

console.log('\n— Chantier Scanner caméra : changer d’écran coupe la caméra en arrière-plan (jamais active une fois quitté)');
click($('[data-new]'));
await wait();
click($('[data-off-open]'));
await wait();
{
  const { lib, calls } = makeFakeScannerLib();
  scannerLib.__setTestLib(lib);
  click($('[data-off-scan-open]'));
  await wait();
  check('flux démarré avant le changement d’écran', calls[0].stopCount === 0);
  app.navigate('planning');
  await wait();
  check('la caméra est coupée dès le changement de vue, sans attendre une fermeture explicite', calls[0].stopCount >= 1);
  scannerLib.__setTestLib(null);
}
app.navigate('foods');
await wait();

restoreCameraSupport();

console.log('\n' + '='.repeat(60));
check('aucune erreur JavaScript', jsErrors.length === 0, jsErrors.join(' / '));
console.log(`${passed} vérifications réussies, ${failures.length} échec(s).`);
if (failures.length) { console.log(failures.map((x) => `  - ${x}`).join('\n')); process.exitCode = 1; }
