/** Écran PLANNING — cycles de courses/batch, sans aucune date réelle. */

import { getState, update, foodsById, recipesById, preparationsById, itemLabel } from '../core/store.js';
import {
  mealMacros, evaluate, PERSONS, PERSON_LABEL, MEAL_TYPES, MACRO_META, autoAdjust,
} from '../core/nutrition.js';
import { optimizeSuggestions, dayTotals } from '../core/derive.js';
import { dayName, esc, num, toast, uid, debounce } from '../core/util.js';
import { openEditor } from './editor.js';
import { actionConfirmModal, wireActionConfirm } from './confirm-action.js';
import { progressRing } from './charts.js';

let showSuggestions = false;
let duplicateFrom = null;
let pendingConfirm = null; // { title, message, confirmLabel, onConfirm } — P1, remplace confirm() natif

// Bascule discrète des anneaux de synthèse : cycle entier, ou un seul type de
// repas à la fois (retour utilisateur) — un seul réglage partagé par les deux
// cartes Thomas/Julie, jamais une donnée persistée (purement un angle d'affichage).
let summaryScope = 'total'; // 'total' | 'lunch' | 'dinner'
const SUMMARY_SCOPES = [
  { id: 'total', label: 'Total' },
  { id: 'lunch', label: 'Déjeuner' },
  { id: 'dinner', label: 'Dîner' },
];

// Pagination des anneaux de synthèse (retour utilisateur) : semaine complète
// (-1), ou un seul jour du cycle à la fois, étiqueté par son VRAI jour de la
// semaine (dayName(startWeekday, d), déjà utilisé pour les colonnes de
// jour) — jamais "Jour 1/2/3…" seul, qui n'a pas de sens sans se référer à
// la grille plus bas. Partagé par les deux cartes Thomas/Julie, jamais
// persisté (angle d'affichage uniquement, comme summaryScope).
let summaryDay = -1; // -1 = semaine complète, sinon index du jour (0-based)

// Glisser-déposer : la charge utile voyage dans une variable de module plutôt
// que dataTransfer.getData() — plus simple, plus fiable (DataTransfer n'est
// pas disponible partout, notamment en environnement de test) puisque tout se
// passe dans la même page. dataTransfer n'est renseigné que pour les repères
// visuels natifs du navigateur (curseur, image fantôme), jamais lu au drop.
let dragPayload = null; // { mealId, mode: 'move' | 'duplicate' }

// Position de défilement de la page au tout début du geste (mousedown, avant
// même que le glisser ne démarre) — retour utilisateur : un glisser-déposer
// ramenait systématiquement la page tout en haut. Creusé : le saut à zéro se
// produit PENDANT le geste natif lui-même (confirmé en instrumentant un vrai
// événement de glisser), avant même que `drop`/handleDrop() ne s'exécutent —
// capturer la position seulement au moment du dépôt (dans render(), plus bas)
// est donc déjà trop tard, la valeur lue serait déjà celle, erronée, après le
// saut. Capturée ici (mousedown, avant tout saut possible), puis réappliquée
// explicitement par handleDrop() une fois le dépôt traité.
let dragStartScrollY = null;

const DAY_COL_WIDTH = 272;
const DAY_COL_GAP = 16;
let resizeWired = false;

/**
 * Nombre de colonnes de jour affichables sur une ligne sans défilement, vu la
 * largeur réellement disponible (retour utilisateur : plus de défilement
 * horizontal sur ce tableau, cf. .board flex-wrap déjà en place — ceci va
 * plus loin en répartissant les lignes de façon équilibrée).
 */
function colsPerRow(root) {
  const view = root.ownerDocument?.defaultView;
  if (!view) return 1; // environnement sans layout réel (tests) : une colonne par ligne, sans effet sur le contenu
  const cs = view.getComputedStyle(root);
  const avail = root.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  return Math.max(1, Math.floor((avail + DAY_COL_GAP) / (DAY_COL_WIDTH + DAY_COL_GAP)));
}

/**
 * Répartit `n` éléments sur le nombre de lignes minimal, le plus
 * équitablement possible (jamais une ligne pleine suivie d'un reliquat isolé :
 * 6 tuiles pour 5 affichables par ligne -> 3 + 3, jamais 5 + 1).
 */
function balancedRowSizes(n, perRow) {
  if (n <= 0) return [];
  const rows = Math.max(1, Math.ceil(n / perRow));
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0));
}

export function render(root) {
  // Position de défilement de la PAGE (root n'est pas lui-même l'élément qui
  // défile, cf. .main/.view dans app.css) — capturée AVANT de remplacer tout
  // le contenu de la vue, restaurée après (retour utilisateur : un glisser-
  // déposer dans le planning ramenait la page tout en haut à chaque fois).
  const scrollY = window.scrollY;
  const s = getState();
  const byId = foodsById();
  const recipesMap = recipesById();
  const preparationsMap = preparationsById();
  const { startWeekday, duration } = s.settings.cycle;
  // Toujours une page valable, même si la durée du cycle a changé depuis le
  // dernier réglage de summaryDay (ex. cycle raccourci dans Paramètres) —
  // -1 (semaine complète) reste valable quelle que soit la durée.
  if (summaryDay >= duration) summaryDay = duration - 1;

  const cols = [];
  for (let d = 0; d < duration; d++) {
    const meals = ['lunch', 'dinner'].map((type) => s.meals.find((m) => m.dayIndex === d && m.mealType === type));
    const dayStats = PERSONS.map((p) => dayTotals(s, byId, d, p, recipesMap, preparationsMap));
    cols.push(`
      <div class="day-col">
        <div class="day-col__head">
          <h2>${esc(dayName(startWeekday, d))}</h2>
          <span class="day-col__num">Jour ${d + 1}</span>
        </div>
        <div class="day-col__stats">
          ${PERSONS.map((p, i) => `<span class="person-name person-name--${p}">${PERSON_LABEL[p]}</span> ${num(dayStats[i].kcal, 0)} kcal · ${num(dayStats[i].protein, 0)} P · ${num(dayStats[i].carbs, 0)} G · ${num(dayStats[i].fat, 0)} L`).join('<br>')}
        </div>
        ${meals.map((m) => mealSlot(m, byId, s, recipesMap, preparationsMap)).join('')}
      </div>`);
  }

  const sizes = balancedRowSizes(cols.length, colsPerRow(root));
  const rowsHtml = [];
  let i = 0;
  for (const size of sizes) {
    rowsHtml.push(`<div class="board__row">${cols.slice(i, i + size).join('')}</div>`);
    i += size;
  }

  const summaryDayLabel = summaryDay === -1 ? 'Semaine complète' : esc(dayName(startWeekday, summaryDay));

  root.innerHTML = `
    <div class="summary-scope">
      <div class="summary-scope__chips">
        ${SUMMARY_SCOPES.map((o) => `<button class="chip chip--xs" data-scope="${o.id}" aria-pressed="${summaryScope === o.id}">${esc(o.label)}</button>`).join('')}
      </div>
      <div class="summary-day-pager">
        <button type="button" class="summary-day-pager__btn" data-summary-day="prev" ${summaryDay <= -1 ? 'disabled' : ''} aria-label="Jour précédent">‹</button>
        <span class="summary-day-pager__label">${summaryDayLabel}</span>
        <button type="button" class="summary-day-pager__btn" data-summary-day="next" ${summaryDay >= duration - 1 ? 'disabled' : ''} aria-label="Jour suivant">›</button>
      </div>
    </div>
    <div class="day-summary">${PERSONS.map((p) => cycleSummaryCard(p, s, byId, recipesMap, preparationsMap, summaryScope, summaryDay)).join('')}</div>

    <div class="row" style="margin-bottom:14px">
      <span class="pill pill--accent">Cycle de ${duration} jours — démarrage ${esc(dayName(startWeekday, 0).toLowerCase())}</span>
      <span class="spacer"></span>
      <button class="btn" data-optimize>✨ Suggestions du cycle</button>
    </div>
    ${showSuggestions ? suggestionsPanel(s, byId, recipesMap, preparationsMap) : ''}

    <div class="board">${rowsHtml.join('')}</div>

    ${duplicateFrom ? duplicatePanel(s) : ''}
    ${pendingConfirm ? actionConfirmModal(pendingConfirm) : ''}
  `;

  wire(root);
  window.scrollTo(0, scrollY);

  // Recalcule la répartition par ligne au redimensionnement (jamais pour une
  // autre vue : root n'a alors plus de .board, le re-rendu est un no-op sans
  // effet visible — évité en vérifiant sa présence avant de relancer render()).
  if (!resizeWired) {
    resizeWired = true;
    window.addEventListener('resize', debounce(() => {
      if (root.isConnected && root.querySelector('.board')) render(root);
    }, 200));
  }
}

/**
 * Carte de synthèse par personne, en haut de l'écran — portée par défaut
 * fixée au cycle entier (somme de tous les jours vs somme de tous les
 * objectifs). `scope` (bascule discrète) restreint la somme à un seul type
 * de repas (déjeuner/dîner) au lieu des deux ; `dayFilter` (pager, retour
 * utilisateur) restreint en plus à UN SEUL jour du cycle (-1 = tous) — ce
 * planificateur reste sans date réelle "aujourd'hui" (cf. en-tête de ce
 * fichier), mais chaque jour du cycle EST déjà rattaché à un vrai jour de la
 * semaine via `dayName(startWeekday, d)` (colonnes de jour, juste plus bas) :
 * défiler Semaine complète -> Samedi -> Dimanche -> … n'invente donc aucune
 * date, ça reprend exactement la même correspondance jour <-> index déjà
 * affichée partout ailleurs sur cet écran.
 */
function cycleSummaryCard(person, s, byId, recipesMap, preparationsMap, scope, dayFilter = -1) {
  const { duration } = s.settings.cycle;
  const types = scope === 'total' ? ['lunch', 'dinner'] : [scope];
  const days = dayFilter === -1 ? Array.from({ length: duration }, (_, d) => d) : [dayFilter];
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const target = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const d of days) {
    for (const type of types) {
      const meal = s.meals.find((m) => m.dayIndex === d && m.mealType === type);
      if (meal) {
        const macros = mealMacros(meal.items, byId, person, recipesMap, preparationsMap);
        total.kcal += macros.kcal; total.protein += macros.protein; total.carbs += macros.carbs; total.fat += macros.fat;
      }
      const t = s.settings.targets[person][type];
      if (t) {
        target.kcal += t.kcal || 0; target.protein += t.protein || 0; target.carbs += t.carbs || 0; target.fat += t.fat || 0;
      }
    }
  }
  const rings = Object.keys(MACRO_META)
    .map((key) => {
      const meta = MACRO_META[key];
      const pct = target[key] > 0 ? (total[key] / target[key]) * 100 : 0;
      return `<div class="day-summary__ring">
        ${progressRing(pct, { size: 62, thickness: 6, color: `var(--${meta.cls})`, label: meta.label })}
        <span class="day-summary__ring-label">${meta.icon} ${meta.short}</span>
        <span class="day-summary__ring-value">${num(total[key], 0)}${target[key] ? ` / ${num(target[key], 0)}` : ''}${key === 'kcal' ? '' : ' g'}</span>
      </div>`;
    })
    .join('');
  const scopeLabel = SUMMARY_SCOPES.find((o) => o.id === scope)?.label || 'Total';
  const periodLabel = dayFilter === -1
    ? "sur l'ensemble du cycle"
    : `le ${esc(dayName(s.settings.cycle.startWeekday, dayFilter).toLowerCase())}`;
  return `<div class="day-summary__card">
    <div class="day-summary__head person-name person-name--${person}">${PERSON_LABEL[person]} <span class="tag" style="font-weight:500">· ${scope === 'total' ? periodLabel : `${esc(scopeLabel)}, ${periodLabel}`}</span></div>
    <div class="day-summary__rings">${rings}</div>
  </div>`;
}

function mealSlot(meal, byId, s, recipesMap, preparationsMap) {
  if (!meal) return '';
  const empty = meal.items.length === 0;
  const icon = meal.mealType === 'lunch' ? '☀️' : '🌙';

  if (empty) {
    return `<div class="meal-slot is-empty" data-slot="${meal.id}" data-drop-meal="${meal.id}">
      <div class="meal-slot__dropzone">Déposer ici</div>
      <span class="meal-slot__ico">${icon}</span>
      <div class="meal-slot__type">${esc(MEAL_TYPES[meal.mealType])}</div>
      <span class="meal-slot__empty-text">Glissez un menu ici<br>ou cliquez sur « Composer »</span>
      <button class="meal-slot__add" data-edit="${meal.id}" title="Composer ${esc(MEAL_TYPES[meal.mealType]).toLowerCase()}" aria-label="Composer">+</button>
    </div>`;
  }

  const ings = meal.items.map((it) => itemLabel(it, byId, recipesMap, preparationsMap)).slice(0, 4).join(', ');
  const macroRow = PERSONS.map((person) => {
    const macros = mealMacros(meal.items, byId, person, recipesMap, preparationsMap);
    const target = s.settings.targets[person][meal.mealType];
    const ev = evaluate(macros, target, s.settings.tolerance);
    const chips = ev.rows
      .map((r) => `<span class="macro is-${r.status}"><b>${num(r.value, 0)}</b> <span class="goal">${r.label}</span></span>`)
      .join('');
    return `<div class="person-band person-band--${person}" style="margin-top:6px">
      <div class="person-name person-name--${person}">${PERSON_LABEL[person]}</div>
      <div class="macros" style="margin-top:3px">${chips}</div>
    </div>`;
  }).join('');

  return `<div class="meal-slot" data-slot="${meal.id}" data-drop-meal="${meal.id}" draggable="true" data-drag-meal="${meal.id}" title="Glisser pour déplacer vers un autre créneau (permute si occupé) — tirer depuis ⠿ pour dupliquer" aria-label="Repas : ${esc(meal.name || 'Sans nom')}. Glisser pour déplacer vers un autre créneau, ou utiliser les boutons">
    <div class="meal-slot__dropzone">Déposer ici</div>
    <span class="meal-slot__drag-handle" aria-hidden="true" title="Glisser depuis ici pour dupliquer (la source reste inchangée)">⠿</span>
    <details class="item-menu meal-slot__menu">
      <summary aria-label="Options du repas">⋯</summary>
      <div class="meal-slot__menu__body">
        <button type="button" data-dup="${meal.id}">Dupliquer vers…</button>
        <button type="button" class="is-danger" data-clear="${meal.id}">Vider</button>
      </div>
    </details>
    <div class="meal-slot__head">
      <span class="meal-slot__ico">${icon}</span>
      <span class="meal-slot__type">${esc(MEAL_TYPES[meal.mealType])}</span>
    </div>
    <div class="meal-slot__name">${esc(meal.name || 'Sans nom')}</div>
    <div class="meal-slot__ing">${esc(ings)}${meal.items.length > 4 ? '…' : ''}</div>
    ${macroRow}
    <button class="btn btn--sm btn--secondary" data-edit="${meal.id}" style="margin-top:10px;width:100%">Modifier</button>
  </div>`;
}

function suggestionsPanel(s, byId, recipesMap, preparationsMap) {
  const list = optimizeSuggestions(s, byId, recipesMap, preparationsMap);
  return `<div class="card" style="margin-bottom:16px">
    <div class="card__head">
      <h3>Suggestions pour ce cycle</h3>
      <button class="btn btn--sm btn--ghost" data-close-sugg>Masquer</button>
    </div>
    <ul style="margin:0;padding-left:18px">
      ${list.map((x) => `<li style="margin-bottom:4px">${esc(x.text)}</li>`).join('')}
    </ul>
    <small>Aucune de ces suggestions n'est appliquée automatiquement : le planning n'est modifié que par toi.</small>
  </div>`;
}

function duplicatePanel(s) {
  const src = s.meals.find((m) => m.id === duplicateFrom);
  if (!src) return '';
  const startWeekday = s.settings.cycle.startWeekday;
  const slots = s.meals
    .filter((m) => m.id !== src.id)
    .map(
      (m) => `<label class="check" style="padding:6px 0">
        <input type="checkbox" data-target="${m.id}">
        ${esc(dayName(startWeekday, m.dayIndex))} (jour ${m.dayIndex + 1}) — ${esc(MEAL_TYPES[m.mealType])}${m.items.length ? ' (sera remplacé)' : ''}
      </label>`
    )
    .join('');
  return `<div class="drawer" data-dup-backdrop>
    <div class="drawer__panel" style="width:min(460px,100%)">
      <div class="drawer__head"><div class="row"><h3 style="flex:1">Dupliquer « ${esc(src.name || 'repas')} »</h3>
      <button class="btn btn--ghost" data-dup-cancel>Fermer</button></div></div>
      <div class="drawer__body">
        ${slots}
        <div class="row" style="margin-top:14px">
          <button class="btn btn--primary" data-dup-confirm>Dupliquer</button>
          <label class="check"><input type="checkbox" data-dup-adjust checked> Réajuster les quantités après copie</label>
        </div>
      </div>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ */
/* Mutations partagées (bouton « Dupliquer » ET glisser-déposer)       */
/* ------------------------------------------------------------------ */

/**
 * Copie la composition d'un repas vers un autre créneau — logique
 * EXTRAITE telle quelle de l'ancien gestionnaire `data-dup-confirm` (aucun
 * changement de comportement), désormais partagée par la modale « Dupliquer »
 * ET le glisser-déposer : une seule mécanique, jamais deux implémentations
 * parallèles pour le même résultat.
 */
function copyMealTo(s, srcId, dstId, { readjust = true } = {}) {
  const src = s.meals.find((m) => m.id === srcId);
  const dst = s.meals.find((m) => m.id === dstId);
  if (!src || !dst || src.id === dst.id) return false;
  const byId = Object.fromEntries(s.foods.map((f) => [f.id, f]));
  dst.name = src.name;
  dst.nameAuto = src.nameAuto;
  dst.sameComposition = src.sameComposition;
  dst.items = cloneItems(src.items);
  if (readjust && s.settings.autoAdjust) {
    autoAdjust(dst.items, byId, {
      thomas: s.settings.targets.thomas[dst.mealType],
      julie: s.settings.targets.julie[dst.mealType],
    });
  }
  return true;
}

/** Nouveaux id pour chaque ingrédient copié — jamais deux repas qui partagent la même référence d'item. */
function cloneItems(items) {
  return items.map((it) => ({ ...JSON.parse(JSON.stringify(it)), id: uid('it') }));
}

/** Même sémantique que « Vider » du menu ⋯ (data-clear ci-dessous) — utilisé par le déplacement glisser-déposer une fois le contenu copié vers la destination. */
function clearMealContent(m) {
  m.items = [];
  m.name = '';
  m.nameAuto = true;
}

/**
 * Échange intégralement le contenu de deux repas — jamais de perte de
 * données dans aucun sens (contrairement à un remplacement), donc jamais
 * besoin de confirmation : c'est le comportement par défaut d'un
 * déplacement glisser-déposer vers un créneau déjà occupé (retour
 * utilisateur). Chaque côté est réajusté à SA PROPRE cible après l'échange
 * (mealType/jour pouvant différer entre les deux créneaux, cf. copyMealTo()).
 */
function swapMeals(s, aId, bId, { readjust = true } = {}) {
  const a = s.meals.find((m) => m.id === aId);
  const b = s.meals.find((m) => m.id === bId);
  if (!a || !b || a.id === b.id) return false;
  const byId = Object.fromEntries(s.foods.map((f) => [f.id, f]));
  const aItems = cloneItems(a.items);
  const bItems = cloneItems(b.items);
  const aMeta = { name: a.name, nameAuto: a.nameAuto, sameComposition: a.sameComposition };
  const bMeta = { name: b.name, nameAuto: b.nameAuto, sameComposition: b.sameComposition };
  Object.assign(a, bMeta);
  a.items = bItems;
  Object.assign(b, aMeta);
  b.items = aItems;
  if (readjust && s.settings.autoAdjust) {
    autoAdjust(a.items, byId, { thomas: s.settings.targets.thomas[a.mealType], julie: s.settings.targets.julie[a.mealType] });
    autoAdjust(b.items, byId, { thomas: s.settings.targets.thomas[b.mealType], julie: s.settings.targets.julie[b.mealType] });
  }
  return true;
}

/**
 * Déplace un repas vers un autre créneau (par défaut au glisser-déposer,
 * retour utilisateur) : la source est vidée une fois sa composition reprise
 * par la destination. Si la destination est déjà occupée, rien n'est perdu
 * — permutation plutôt que remplacement (swapMeals() ci-dessus), donc là
 * non plus jamais besoin de confirmation.
 */
function moveMealTo(s, srcId, dstId, { readjust = true } = {}) {
  const src = s.meals.find((m) => m.id === srcId);
  const dst = s.meals.find((m) => m.id === dstId);
  if (!src || !dst || src.id === dst.id) return false;
  if (dst.items.length) return swapMeals(s, srcId, dstId, { readjust });
  copyMealTo(s, srcId, dstId, { readjust });
  clearMealContent(src);
  return true;
}

/**
 * Dépose la charge `dragPayload` courante sur le créneau `dstId`.
 *
 * mode 'move' (par défaut, glisser depuis n'importe quel point de la carte) :
 * créneau vide -> déplacement (la source se vide) ; créneau occupé ->
 * permutation (swapMeals()) — jamais de perte de données dans un sens comme
 * dans l'autre, donc JAMAIS de confirmation.
 *
 * mode 'duplicate' (glisser depuis la poignée ⠿ dédiée) : la source n'est
 * jamais modifiée ; créneau occupé -> confirmation requise (son contenu sera
 * remplacé, la seule des deux issues qui perd réellement quelque chose).
 */
function handleDrop(root, dstId) {
  const payload = dragPayload;
  dragPayload = null;
  // Capturée au tout début du geste (mousedown, cf. dragStartScrollY plus
  // haut) : par le moment où ce rendu s'exécute, window.scrollY a déjà
  // potentiellement sauté à 0 (saut survenant PENDANT le geste natif
  // lui-même) — restaurer explicitement avec CETTE valeur après chaque
  // render() ci-dessous, plutôt que de se fier à ce que render() capture de
  // son côté (déjà trop tard à ce stade).
  const savedScrollY = dragStartScrollY;
  dragStartScrollY = null;
  const restoreScroll = () => { if (savedScrollY !== null) window.scrollTo(0, savedScrollY); };
  if (!payload) { restoreScroll(); return; }
  const s0 = getState();
  const dst = s0.meals.find((m) => m.id === dstId);
  if (!dst) { restoreScroll(); return; }
  if (payload.mealId === dstId) { restoreScroll(); return; } // dépose sur soi-même : rien à faire
  const dstWasFilled = dst.items.length > 0;

  if (payload.mode === 'duplicate') {
    const apply = () => {
      update((s) => { copyMealTo(s, payload.mealId, dstId, { readjust: true }); });
      toast('Repas dupliqué');
      render(root);
      restoreScroll();
    };
    if (dstWasFilled) {
      pendingConfirm = {
        title: 'Remplacer ce repas ?',
        message: `« ${dst.name || 'Ce repas'} » sera entièrement remplacé par ce que tu viens de déposer.`,
        confirmLabel: 'Remplacer',
        onConfirm: apply,
      };
      render(root);
      restoreScroll();
    } else {
      apply();
    }
    return;
  }

  update((s) => { moveMealTo(s, payload.mealId, dstId, { readjust: true }); });
  toast(dstWasFilled ? 'Repas permutés' : 'Repas déplacé');
  render(root);
  restoreScroll();
}

function wire(root) {
  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => openEditor('meal', e.currentTarget.dataset.edit))
  );

  root.querySelectorAll('[data-clear]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.clear;
      pendingConfirm = {
        title: 'Vider ce repas ?',
        message: 'Tous les ingrédients de ce repas seront retirés, et son nom réinitialisé.',
        confirmLabel: 'Vider le repas',
        onConfirm: () => update((s) => {
          // Vider le repas le ramène à un état vraiment vide — équivalent à
          // newMeal() — donc nameAuto repasse à true : un nom manuellement tapé
          // puis explicitement vidé DANS L'ÉDITEUR reste figé (règle existante,
          // data-name), mais « Vider ce repas » depuis le planning est un reset
          // complet, pas un simple effacement du champ nom ; sans ce repli, un
          // repas qui avait un nom manuel resterait bloqué sans auto-nommage
          // pour toujours, même une fois recomposé.
          const m = s.meals.find((x) => x.id === id);
          if (m) { m.items = []; m.name = ''; m.nameAuto = true; }
        }),
      };
      render(root);
    })
  );

  root.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', (e) => {
      duplicateFrom = e.currentTarget.dataset.dup;
      render(root);
    })
  );

  root.querySelectorAll('[data-scope]').forEach((b) =>
    b.addEventListener('click', (e) => { summaryScope = e.currentTarget.dataset.scope; render(root); })
  );

  root.querySelectorAll('[data-summary-day]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const { duration } = getState().settings.cycle;
      const dir = e.currentTarget.dataset.summaryDay === 'next' ? 1 : -1;
      summaryDay = Math.max(-1, Math.min(duration - 1, summaryDay + dir));
      render(root);
    })
  );

  root.querySelector('[data-optimize]')?.addEventListener('click', () => {
    showSuggestions = !showSuggestions;
    render(root);
  });
  root.querySelector('[data-close-sugg]')?.addEventListener('click', () => {
    showSuggestions = false;
    render(root);
  });

  root.querySelector('[data-dup-cancel]')?.addEventListener('click', () => {
    duplicateFrom = null;
    render(root);
  });
  root.querySelector('[data-dup-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.dupBackdrop !== undefined) { duplicateFrom = null; render(root); }
  });
  wireActionConfirm(root, { getPending: () => pendingConfirm, setPending: (v) => { pendingConfirm = v; }, render });

  root.querySelector('[data-dup-confirm]')?.addEventListener('click', () => {
    const targets = [...root.querySelectorAll('[data-target]:checked')].map((c) => c.dataset.target);
    const readjust = root.querySelector('[data-dup-adjust]')?.checked;
    if (!targets.length) { toast('Choisis au moins une destination', 'error'); return; }
    update((s) => {
      for (const tid of targets) copyMealTo(s, duplicateFrom, tid, { readjust });
    });
    toast(`Repas dupliqué sur ${targets.length} créneau(x)`);
    duplicateFrom = null;
    render(root);
  });

  wireDragAndDrop(root);
}

/**
 * Glisser-déposer : un repas déjà composé peut être tiré vers un autre
 * créneau. La carte ENTIÈRE reste draggable (retour utilisateur — même
 * principe déjà appliqué aux tuiles d'aliment du composeur), avec DEUX
 * zones de départ distinctes (retour utilisateur, deuxième demande) :
 *   - n'importe où ailleurs sur la carte -> mode 'move' (par défaut) :
 *     déplace le repas (créneau vide) ou le permute avec la destination
 *     (créneau occupé) — jamais de perte de données, jamais de clic
 *     supplémentaire.
 *   - depuis la poignée ⠿ (.meal-slot__drag-handle) -> mode 'duplicate' :
 *     comportement historique, la source n'est jamais modifiée.
 * Sûr malgré la carte entière draggable UNIQUEMENT parce que dragstart
 * écarte explicitement ses propres sous-éléments interactifs (bouton
 * « Modifier », menu « ⋯ » et son contenu) : partir d'un clic sur l'un
 * d'eux annule le glisser (e.preventDefault()) et laisse le clic normal
 * suivre son cours.
 */
function wireDragAndDrop(root) {
  root.querySelectorAll('[data-drag-meal]').forEach((card) => {
    // La zone de départ (poignée ⠿ ou reste de la carte) doit être détectée
    // sur `mousedown`, PAS sur `dragstart` : en HTML5 drag-and-drop, le
    // navigateur cible TOUJOURS `dragstart` sur l'élément `draggable="true"`
    // lui-même (ici .meal-slot), jamais sur le sous-élément réellement
    // survolé au moment du clic — confirmé en testant avec de vrais
    // événements de glisser (Playwright), contrairement à ce qu'un test
    // avec des événements synthétiques simples pouvait laisser croire.
    // `mousedown`, lui, cible normalement le sous-élément exact sous le
    // pointeur, exactement comme un clic — d'où la pré-détection ici,
    // relue dans `dragstart` juste après.
    let pendingMode = 'move';
    card.addEventListener('mousedown', (e) => {
      pendingMode = e.target.closest('.meal-slot__drag-handle') ? 'duplicate' : 'move';
      dragStartScrollY = window.scrollY;
    });
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('button, details, summary')) { e.preventDefault(); return; }
      const mode = pendingMode;
      dragPayload = { mealId: card.dataset.dragMeal, mode };
      card.classList.add('is-dragging');
      try {
        // 'copy' (curseur +) pour une duplication, 'move' (curseur flèche)
        // pour un déplacement/permutation — repère visuel natif du
        // navigateur cohérent avec ce qui va réellement se passer au dépôt.
        e.dataTransfer.effectAllowed = mode === 'duplicate' ? 'copy' : 'move';
        e.dataTransfer.setData('text/plain', card.dataset.dragMeal);
        e.dataTransfer.setDragImage(card, 24, 24);
      } catch { /* environnement sans dataTransfer (tests) */ }
    });
    card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
  });

  root.querySelectorAll('[data-drop-meal]').forEach((el) => {
    el.addEventListener('dragover', (e) => {
      if (!dragPayload) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = dragPayload?.mode === 'duplicate' ? 'copy' : 'move'; } catch { /* no-op */ }
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-drop-target');
      handleDrop(root, el.dataset.dropMeal);
    });
  });
}
