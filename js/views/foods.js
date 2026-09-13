/** Écran ALIMENTS — banque alimentaire entièrement modifiable. */

import { getState, update } from '../core/store.js';
import { CATEGORIES, STATES } from '../core/nutrition.js';
import { esc, num, normalize, toast, uid, euros } from '../core/util.js';
import { findSimilarFoods } from '../core/similarity.js';

let query = '';
let cat = 'all';
let editing = null; // id d'aliment ou 'new'
let similarWarning = null; // { list, pending } — avertissement doublon, jamais bloquant

export function render(root) {
  const s = getState();
  const q = normalize(query);
  let list = [...s.foods].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (cat === 'fav') list = list.filter((f) => f.favorite);
  else if (cat !== 'all') list = list.filter((f) => f.category === cat);
  if (q) list = list.filter((f) => normalize(`${f.name} ${f.brand}`).includes(q));

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <input type="text" data-q value="${esc(query)}" placeholder="Rechercher un aliment…" style="flex:1;min-width:200px">
      <button class="btn btn--primary" data-new>Nouvel aliment</button>
    </div>
    <div class="chips" style="margin-bottom:12px">
      ${[['all', 'Tous'], ['fav', 'Favoris'], ...CATEGORIES.map((c) => [c.id, c.label])]
        .map(([id, label]) => `<button class="chip" data-cat="${id}" aria-pressed="${cat === id}">${esc(label)}</button>`)
        .join('')}
    </div>
    <div class="card">
      <table>
        <thead><tr>
          <th>Aliment</th><th class="nums">kcal</th><th class="nums">P</th><th class="nums">G</th><th class="nums">L</th>
          <th>État</th><th>Unité</th><th class="nums">Prix</th><th>Batch</th><th></th>
        </tr></thead>
        <tbody>
          ${list.length ? list.map(rowOf).join('') : `<tr><td colspan="10" class="muted">Aucun aliment ne correspond.</td></tr>`}
        </tbody>
      </table>
    </div>
    <small>${list.length} aliment(s) affiché(s) sur ${s.foods.length}. Valeurs pour 100 g dans l'état de référence.</small>
    ${editing ? formPanel(s) : ''}
  `;
  wire(root);
}

function rowOf(f) {
  return `<tr>
    <td><strong>${esc(f.name)}</strong>${f.brand ? ` <span class="tag">${esc(f.brand)}</span>` : ''}
      ${f.favorite ? ' ★' : ''}
      <div class="tag">${esc(CATEGORIES.find((c) => c.id === f.category)?.label || '')}</div></td>
    <td class="nums">${num(f.kcal, 0)}</td>
    <td class="nums">${num(f.protein, 1)}</td>
    <td class="nums">${num(f.carbs, 1)}</td>
    <td class="nums">${num(f.fat, 1)}</td>
    <td>${esc(STATES.find((s) => s.id === f.referenceState)?.label || '')}${f.cookedFactor && f.cookedFactor !== 1 ? ` <span class="tag">×${num(f.cookedFactor, 2)}</span>` : ''}</td>
    <td>${f.gramsPerUnit ? `${esc(f.unitName || 'unité')} = ${num(f.gramsPerUnit, 0)} g${f.fractionable ? '' : ' (entier)'}` : '—'}</td>
    <td class="nums">${f.price ? `${euros(f.price)} / ${num(f.packageWeight, 0)} g` : '—'}</td>
    <td>${f.batchAllowed ? 'oui' : 'non'}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="btn btn--sm" data-fav="${f.id}">${f.favorite ? '★' : '☆'}</button>
      <button class="btn btn--sm" data-edit="${f.id}">Modifier</button>
    </td>
  </tr>`;
}

const blank = () => ({
  id: `f_${uid('custom')}`, name: '', category: 'autre', brand: '',
  kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0,
  referenceState: 'pret', cookedFactor: 1, unitName: '', gramsPerUnit: 0,
  fractionable: true, unitEntry: false, price: null, packageWeight: null,
  batchAllowed: false, favorite: false, lastUsed: null,
  cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
});

function formPanel(s) {
  // en cas d'avertissement de doublon, on ré-affiche la saisie en cours telle quelle
  const f = editing === 'new' ? (similarWarning?.pending || blank()) : s.foods.find((x) => x.id === editing);
  if (!f) return '';
  const n = (v) => (v === null || v === undefined ? '' : v);
  return `<div class="drawer" data-form-backdrop>
    <div class="drawer__panel" style="width:min(560px,100%)">
      <div class="drawer__head"><div class="row">
        <h3 style="flex:1">${editing === 'new' ? 'Nouvel aliment' : 'Modifier l\'aliment'}</h3>
        <button class="btn btn--ghost" data-form-cancel>Fermer</button>
      </div></div>
      <div class="drawer__body">
        <div class="grid grid--3">
          <label class="field" style="grid-column:1/-1">Nom
            <input type="text" data-f="name" value="${esc(f.name)}"></label>
          <label class="field">Marque (facultatif)
            <input type="text" data-f="brand" value="${esc(f.brand)}"></label>
          <label class="field">Catégorie
            <select data-f="category">${CATEGORIES.map((c) => `<option value="${c.id}" ${f.category === c.id ? 'selected' : ''}>${c.label}</option>`).join('')}</select></label>
        </div>
        <h3 style="margin:16px 0 6px">Pour 100 g</h3>
        <div class="grid grid--3">
          <label class="field">kcal <input type="number" step="1" data-f="kcal" value="${n(f.kcal)}"></label>
          <label class="field">Protéines (g) <input type="number" step="0.1" data-f="protein" value="${n(f.protein)}"></label>
          <label class="field">Glucides (g) <input type="number" step="0.1" data-f="carbs" value="${n(f.carbs)}"></label>
          <label class="field">Lipides (g) <input type="number" step="0.1" data-f="fat" value="${n(f.fat)}"></label>
          <label class="field">Fibres (g) <input type="number" step="0.1" data-f="fiber" value="${n(f.fiber)}"></label>
        </div>
        <h3 style="margin:16px 0 6px">État et unités</h3>
        <div class="grid grid--3">
          <label class="field">État de référence
            <select data-f="referenceState">${STATES.map((st) => `<option value="${st.id}" ${f.referenceState === st.id ? 'selected' : ''}>${st.label}</option>`).join('')}</select></label>
          <label class="field">Coefficient cru → cuit
            <input type="number" step="0.05" data-f="cookedFactor" value="${n(f.cookedFactor)}"></label>
          <label class="field">Nom de l'unité
            <input type="text" data-f="unitName" value="${esc(f.unitName)}" placeholder="tranche, pot, œuf…"></label>
          <label class="field">Poids d'une unité (g)
            <input type="number" step="1" data-f="gramsPerUnit" value="${n(f.gramsPerUnit)}"></label>
        </div>
        <label class="check" style="margin-top:8px"><input type="checkbox" data-f="fractionable" ${f.fractionable ? 'checked' : ''}> Unité fractionnable (sinon quantités par unité entière)</label>
        <label class="check" style="margin-top:6px"><input type="checkbox" data-f="unitEntry" ${f.unitEntry ? 'checked' : ''}> Saisir les quantités en unités plutôt qu'en grammes</label>
        <small style="display:block;margin-top:4px">Un aliment non fractionnable ne peut exister qu'en multiples entiers de son poids par unité, quelle que soit la façon dont la quantité est saisie.</small>
        <h3 style="margin:16px 0 6px">Achat</h3>
        <div class="grid grid--3">
          <label class="field">Prix du conditionnement (€)
            <input type="number" step="0.01" data-f="price" value="${n(f.price)}"></label>
          <label class="field">Poids du conditionnement (g)
            <input type="number" step="1" data-f="packageWeight" value="${n(f.packageWeight)}"></label>
        </div>
        <label class="check" style="margin-top:8px"><input type="checkbox" data-f="batchAllowed" ${f.batchAllowed ? 'checked' : ''}> Autorisé en batch cooking</label>
        <h3 style="margin:16px 0 6px">Préparation</h3>
        <div class="grid grid--3">
          <label class="field">Méthode de cuisson
            <input type="text" data-f="cookingMethod" value="${esc(f.cookingMethod || '')}" placeholder="Four, poêle, vapeur…"></label>
          <label class="field">Température (°C)
            <input type="number" step="5" data-f="cookingTemp" value="${n(f.cookingTemp)}"></label>
          <label class="field">Durée de cuisson (min)
            <input type="number" step="1" data-f="cookingTime" value="${n(f.cookingTime)}"></label>
          <label class="field">Temps de préparation (min)
            <input type="number" step="1" data-f="prepTime" value="${n(f.prepTime)}"></label>
          <label class="field">Matériel
            <input type="text" data-f="equipment" value="${esc(f.equipment || '')}" placeholder="Four, sauteuse…"></label>
        </div>
        <label class="field" style="margin-top:8px">Consignes libres
          <textarea data-f="instructions" rows="3" placeholder="Ex. cuire entier, laisser tiédir, couper ensuite.">${esc(f.instructions || '')}</textarea></label>
        <small style="display:block;margin-top:4px">Rendement cru → cuit actuel : ${num((f.cookedFactor || 1) * 100, 0)} %. Ces informations sont reprises telles quelles dans le plan de batch.</small>
        <label class="check" style="margin-top:6px"><input type="checkbox" data-f="favorite" ${f.favorite ? 'checked' : ''}> Favori</label>
        ${similarWarning ? similarBox() : ''}
        <div class="row" style="margin-top:18px">
          <button class="btn btn--primary" data-save="${f.id}">${similarWarning ? 'Créer quand même' : 'Enregistrer'}</button>
          ${editing === 'new' ? '' : `<span class="spacer"></span><button class="btn btn--danger" data-delete="${f.id}">Supprimer</button>`}
        </div>
        <small style="display:block;margin-top:10px">Les valeurs livrées par défaut sont génériques. Pour un produit de marque, recopie les valeurs de l'emballage.</small>
      </div>
    </div>
  </div>`;
}

/** Avertissement non bloquant : un aliment très proche existe déjà. */
function similarBox() {
  return `<div class="card" style="margin-top:14px;border-color:#ecd7ae;background:var(--warn-bg)">
    <strong>Aliment${similarWarning.list.length > 1 ? 's' : ''} similaire${similarWarning.list.length > 1 ? 's' : ''} détecté${similarWarning.list.length > 1 ? 's' : ''}</strong>
    <ul style="margin:6px 0 0;padding-left:18px">
      ${similarWarning.list
        .map(
          (x) => `<li>${esc(x.food.name)}${x.food.brand ? ` — ${esc(x.food.brand)}` : ''}${
            x.food.gramsPerUnit ? ` — ${num(x.food.gramsPerUnit, 0)} g/${esc(x.food.unitName || 'unité')}` : ''
          } <span class="tag">${esc(x.reasons.join(', '))}</span></li>`
        )
        .join('')}
    </ul>
    <small>Vérifie qu'il ne s'agit pas du même produit. Rien n'est fusionné ni supprimé automatiquement.</small>
  </div>`;
}

function readForm(root, base) {
  const out = { ...base };
  root.querySelectorAll('[data-f]').forEach((input) => {
    const key = input.dataset.f;
    if (input.type === 'checkbox') out[key] = input.checked;
    else if (input.type === 'number') {
      const v = input.value === '' ? null : Number(input.value);
      out[key] = v;
    } else out[key] = input.value.trim();
  });
  if (!out.cookedFactor) out.cookedFactor = 1;
  if (!out.gramsPerUnit) out.gramsPerUnit = 0;
  for (const k of ['kcal', 'protein', 'carbs', 'fat', 'fiber']) out[k] = Number(out[k]) || 0;
  return out;
}

function wire(root) {
  const qEl = root.querySelector('[data-q]');
  qEl?.addEventListener('input', (e) => {
    query = e.target.value;
    render(root);
    const el2 = root.querySelector('[data-q]');
    el2.focus();
    el2.setSelectionRange(el2.value.length, el2.value.length);
  });

  root.querySelectorAll('[data-cat]').forEach((c) =>
    c.addEventListener('click', (e) => { cat = e.currentTarget.dataset.cat; render(root); })
  );

  root.querySelector('[data-new]')?.addEventListener('click', () => { editing = 'new'; similarWarning = null; render(root); });

  root.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', (e) => { editing = e.currentTarget.dataset.edit; similarWarning = null; render(root); })
  );

  root.querySelectorAll('[data-fav]').forEach((b) =>
    b.addEventListener('click', (e) => {
      const id = e.currentTarget.dataset.fav;
      update((s) => {
        const f = s.foods.find((x) => x.id === id);
        if (f) f.favorite = !f.favorite;
      });
    })
  );

  root.querySelector('[data-form-cancel]')?.addEventListener('click', () => { editing = null; similarWarning = null; render(root); });
  root.querySelector('[data-form-backdrop]')?.addEventListener('mousedown', (e) => {
    if (e.target.dataset.formBackdrop !== undefined) { editing = null; similarWarning = null; render(root); }
  });

  root.querySelector('[data-save]')?.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.save;
    const s = getState();
    const base = editing === 'new' ? { ...(similarWarning?.pending || blank()), id } : s.foods.find((x) => x.id === id);
    const data = readForm(root, base);
    if (!data.name) { toast('Le nom est obligatoire', 'error'); return; }

    // Détection de doublon à la création : avertissement, jamais blocage.
    if (editing === 'new' && !similarWarning) {
      const list = findSimilarFoods(data, s.foods);
      if (list.length) {
        similarWarning = { list, pending: data };
        render(root);
        toast('Un aliment similaire existe déjà — vérifie avant de créer');
        return;
      }
    }
    similarWarning = null;

    update((st) => {
      const idx = st.foods.findIndex((x) => x.id === id);
      if (idx >= 0) st.foods[idx] = data;
      else st.foods.push(data);
    });
    editing = null;
    toast('Aliment enregistré');
    render(root);
  });

  root.querySelector('[data-delete]')?.addEventListener('click', (e) => {
    const id = e.currentTarget.dataset.delete;
    const s = getState();
    const used =
      s.meals.some((m) => m.items.some((i) => i.foodId === id)) ||
      [...s.breakfasts, ...s.snacksAfternoon, ...s.snacksEvening].some((o) => o.items.some((i) => i.foodId === id));
    if (!confirm(used ? 'Cet aliment est utilisé dans des repas. Le supprimer quand même ?' : 'Supprimer cet aliment ?')) return;
    update((st) => { st.foods = st.foods.filter((x) => x.id !== id); });
    editing = null;
    render(root);
  });
}
