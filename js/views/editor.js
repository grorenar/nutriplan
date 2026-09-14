/**
 * Éditeur partagé : repas du planning, petits-déjeuners, collations.
 * C'est ici que vit l'expérience "calcul + ajustement en continu".
 */

import { getState, update, foodsById, newItem, newFreeItem, catalogKey } from '../core/store.js';
import {
  CATEGORIES, STATES, PERSONS, PERSON_LABEL, MEAL_TYPES,
  mealMacros, macrosFor, evaluate, autoAdjust, initialQuantity, diagnose,
  snapQuantity, isUnitFood, isWholeUnitFood, toUnits, fromUnits, quantityStep,
  conversionInfo, stateLabel,
} from '../core/nutrition.js';
import { esc, num, normalize, toast, uid } from '../core/util.js';

let ctx = null; // { kind, id }
let pickerQuery = '';
let pickerCategory = 'all';
let addFor = 'both'; // utilisé quand les compositions diffèrent
let host = null;

export const isOpen = () => ctx !== null;

export function openEditor(kind, id) {
  ctx = { kind, id };
  pickerQuery = '';
  pickerCategory = 'all';
  addFor = 'both';
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

/** Mutation de l'entité + ajustement automatique optionnel. */
function mutate(fn, { adjust = true, pinned = [] } = {}) {
  update((s) => {
    const e = entityFrom(s);
    if (!e) return;
    fn(e, s);
    if (adjust && s.settings.autoAdjust) {
      autoAdjust(e.items, foodsByIdFrom(s), targetsForState(s), { pinned });
    }
  });
  renderEditor();
}

const foodsByIdFrom = (s) => Object.fromEntries(s.foods.map((f) => [f.id, f]));
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
    ${renderSummary(entity, byId, targets, tol, state)}
    ${renderItems(entity, byId, state)}
    ${renderPicker(state, entity)}`;

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

function renderSummary(entity, byId, targets, tol, state) {
  const blocks = PERSONS.map((person) => {
    const macros = mealMacros(entity.items, byId, person);
    const ev = evaluate(macros, targets[person], tol);
    const diag = diagnose(macros, targets[person], state.foods, tol);
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
    </div>`;
  }).join('');

  // ingrédients écartés du total faute de conversion définie
  const excluded = mealMacros(entity.items, byId, PERSONS[0]).unconvertible || 0;
  const notice = excluded
    ? `<div class="sync-error"><small>${excluded} ingrédient(s) exclu(s) du total : aucune conversion définie entre l'état pesé et celui de leurs valeurs nutritionnelles.</small></div>`
    : '';

  return `<div class="card">${blocks}${notice}</div>`;
}

/** Libellé d'unité au pluriel simple ("2 tranches", "2 c. à soupe"). */
function unitLabel(food, count) {
  const name = food.unitName || 'unité';
  const plural = Math.abs(count) >= 2 && !/^c\./.test(name) ? 's' : '';
  return `${name}${plural}`;
}

/** Équivalence affichée sous le champ de saisie. */
function unitHint(food, qty) {
  if (!isUnitFood(food)) return '';
  const u = toUnits(food, qty);
  if (food.unitEntry) return `= ${num(qty, 0)} g`;
  const txt = isWholeUnitFood(food) ? Math.round(u) : num(u, 1);
  return `≈ ${txt} ${esc(unitLabel(food, u))}`;
}

function renderItems(entity, byId, state) {
  if (!entity.items.length) {
    return `<div class="empty" style="margin:12px 0">Aucun ingrédient. Ajoute un aliment ci-dessous : la quantité est proposée automatiquement.</div>`;
  }
  const rows = entity.items
    .map((it) => {
      const food = it.foodId ? byId[it.foodId] : null;
      if (!food && it.foodId) {
        return `<div class="item"><div class="item__main"><div class="item__name">Aliment supprimé</div>
          <div class="item__meta">Cet ingrédient n'existe plus dans la banque.</div></div>
          <div class="item__tools"><button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button></div></div>`;
      }
      if (!food) {
        return `<div class="item">
          <div class="item__main">
            <div class="item__name">${esc(it.free.name)} <span class="pill">libre</span></div>
            <div class="item__meta">Quantité : ${esc(it.free.quantity || 'au goût')} — non compté dans les macros, le batch et le budget.</div>
          </div>
          <div class="item__tools">
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
          <button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button>
        </div>
      </div>`;
    })
    .join('');

  return `<div class="items" style="margin:12px 0">${rows}</div>`;
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
        <strong>${esc(f.name)}</strong>${f.favorite ? ' ★' : ''}
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

function renderPicker(state, entity) {
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

  return `<div class="card">
    <div class="card__head"><h3>Ajouter un ingrédient</h3></div>
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

  root.querySelector('[data-name]')?.addEventListener('change', (e) => {
    const v = e.target.value;
    mutate((en) => { en.name = v; }, { adjust: false });
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
    mutate(() => {}, { adjust: true });
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
        const food = st.foods.find((f) => f.id === it.foodId);
        const grams = inUnits && food ? fromUnits(food, raw) : raw;
        // contrainte absolue : multiple entier de gramsPerUnit si non fractionnable
        it.qty[person] = snapQuantity(food, grams);
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

  root.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', onAddFood));

  root.querySelector('[data-free-add]')?.addEventListener('click', () => {
    const nameEl = root.querySelector('[data-free-name]');
    const qtyEl = root.querySelector('[data-free-qty]');
    const name = nameEl.value.trim();
    if (!name) { toast('Donne un nom à l\'ingrédient libre', 'error'); return; }
    const quantity = qtyEl.value.trim() || 'au goût';
    mutate((en) => { en.items.push(newFreeItem(name, quantity)); }, { adjust: false });
  });
}
