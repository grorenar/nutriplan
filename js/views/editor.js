/**
 * Éditeur partagé : repas du planning, petits-déjeuners, collations.
 * C'est ici que vit l'expérience "calcul + ajustement en continu".
 */

import {
  getState, update, foodsById, newItem, newFreeItem, catalogKey,
  SECTIONS, SECTION_LABEL, DEFAULT_SECTION, sectionsUsed,
  recipesById, preparationsById, newRecipeMealItem, newPreparationItem, newPreparation,
  autoMealName,
} from '../core/store.js';
import {
  CATEGORIES, STATES, PERSONS, PERSON_LABEL, MEAL_TYPES,
  mealMacros, macrosFor, evaluate, autoAdjust, initialQuantity, diagnose,
  snapQuantity, isUnitFood, isWholeUnitFood, toUnits, fromUnits, quantityStep,
  conversionInfo, stateLabel, recipeAsVirtualFood, preparationAsVirtualFood, resolveItemFood,
  resolveZeroWasteAllocation, preparedGramsOf, portionGramsOf,
} from '../core/nutrition.js';
import { esc, num, normalize, toast, uid } from '../core/util.js';
import { analyzeMealVolume } from '../core/meal-volume.js';
import { preparationAvailable, zeroWasteSlotsFor } from '../core/derive.js';

let ctx = null; // { kind, id }
let pickerQuery = '';
let pickerCategory = 'all';
let addFor = 'both'; // utilisé quand les compositions diffèrent
let addSection = DEFAULT_SECTION; // section cible d'un ajout depuis le picker
let host = null;

/**
 * Intitulé unique affiché à la place des sections (Entrée/Plat/…) pour un
 * petit-déjeuner ou une collation (P3.1) : ces catégories n'ont pas de sens
 * hors d'un repas classique. `SECTIONS`/`DEFAULT_SECTION` restent inchangés
 * (décision verrouillée) — seul l'affichage change, `item.section` continue
 * d'exister tel quel en interne.
 */
const CATALOG_HEADING = {
  breakfast: 'Petit-déjeuner',
  snack_afternoon: 'Collation 16 h',
  snack_evening: 'Collation soir',
};

export const isOpen = () => ctx !== null;

export function openEditor(kind, id) {
  ctx = { kind, id };
  pickerQuery = '';
  pickerCategory = 'all';
  addFor = 'both';
  addSection = DEFAULT_SECTION;
  renderEditor();
}

export function closeEditor() {
  ctx = null;
  if (host) host.innerHTML = '';
}

/* ------------------------------------------------------------------ */
/* Accès à l'entité éditée                                             */
/* ------------------------------------------------------------------ */

function entityFrom(state) {
  if (!ctx) return null;
  if (ctx.kind === 'meal') return state.meals.find((m) => m.id === ctx.id) || null;
  const key = catalogKey(ctx.kind);
  return state[key]?.find((o) => o.id === ctx.id) || null;
}

function targetType() {
  if (!ctx) return 'lunch';
  if (ctx.kind === 'breakfast') return 'breakfast';
  if (ctx.kind === 'snack') {
    // une collation a UNE composition ; l'objectif de référence (16 h ou soir)
    // sert uniquement de repère pour les macros et l'ajustement.
    const opt = entityFrom(getState());
    return opt?.targetSlot === 'evening' ? 'snack_evening' : 'snack_afternoon';
  }
  const e = entityFrom(getState());
  return e?.mealType || 'lunch';
}

function targetsFor(state) {
  const type = targetType();
  return {
    thomas: state.settings.targets.thomas[type],
    julie: state.settings.targets.julie[type],
  };
}

/**
 * Mutation de l'entité + ajustement optionnel.
 * `adjust` : un ajustement est-il pertinent après cette mutation (ajout d'un
 * ingrédient, changement de quantité…) ? `force` : l'utilisateur l'a-t-il
 * demandé explicitement (bouton "Ajuster maintenant") ? Dans ce cas
 * l'ajustement s'exécute TOUJOURS, même si le réglage "Ajustement auto" est
 * décoché — sinon le bouton ne fait rien tout en affichant un message de
 * succès. Un ajustement automatique (après ajout, saisie…) reste, lui,
 * soumis au réglage.
 */
function mutate(fn, { adjust = true, force = false, pinned = [] } = {}) {
  update((s) => {
    const e = entityFrom(s);
    if (!e) return;
    fn(e, s);
    if (adjust && (force || s.settings.autoAdjust)) {
      // disponible RÉEL de chaque préparation, sur l'état À CET INSTANT (après
      // la mutation qui vient de s'appliquer) : adjustQuantities() rend à
      // chaque item sa propre contribution courante (cf. nutrition.js), donc
      // le calculer une seule fois ici, avant les deux passes thomas/julie,
      // est correct pour les deux (mode normal, Σ affecté ≤ disponible — §8).
      const preparationAvailability = {};
      for (const p of s.preparations) preparationAvailability[p.id] = preparationAvailable(s, p);
      autoAdjust(e.items, foodsByIdFrom(s), targetsForState(s), {
        pinned,
        recipesById: recipesByIdFrom(s),
        preparationsById: preparationsByIdFrom(s),
        preparationAvailability,
      });
    }
    // Auto-nommage (P2.4) : uniquement les repas (lunch/dinner), jamais les
    // catalogues petit-déjeuner/collation — leur "nom" désigne le plat
    // lui-même, pas un résumé de composition. Ne s'applique QUE si le nom
    // est encore piloté automatiquement (nameAuto) : un nom saisi ou
    // volontairement vidé par l'utilisateur n'est jamais régénéré.
    if (ctx.kind === 'meal' && e.nameAuto) {
      e.name = autoMealName(e.items, foodsByIdFrom(s));
    }
  });
  renderEditor();
}

const foodsByIdFrom = (s) => Object.fromEntries(s.foods.map((f) => [f.id, f]));
const recipesByIdFrom = (s) => Object.fromEntries(s.recipes.map((r) => [r.id, r]));
const preparationsByIdFrom = (s) => Object.fromEntries(s.preparations.map((p) => [p.id, p]));
function targetsForState(s) {
  const type = targetType();
  return { thomas: s.settings.targets.thomas[type], julie: s.settings.targets.julie[type] };
}

/* ------------------------------------------------------------------ */
/* Rendu                                                               */
/* ------------------------------------------------------------------ */

export function renderEditor() {
  host = document.getElementById('drawer');
  if (!host) return;
  if (!ctx) { host.innerHTML = ''; return; }

  const state = getState();
  const entity = entityFrom(state);
  if (!entity) { closeEditor(); return; }

  const scroll = host.querySelector('.drawer__body')?.scrollTop || 0;
  const byId = foodsById();
  const recipesMap = recipesById();
  const preparationsMap = preparationsById();
  const targets = targetsFor(state);
  const tol = state.settings.tolerance;
  const typeLabel = MEAL_TYPES[targetType()];

  const head = `
    <div class="row">
      <span class="pill pill--accent">${esc(typeLabel)}</span>
      ${ctx.kind === 'meal' ? `<span class="tag">Jour ${entity.dayIndex + 1}</span>` : ''}
      <span class="spacer"></span>
      <button class="btn btn--ghost" data-close>Fermer</button>
    </div>
    ${
      ctx.kind === 'snack'
        ? `<div class="row row--tight" style="margin-top:8px">
             <small>Objectif de référence :</small>
             <button class="chip" data-set-slot="afternoon" aria-pressed="${entity.targetSlot !== 'evening'}">16 h</button>
             <button class="chip" data-set-slot="evening" aria-pressed="${entity.targetSlot === 'evening'}">Soir</button>
           </div>`
        : ''
    }
    <div class="row" style="margin-top:8px">
      <input type="text" data-name value="${esc(entity.name)}" placeholder="Nom du repas (facultatif)" style="flex:1;min-width:180px">
    </div>
    <div class="row" style="margin-top:8px">
      <label class="check"><input type="checkbox" data-same ${entity.sameComposition ? 'checked' : ''}> Même composition Thomas / Julie</label>
      <span class="spacer"></span>
      <label class="check"><input type="checkbox" data-auto ${state.settings.autoAdjust ? 'checked' : ''}> Ajustement auto</label>
      <button class="btn btn--sm" data-adjust>Ajuster maintenant</button>
    </div>`;

  const body = `
    ${renderSummary(entity, byId, targets, tol, state, recipesMap, preparationsMap)}
    ${renderItems(entity, byId, recipesMap, preparationsMap)}
    ${renderPicker(state, entity, recipesMap, preparationsMap)}`;

  // Le panneau n'est créé qu'à l'ouverture : les re-rendus suivants remplacent
  // seulement son contenu, donc pas de réapparition ni d'animation rejouée.
  let panel = host.querySelector('.drawer__panel');
  if (!panel) {
    host.innerHTML = `
      <div class="drawer" data-close-backdrop>
        <div class="drawer__panel" role="dialog" aria-label="Édition du repas">
          <div class="drawer__head"></div>
          <div class="drawer__body"></div>
        </div>
      </div>`;
    panel = host.querySelector('.drawer__panel');
  }
  panel.querySelector('.drawer__head').innerHTML = head;
  panel.querySelector('.drawer__body').innerHTML = body;

  host.querySelector('.drawer__body').scrollTop = scroll;
  wire(host, entity);
}

function renderSummary(entity, byId, targets, tol, state, recipesMap = {}, preparationsMap = {}) {
  const blocks = PERSONS.map((person) => {
    // cible nutritionnelle UNIQUE pour tout le repas (décision §6) : les
    // sections ne sont jamais des sous-problèmes d'optimisation séparés.
    const macros = mealMacros(entity.items, byId, person, recipesMap, preparationsMap);
    const ev = evaluate(macros, targets[person], tol);
    const diag = diagnose(macros, targets[person], state.foods, tol);
    // le volume, lui, est analysé INDÉPENDAMMENT par section (décision §6/§8) :
    // un plat volumineux ne doit pas noyer une entrée ou un dessert normaux
    // dans une seule masse globale. Un petit-déjeuner/collation (P3.1) n'a
    // qu'un seul groupe (pas de sous-division Entrée/Plat/…) : analyse sur
    // la totalité des items, libellée par CATALOG_HEADING.
    const volBySection = ctx.kind === 'meal'
      ? sectionsUsed(entity.items)
          .map((section) => ({
            label: SECTION_LABEL[section],
            vol: analyzeMealVolume(entity.items.filter((it) => (it.section || DEFAULT_SECTION) === section), byId, person),
          }))
          .filter((x) => x.vol.level > 0)
      : [{ label: CATALOG_HEADING[targetType()], vol: analyzeMealVolume(entity.items, byId, person) }]
          .filter((x) => x.vol.level > 0);
    const chips = ev.rows
      .map(
        (r) => `<span class="macro is-${r.status}">
          <b>${num(r.value, r.key === 'kcal' ? 0 : 1)}</b>${r.key === 'kcal' ? '' : ' g'}
          <span class="goal">/ ${num(r.target, 0)}</span>
          <span class="goal">${r.label}</span></span>`
      )
      .join('');
    return `<div class="person-band person-band--${person}" style="margin-bottom:10px">
      <div class="person-name person-name--${person}">${PERSON_LABEL[person]}</div>
      <div class="macros" style="margin:4px 0 4px">${chips}</div>
      ${
        diag
          ? `<small>Hors cible : ${diag.rows
              .map((r) => `${r.label} ${r.delta > 0 ? '+' : ''}${num(r.delta, 0)}`)
              .join(', ')}${diag.suggestions.length ? ` — piste : ${esc(diag.suggestions.join(', '))}` : ''}</small>`
          : `<small>Tous les macros dans la cible ±${Math.round(tol * 100)} %.</small>`
      }
      ${volBySection
        .map(
          ({ label, vol }) => `<div class="tag${vol.level >= 2 ? ' sync-error' : ''}" style="margin-top:4px">
               ${esc(label)} — ${esc(vol.label)} — environ ${num(vol.grams, 0)} g${vol.partial ? ' (estimation partielle : au moins un ingrédient sans rendement cru → cuit renseigné n’est pas compté)' : ''}
             </div>`
        )
        .join('')}
    </div>`;
  }).join('');

  // ingrédients écartés du total faute de conversion définie
  const excluded = mealMacros(entity.items, byId, PERSONS[0], recipesMap, preparationsMap).unconvertible || 0;
  const notice = excluded
    ? `<div class="sync-error"><small>${excluded} ingrédient(s) exclu(s) du total : aucune conversion définie entre l'état pesé et celui de leurs valeurs nutritionnelles.</small></div>`
    : '';

  return `<div class="card">${blocks}${notice}</div>`;
}

/**
 * Libellé d'unité au pluriel simple ("2 tranches", "2 c. à soupe").
 * Exportée : réutilisée telle quelle par l'écran Recettes (`recipes.js`),
 * pour que la même unité s'affiche de la même façon partout — jamais une
 * seconde mécanique parallèle.
 */
export function unitLabel(food, count) {
  const name = food.unitName || 'unité';
  const plural = Math.abs(count) >= 2 && !/^c\./.test(name) ? 's' : '';
  return `${name}${plural}`;
}

/** Équivalence affichée sous le champ de saisie. */
export function unitHint(food, qty) {
  if (!isUnitFood(food)) return '';
  const u = toUnits(food, qty);
  if (food.unitEntry) return `= ${num(qty, 0)} g`;
  const txt = isWholeUnitFood(food) ? Math.round(u) : num(u, 1);
  return `≈ ${txt} ${esc(unitLabel(food, u))}`;
}

/**
 * Sélecteur de section, réutilisé sur chaque ligne : déplacer un item ne
 * modifie qu'un champ. Absent pour un petit-déjeuner/collation (P3.1) : ces
 * catégories (Entrée/Plat/…) n'ont pas de sens hors d'un repas classique —
 * `item.section` reste néanmoins inchangé en interne (aucune migration).
 */
function sectionSelect(it) {
  if (ctx.kind !== 'meal') return '';
  return `<select data-section-of="${it.id}" class="section-select" aria-label="Section">
    ${SECTIONS.map((s) => `<option value="${s}" ${(it.section || DEFAULT_SECTION) === s ? 'selected' : ''}>${esc(SECTION_LABEL[s])}</option>`).join('')}
  </select>`;
}

function renderItems(entity, byId, recipesMap, preparationsMap) {
  if (!entity.items.length) {
    return `<div class="empty" style="margin:12px 0">Aucun ingrédient. Ajoute un aliment ci-dessous : la quantité est proposée automatiquement.</div>`;
  }
  if (ctx.kind !== 'meal') {
    // Un seul groupe, intitulé par type (P3.1) — pas de sous-division en
    // sections Entrée/Plat/… pour un petit-déjeuner ou une collation.
    const rows = entity.items.map((it) => renderItemRow(it, byId, recipesMap, preparationsMap)).join('');
    return `<div class="items" style="margin:12px 0">
      <div class="section-group" style="margin-bottom:14px">
        <h4 style="margin:0 0 6px">${esc(CATALOG_HEADING[targetType()])}</h4>
        ${rows}
      </div>
    </div>`;
  }
  const used = sectionsUsed(entity.items);
  const groups = used
    .map((section) => {
      const rows = entity.items
        .filter((it) => (it.section || DEFAULT_SECTION) === section)
        .map((it) => renderItemRow(it, byId, recipesMap, preparationsMap))
        .join('');
      return `<div class="section-group" style="margin-bottom:14px">
        <h4 style="margin:0 0 6px">${esc(SECTION_LABEL[section])}</h4>
        ${rows}
      </div>`;
    })
    .join('');
  return `<div class="items" style="margin:12px 0">${groups}</div>`;
}

/**
 * Libellé du stock d'une préparation, dans SON unité naturelle : grammes pour
 * `kind:'weight'`, nombre de portions pour `kind:'portion'` — `disponibleGrams`
 * et `prep.preparedQuantity` sont toujours en grammes/portions respectivement
 * en interne (voir `preparedGramsOf()`), converti ici uniquement pour l'affichage.
 */
function stockLabel(prep, disponibleGrams) {
  if (prep.recipeSnapshot?.kind === 'portion') {
    const portionGrams = portionGramsOf(prep.recipeSnapshot);
    const disponiblePortions = disponibleGrams / portionGrams;
    return `Disponible : ${num(disponiblePortions, 1)} portion(s) / ${num(prep.preparedQuantity, 0)} portion(s) préparées`;
  }
  return `Disponible : ${num(disponibleGrams, 0)} g / ${num(prep.preparedQuantity, 0)} g préparés`;
}

/**
 * Composition détaillée d'une recette/préparation pour une échelle donnée —
 * dérivée de `recipe.items`/`recipeSnapshot.items` à l'affichage, jamais
 * stockée. `scale` multiplie chaque `ci.qty` (la quantité de référence de
 * l'ingrédient dans la composition) :
 *  - `portion` : `scale` = nombre ENTIER de portions (ex. 2 → "6 Wasa · 60 g
 *    St Môret · 160 g poulet") ;
 *  - `weight`  : `scale` = quantité demandée ÷ somme des quantités de
 *    référence (`portionGramsOf`), un ratio CONTINU (ex. 428 g demandés pour
 *    une composition de référence de 200 g → scale = 2,14, "321 g Skyr ·
 *    107 g flocons d'avoine") — même formule, seule l'échelle diffère.
 * Un aliment non fractionnable s'affiche dans SON unité (réutilise
 * `isWholeUnitFood`/`toUnits`/`unitLabel`) ; un aliment fractionnable en
 * grammes, avec `decimals` décimales (0 pour une portion, 1 pour un poids —
 * `num()` élague déjà les décimales nulles, donc 428 g/200 g × 150 g = 321 g
 * s'affiche sans décimale superflue, et 214 g/200 g × 150 g = "160,5 g").
 */
function compositionLine(compositionItems, byId, scale, decimals = 0) {
  if (!scale || !compositionItems?.length) return '';
  return compositionItems
    .map((ci) => {
      const food = byId[ci.foodId];
      if (!food) return null;
      const scaled = (Number(ci.qty) || 0) * scale;
      return isWholeUnitFood(food)
        ? `${num(toUnits(food, scaled), 0)} ${unitLabel(food, toUnits(food, scaled))} ${esc(food.name)}`
        : `${num(scaled, decimals)} g ${esc(food.name)}`;
    })
    .filter(Boolean)
    .join(' · ');
}

/**
 * Ligne d'un item référençant une recette (molle) ou une préparation (ferme).
 * Résolue vers son aliment virtuel (`recipeAsVirtualFood`/`preparationAsVirtualFood`,
 * exactement ce que l'optimiseur utilise déjà) : une recette/préparation
 * `portion` se comporte alors comme n'importe quel aliment non fractionnable
 * (§4 de la demande) — saisie en NOMBRE DE PORTIONS, jamais en grammes.
 * `weight` reste en grammes, inchangé.
 */
function renderRecipeOrPreparationRow(it, byId, recipesMap, preparationsMap) {
  const isPrep = Boolean(it.preparationId);
  const recipe = isPrep ? null : recipesMap[it.recipeId];
  const prep = isPrep ? preparationsMap[it.preparationId] : null;
  if (isPrep && !prep) {
    return `<div class="item"><div class="item__main"><div class="item__name">Préparation supprimée</div>
      <div class="item__meta">Cette préparation n'existe plus.</div></div>
      <div class="item__tools">${sectionSelect(it)}<button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button></div></div>`;
  }
  if (!isPrep && !recipe) {
    return `<div class="item"><div class="item__main"><div class="item__name">Recette supprimée</div>
      <div class="item__meta">Cette recette n'existe plus.</div></div>
      <div class="item__tools">${sectionSelect(it)}<button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button></div></div>`;
  }
  const name = isPrep ? prep.label : recipe.name;
  const badge = isPrep ? '<span class="pill">préparation</span>' : '<span class="pill">recette</span>';
  const disponible = isPrep ? preparationAvailable(getState(), prep) : null;
  const virtualFood = isPrep ? preparationAsVirtualFood(prep, byId) : recipeAsVirtualFood(recipe, byId);
  const isPortion = (isPrep ? prep.recipeSnapshot?.kind : recipe.kind) === 'portion';
  const compositionItems = isPrep ? prep.recipeSnapshot?.items : recipe.items;
  // somme des quantités de référence de la composition — la SEULE échelle
  // pertinente pour déployer une recette `weight` proportionnellement
  // (portionGramsOf est générique : elle ne dépend pas de `kind`). Jamais
  // `baseGrams` ici : `baseGrams` est la référence de L'OPTIMISEUR (peut
  // différer, ex. poids après cuisson), alors que la composition affichée
  // doit toujours sommer EXACTEMENT à la quantité demandée.
  const referenceTotal = portionGramsOf({ items: compositionItems });
  const step = quantityStep(virtualFood, { inUnits: isPortion });

  const qtyBoxes = PERSONS.map((person) => {
    const qty = it.qty[person] || 0;
    const locked = !!it.locked[person];
    const portions = isPortion ? toUnits(virtualFood, qty) : 0;
    const shown = isPortion ? num(portions, 0) : num(qty, 1);
    // portion : échelle entière (nombre de portions) ; weight : ratio continu
    // quantité demandée ÷ composition de référence (ex. 428 g / 200 g = 2,14).
    const scale = isPortion ? Math.round(portions) : qty / referenceTotal;
    const composition = qty > 0 ? compositionLine(compositionItems, byId, scale, isPortion ? 0 : 1) : '';
    return `<div class="qty-box">
      <span class="person-name person-name--${person}">${PERSON_LABEL[person]}</span>
      <div class="qty-box__row">
        <input type="number" min="0" step="${step}" inputmode="decimal" value="${String(shown).replace(',', '.')}"
               data-qty="${it.id}" data-person="${person}" data-unitmode="${isPortion ? '1' : '0'}"
               aria-label="Quantité ${PERSON_LABEL[person]}">
        <span class="item__unit">${isPortion ? esc(unitLabel(virtualFood, portions)) : 'g'}</span>
        <button class="lock" data-lock="${it.id}" data-person="${person}" aria-pressed="${locked}"
                title="${locked ? 'Quantité verrouillée' : 'Quantité ajustable'}">${locked ? '🔒' : '🔓'}</button>
      </div>
      ${composition ? `<small>${esc(composition)}</small>` : ''}
    </div>`;
  }).join('');
  return `<div class="item">
    <div class="item__main">
      <div class="item__name">${esc(name)} ${badge}</div>
      <div class="item__meta">${isPrep ? stockLabel(prep, disponible) : 'Référence directe — pas encore préparée (calcul inverse)'}</div>
      ${
        isPrep
          ? `<label class="check" style="margin-top:6px">
               <input type="checkbox" data-zero-waste="${it.id}" ${it.zeroWaste ? 'checked' : ''}>
               Mode zéro reste (écouler cette préparation en priorité, même au-delà des objectifs)
             </label>`
          : ''
      }
      <div class="item__qty" style="margin-top:8px">${qtyBoxes}</div>
    </div>
    <div class="item__tools">
      ${sectionSelect(it)}
      <button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button>
    </div>
  </div>`;
}

function renderItemRow(it, byId, recipesMap = {}, preparationsMap = {}) {
  if (it.recipeId || it.preparationId) return renderRecipeOrPreparationRow(it, byId, recipesMap, preparationsMap);
  const food = it.foodId ? byId[it.foodId] : null;
      if (!food && it.foodId) {
        return `<div class="item"><div class="item__main"><div class="item__name">Aliment supprimé</div>
          <div class="item__meta">Cet ingrédient n'existe plus dans la banque.</div></div>
          <div class="item__tools">${sectionSelect(it)}<button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button></div></div>`;
      }
      if (!food) {
        return `<div class="item">
          <div class="item__main">
            <div class="item__name">${esc(it.free.name)} <span class="pill">libre</span></div>
            <div class="item__meta">Quantité : ${esc(it.free.quantity || 'au goût')} — non compté dans les macros, le batch et le budget.</div>
          </div>
          <div class="item__tools">
            ${sectionSelect(it)}
            <button class="btn btn--sm" data-promote="${it.id}">Créer l'aliment</button>
            <button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button>
          </div>
        </div>`;
      }

      const itemState = it.state || food.referenceState;
      const conv = conversionInfo(food, itemState);
      const stateBox = `<div class="qty-box">
        <span class="tag">État pesé</span>
        <select data-state="${it.id}" style="width:auto;min-width:136px">
          ${STATES.map((st) => `<option value="${st.id}" ${itemState === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}
        </select>
        <small class="${conv.needed && !conv.possible ? 'sync-error' : ''}">${
          conv.needed && conv.possible
            ? `converti via le rendement ${num(food.cookedFactor, 2)}`
            : conv.needed
              ? 'conversion impossible'
              : `valeurs pour 100 g ${esc(stateLabel(food.referenceState).toLowerCase())}`
        }</small>
      </div>`;

      // Saisie en unités ou en grammes ; dans les deux cas, la quantité stockée
      // reste un multiple entier de gramsPerUnit pour un aliment non fractionnable.
      const unitMode = isUnitFood(food) && food.unitEntry;
      // en grammes, le pas suit gramsPerUnit pour un aliment non fractionnable :
      // 13 → 26 → 39 → 52, jamais 25 → 26 → 27.
      const step = quantityStep(food, { inUnits: unitMode });

      const qtyBoxes = PERSONS.map((person) => {
        const qty = it.qty[person] || 0;
        const m = macrosFor(food, qty, it.state || food.referenceState);
        const locked = !!it.locked[person];
        const shown = unitMode ? num(toUnits(food, qty), isWholeUnitFood(food) ? 0 : 1) : num(qty, 1);
        return `<div class="qty-box">
          <span class="person-name person-name--${person}">${PERSON_LABEL[person]}</span>
          <div class="qty-box__row">
            <input type="number" min="0" step="${step}" inputmode="decimal" value="${String(shown).replace(',', '.')}"
                   data-qty="${it.id}" data-person="${person}" data-unitmode="${unitMode ? '1' : '0'}"
                   aria-label="Quantité ${PERSON_LABEL[person]}">
            <span class="item__unit">${unitMode ? esc(unitLabel(food, toUnits(food, qty))) : 'g'}</span>
            <button class="lock" data-lock="${it.id}" data-person="${person}" aria-pressed="${locked}"
                    title="${locked ? 'Quantité verrouillée' : 'Quantité ajustable'}">${locked ? '🔒' : '🔓'}</button>
          </div>
          <small class="nums">${
            m.unconvertible ? '— kcal · — P · — G · — L' : `${num(m.kcal, 0)} kcal · ${num(m.protein, 0)} P · ${num(m.carbs, 0)} G · ${num(m.fat, 0)} L`
          }</small>
          <small>${num(qty, 0)} g ${esc(stateLabel(itemState).toLowerCase())}${unitHint(food, qty) ? ` · ${unitHint(food, qty)}` : ''}</small>
        </div>`;
      }).join('');

      const cat = CATEGORIES.find((c) => c.id === food.category)?.label || '';
      return `<div class="item">
        <div class="item__main">
          <div class="item__name">${esc(food.name)}${food.brand ? ` <span class="tag">${esc(food.brand)}</span>` : ''}</div>
          <div class="item__meta">${esc(cat)}${food.batchAllowed ? '' : ' · cuisson du jour'}</div>
          <div class="row row--tight" style="margin-top:6px">
            ${
              isUnitFood(food)
                ? `<button class="btn btn--sm" data-unit-toggle="${food.id}">Saisie : ${food.unitEntry ? esc(unitLabel(food, 1)) : 'grammes'}</button>`
                : ''
            }
            ${isWholeUnitFood(food) ? `<span class="tag">multiples de ${num(food.gramsPerUnit, 0)} g (pas du curseur)</span>` : ''}
          </div>
          ${
            conv.needed && !conv.possible
              ? `<div class="card sync-error" style="margin-top:8px;padding:8px;border-color:#eebeb9;background:var(--off-bg)">${esc(conv.message)}</div>`
              : ''
          }
          <div class="item__qty" style="margin-top:8px">${qtyBoxes}${stateBox}</div>
          ${conv.message ? `<div class="tag sync-error" style="margin-top:6px">⚠️ ${esc(conv.message)}</div>` : ''}
        </div>
        <div class="item__tools">
          ${sectionSelect(it)}
          <button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button>
        </div>
      </div>`;
}

/** Liste filtrée des aliments proposés (recherche + filtres). */
function pickerList(state) {
  const q = normalize(pickerQuery);
  let list = state.foods;
  if (pickerCategory === 'fav') list = list.filter((f) => f.favorite);
  else if (pickerCategory === 'recent') list = list.filter((f) => f.lastUsed).sort((a, b) => (b.lastUsed > a.lastUsed ? 1 : -1));
  else if (pickerCategory !== 'all') list = list.filter((f) => f.category === pickerCategory);
  if (q) list = list.filter((f) => normalize(`${f.name} ${f.brand}`).includes(q));
  return list.slice(0, 40);
}

/** HTML de la seule liste de résultats. */
function pickerResults(state) {
  const list = pickerList(state);
  if (!list.length) {
    return `<div style="padding:12px" class="muted">Aucun aliment ne correspond. Crée-le dans l'écran Aliments, ou ajoute-le comme ingrédient libre.</div>`;
  }
  return list
    .map(
      (f) => `<button data-add="${f.id}">
        <strong>${esc(f.name)}</strong>${f.favorite ? ' ★' : ''}${isWholeUnitFood(f) ? ' <span class="tag">non fractionnable</span>' : ''}
        <div class="cat">${esc(CATEGORIES.find((c) => c.id === f.category)?.label || '')} · ${num(f.kcal, 0)} kcal · ${num(f.protein, 1)} P / ${num(f.carbs, 1)} G / ${num(f.fat, 1)} L (100 g ${esc(f.referenceState)})${
        isWholeUnitFood(f) ? ` · ${num(f.gramsPerUnit, 0)} g / ${esc(f.unitName || 'unité')}` : ''
      }</div>
      </button>`
    )
    .join('');
}

/**
 * Met à jour UNIQUEMENT la liste des résultats : la fenêtre reste en place et
 * le champ de recherche conserve son focus et son curseur.
 */
function updateResults() {
  const box = host?.querySelector('.picker__results');
  if (!box) return;
  box.innerHTML = pickerResults(getState());
  box.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', onAddFood));
}

function renderPicker(state, entity, recipesMap, preparationsMap) {
  const chips = [
    ['all', 'Tous'],
    ['fav', 'Favoris'],
    ['recent', 'Récents'],
    ...CATEGORIES.map((c) => [c.id, c.label]),
  ]
    .map(
      ([id, label]) =>
        `<button class="chip" data-cat="${id}" aria-pressed="${pickerCategory === id}">${esc(label)}</button>`
    )
    .join('');

  const personSelector = entity.sameComposition
    ? ''
    : `<div class="row" style="margin-bottom:8px">
         <small>Ajouter pour :</small>
         ${[['both', 'Les deux'], ['thomas', 'Thomas'], ['julie', 'Julie']]
           .map(([id, label]) => `<button class="chip" data-target-person="${id}" aria-pressed="${addFor === id}">${label}</button>`)
           .join('')}
       </div>`;

  const sectionSelector = `<div class="row" style="margin-bottom:8px">
       <small>Dans la section :</small>
       ${SECTIONS.map((s) => `<button class="chip" data-target-section="${s}" aria-pressed="${addSection === s}">${esc(SECTION_LABEL[s])}</button>`).join('')}
     </div>`;

  return `<div class="card">
    <div class="card__head"><h3>Ajouter un ingrédient</h3></div>
    ${sectionSelector}
    ${personSelector}
    <input type="text" data-search value="${esc(pickerQuery)}" placeholder="Rechercher un aliment…">
    <div class="chips" style="margin:10px 0">${chips}</div>
    <div class="picker__results" style="position:static;border:1px solid var(--line);border-radius:var(--radius-sm);max-height:260px">${pickerResults(state)}</div>
    <div class="row" style="margin-top:12px">
      <input type="text" data-free-name placeholder="Ingrédient libre (ex. curry)" style="flex:2;min-width:150px">
      <input type="text" data-free-qty placeholder="Quantité (ex. au goût)" style="flex:1;min-width:120px">
      <button class="btn" data-free-add>Ajouter</button>
    </div>
    <small>Un ingrédient libre apparaît dans le repas et à l'impression, mais ne compte ni dans les macros, ni dans le batch, ni dans le budget.</small>
  </div>
  ${renderRecipesPanel(state, recipesMap, preparationsMap)}`;
}

/** Recettes/préparations — `kind:'weight'` et `kind:'portion'` toutes deux disponibles. */
function renderRecipesPanel(state, recipesMap, preparationsMap) {
  const recipes = Object.values(recipesMap);
  if (!recipes.length) {
    return `<div class="card" style="margin-top:16px">
      <div class="card__head"><h3>Recettes & préparations</h3></div>
      <small>Aucune recette créée pour l'instant. Crée-en une dans l'écran Recettes.</small>
    </div>`;
  }
  const recipeRows = recipes
    .map((r) => `<div class="item" style="padding:6px 0">
        <div class="item__main">
          <div class="item__name">${esc(r.name)} <span class="pill">${r.kind === 'portion' ? 'portion' : 'au poids'}</span></div>
          <div class="item__meta">${r.kind === 'portion' ? `1 portion = ${num(portionGramsOf(r), 0)} g` : `${num(r.baseGrams, 0)} g de référence`}</div>
        </div>
        <div class="item__tools">
          <button class="btn btn--sm" data-add-recipe="${r.id}">+ Recette (sans préparation)</button>
        </div>
      </div>`)
    .join('');

  const preparations = Object.values(preparationsMap);
  const prepRows = preparations
    .map((p) => {
      const disponible = preparationAvailable(state, p);
      const recipeName = recipesMap[p.recipeId]?.name || '?';
      const slots = zeroWasteSlotsFor(state, p.id);
      return `<div class="item" style="padding:6px 0">
        <div class="item__main">
          <div class="item__name">${esc(p.label)} <span class="tag">${esc(recipeName)}</span></div>
          <div class="item__meta">${stockLabel(p, disponible)}</div>
          ${slots.length ? `<small>${slots.length} créneau(x) en mode zéro reste pour cette préparation</small>` : ''}
        </div>
        <div class="item__tools">
          <button class="btn btn--sm" data-use-preparation="${p.id}" ${disponible <= 0 ? 'disabled' : ''}>+ Utiliser</button>
          <button class="btn btn--sm" data-zero-waste-apply="${p.id}" ${slots.length < 2 ? 'disabled' : ''}
                  title="${slots.length < 2 ? 'Coche « mode zéro reste » sur au moins 2 créneaux (repas) référençant cette préparation' : ''}">
            Répartir en zéro reste
          </button>
        </div>
      </div>`;
    })
    .join('');

  return `<div class="card" style="margin-top:16px">
    <div class="card__head"><h3>Recettes & préparations</h3></div>
    ${recipeRows}
    ${preparations.length ? `<div style="margin-top:8px">${prepRows}</div>` : '<small>Aucune préparation matérialisée pour l’instant.</small>'}
    <div class="row" style="margin-top:12px">
      <select data-new-prep-recipe style="flex:1;min-width:150px">
        ${recipes.map((r) => `<option value="${r.id}">${esc(r.name)} (${r.kind === 'portion' ? 'portion' : 'poids'})</option>`).join('')}
      </select>
      <input type="number" min="1" step="1" data-new-prep-qty placeholder="Quantité préparée (g, ou nb de portions)" style="flex:1;min-width:150px">
      <button class="btn" data-new-prep>Créer une préparation</button>
    </div>
    <small>Quantité RÉELLEMENT obtenue après cuisson (en grammes pour une recette au poids, en NOMBRE DE PORTIONS pour une recette portion) — jamais recalculée depuis les ingrédients.</small>
  </div>`;
}


/* ------------------------------------------------------------------ */
/* Interactions                                                        */
/* ------------------------------------------------------------------ */

/** Ajout d'un aliment au repas en cours (quantité initiale proposée puis ajustée). */
function onAddFood(e) {
  const foodId = e.currentTarget.dataset.add;
  const food = getState().foods.find((f) => f.id === foodId);
  if (!food) return;
  const qty = initialQuantity(food);
  mutate((en, s) => {
    const item = newItem(foodId, qty, food.referenceState);
    item.section = addSection;
    if (!en.sameComposition && addFor !== 'both') {
      for (const p of PERSONS) item.qty[p] = p === addFor ? qty : 0;
    }
    en.items.push(item);
    const f = s.foods.find((x) => x.id === foodId);
    if (f) f.lastUsed = new Date().toISOString();
  });
}

function wire(root, entity) {
  root.querySelector('[data-close]')?.addEventListener('click', closeEditor);
  root.querySelector('[data-close-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.closeBackdrop !== undefined) closeEditor();
  });

  // P3.2 : bascule 16 h / soir directement dans le tiroir, sans le fermer —
  // même collation, mêmes items, seul `targetSlot` (la cible macro de
  // référence) change ; identique au toggle déjà existant sur l'écran
  // catalogue (catalogs.js), réutilise le même mécanisme mutate().
  root.querySelectorAll('[data-set-slot]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const slot = e.currentTarget.dataset.setSlot;
      mutate((en) => { en.targetSlot = slot; }, { adjust: false });
    });
  });

  root.querySelector('[data-name]')?.addEventListener('change', (e) => {
    const v = e.target.value;
    // Saisie manuelle (y compris un champ volontairement vidé) : nameAuto
    // passe à false immédiatement, avant le hook de régénération de mutate()
    // — un repas dont le nom vient d'être tapé/effacé à la main n'est plus
    // jamais recalculé automatiquement (règle obligatoire P2.4).
    mutate((en) => { en.name = v; if (ctx.kind === 'meal') en.nameAuto = false; }, { adjust: false });
  });

  root.querySelector('[data-same]')?.addEventListener('change', (e) => {
    const v = e.target.checked;
    mutate((en) => {
      en.sameComposition = v;
      if (v) {
        // on ré-active tous les ingrédients pour les deux personnes
        for (const it of en.items) {
          for (const p of PERSONS) if (!it.qty[p]) it.qty[p] = it.qty.thomas || it.qty.julie || 0;
        }
      }
    });
  });

  root.querySelector('[data-auto]')?.addEventListener('change', (e) => {
    const v = e.target.checked;
    update((s) => { s.settings.autoAdjust = v; });
    renderEditor();
  });

  root.querySelector('[data-adjust]')?.addEventListener('click', () => {
    mutate(() => {}, { adjust: true, force: true });
    toast('Quantités ajustées');
  });

  root.querySelectorAll('[data-qty]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const id = e.target.dataset.qty;
      const person = e.target.dataset.person;
      const inUnits = e.target.dataset.unitmode === '1';
      const raw = Math.max(0, Number(String(e.target.value).replace(',', '.')) || 0);
      mutate((en, st) => {
        const it = en.items.find((i) => i.id === id);
        if (!it) return;
        // aliment réel (foodId) OU virtuel (recipeId/preparationId) — même
        // résolution que l'optimiseur (nutrition.js), pour qu'une recette
        // `portion` snap EXACTEMENT comme un aliment non fractionnable.
        const food = resolveItemFood(it, foodsByIdFrom(st), recipesByIdFrom(st), preparationsByIdFrom(st));
        const grams = inUnits && food ? fromUnits(food, raw) : raw;
        // contrainte absolue : multiple entier de gramsPerUnit si non fractionnable
        it.qty[person] = snapQuantity(food, grams);
        // P1.2 (décision verrouillée) : toute saisie manuelle verrouille
        // immédiatement et durablement cette quantité, pour cette personne
        // uniquement — jusqu'ici seul `pinned` (local à cet appel de
        // mutate()) protégeait l'item pendant CET ajustement ; rien ne le
        // protégeait des ajustements suivants (bug réel : une modification
        // manuelle pouvait être défaite par un ajustement ultérieur sur un
        // AUTRE aliment). `pinned` reste en place : il protège l'item
        // pendant l'ajustement immédiat déclenché plus bas, avant même que
        // ce nouveau `locked` n'ait besoin d'être relu.
        it.locked[person] = true;
      }, { pinned: [id] });
    });
  });

  root.querySelectorAll('[data-unit-toggle]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const foodId = e.currentTarget.dataset.unitToggle;
      update((st) => {
        const f = st.foods.find((x) => x.id === foodId);
        if (f) f.unitEntry = !f.unitEntry;
      });
      renderEditor();
    });
  });

  root.querySelectorAll('[data-section-of]').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const id = e.target.dataset.sectionOf;
      const v = e.target.value;
      // déplacer un item d'une section à l'autre ne modifie qu'un champ,
      // sans effet sur les macros : pas de réajustement.
      mutate((en) => {
        const it = en.items.find((i) => i.id === id);
        if (it) it.section = v;
      }, { adjust: false });
    });
  });

  root.querySelectorAll('[data-zero-waste]').forEach((box) => {
    box.addEventListener('change', (e) => {
      const id = e.target.dataset.zeroWaste;
      const v = e.target.checked;
      // aucun réajustement automatique ici : le mode normal (≤ disponible)
      // continue de s'appliquer tant que "Répartir en mode zéro reste" n'a
      // pas été explicitement déclenché — jamais de bascule automatique.
      mutate((en) => {
        const it = en.items.find((i) => i.id === id);
        if (it) it.zeroWaste = v;
      }, { adjust: false });
    });
  });

  root.querySelectorAll('[data-lock]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.lock;
      const person = e.currentTarget.dataset.person;
      mutate((en) => {
        const it = en.items.find((i) => i.id === id);
        if (it) it.locked[person] = !it.locked[person];
      });
    });
  });

  root.querySelectorAll('[data-state]').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const id = e.target.dataset.state;
      const v = e.target.value;
      mutate((en) => {
        const it = en.items.find((i) => i.id === id);
        if (it) it.state = v;
      });
    });
  });

  root.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.del;
      mutate((en) => { en.items = en.items.filter((i) => i.id !== id); });
    });
  });

  root.querySelectorAll('[data-promote]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.promote;
      const item = entity.items.find((i) => i.id === id);
      if (!item) return;
      const foodId = `f_${uid('custom')}`;
      update((s) => {
        s.foods.push({
          id: foodId, name: item.free.name, category: 'autre', brand: '',
          kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0,
          referenceState: 'pret', cookedFactor: 1, unitName: '', gramsPerUnit: 0,
          fractionable: true, price: null, packageWeight: null, batchAllowed: false,
          favorite: false, lastUsed: null,
        });
      });
      toast(`« ${item.free.name} » créé dans la banque — complète ses valeurs dans Aliments.`);
    });
  });

  // La recherche ne reconstruit QUE la liste des résultats : le champ garde le
  // focus et la fenêtre ne se réaffiche pas à chaque frappe.
  root.querySelector('[data-search]')?.addEventListener('input', (e) => {
    pickerQuery = e.target.value;
    updateResults();
  });

  root.querySelectorAll('[data-cat]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      pickerCategory = e.currentTarget.dataset.cat;
      for (const c of root.querySelectorAll('[data-cat]')) {
        c.setAttribute('aria-pressed', String(c.dataset.cat === pickerCategory));
      }
      updateResults();
    });
  });

  root.querySelectorAll('[data-target-person]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      addFor = e.currentTarget.dataset.targetPerson;
      renderEditor();
    });
  });

  root.querySelectorAll('[data-target-section]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      addSection = e.currentTarget.dataset.targetSection;
      renderEditor();
    });
  });

  root.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', onAddFood));

  root.querySelector('[data-free-add]')?.addEventListener('click', () => {
    const nameEl = root.querySelector('[data-free-name]');
    const qtyEl = root.querySelector('[data-free-qty]');
    const name = nameEl.value.trim();
    if (!name) { toast('Donne un nom à l\'ingrédient libre', 'error'); return; }
    const quantity = qtyEl.value.trim() || 'au goût';
    mutate((en) => {
      const item = newFreeItem(name, quantity);
      item.section = addSection;
      en.items.push(item);
    }, { adjust: false });
  });

  root.querySelectorAll('[data-add-recipe]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const recipeId = e.currentTarget.dataset.addRecipe;
      const recipe = getState().recipes.find((r) => r.id === recipeId);
      if (!recipe) return;
      // quantité initiale = 1 portion pour une recette portion, la référence pour une recette au poids
      const qty = recipe.kind === 'portion'
        ? portionGramsOf(recipe)
        : Math.max(1, Math.round(Number(recipe.baseGrams) || 0));
      mutate((en) => {
        const it = newRecipeMealItem(recipeId, qty);
        it.section = addSection;
        if (!en.sameComposition && addFor !== 'both') {
          for (const p of PERSONS) it.qty[p] = p === addFor ? qty : 0;
        }
        en.items.push(it);
      });
    });
  });

  root.querySelectorAll('[data-use-preparation]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const prepId = e.currentTarget.dataset.usePreparation;
      const prep = getState().preparations.find((p) => p.id === prepId);
      if (!prep) return;
      const disponible = preparationAvailable(getState(), prep); // toujours en grammes (preparedGramsOf)
      // quantité initiale : 1 portion pour une préparation portion (jamais une
      // fraction de portion), sinon une tranche raisonnable du disponible.
      const qty = prep.recipeSnapshot?.kind === 'portion'
        ? Math.min(portionGramsOf(prep.recipeSnapshot), Math.max(1, disponible))
        : Math.max(1, Math.round(Math.min(disponible, 200)));
      mutate((en) => {
        const it = newPreparationItem(prepId, qty);
        it.section = addSection;
        if (!en.sameComposition && addFor !== 'both') {
          for (const p of PERSONS) it.qty[p] = p === addFor ? qty : 0;
        }
        en.items.push(it);
      });
    });
  });

  root.querySelector('[data-new-prep]')?.addEventListener('click', () => {
    const recipeSel = root.querySelector('[data-new-prep-recipe]');
    const qtyEl = root.querySelector('[data-new-prep-qty]');
    const recipe = getState().recipes.find((r) => r.id === recipeSel?.value);
    const qty = Number(qtyEl?.value);
    if (!recipe) { toast('Choisis une recette', 'error'); return; }
    if (!(qty > 0)) { toast('Indique la quantité réellement obtenue (g)', 'error'); return; }
    update((s) => {
      const r = s.recipes.find((x) => x.id === recipe.id);
      if (r) s.preparations.push(newPreparation(r, qty));
    });
    toast(`Préparation « ${recipe.name} » créée (${qty} g)`);
    renderEditor();
  });

  root.querySelectorAll('[data-zero-waste-apply]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const prepId = e.currentTarget.dataset.zeroWasteApply;
      let summary = null;
      update((s) => {
        const prep = s.preparations.find((p) => p.id === prepId);
        if (!prep) return;
        const slots = zeroWasteSlotsFor(s, prepId);
        if (slots.length < 2) return;
        const byIdFoods = foodsByIdFrom(s);
        const recMap = recipesByIdFrom(s);
        const prepMap = preparationsByIdFrom(s);
        const targetForMeal = (meal, person) => s.settings.targets[person][meal.mealType];

        // évaluations AVANT (mode normal courant), pour détecter un
        // dépassement CAUSÉ par l'égalité — une comparaison, pas un
        // mécanisme séparé (§9/§20 de la spécification).
        const before = slots.map(({ meal, person }) =>
          evaluate(mealMacros(meal.items, byIdFoods, person, recMap, prepMap), targetForMeal(meal, person), s.settings.tolerance)
        );

        const roundStep = prep.recipeSnapshot?.kind === 'portion' ? portionGramsOf(prep.recipeSnapshot) : 1;
        const result = resolveZeroWasteAllocation(
          slots.map(({ meal, item, person }) => ({
            items: meal.items, itemId: item.id, target: targetForMeal(meal, person), person,
          })),
          preparedGramsOf(prep), byIdFoods, recMap, prepMap, { roundStep }
        );

        slots.forEach((slot, i) => {
          slot.item.qty[slot.person] = result.allocation[i];
          for (const [itemId, qty] of Object.entries(result.quantities[i])) {
            const other = slot.meal.items.find((x) => x.id === itemId);
            if (other) other.qty[slot.person] = qty;
          }
        });

        const after = slots.map(({ meal, person }) =>
          evaluate(mealMacros(meal.items, byIdFoods, person, recMap, prepMap), targetForMeal(meal, person), s.settings.tolerance)
        );
        const causedByZeroWaste = after.some((ev, i) => ev.status !== 'ok' && before[i].status === 'ok');
        const sumGrams = result.allocation.reduce((a, b) => a + b, 0);
        const isPortion = prep.recipeSnapshot?.kind === 'portion';
        summary = {
          sumLabel: isPortion ? `${sumGrams / roundStep} portion(s)` : `${sumGrams} g`,
          preparedLabel: isPortion ? `${prep.preparedQuantity} portion(s)` : `${prep.preparedQuantity} g`,
          causedByZeroWaste,
        };
      });
      if (summary) {
        toast(
          `Zéro reste appliqué : ${summary.sumLabel} / ${summary.preparedLabel} affectés` +
          (summary.causedByZeroWaste ? ' — dépassement des objectifs causé par le zéro reste' : '')
        );
      }
      renderEditor();
    });
  });
}
