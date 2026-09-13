/**
 * Éditeur partagé : repas du planning, petits-déjeuners, collations.
 * C'est ici que vit l'expérience "calcul + ajustement en continu".
 */

import { getState, update, foodsById, newItem, newFreeItem, catalogKey } from '../core/store.js';
import {
  CATEGORIES, STATES, PERSONS, PERSON_LABEL, MEAL_TYPES,
  mealMacros, macrosFor, evaluate, autoAdjust, initialQuantity, diagnose,
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
  if (ctx.kind !== 'meal') return ctx.kind;
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

  host.innerHTML = `
    <div class="drawer" data-close-backdrop>
      <div class="drawer__panel" role="dialog" aria-label="Édition du repas">
        <div class="drawer__head">
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
          </div>
        </div>
        <div class="drawer__body">
          ${renderSummary(entity, byId, targets, tol, state)}
          ${renderItems(entity, byId, state)}
          ${renderPicker(state, entity)}
        </div>
      </div>
    </div>`;

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

  return `<div class="card">${blocks}</div>`;
}

function unitHint(food, qty) {
  if (!food.gramsPerUnit || !food.unitName) return '';
  const u = qty / food.gramsPerUnit;
  const txt = food.fractionable ? num(u, 1) : Math.round(u);
  return `≈ ${txt} ${esc(food.unitName)}${Math.abs(u) >= 2 && !/^c\./.test(food.unitName) ? 's' : ''}`;
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

      const stateSel = `<select data-state="${it.id}" style="width:auto;min-width:116px">
        ${STATES.map((s) => `<option value="${s.id}" ${(it.state || food.referenceState) === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>`;

      const qtyBoxes = PERSONS.map((person) => {
        const qty = it.qty[person] || 0;
        const m = macrosFor(food, qty, it.state || food.referenceState);
        const locked = !!it.locked[person];
        return `<div class="qty-box">
          <span class="person-name person-name--${person}">${PERSON_LABEL[person]}</span>
          <div class="qty-box__row">
            <input type="number" min="0" step="1" inputmode="numeric" value="${num(qty, 1).replace(',', '.')}"
                   data-qty="${it.id}" data-person="${person}" aria-label="Quantité ${PERSON_LABEL[person]}">
            <span class="item__unit">g</span>
            <button class="lock" data-lock="${it.id}" data-person="${person}" aria-pressed="${locked}"
                    title="${locked ? 'Quantité verrouillée' : 'Quantité ajustable'}">${locked ? '🔒' : '🔓'}</button>
          </div>
          <small class="nums">${num(m.kcal, 0)} kcal · ${num(m.protein, 0)} P · ${num(m.carbs, 0)} C · ${num(m.fat, 0)} L</small>
          <small>${unitHint(food, qty)}</small>
        </div>`;
      }).join('');

      const cat = CATEGORIES.find((c) => c.id === food.category)?.label || '';
      return `<div class="item">
        <div class="item__main">
          <div class="item__name">${esc(food.name)}${food.brand ? ` <span class="tag">${esc(food.brand)}</span>` : ''}</div>
          <div class="item__meta">${esc(cat)}${food.batchAllowed ? '' : ' · cuisson du jour'}</div>
          <div class="row row--tight" style="margin-top:6px">${stateSel}</div>
          <div class="item__qty" style="margin-top:8px">${qtyBoxes}</div>
        </div>
        <div class="item__tools">
          <button class="btn btn--sm btn--danger" data-del="${it.id}">Retirer</button>
        </div>
      </div>`;
    })
    .join('');

  return `<div class="items" style="margin:12px 0">${rows}</div>`;
}

function renderPicker(state, entity) {
  const q = normalize(pickerQuery);
  let list = state.foods;
  if (pickerCategory === 'fav') list = list.filter((f) => f.favorite);
  else if (pickerCategory === 'recent') list = list.filter((f) => f.lastUsed).sort((a, b) => (b.lastUsed > a.lastUsed ? 1 : -1));
  else if (pickerCategory !== 'all') list = list.filter((f) => f.category === pickerCategory);
  if (q) list = list.filter((f) => normalize(`${f.name} ${f.brand}`).includes(q));
  list = list.slice(0, 40);

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

  const results = list.length
    ? list
        .map(
          (f) => `<button data-add="${f.id}">
            <strong>${esc(f.name)}</strong>${f.favorite ? ' ★' : ''}
            <div class="cat">${esc(CATEGORIES.find((c) => c.id === f.category)?.label || '')} · ${num(f.kcal, 0)} kcal · ${num(f.protein, 1)} P / ${num(f.carbs, 1)} C / ${num(f.fat, 1)} L (100 g ${esc(f.referenceState)})</div>
          </button>`
        )
        .join('')
    : `<div style="padding:12px" class="muted">Aucun aliment. Crée-le dans l'écran Aliments, ou ajoute-le comme ingrédient libre.</div>`;

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
    <div class="picker__results" style="position:static;border:1px solid var(--line);border-radius:var(--radius-sm);max-height:260px">${results}</div>
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
      const value = Math.max(0, Number(String(e.target.value).replace(',', '.')) || 0);
      mutate((en) => {
        const it = en.items.find((i) => i.id === id);
        if (!it) return;
        it.qty[person] = value;
        if (en.sameComposition) {
          // rien de plus : chaque personne garde sa propre quantité
        }
      }, { pinned: [id] });
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

  const search = root.querySelector('[data-search]');
  search?.addEventListener('input', (e) => {
    pickerQuery = e.target.value;
    renderEditor();
    const s2 = document.querySelector('[data-search]');
    if (s2) { s2.focus(); s2.setSelectionRange(s2.value.length, s2.value.length); }
  });

  root.querySelectorAll('[data-target-person]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      addFor = e.currentTarget.dataset.targetPerson;
      renderEditor();
    });
  });

  root.querySelectorAll('[data-cat]').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      pickerCategory = e.currentTarget.dataset.cat;
      renderEditor();
    });
  });

  root.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
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
    });
  });

  root.querySelector('[data-free-add]')?.addEventListener('click', () => {
    const nameEl = root.querySelector('[data-free-name]');
    const qtyEl = root.querySelector('[data-free-qty]');
    const name = nameEl.value.trim();
    if (!name) { toast('Donne un nom à l\'ingrédient libre', 'error'); return; }
    const quantity = qtyEl.value.trim() || 'au goût';
    mutate((en) => { en.items.push(newFreeItem(name, quantity)); }, { adjust: false });
  });
}
