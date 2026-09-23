/**
 * Écran BATCH COOKING — plan opératoire déduit du planning.
 * Trois catégories : à préparer en batch, à cuire le jour même, à assembler le jour même.
 * Cet écran ne modifie jamais le planning.
 */

import { getState, update, foodsById, recipesById, preparationsById } from '../core/store.js';
import { buildBatchPlan, BATCH_CATEGORY_LABEL } from '../core/derive.js';
import { dayName, esc, grams, num, toast } from '../core/util.js';
import { MEAL_TYPES, PERSONS, PERSON_LABEL } from '../core/nutrition.js';

export function render(root) {
  const s = getState();
  if (!s.settings.batch.enabled) {
    root.innerHTML = `<div class="empty">Le batch cooking est désactivé dans les paramètres.</div>`;
    return;
  }
  const byId = foodsById();
  const plan = buildBatchPlan(s, byId, recipesById(), preparationsById());
  const startWeekday = s.settings.cycle.startWeekday;

  root.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <span class="pill pill--accent">Conservation : ${s.settings.batch.maxDays} jours par session</span>
      <small>Le plan est une conséquence du planning : le modifier ici ne change jamais les repas.</small>
    </div>
    ${plan.map((sess) => sessionCard(sess, startWeekday)).join('')}
  `;
  wire(root);
}

const slot = (startWeekday, dayIndex, mealType) =>
  `${dayName(startWeekday, dayIndex).toLowerCase()} ${mealType === 'lunch' ? 'midi' : 'soir'}`;

function sessionCard(sess, startWeekday) {
  const range = sess.startDay === sess.endDay ? `jour ${sess.startDay + 1}` : `jours ${sess.startDay + 1} à ${sess.endDay + 1}`;
  const days = `${dayName(startWeekday, sess.startDay)} → ${dayName(startWeekday, sess.endDay)}`;

  const covered = sess.gamelles.length
    ? `<p>Préparer les gamelles de : ${sess.gamelles
        .map((g) => `<strong>${esc(slot(startWeekday, g.dayIndex, g.mealType))}</strong>`)
        .join(', ')}.</p>`
    : '<p class="muted">Aucun repas planifié sur cette session.</p>';

  return `<div class="card">
    <div class="card__head">
      <h2>Session ${sess.index + 1}</h2>
      <span class="tag">${esc(range)} · ${esc(days)}</span>
    </div>
    ${covered}
    ${conservationBlock(sess)}
    ${componentsBlock(sess, startWeekday)}
    ${recipesToPrepareBlock(sess, startWeekday)}
    ${sameDayBlock('cook', sess.cookSameDay, startWeekday)}
    ${sameDayBlock('assemble', sess.assembleSameDay, startWeekday)}
    ${gamellesBlock(sess, startWeekday)}
  </div>`;
}

/** Alerte : la conservation d'un composant ne couvre pas la durée de la session. */
function conservationBlock(sess) {
  if (!sess.conservationAlerts?.length) return '';
  return `<div class="card" style="border-color:#eebeb9;background:var(--off-bg);margin-bottom:12px">
    <strong>⚠️ Conservation insuffisante</strong>
    <ul style="margin:6px 0 0;padding-left:18px">
      ${sess.conservationAlerts.map((a) => `<li>${esc(a.message)}</li>`).join('')}
    </ul>
    <small>Rien n'est retiré et le planning n'est pas modifié : à toi de scinder la session, de réduire la durée de conservation dans les paramètres, ou de cuisiner ces composants plus tard.</small>
  </div>`;
}

/* ---------------------------------------------------- A — à préparer en batch */

/**
 * Conservation plus courte que la session (P0.3/P2.2) : au lieu d'une simple
 * alerte, le calendrier concret de reprise — une ligne par sous-préparation,
 * ancrée sur les jours de consommation réels et sa propre saisie "je prépare"
 * (clé distincte de la ligne principale, cf. `computeSubBatches()` /
 * derive.js). La première préparation est neutre (☐) ; toute préparation
 * supplémentaire après la première porte un ⚠️ (P2.3) pour signaler qu'elle
 * s'ajoute à celle déjà prévue en début de session.
 */
function subBatchRows(subBatches, startWeekday) {
  if (!subBatches?.length) return '';
  return `<table style="margin-top:6px">
    <thead><tr><th>Préparation</th><th class="nums">Besoin</th><th>Je prépare</th></tr></thead>
    <tbody>
      ${subBatches
        .map((b, i) => {
          const marker = i === 0 ? '☐' : '⚠️';
          const label = i === 0 ? 'Préparation' : 'Nouvelle préparation nécessaire';
          const prepDayName = dayName(startWeekday, b.startDay);
          const coversText = (b.coversDays?.length ? b.coversDays : [b.startDay, b.endDay])
            .map((d) => dayName(startWeekday, d)).join(', ');
          return `<tr>
            <td>
              ${marker} <strong>${esc(prepDayName)}</strong> — ${esc(label)}
              <div class="tag muted">couvre ${esc(coversText)}</div>
            </td>
            <td class="nums">${grams(b.requiredRaw)}</td>
            <td><input type="number" step="10" min="0" value="${num(b.preparedRaw, 0).replace(',', '.')}"
                   data-prep="${b.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  </table>`;
}

function componentsBlock(sess, startWeekday) {
  if (!sess.components.length) {
    return `<h3>${BATCH_CATEGORY_LABEL.batch}</h3><p class="muted">Aucun composant batchable sur cette session.</p>`;
  }
  const rows = sess.components
    .map((c) => {
      const surplus = c.preparedRaw - c.requiredRaw;
      const coverage = c.requiredRaw > 0 ? (c.preparedRaw / c.requiredRaw) * 100 : 100;
      const method = [
        c.method ? `méthode : ${esc(c.method)}` : null,
        c.temperature ? `${num(c.temperature, 0)} °C` : null,
        c.duration ? `${num(c.duration, 0)} min` : null,
        c.prepTime ? `préparation ${num(c.prepTime, 0)} min` : null,
        c.equipment ? esc(c.equipment) : null,
      ].filter(Boolean).join(' · ');
      return `<tr>
        <td>
          <strong>${esc(c.food.name)}</strong>
          ${method ? `<div class="tag">${method}</div>` : '<div class="tag muted">aucune consigne de cuisson définie dans la fiche aliment</div>'}
          ${c.note ? `<div class="tag">${esc(c.note)}</div>` : ''}
          ${
            c.shelfLifeDays !== null
              ? `<div class="tag${c.shelfLifeShort ? ' sync-error' : ''}">conservation ${num(c.shelfLifeDays, 0)} j / ${num(c.coveredDays, 0)} j couverts</div>`
              : ''
          }
          ${subBatchRows(c.subBatches, startWeekday)}
        </td>
        <td class="nums">
          ${c.needsCooking ? `${grams(c.requiredRaw)} crus` : grams(c.requiredRaw)}
          ${c.needsCooking ? `<div class="tag">rendement ${num(c.yieldPct, 0)} %</div>` : ''}
        </td>
        <td class="nums">${grams(c.requiredCooked)}${c.needsCooking ? ' cuits' : ''}</td>
        <td><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
               data-prep="${c.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
        <td class="nums">${grams(c.preparedCooked)}</td>
        <td class="nums">${surplus >= 0 ? `+ ${grams(surplus)}` : `manque ${grams(-surplus)}`}<div class="tag">${num(coverage, 0)} %</div></td>
      </tr>`;
    })
    .join('');

  return `<h3>${BATCH_CATEGORY_LABEL.batch}</h3>
    <table>
      <thead><tr>
        <th>Composant et méthode</th><th>À sortir</th><th>Quantité cuite nécessaire</th>
        <th>Je prépare</th><th>Cuit attendu</th><th>Surplus</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ---------------------------------------------- A' — recettes à préparer en batch (P0.2) */

function recipesToPrepareBlock(sess, startWeekday) {
  if (!sess.recipesToPrepare?.length) return '';
  const rows = sess.recipesToPrepare
    .map((c) => {
      const surplus = c.preparedRaw - c.requiredRaw;
      const coverage = c.requiredRaw > 0 ? (c.preparedRaw / c.requiredRaw) * 100 : 100;
      const method = [
        c.method ? `méthode : ${esc(c.method)}` : null,
        c.temperature ? `${num(c.temperature, 0)} °C` : null,
        c.duration ? `${num(c.duration, 0)} min` : null,
        c.prepTime ? `préparation ${num(c.prepTime, 0)} min` : null,
        c.equipment ? esc(c.equipment) : null,
      ].filter(Boolean).join(' · ');
      return `<tr>
        <td>
          <strong>${esc(c.recipe.name)}</strong> <span class="tag">recette</span>
          ${method ? `<div class="tag">${method}</div>` : '<div class="tag muted">aucune consigne de cuisson définie dans la fiche recette</div>'}
          ${c.note ? `<div class="tag">${esc(c.note)}</div>` : ''}
          ${
            c.shelfLifeDays !== null
              ? `<div class="tag${c.shelfLifeShort ? ' sync-error' : ''}">conservation ${num(c.shelfLifeDays, 0)} j / ${num(c.coveredDays, 0)} j couverts</div>`
              : ''
          }
          ${subBatchRows(c.subBatches, startWeekday)}
        </td>
        <td class="nums">${grams(c.requiredRaw)}</td>
        <td><input type="number" step="10" min="0" value="${num(c.preparedRaw, 0).replace(',', '.')}"
               data-prep="${c.key}" style="width:104px" aria-label="Quantité préparée"> g</td>
        <td class="nums">${surplus >= 0 ? `+ ${grams(surplus)}` : `manque ${grams(-surplus)}`}<div class="tag">${num(coverage, 0)} %</div></td>
      </tr>`;
    })
    .join('');

  return `<h3>Recettes à préparer en batch</h3>
    <table>
      <thead><tr><th>Recette et méthode</th><th>Quantité nette nécessaire</th><th>Je prépare</th><th>Surplus</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ------------------------------------- B et C — le jour même */

function sameDayBlock(kind, rows, startWeekday) {
  const label = BATCH_CATEGORY_LABEL[kind];
  if (!rows.length) return `<h3>${label}</h3><p class="muted">Rien dans cette catégorie sur cette session.</p>`;
  const byMeal = {};
  for (const r of rows) {
    const key = `${r.dayIndex}:${r.mealType}`;
    (byMeal[key] ||= { dayIndex: r.dayIndex, mealType: r.mealType, items: [] }).items.push(r);
  }
  return `<h3>${label}</h3>
    <ul style="margin:4px 0 10px;padding-left:18px">
      ${Object.values(byMeal)
        .sort((a, b) => a.dayIndex - b.dayIndex || (a.mealType === 'lunch' ? -1 : 1))
        .map(
          (m) => `<li><strong>${esc(slot(startWeekday, m.dayIndex, m.mealType))}</strong> — ${m.items
            .map((r) => `${esc(r.food.name)} ${grams(r.grams)}${r.summary ? ` (${esc(r.summary)})` : ''}`)
            .join(', ')}</li>`
        )
        .join('')}
    </ul>`;
}

/* ------------------------------------- détail des gamelles */

function gamellesBlock(sess, startWeekday) {
  const filled = sess.gamelles.filter((g) => PERSONS.some((p) => g.persons[p].length));
  if (!filled.length) return '';
  return `<h3>Détail des gamelles</h3>
    <div class="grid grid--2">
      ${filled
        .map(
          (g) => `<div class="meal-card">
          <div class="meal-card__type">${esc(MEAL_TYPES[g.mealType])} — ${esc(slot(startWeekday, g.dayIndex, g.mealType))}</div>
          <div class="meal-card__name">${esc(g.name || 'Sans nom')}</div>
          ${PERSONS.map(
            (p) => `<div class="person-band person-band--${p}" style="margin-bottom:6px">
              <div class="person-name person-name--${p}">${PERSON_LABEL[p]}</div>
              <ul style="margin:2px 0 0;padding-left:16px">
                ${g.persons[p]
                  .map((e) =>
                    e.free
                      ? `<li>${esc(e.name)} — ${esc(e.quantity || 'au goût')}</li>`
                      : `<li>${grams(e.grams)} ${esc(e.name)}${e.cooked ? ' cuit' : ''} <span class="tag">${esc(shortCat(e.category))}</span></li>`
                  )
                  .join('') || '<li class="muted">rien</li>'}
              </ul>
            </div>`
          ).join('')}
        </div>`
        )
        .join('')}
    </div>`;
}

const shortCat = (category) =>
  ({ batch: 'batch', cook: 'cuisson du jour', assemble: 'assemblage', free: 'libre' }[category] || '');

function wire(root) {
  root.querySelectorAll('[data-prep]').forEach((input) =>
    input.addEventListener('change', (e) => {
      const key = e.target.dataset.prep;
      const value = Math.max(0, Number(e.target.value) || 0);
      update((s) => { s.batch.overrides[key] = value; });
      toast('Quantité préparée mise à jour');
    })
  );
}
