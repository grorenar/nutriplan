/** Impression A4 — construit un document propre dans #print puis lance l'impression. */

import { getState, foodsById } from '../core/store.js';
import { mealMacros, evaluate, PERSONS, PERSON_LABEL, MEAL_TYPES } from '../core/nutrition.js';
import { buildBatchPlan, buildShoppingList } from '../core/derive.js';
import { dayName, esc, grams, euros, num } from '../core/util.js';

export function openPrintDialog() {
  const host = document.getElementById('modal');
  host.innerHTML = `
    <div class="drawer" data-print-backdrop>
      <div class="drawer__panel" style="width:min(420px,100%)">
        <div class="drawer__head"><div class="row"><h3 style="flex:1">Imprimer</h3>
          <button class="btn btn--ghost" data-print-cancel>Fermer</button></div></div>
        <div class="drawer__body">
          <label class="check"><input type="checkbox" value="planning" checked> Planning</label>
          <label class="check"><input type="checkbox" value="batch" checked> Batch cooking</label>
          <label class="check"><input type="checkbox" value="shopping" checked> Liste de courses</label>
          <label class="check"><input type="checkbox" value="nutrition"> Détails nutritionnels</label>
          <label class="check"><input type="checkbox" value="catalogs"> Catalogues (petits-déjeuners, collations)</label>
          <div class="row" style="margin-top:16px">
            <button class="btn btn--primary" data-print-go>Imprimer</button>
            <button class="btn btn--sm" data-print-all>Tout sélectionner</button>
          </div>
        </div>
      </div>
    </div>`;

  const close = () => { host.innerHTML = ''; };
  host.querySelector('[data-print-cancel]').addEventListener('click', close);
  host.querySelector('[data-print-backdrop]').addEventListener('mousedown', (e) => {
    if (e.target.dataset.printBackdrop !== undefined) close();
  });
  host.querySelector('[data-print-all]').addEventListener('click', () => {
    host.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = true));
  });
  host.querySelector('[data-print-go]').addEventListener('click', () => {
    const sections = [...host.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
    close();
    printSections(sections);
  });
}

export function printSections(sections) {
  const s = getState();
  const byId = foodsById();
  const target = document.getElementById('print');
  const parts = [
    `<h1>Nutriplan — cycle de ${s.settings.cycle.duration} jours</h1>
     <div class="print-meta">Départ ${dayName(s.settings.cycle.startWeekday, 0).toLowerCase()} · budget cible ${euros(s.settings.budget)} · tolérance ±${num(s.settings.tolerance * 100, 0)} %</div>`,
  ];

  if (sections.includes('planning')) parts.push(planningSection(s, byId));
  if (sections.includes('batch') && s.settings.batch.enabled) parts.push(batchSection(s, byId));
  if (sections.includes('shopping')) parts.push(shoppingSection(s, byId));
  if (sections.includes('nutrition')) parts.push(nutritionSection(s, byId));
  if (sections.includes('catalogs')) parts.push(catalogsSection(s, byId));

  target.innerHTML = parts.join('');
  window.print();
}

function itemLine(it, byId) {
  if (!it.foodId) return `${esc(it.free.name)} — ${esc(it.free.quantity || 'au goût')}`;
  const f = byId[it.foodId];
  if (!f) return 'Aliment supprimé';
  const state = it.state || f.referenceState;
  const q = (p) => `${PERSON_LABEL[p]} ${num(it.qty[p], 0)} g`;
  return `${esc(f.name)} (${esc(state)}) — ${q('thomas')} / ${q('julie')}${it.locked.thomas || it.locked.julie ? ' [verrouillé]' : ''}`;
}

function planningSection(s, byId) {
  const days = [];
  for (let d = 0; d < s.settings.cycle.duration; d++) {
    const meals = s.meals.filter((m) => m.dayIndex === d);
    days.push(`<div class="print-day">
      <h3>Jour ${d + 1} — ${esc(dayName(s.settings.cycle.startWeekday, d))}</h3>
      ${meals
        .map((m) => {
          const mt = PERSONS.map((p) => {
            const macros = mealMacros(m.items, byId, p);
            return `${PERSON_LABEL[p]} : ${num(macros.kcal, 0)} kcal, ${num(macros.protein, 0)} P, ${num(macros.carbs, 0)} C, ${num(macros.fat, 0)} L`;
          }).join(' · ');
          return `<p><strong>${esc(MEAL_TYPES[m.mealType])} — ${esc(m.name || 'sans nom')}</strong><br>
            ${m.items.length ? `<ul>${m.items.map((it) => `<li>${itemLine(it, byId)}</li>`).join('')}</ul>` : '<em>Non composé</em>'}
            <span class="nums">${mt}</span></p>`;
        })
        .join('')}
    </div>`);
  }
  return `<div class="print-section"><h2>Planning</h2>${days.join('')}</div>`;
}

function batchSection(s, byId) {
  const plan = buildBatchPlan(s, byId);
  return `<div class="print-section"><h2>Batch cooking</h2>
    ${plan
      .map(
        (sess) => `<h3>Session ${sess.index + 1} — jours ${sess.startDay + 1} à ${sess.endDay + 1}</h3>
      <table><thead><tr><th>Composant</th><th>Besoin</th><th>À préparer</th><th>Préparé</th><th>Note</th></tr></thead>
      <tbody>${
        sess.components.length
          ? sess.components
              .map(
                (c) => `<tr><td>${esc(c.food.name)}</td>
          <td class="nums">${c.needsCooking ? `${grams(c.requiredCooked)} cuits` : grams(c.requiredRaw)}</td>
          <td class="nums">${c.needsCooking ? `${grams(c.requiredRaw)} crus` : '—'}</td>
          <td class="nums">${grams(c.preparedRaw)}</td>
          <td>${esc(c.note || '')}</td></tr>`
              )
              .join('')
          : '<tr><td colspan="5">Aucun composant batchable.</td></tr>'
      }</tbody></table>
      ${
        sess.sameDay.length
          ? `<p><strong>Cuisson du jour :</strong></p><ul>${sess.sameDay
              .map((x) => `<li>Jour ${x.dayIndex + 1} — ${esc(MEAL_TYPES[x.mealType])} : ${esc(x.food.name)}, ${grams(x.grams)}</li>`)
              .join('')}</ul>`
          : ''
      }`
      )
      .join('')}
  </div>`;
}

function shoppingSection(s, byId) {
  const { lines, total, budget } = buildShoppingList(s, byId);
  return `<div class="print-section"><h2>Liste de courses</h2>
    <table><thead><tr><th></th><th>Article</th><th>Besoin</th><th>À acheter</th><th>Surplus</th><th>Prix</th></tr></thead>
    <tbody>${lines
      .map(
        (l) => `<tr><td><span class="check"></span></td><td>${esc(l.food.name)}</td>
      <td class="nums">${grams(l.required)}</td>
      <td class="nums">${l.packages ? `${l.packages} × ${grams(l.packageWeight)}` : grams(l.buyGrams)}</td>
      <td class="nums">${l.packages ? grams(l.surplus) : '—'}</td>
      <td class="nums">${l.cost !== null ? euros(l.cost) : '—'}</td></tr>`
      )
      .join('')}</tbody></table>
    <p class="nums">Total estimé : ${euros(total)} — budget cible ${euros(budget)}</p>
  </div>`;
}

function nutritionSection(s, byId) {
  const rows = [];
  for (let d = 0; d < s.settings.cycle.duration; d++) {
    for (const m of s.meals.filter((x) => x.dayIndex === d)) {
      for (const p of PERSONS) {
        const macros = mealMacros(m.items, byId, p);
        const ev = evaluate(macros, s.settings.targets[p][m.mealType], s.settings.tolerance);
        rows.push(`<tr>
          <td>J${d + 1} ${esc(MEAL_TYPES[m.mealType])}</td>
          <td>${PERSON_LABEL[p]}</td>
          ${ev.rows.map((r) => `<td class="nums">${num(r.value, 0)} / ${num(r.target, 0)}${r.status === 'ok' ? '' : ' *'}</td>`).join('')}
        </tr>`);
      }
    }
  }
  return `<div class="print-section"><h2>Détails nutritionnels</h2>
    <table><thead><tr><th>Repas</th><th>Personne</th><th>kcal</th><th>Protéines</th><th>Glucides</th><th>Lipides</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    <p>* valeur hors de la cible ±${num(s.settings.tolerance * 100, 0)} %.</p>
  </div>`;
}

function catalogsSection(s, byId) {
  const block = (title, list) => `<h3>${esc(title)}</h3>${
    list.length
      ? list
          .map(
            (o) => `<p><strong>${esc(o.name || 'Sans nom')}</strong><ul>${o.items
              .map((it) => `<li>${itemLine(it, byId)}</li>`)
              .join('')}</ul></p>`
          )
          .join('')
      : '<p>Aucune option.</p>'
  }`;
  return `<div class="print-section"><h2>Catalogues</h2>
    ${block('Petits-déjeuners', s.breakfasts)}
    ${block('Collations 16 h', s.snacksAfternoon)}
    ${block('Collations du soir', s.snacksEvening)}
  </div>`;
}
