/**
 * Couche de données locale.
 *  - état applicatif unique (objet JSON) ;
 *  - persistance immédiate dans localStorage (fonctionne hors ligne) ;
 *  - marquage "dirty" pour la resynchronisation Supabase ;
 *  - export / import JSON.
 *
 * L'UI ne modifie JAMAIS l'état directement : elle passe par update().
 */

import { STORAGE_KEY } from '../config.js';
import { uid, deepCopy } from './util.js';
import { seedFoods } from './seed-foods.js';
import { preparationAvailable } from './derive.js';

export const DEFAULT_TARGETS = {
  thomas: {
    day: { kcal: 3500, protein: 195, carbs: 395, fat: 115 },
    breakfast: { kcal: 850, protein: 40, carbs: 100, fat: 30 },
    lunch: { kcal: 1050, protein: 55, carbs: 120, fat: 35 },
    snack_afternoon: { kcal: 350, protein: 25, carbs: 40, fat: 10 },
    dinner: { kcal: 1050, protein: 55, carbs: 120, fat: 35 },
    snack_evening: { kcal: 200, protein: 20, carbs: 15, fat: 5 },
  },
  julie: {
    day: { kcal: 2450, protein: 145, carbs: 265, fat: 81 },
    breakfast: { kcal: 550, protein: 30, carbs: 60, fat: 18 },
    lunch: { kcal: 750, protein: 40, carbs: 85, fat: 25 },
    snack_afternoon: { kcal: 300, protein: 20, carbs: 35, fat: 8 },
    dinner: { kcal: 700, protein: 40, carbs: 75, fat: 25 },
    snack_evening: { kcal: 150, protein: 15, carbs: 10, fat: 5 },
  },
};

export function defaultState() {
  return {
    version: 1,
    foods: seedFoods(),
    recipes: [], // catalogue global de recettes (composition figée, macros dérivées — jamais stockées)
    preparations: [], // événements de préparation réels (quantité préparée, snapshot figé de la recette)
    settings: {
      targets: deepCopy(DEFAULT_TARGETS),
      tolerance: 0.05,
      cycle: { startWeekday: 1, duration: 4 }, // 0 = Lundi
      budget: 100,
      batch: { enabled: true, maxDays: 3 },
      autoAdjust: true,
    },
    meals: [], // repas du cycle en cours (déjeuners / dîners uniquement)
    breakfasts: [],
    snacks: [], // catalogue unique : 16 h et soir ne sont que des affectations
    shopping: { purchased: {} }, // foodId -> bool
    batch: {
      overrides: {}, // `${session}:${foodId}` -> grammes crus préparés
      // Mesure ponctuelle "cuit obtenu" pour cette séance — jamais appliquée
      // automatiquement au rendement enregistré de l'aliment (food.cookedFactor,
      // global, utilisé par tous les calculs nutritionnels) : seule une action
      // explicite de l'utilisateur (voir js/views/batch.js) le fait.
      cookedOverrides: {}, // `${session}:${foodId}` -> grammes cuits obtenus
    },
    // Groupes de « doublons possibles » explicitement écartés par
    // l'utilisateur (« pas un doublon ») — liste de clés stables
    // (similarity.js::duplicateGroupKey()), jamais ré-affichés tant que la
    // composition exacte du groupe ne change pas. Persisté côté Supabase
    // sur la colonne settings.dismissed_duplicates (voir sync.js) : même
    // décision partagée entre tous les appareils du compte.
    dismissedDuplicates: [],
    // syncing : indicateur d'exécution, jamais une donnée à synchroniser —
    // toujours remis à false au chargement (cf. migrate()), une synchronisation
    // en cours ne survit jamais à un rechargement de page.
    // syncErrorKind : 'network' (connexion/authentification injoignable) vs
    // 'server' (la base a été jointe mais a renvoyé une erreur réelle) — sert
    // à distinguer « déconnecté de la BDD » d'une véritable erreur de
    // synchronisation dans l'interface (P0.4).
    meta: {
      updatedAt: new Date().toISOString(), dirty: false, syncedAt: null,
      syncError: null, syncErrorKind: null, syncing: false,
    },
  };
}

let state = null;
const listeners = new Set();

/* ------------------------------------------------------------------ */
/* Chargement / sauvegarde                                             */
/* ------------------------------------------------------------------ */

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = raw ? migrate(JSON.parse(raw)) : defaultState();
  } catch (e) {
    console.warn('État local illisible, réinitialisation.', e);
    state = defaultState();
  }
  ensureCycleMeals(state);
  return state;
}

/** Complète un aliment venant d'une version antérieure (ou d'un import partiel). */
export function normalizeFood(f) {
  return {
    brand: '', fiber: 0, cookedFactor: 1, unitName: '', gramsPerUnit: 0, fractionable: true,
    price: null, packageWeight: null, batchAllowed: false, favorite: false, lastUsed: null,
    // état des valeurs nutritionnelles : « prêt à consommer » est la valeur
    // compatible par défaut (les valeurs saisies sont utilisées telles quelles,
    // sans conversion). Un aliment qui en possède déjà un le conserve.
    referenceState: 'pret',
    // durée maximale de conservation après préparation, en jours (null = non renseignée)
    shelfLifeDays: null,
    requiresCooking: false,
    cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
    // Open Food Facts (recherche/préremplissage de la fiche aliment) : tous
    // purement informatifs, jamais utilisés par le moteur nutritionnel
    // (macros/objectifs restent kcal/protein/carbs/fat/fiber uniquement).
    // `barcode` est TOUJOURS une chaîne (jamais Number()) pour préserver un
    // éventuel zéro initial. null = non renseigné, jamais 0/'' par défaut.
    barcode: null, satFat: null, sugars: null, salt: null, sodium: null,
    nutriScore: null, novaGroup: null, ecoScore: null,
    ingredientsText: null, allergensText: null,
    imageUrl: null, imageThumbUrl: null, offUrl: null, offQuantity: null, offFetchedAt: null,
    ...f,
    // saisie par unités entières par défaut pour un aliment non fractionnable
    unitEntry: f.unitEntry ?? (Number(f.gramsPerUnit) > 0 && f.fractionable === false),
    // "Nécessite une cuisson" est désormais une propriété explicite.
    // Pour un aliment enregistré avant son introduction, on reprend UNE SEULE FOIS
    // le classement qu'il avait, afin de ne rien changer aux plans existants ;
    // la valeur est ensuite modifiable dans la fiche aliment.
    requiresCooking: f.requiresCooking ?? (Boolean(f.cookingMethod) || f.referenceState === 'cru'),
  };
}

/**
 * Complète une recette venant d'une version antérieure (ou d'un import partiel).
 * `items[]` : { foodId, qty, state } — mêmes conventions qu'un item de repas,
 * réutilisées telles quelles (macrosFor() s'applique sans adaptation).
 */
export function normalizeRecipe(r) {
  return {
    kind: 'weight', // 'weight' | 'portion'
    baseGrams: null,
    items: [],
    batchAllowed: false,
    shelfLifeDays: null,
    cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
    ...r,
  };
}

/** Complète une préparation venant d'une version antérieure (ou d'un import partiel). */
export function normalizePreparation(p) {
  return {
    label: '',
    createdAt: new Date().toISOString(),
    recipeSnapshot: null,
    // P4 : null = aucun reset n'a encore figé de stock restant pour cette
    // préparation — comportement dérivé habituel (preparedGramsOf − usages).
    // Une préparation antérieure à P4 (donc sans ce champ) est normalisée
    // avec null, jamais une autre valeur : aucun changement de comportement
    // tant qu'aucun reset n'a eu lieu depuis la mise à jour.
    remainingAtReset: null,
    // P1 : historique des pertes (« Jeter les restes ») — jamais effacé, même
    // après un reset (cf. preparationWasted()/derive.js). Une préparation
    // antérieure à P1 est normalisée sans aucune perte, comportement inchangé.
    losses: [],
    lastResetAt: null,
    ...p,
  };
}

/**
 * Préparation réelle, matérialisée à partir d'une recette : `preparedQuantity`
 * saisie par l'utilisateur (jamais recalculée depuis les ingrédients — décision
 * verrouillée), `recipeSnapshot` figé au moment de la création (copie profonde,
 * pas une référence) — si la recette source est modifiée ensuite, cette
 * préparation garde sa composition d'origine.
 */
export const newPreparation = (recipe, preparedQuantity, label = '') => ({
  id: uid('prep'),
  recipeId: recipe.id,
  label: label || recipe.name,
  preparedQuantity: Math.max(0, Number(preparedQuantity) || 0),
  createdAt: new Date().toISOString(),
  recipeSnapshot: deepCopy({ kind: recipe.kind, baseGrams: recipe.baseGrams, items: recipe.items }),
  remainingAtReset: null, // P4 : stock restant figé au dernier reset (null = jamais reseté)
  losses: [], // P1 : historique des pertes (« Jeter les restes »), jamais effacé
  lastResetAt: null, // P1 : fenêtre de comptage des pertes, avancée par resetCycle()
});

/** Un enregistrement de perte (« Jeter les restes », P1) : toujours en GRAMMES, jamais effacé. */
export const newPreparationLoss = (qty) => ({
  id: uid('loss'),
  qty: Math.max(0, Number(qty) || 0),
  at: new Date().toISOString(),
});

/** Compteurs d'utilisation d'une option dans le cycle, par personne. */
export const emptyBreakfastUses = () => ({ thomas: 0, julie: 0 });
export const emptySnackUses = () => ({
  thomas: { afternoon: 0, evening: 0 },
  julie: { afternoon: 0, evening: 0 },
});

const normalizeBreakfast = (o) => ({
  sameComposition: true,
  items: [],
  ...o,
  // migration depuis l'ancien compteur unique
  uses: { ...emptyBreakfastUses(), ...(o.uses || (o.cycleUses ? { thomas: o.cycleUses, julie: o.cycleUses } : {})) },
  cycleUses: undefined,
});

const normalizeSnack = (o, slot = 'afternoon') => {
  const legacy = o.cycleUses
    ? { thomas: { afternoon: slot === 'afternoon' ? o.cycleUses : 0, evening: slot === 'evening' ? o.cycleUses : 0 },
        julie: { afternoon: slot === 'afternoon' ? o.cycleUses : 0, evening: slot === 'evening' ? o.cycleUses : 0 } }
    : null;
  const base = emptySnackUses();
  const uses = o.uses || legacy || base;
  return {
    sameComposition: true,
    items: [],
    targetSlot: slot,
    ...o,
    uses: {
      thomas: { ...base.thomas, ...(uses.thomas || {}) },
      julie: { ...base.julie, ...(uses.julie || {}) },
    },
    cycleUses: undefined,
  };
};

/**
 * Normalise un état venant d'une version antérieure (ou d'un import).
 * Exporté pour être testable : fusion des anciens catalogues de collations,
 * conversion des anciens compteurs uniques en compteurs par personne.
 */
export function migrateState(s) {
  return migrate(s);
}

function migrate(s) {
  const base = defaultState();
  const merged = { ...base, ...s };
  merged.settings = { ...base.settings, ...(s.settings || {}) };
  // Fusion PAR PERSONNE ET PAR TYPE DE REPAS (jamais un simple remplacement
  // du sous-objet entier) : un état sauvegardé dont targets.thomas ne
  // couvrirait pas tous les types de repas (ex. état ancien, ou corrompu)
  // écrasait silencieusement les types par défaut manquants (breakfast,
  // snack_afternoon…) avec `{...base, ...saved}` au niveau de `targets`
  // seul — un repli sur `undefined` plus loin dans l'app (ex. catalogs.js)
  // plantait alors au premier rendu de l'écran Petits-déjeuners/Collations.
  merged.settings.targets = {};
  for (const person of Object.keys(base.settings.targets)) {
    merged.settings.targets[person] = { ...base.settings.targets[person], ...(s.settings?.targets?.[person] || {}) };
  }
  merged.settings.cycle = { ...base.settings.cycle, ...(s.settings?.cycle || {}) };
  merged.settings.batch = { ...base.settings.batch, ...(s.settings?.batch || {}) };
  merged.shopping = { purchased: {}, ...(s.shopping || {}) };
  merged.batch = { overrides: {}, cookedOverrides: {}, ...(s.batch || {}) };
  merged.dismissedDuplicates = Array.isArray(merged.dismissedDuplicates) ? merged.dismissedDuplicates : [];
  merged.meta = { ...base.meta, ...(s.meta || {}) };
  // une synchronisation en cours ne survit jamais à un rechargement de page
  // (le code qui la pilotait n'existe plus) : jamais figée à `true` par une
  // persistance survenue pendant qu'elle tournait.
  merged.meta.syncing = false;
  if (!Array.isArray(merged.foods) || !merged.foods.length) merged.foods = seedFoods();
  merged.foods = merged.foods.map(normalizeFood);
  merged.recipes = (Array.isArray(merged.recipes) ? merged.recipes : []).map(normalizeRecipe);
  merged.preparations = (Array.isArray(merged.preparations) ? merged.preparations : []).map(normalizePreparation);
  merged.meals = (Array.isArray(merged.meals) ? merged.meals : []).map(normalizeMeal);
  merged.breakfasts = (merged.breakfasts || []).map(normalizeBreakfast);
  // fusion des deux anciens catalogues de collations en un seul
  merged.snacks = [
    ...(merged.snacks || []).map((o) => normalizeSnack(o, o.targetSlot || 'afternoon')),
    ...(s.snacksAfternoon || []).map((o) => normalizeSnack(o, 'afternoon')),
    ...(s.snacksEvening || []).map((o) => normalizeSnack(o, 'evening')),
  ];
  delete merged.snacksAfternoon;
  delete merged.snacksEvening;
  // P3.3 : coverage.forced supprimé (bouton « Forcer quand même », sans
  // aucun effet sur le moteur) — nettoyage d'une éventuelle donnée
  // antérieure encore présente dans un état local déjà persisté.
  delete merged.coverage;
  return merged;
}

export function getState() {
  if (!state) load();
  return state;
}

export function persist() {
  state.meta.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Sauvegarde locale impossible', e);
  }
}

/** Applique une mutation puis notifie l'UI. */
export function update(mutator, { silent = false, sync = true } = {}) {
  const s = getState();
  mutator(s);
  if (sync) s.meta.dirty = true;
  persist();
  if (!silent) emit();
  return s;
}

/** Remplace tout l'état (import, synchronisation descendante). */
export function replaceState(next, { dirty = false } = {}) {
  state = migrate(next);
  state.meta.dirty = dirty;
  ensureCycleMeals(state);
  persist();
  emit();
}

/* ---------------------------------------------------------------- */
/* Sauvegarde locale de secours                                       */
/* ---------------------------------------------------------------- */

const BACKUP_KEY = `${STORAGE_KEY}.backup`;

/** Copie l'état local avant une opération destructive (récupération cloud). */
export function backupLocal() {
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ savedAt: new Date().toISOString(), state: getState() }));
    return true;
  } catch (e) {
    console.warn('Sauvegarde de secours impossible', e);
    return false;
  }
}

/** Date de la sauvegarde de secours, ou null. */
export function backupInfo() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? { savedAt: JSON.parse(raw).savedAt } : null;
  } catch { return null; }
}

/** Restaure la sauvegarde de secours (état d'avant la dernière récupération). */
export function restoreBackup() {
  const raw = localStorage.getItem(BACKUP_KEY);
  if (!raw) throw new Error('Aucune sauvegarde locale disponible');
  replaceState(JSON.parse(raw).state, { dirty: true });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn(state);
}

/* ------------------------------------------------------------------ */
/* Helpers de domaine                                                  */
/* ------------------------------------------------------------------ */

export function foodsById() {
  const map = {};
  for (const f of getState().foods) map[f.id] = f;
  return map;
}

/**
 * Aliment de la banque déjà associé à ce code-barres EXACT (même convention
 * que le reste de l'app : toujours une comparaison de chaînes normalisées en
 * amont — cf. off.js::normalizeBarcode() —, jamais une conversion Number()
 * qui perdrait un éventuel zéro initial). Critère fort de doublon : si
 * trouvé, aucun endroit de l'app ne doit proposer de créer un second aliment
 * pour le même code-barres, seulement de réutiliser celui-ci.
 */
export function foodByBarcode(barcode) {
  if (!barcode) return null;
  return getState().foods.find((f) => f.barcode && f.barcode === barcode) || null;
}

export function recipesById() {
  const map = {};
  for (const r of getState().recipes) map[r.id] = r;
  return map;
}

export const newRecipe = (name = '', kind = 'weight') => ({
  id: uid('recipe'),
  name,
  kind, // 'weight' | 'portion'
  baseGrams: kind === 'weight' ? 0 : null,
  items: [],
  batchAllowed: false,
  shelfLifeDays: null,
  cookingMethod: '', cookingTemp: null, cookingTime: null, prepTime: null, equipment: '', instructions: '',
});

/** Ingrédient d'une recette : mêmes conventions qu'un item de repas (qty, state). */
export const newRecipeItem = (foodId, qty = 0, itemState = null) => ({
  id: uid('ri'),
  foodId,
  qty,
  state: itemState,
});

export function preparationsById() {
  const map = {};
  for (const p of getState().preparations) map[p.id] = p;
  return map;
}

/** Sections d'un repas — liste fixe pour cette version (décision verrouillée). */
export const SECTIONS = ['entree', 'plat', 'accompagnement', 'fromage', 'dessert', 'collation', 'autre'];
export const DEFAULT_SECTION = 'plat';
export const SECTION_LABEL = {
  entree: 'Entrée', plat: 'Plat', accompagnement: 'Accompagnement',
  fromage: 'Fromage', dessert: 'Dessert', collation: 'Collation', autre: 'Autre',
};

export const newItem = (foodId, qty = 0, itemState = null) => ({
  id: uid('it'),
  section: DEFAULT_SECTION,
  foodId,
  recipeId: null,
  preparationId: null,
  free: null,
  state: itemState,
  qty: { thomas: qty, julie: qty },
  locked: { thomas: false, julie: false },
});

export const newFreeItem = (name, quantity) => ({
  id: uid('it'),
  section: DEFAULT_SECTION,
  foodId: null,
  recipeId: null,
  preparationId: null,
  free: { name, quantity },
  state: null,
  qty: { thomas: 0, julie: 0 },
  locked: { thomas: false, julie: false },
});

/** Item de repas référençant une recette directement, SANS préparation : mode "molle" du calcul inverse (étape 6). */
export const newRecipeMealItem = (recipeId, qty = 0) => ({
  id: uid('it'),
  section: DEFAULT_SECTION,
  foodId: null,
  recipeId,
  preparationId: null,
  free: null,
  state: null,
  qty: { thomas: qty, julie: qty },
  locked: { thomas: false, julie: false },
});

/** Item de repas référençant une préparation : utilisation ferme, tire sur son stock (étape 7). */
export const newPreparationItem = (preparationId, qty = 0) => ({
  id: uid('it'),
  section: DEFAULT_SECTION,
  foodId: null,
  recipeId: null,
  preparationId,
  free: null,
  state: null,
  qty: { thomas: qty, julie: qty },
  locked: { thomas: false, julie: false },
  zeroWaste: false, // mode normal par défaut — jamais basculé automatiquement (décision verrouillée)
});

/** Sections effectivement utilisées par une liste d'items, dans l'ordre de SECTIONS. Jamais persisté. */
export function sectionsUsed(items) {
  const present = new Set(items.map((it) => it.section || DEFAULT_SECTION));
  return SECTIONS.filter((s) => present.has(s));
}

/**
 * Libellé d'affichage d'un item, quel que soit son type de référence — utilisé
 * par toutes les vues qui listent des items (planning, catalogues, impression)
 * pour rester cohérentes entre elles sans dupliquer cette logique.
 */
export const itemLabel = (it, byId, recipesMap = {}, preparationsMap = {}) => {
  if (it.foodId) return byId[it.foodId]?.name || '?';
  if (it.recipeId) return `${recipesMap[it.recipeId]?.name || '?'} (recette)`;
  if (it.preparationId) return preparationsMap[it.preparationId]?.label || '?';
  return it.free?.name || '?';
};

export const newMeal = (dayIndex, mealType) => ({
  id: uid('meal'),
  dayIndex,
  mealType,
  name: '',
  nameAuto: true, // P2.4 : nom vide, régénérable depuis la composition
  sameComposition: true,
  items: [],
});

/**
 * Complète un repas venant d'une version antérieure (ou d'un import partiel).
 * `nameAuto` piloté par store.js seul (jamais recalculé côté UI/sync) : un
 * repas qui porte déjà le champ (booléen) le conserve tel quel — y compris
 * un nom auto-généré non vide, qui ne doit JAMAIS être pris pour un nom
 * saisi par l'utilisateur simplement parce qu'il n'est pas vide. Seul un
 * repas qui n'a jamais connu ce champ (donnée antérieure à P2.4) reçoit une
 * valeur dérivée de `name` — jamais l'inverse, sous peine d'écraser un nom
 * réel au premier recalcul.
 */
export function normalizeMeal(m) {
  const nameAuto = typeof m.nameAuto === 'boolean' ? m.nameAuto : !(m.name && String(m.name).trim());
  return { sameComposition: true, items: [], ...m, nameAuto };
}

const AUTO_NAME_GROUPS = ['feculent', 'proteine', 'legume'];

/**
 * Nom généré depuis la composition : "[Féculent] - [Protéine] - [Légume]"
 * (P2.4). Seuls les aliments simples (foodId) participent — une recette ou
 * une préparation n'a pas de catégorie alimentaire réelle (cf.
 * recipeAsVirtualFood()/preparationAsVirtualFood(), nutrition.js) et n'est
 * donc jamais prise en compte ici. Pour chaque groupe, l'aliment retenu est
 * celui à la plus grande quantité cumulée Thomas + Julie ; un groupe absent
 * est simplement omis (aucun placeholder). Si aucun des trois groupes n'est
 * identifiable, retourne une chaîne vide.
 */
export function autoMealName(items, byId, recipesById = {}, preparationsById = {}) {
  const totals = new Map(); // foodId -> { food, qty }
  for (const it of items) {
    if (!it.foodId) continue;
    const food = byId[it.foodId];
    if (!food || !AUTO_NAME_GROUPS.includes(food.category)) continue;
    const qty = (Number(it.qty?.thomas) || 0) + (Number(it.qty?.julie) || 0);
    const entry = totals.get(it.foodId) || { food, qty: 0 };
    entry.qty += qty;
    totals.set(it.foodId, entry);
  }
  const parts = [];
  for (const group of AUTO_NAME_GROUPS) {
    let best = null;
    for (const entry of totals.values()) {
      if (entry.food.category !== group) continue;
      if (!best || entry.qty > best.qty) best = entry;
    }
    if (best) parts.push(best.food.name);
  }
  if (parts.length) return parts.join(' - ');

  // Repli de dernier recours, jamais prioritaire sur la composition ci-dessus
  // (qui n'aboutit à rien ici, faute de féculent/protéine/légume identifiable) :
  // si une recette ou une préparation est présente dans le repas, son nom sert
  // de nom automatique — mieux qu'un repas "Sans nom" quand une seule recette
  // en fait tout le contenu.
  const recipeTotals = new Map(); // nom de recette -> qty cumulée
  for (const it of items) {
    const recipeId = it.recipeId || preparationsById[it.preparationId]?.recipeId;
    const name = recipesById[recipeId]?.name;
    if (!name) continue;
    const qty = (Number(it.qty?.thomas) || 0) + (Number(it.qty?.julie) || 0);
    recipeTotals.set(name, (recipeTotals.get(name) || 0) + qty);
  }
  let bestName = '', bestQty = -1;
  for (const [name, qty] of recipeTotals) {
    if (qty > bestQty) { bestName = name; bestQty = qty; }
  }
  return bestName;
}

/**
 * Option de catalogue (petit-déjeuner ou collation).
 * Ce sont les compteurs d'utilisation — et eux seuls — qui font entrer les
 * aliments d'un catalogue dans le cycle et dans les courses : aucune option
 * n'est rattachée à un jour ni à une date.
 */
export const newOption = (name = '', kind = 'breakfast') => ({
  id: uid('opt'),
  name,
  sameComposition: true,
  items: [],
  ...(kind === 'breakfast'
    ? { uses: emptyBreakfastUses() }
    : { uses: emptySnackUses(), targetSlot: 'afternoon' }),
});

/** Crée les créneaux déjeuner/dîner manquants et supprime ceux hors cycle. */
export function ensureCycleMeals(s = getState()) {
  const days = s.settings.cycle.duration;
  s.meals = s.meals.filter((m) => m.dayIndex < days);
  for (let d = 0; d < days; d++) {
    for (const type of ['lunch', 'dinner']) {
      if (!s.meals.some((m) => m.dayIndex === d && m.mealType === type)) {
        s.meals.push(newMeal(d, type));
      }
    }
  }
  s.meals.sort((a, b) => a.dayIndex - b.dayIndex || (a.mealType === 'lunch' ? -1 : 1));
  return s;
}

/** Clé de l'état pour un type de catalogue. */
export function catalogKey(kind) {
  return { breakfast: 'breakfasts', snack: 'snacks' }[kind];
}

/* ------------------------------------------------------------------ */
/* Export / import                                                     */
/* ------------------------------------------------------------------ */

// Repère de compatibilité simple pour les fichiers exportés — PAS une clé de
// migration complexe : le format actuel (objet d'état complet, normalisé par
// migrate()/normalize*() à l'import comme au chargement local) absorbe déjà
// les champs manquants ou en trop. Ce numéro sert uniquement à distinguer,
// plus tard, un format qui romprait cette compatibilité ascendante — tant
// qu'aucun tel format n'existe, importJSON() ne fait que le lire sans bloquer
// sur sa valeur (un export d'avant son introduction n'a pas ce champ).
export const EXPORT_SCHEMA_VERSION = 1;

export function exportJSON() {
  return JSON.stringify({ ...getState(), schemaVersion: EXPORT_SCHEMA_VERSION, exportedAt: new Date().toISOString() }, null, 2);
}

export function importJSON(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('Le fichier n’est pas un JSON valide.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Fichier invalide : ce n’est pas une sauvegarde Nutriplan.');
  if (!Array.isArray(data.foods)) throw new Error('Fichier invalide : banque alimentaire absente.');
  // schemaVersion absent = export antérieur à son introduction, toujours
  // compatible (migrate() le normalise) ; schemaVersion SUPÉRIEUR à celui
  // que cette version du code connaît = fichier plus récent qu'elle, import
  // bloqué plutôt que de risquer une donnée mal interprétée en silence.
  if (Number.isFinite(data.schemaVersion) && data.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error(`Ce fichier vient d’une version plus récente de Nutriplan (format ${data.schemaVersion}, cette version ne connaît que le format ${EXPORT_SCHEMA_VERSION}). Mets à jour l’application avant d’importer.`);
  }
  replaceState(data, { dirty: true });
}

/** Réinitialise uniquement le cycle en cours. */
export function resetCycle() {
  update((s) => {
    // P4 : figer le stock RÉELLEMENT restant de chaque préparation AVANT de
    // vider le planning — sinon preparationUsed() (qui lit state.meals) ne
    // trouverait plus aucun usage une fois les repas supprimés, et
    // preparationAvailable() referait passer le disponible à preparedQuantity
    // en entier, comme si la préparation venait d'être cuisinée. Idempotent
    // sur des resets successifs : preparationAvailable() tient déjà compte
    // d'un remainingAtReset déjà présent (baseline = remainingAtReset ??
    // preparedGramsOf(...)), donc chaque reset re-fige simplement "ce qu'il
    // reste maintenant", quel que soit le nombre de resets précédents.
    for (const p of s.preparations) {
      p.remainingAtReset = preparationAvailable(s, p);
      // P1 : avance la fenêtre de comptage des pertes (« Jeter les restes »)
      // — preparationAvailable() ci-dessus a DÉJÀ soustrait les pertes depuis
      // le précédent lastResetAt, donc ce nouveau remainingAtReset les reflète
      // déjà : les recompter après ce point les déduirait deux fois. L'avancer
      // maintenant garantit qu'une perte future ne compte qu'une seule fois,
      // et l'historique (p.losses) n'est jamais effacé (trace conservée).
      p.lastResetAt = new Date().toISOString();
    }
    s.meals = [];
    s.shopping = { purchased: {} };
    s.batch = { overrides: {}, cookedOverrides: {} };
    // les catalogues sont conservés : seuls leurs compteurs d'utilisation repartent à zéro
    for (const o of s.breakfasts) o.uses = emptyBreakfastUses();
    for (const o of s.snacks) o.uses = emptySnackUses();
    ensureCycleMeals(s);
  });
}

/* ------------------------------------------------------------------ */
/* Fusion d'aliments en doublon (P3)                                   */
/* ------------------------------------------------------------------ */

/**
 * Fusionne un ou plusieurs aliments (`mergeIds`) dans `keepId` : toute
 * référence vivante à un aliment fusionné est redirigée vers `keepId`,
 * jamais l'inverse — les valeurs nutritionnelles, l'unité et les métadonnées
 * de `keepId` restent telles quelles, c'est lui qui gagne. Aucune fusion
 * automatique : cette fonction n'est jamais appelée sur la seule base d'une
 * similarité de nom, uniquement sur un choix explicite de l'utilisateur
 * (écran Aliments, § doublons détectés).
 *
 * Ne touche JAMAIS `preparations[].recipeSnapshot` : cette copie est
 * volontairement figée au moment de la création de la préparation (décision
 * verrouillée, cf. preparationAsVirtualFood()) — une préparation déjà
 * matérialisée garde l'historique exact de ce qui a été réellement préparé,
 * y compris un aliment depuis fusionné ailleurs.
 *
 * Retourne un résumé des références migrées, pour affichage et tests —
 * jamais une opération silencieuse.
 */
export function mergeFoods(state, keepId, mergeIds) {
  const ids = new Set(mergeIds.filter((id) => id && id !== keepId));
  if (!ids.size || !state.foods.some((f) => f.id === keepId)) {
    return { recipes: 0, meals: 0, breakfasts: 0, snacks: 0, shopping: 0, batch: 0, foodsRemoved: 0 };
  }
  const summary = { recipes: 0, meals: 0, breakfasts: 0, snacks: 0, shopping: 0, batch: 0, foodsRemoved: 0 };

  for (const r of state.recipes) {
    for (const it of r.items) if (ids.has(it.foodId)) { it.foodId = keepId; summary.recipes++; }
  }
  for (const m of state.meals) {
    for (const it of m.items) if (ids.has(it.foodId)) { it.foodId = keepId; summary.meals++; }
  }
  for (const o of state.breakfasts) {
    for (const it of o.items) if (ids.has(it.foodId)) { it.foodId = keepId; summary.breakfasts++; }
  }
  for (const o of state.snacks) {
    for (const it of o.items) if (ids.has(it.foodId)) { it.foodId = keepId; summary.snacks++; }
  }
  // shopping.purchased : simple case à cocher par aliment (aucun stock) —
  // fusionnée par OR (coché si l'un OU l'autre l'était), jamais perdue.
  const purchased = state.shopping?.purchased || {};
  let keptChecked = Boolean(purchased[keepId]);
  for (const id of ids) {
    if (id in purchased) { keptChecked = keptChecked || Boolean(purchased[id]); delete purchased[id]; summary.shopping++; }
  }
  if (summary.shopping) purchased[keepId] = keptChecked;
  // batch.overrides : clés "session:foodId" (aliment) ou "session:x-y:foodId"
  // (sous-préparation) — seul le dernier segment identifie l'aliment. En cas
  // de conflit (une saisie existe déjà pour keepId sur la même clé), celle de
  // keepId est conservée : jamais une valeur silencieusement écrasée par
  // celle de l'aliment fusionné.
  const overrides = state.batch?.overrides || {};
  for (const [key, value] of Object.entries(overrides)) {
    const lastSegment = key.split(':').pop();
    if (!ids.has(lastSegment)) continue;
    const newKey = `${key.slice(0, key.length - lastSegment.length)}${keepId}`;
    if (!(newKey in overrides)) overrides[newKey] = value;
    delete overrides[key];
    summary.batch++;
  }
  // cookedOverrides : même logique de clés, même garde anti-écrasement.
  const cookedOverrides = state.batch?.cookedOverrides || {};
  for (const [key, value] of Object.entries(cookedOverrides)) {
    const lastSegment = key.split(':').pop();
    if (!ids.has(lastSegment)) continue;
    const newKey = `${key.slice(0, key.length - lastSegment.length)}${keepId}`;
    if (!(newKey in cookedOverrides)) cookedOverrides[newKey] = value;
    delete cookedOverrides[key];
  }

  const before = state.foods.length;
  state.foods = state.foods.filter((f) => !ids.has(f.id));
  summary.foodsRemoved = before - state.foods.length;
  return summary;
}
