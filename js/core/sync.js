/**
 * Synchronisation Supabase.
 *
 * Principe volontairement simple (un seul compte partagé, jamais d'usage simultané) :
 *   - PUSH : l'état local est écrit en entier (table par table, remplacement complet) ;
 *   - PULL : l'état est reconstruit depuis la base.
 * Aucune gestion de conflit complexe n'est nécessaire.
 *
 * Si les clés Supabase ne sont pas renseignées dans js/config.js,
 * l'application fonctionne intégralement en local.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { getState, replaceState, update, defaultState, backupLocal } from './store.js';
import { PERSONS } from './nutrition.js';

let client = null;
let libPromise = null;

export const isConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

async function getClient() {
  if (!isConfigured()) return null;
  if (client) return client;
  if (!libPromise) libPromise = import('https://esm.sh/@supabase/supabase-js@2');
  const { createClient } = await libPromise;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return client;
}

/* ------------------------------------------------------------------ */
/* Authentification                                                    */
/* ------------------------------------------------------------------ */

export async function currentUser() {
  const c = await getClient();
  if (!c) return null;
  const { data } = await c.auth.getUser();
  return data?.user || null;
}

export async function signIn(email, password) {
  const c = await getClient();
  if (!c) throw new Error('Supabase non configuré (js/config.js)');
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signUp(email, password) {
  const c = await getClient();
  if (!c) throw new Error('Supabase non configuré (js/config.js)');
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  const c = await getClient();
  if (c) await c.auth.signOut();
}

export async function changePassword(password) {
  const c = await getClient();
  if (!c) throw new Error('Supabase non configuré');
  const { error } = await c.auth.updateUser({ password });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Mapping état <-> tables                                             */
/* ------------------------------------------------------------------ */

const foodRow = (f) => ({
  id: f.id,
  name: f.name,
  category: f.category,
  brand: f.brand || null,
  kcal_per_100g: f.kcal,
  protein_per_100g: f.protein,
  carbs_per_100g: f.carbs,
  fat_per_100g: f.fat,
  fiber_per_100g: f.fiber,
  reference_state: f.referenceState,
  cooked_factor: f.cookedFactor,
  unit_name: f.unitName || null,
  grams_per_unit: f.gramsPerUnit,
  fractionable: f.fractionable,
  price: f.price,
  package_weight: f.packageWeight,
  batch_allowed: f.batchAllowed,
  shelf_life_days: f.shelfLifeDays ?? null,
  requires_cooking: f.requiresCooking === true,
  favorite: f.favorite,
  last_used: f.lastUsed || null,
  unit_entry: f.unitEntry === true,
  cooking_method: f.cookingMethod || null,
  cooking_temp: f.cookingTemp ?? null,
  cooking_time: f.cookingTime ?? null,
  prep_time: f.prepTime ?? null,
  equipment: f.equipment || null,
  instructions: f.instructions || null,
});

const foodFromRow = (r) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  brand: r.brand || '',
  kcal: r.kcal_per_100g,
  protein: r.protein_per_100g,
  carbs: r.carbs_per_100g,
  fat: r.fat_per_100g,
  fiber: r.fiber_per_100g,
  referenceState: r.reference_state,
  cookedFactor: r.cooked_factor,
  unitName: r.unit_name || '',
  gramsPerUnit: r.grams_per_unit || 0,
  fractionable: r.fractionable,
  price: r.price,
  packageWeight: r.package_weight,
  batchAllowed: r.batch_allowed,
  shelfLifeDays: r.shelf_life_days === null || r.shelf_life_days === undefined ? null : Number(r.shelf_life_days),
  // NULL = ligne antérieure à l'introduction du champ (base pas encore migrée) :
  // on reprend une seule fois l'ancien classement, comme le fait la migration SQL.
  // Une valeur booléenne persistée n'est jamais recalculée.
  requiresCooking:
    r.requires_cooking === null || r.requires_cooking === undefined
      ? Boolean(r.cooking_method) || r.reference_state === 'cru'
      : r.requires_cooking === true,
  favorite: r.favorite,
  unitEntry: r.unit_entry === true,
  cookingMethod: r.cooking_method || '',
  cookingTemp: r.cooking_temp ?? null,
  cookingTime: r.cooking_time ?? null,
  prepTime: r.prep_time ?? null,
  equipment: r.equipment || '',
  instructions: r.instructions || '',
  // PostgreSQL renvoie un autre format ISO : on renormalise pour garder
  // un tri des "aliments récents" cohérent entre les appareils.
  lastUsed: r.last_used ? new Date(r.last_used).toISOString() : null,
});

/** Un ingrédient = une ligne par personne (schéma demandé). */
function itemRows(item, parentKey, parentId) {
  return PERSONS.map((person) => ({
    id: `${item.id}:${person}`,
    item_id: item.id,
    [parentKey]: parentId,
    food_id: item.foodId,
    free_ingredient_name: item.free?.name || null,
    free_ingredient_quantity: item.free?.quantity || null,
    person,
    quantity_g: item.qty?.[person] || 0,
    locked: !!item.locked?.[person],
    reference_state: item.state,
  }));
}

function itemsFromRows(rows, parentKey, parentId) {
  const byItem = new Map();
  for (const r of rows.filter((r) => r[parentKey] === parentId)) {
    if (!byItem.has(r.item_id)) {
      byItem.set(r.item_id, {
        id: r.item_id,
        foodId: r.food_id,
        free: r.free_ingredient_name ? { name: r.free_ingredient_name, quantity: r.free_ingredient_quantity } : null,
        state: r.reference_state,
        qty: { thomas: 0, julie: 0 },
        locked: { thomas: false, julie: false },
      });
    }
    const it = byItem.get(r.item_id);
    it.qty[r.person] = Number(r.quantity_g) || 0;
    it.locked[r.person] = !!r.locked;
  }
  return [...byItem.values()];
}

export function stateToTables(s) {
  const settings = {
    id: 'main',
    budget: s.settings.budget,
    batch_duration: s.settings.batch.maxDays,
    batch_enabled: s.settings.batch.enabled,
    cycle_start_weekday: s.settings.cycle.startWeekday,
    cycle_duration: s.settings.cycle.duration,
    tolerance: s.settings.tolerance,
    auto_adjust: s.settings.autoAdjust,
    // jsonb_populate_record n'applique pas les DEFAULT : toute colonne NOT NULL
    // doit être fournie explicitement par le client.
    updated_at: new Date().toISOString(),
  };

  const targets = [];
  for (const person of PERSONS) {
    for (const [mealType, t] of Object.entries(s.settings.targets[person] || {})) {
      targets.push({ id: `${person}:${mealType}`, person, meal_type: mealType, ...t });
    }
  }

  const meals = s.meals.map((m) => ({
    id: m.id,
    day_index: m.dayIndex,
    meal_type: m.mealType,
    name: m.name || null,
    same_composition: m.sameComposition,
  }));
  const meal_items = s.meals.flatMap((m) => m.items.flatMap((it) => itemRows(it, 'meal_id', m.id)));

  const breakfast_options = s.breakfasts.map((o) => ({
    id: o.id,
    name: o.name,
    same_composition: o.sameComposition,
    uses_thomas: Number(o.uses?.thomas) || 0,
    uses_julie: Number(o.uses?.julie) || 0,
  }));
  const breakfast_items = s.breakfasts.flatMap((o) => o.items.flatMap((it) => itemRows(it, 'option_id', o.id)));

  const snack_options = s.snacks.map((o) => ({
    id: o.id,
    type: 'snack', // catalogue unique : 16 h / soir ne sont que des affectations
    name: o.name,
    same_composition: o.sameComposition,
    target_slot: o.targetSlot === 'evening' ? 'evening' : 'afternoon',
    uses_thomas_afternoon: Number(o.uses?.thomas?.afternoon) || 0,
    uses_thomas_evening: Number(o.uses?.thomas?.evening) || 0,
    uses_julie_afternoon: Number(o.uses?.julie?.afternoon) || 0,
    uses_julie_evening: Number(o.uses?.julie?.evening) || 0,
  }));
  const snack_items = s.snacks.flatMap((o) => o.items.flatMap((it) => itemRows(it, 'option_id', o.id)));

  const shopping_items = Object.entries(s.shopping.purchased).map(([foodId, purchased]) => ({
    id: `shop:${foodId}`,
    food_id: foodId,
    purchased: !!purchased,
  }));

  const batch_items = Object.entries(s.batch.overrides).map(([key, grams]) => {
    const [session, foodId] = key.split(':');
    return { id: `batch:${key}`, preparation_session: Number(session), food_id: foodId, preparation_quantity: grams };
  });

  return {
    foods: s.foods.map(foodRow),
    targets,
    settings: [settings],
    meals,
    meal_items,
    breakfast_options,
    breakfast_items,
    snack_options,
    snack_items,
    shopping_items,
    batch_items,
  };
}

export function tablesToState(t) {
  const s = defaultState();
  if (t.foods?.length) s.foods = t.foods.map(foodFromRow);

  const cfg = t.settings?.[0];
  if (cfg) {
    s.settings.budget = Number(cfg.budget);
    s.settings.batch = { enabled: cfg.batch_enabled, maxDays: Number(cfg.batch_duration) };
    s.settings.cycle = { startWeekday: Number(cfg.cycle_start_weekday), duration: Number(cfg.cycle_duration) };
    s.settings.tolerance = Number(cfg.tolerance) || 0.05;
    s.settings.autoAdjust = cfg.auto_adjust !== false;
  }
  for (const r of t.targets || []) {
    s.settings.targets[r.person] = s.settings.targets[r.person] || {};
    s.settings.targets[r.person][r.meal_type] = {
      kcal: Number(r.kcal),
      protein: Number(r.protein),
      carbs: Number(r.carbs),
      fat: Number(r.fat),
    };
  }

  s.meals = (t.meals || []).map((m) => ({
    id: m.id,
    dayIndex: m.day_index,
    mealType: m.meal_type,
    name: m.name || '',
    sameComposition: m.same_composition !== false,
    items: itemsFromRows(t.meal_items || [], 'meal_id', m.id),
  }));

  s.breakfasts = (t.breakfast_options || []).map((o) => ({
    id: o.id,
    name: o.name,
    sameComposition: o.same_composition !== false,
    uses: { thomas: Number(o.uses_thomas) || 0, julie: Number(o.uses_julie) || 0 },
    items: itemsFromRows(t.breakfast_items || [], 'option_id', o.id),
  }));

  s.snacks = (t.snack_options || []).map((o) => ({
    id: o.id,
    name: o.name,
    sameComposition: o.same_composition !== false,
    targetSlot: o.target_slot === 'evening' ? 'evening' : 'afternoon',
    uses: {
      thomas: { afternoon: Number(o.uses_thomas_afternoon) || 0, evening: Number(o.uses_thomas_evening) || 0 },
      julie: { afternoon: Number(o.uses_julie_afternoon) || 0, evening: Number(o.uses_julie_evening) || 0 },
    },
    items: itemsFromRows(t.snack_items || [], 'option_id', o.id),
  }));

  s.shopping.purchased = Object.fromEntries((t.shopping_items || []).map((r) => [r.food_id, r.purchased]));
  s.batch.overrides = Object.fromEntries(
    (t.batch_items || []).map((r) => [`${r.preparation_session}:${r.food_id}`, Number(r.preparation_quantity)])
  );
  return s;
}

export const TABLES = [
  'foods',
  'targets',
  'settings',
  'meals',
  'meal_items',
  'breakfast_options',
  'breakfast_items',
  'snack_options',
  'snack_items',
  'shopping_items',
  'batch_items',
];

/* ------------------------------------------------------------------ */
/* Push / pull                                                         */
/* ------------------------------------------------------------------ */

export async function push() {
  const c = await getClient();
  if (!c) throw new Error('Supabase non configuré');
  if (!(await currentUser())) throw new Error('Non connecté');

  const payload = stateToTables(getState());

  // Écriture atomique : une seule transaction côté PostgreSQL.
  // En cas d'échec, rien n'est écrit et l'état local reste intact.
  const { data, error } = await c.rpc('nutriplan_replace_all', { payload });
  if (error) throw new Error(describeRpcError(error));

  // La synchronisation n'est considérée réussie qu'après vérification des compteurs.
  const counts = data || {};
  const mismatches = verifyCounts(payload, counts);
  if (mismatches.length) {
    throw new Error(
      `Vérification échouée (${mismatches.join(', ')}) : données locales conservées, rien n'est considéré comme synchronisé.`
    );
  }

  setSyncMeta({ dirty: false, syncedAt: new Date().toISOString(), syncError: null });
  return counts;
}

/**
 * Compare les lignes envoyées et les lignes réellement écrites (compteurs
 * renvoyés par la fonction PostgreSQL). Renvoie la liste des tables douteuses :
 * tant qu'elle n'est pas vide, la synchronisation n'est pas considérée réussie.
 */
export function verifyCounts(payload, counts) {
  return TABLES.filter((t) => Number(counts?.[t] ?? -1) !== (payload[t]?.length ?? 0));
}

function describeRpcError(error) {
  const msg = error.message || 'erreur inconnue';
  if (error.code === 'PGRST202' || /nutriplan_replace_all/.test(msg)) {
    return "La fonction nutriplan_replace_all est absente de la base : exécute supabase/schema.sql dans l'éditeur SQL de Supabase, puis réessaie.";
  }
  return msg;
}

function setSyncMeta(patch) {
  update((s) => { Object.assign(s.meta, patch); }, { sync: false });
}

export async function pull() {
  const c = await getClient();
  if (!c) throw new Error('Supabase non configuré');
  if (!(await currentUser())) throw new Error('Non connecté');

  const data = {};
  for (const table of TABLES) {
    const { data: rows, error } = await c.from(table).select('*');
    if (error) { setSyncMeta({ syncError: error.message }); throw error; }
    data[table] = rows || [];
  }

  if (!data.foods.length && !data.meals.length) {
    // base vide : on y envoie l'état local plutôt que de l'écraser
    await push();
    return { seeded: true };
  }

  const next = tablesToState(data);
  if (!next.foods.length) {
    throw new Error('Données distantes incomplètes : récupération annulée, rien n\'a été remplacé en local.');
  }

  // filet de sécurité : l'état local est sauvegardé avant d'être remplacé
  backupLocal();
  next.meta = { updatedAt: new Date().toISOString(), dirty: false, syncedAt: new Date().toISOString(), syncError: null };
  replaceState(next, { dirty: false });
  return { seeded: false };
}

/** Push automatique si des modifications locales sont en attente. */
export async function syncIfNeeded() {
  if (!isConfigured() || !navigator.onLine) return false;
  const s = getState();
  if (!s.meta.dirty) return false;
  if (!(await currentUser())) return false;
  try {
    await push();
    return true;
  } catch (e) {
    // les données locales restent la référence tant que l'envoi n'a pas abouti
    setSyncMeta({ syncError: e.message || String(e) });
    return false;
  }
}
