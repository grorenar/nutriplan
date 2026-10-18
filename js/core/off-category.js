/**
 * Suggestion de catégorie Nutriplan à partir d'une fiche produit Open Food
 * Facts (OFF) — module indépendant de l'UI, pur (mêmes entrées -> même
 * sortie), réutilisé par js/core/off.js lors du préremplissage d'un aliment.
 *
 * Principe : ne JAMAIS inventer une catégorie. Soit la correspondance est
 * fiable (un seul des 8 groupes `nutrition.js` est atteint sans ambiguïté),
 * soit la fonction renvoie `null` — auquel cas l'appelant n'écrit rien dans
 * le brouillon et le champ garde sa valeur actuelle (par défaut « Autre »,
 * ou le choix déjà fait par l'utilisateur). « Autre » n'est donc JAMAIS
 * suggéré explicitement par ce module : il reste la valeur par défaut du
 * formulaire, pas une déduction.
 *
 * Deux signaux, dans cet ORDRE DE PRIORITÉ strict :
 *   1. `categories_tags` (taxonomie structurée OFF) — fiable, utilisé en
 *      priorité absolue dès qu'il donne un résultat net.
 *   2. Le nom du produit (mots-clés) — UNIQUEMENT si (1) n'a rien donné
 *      (aucun tag connu, champ absent, ou produit mal renseigné). Un nom
 *      évocateur ne l'emporte jamais sur une catégorie OFF reconnue, même
 *      contradictoire : la taxonomie structurée est plus fiable qu'un texte
 *      libre (cf. tests : « indices contradictoires »).
 * La marque n'est JAMAIS utilisée seule comme signal (pas assez
 * discriminante : la même marque vend des produits de toutes catégories).
 * Les ingrédients ne sont pas exploités ici (cf. README : la composition
 * d'un produit n'indique pas de façon fiable SA PROPRE catégorie — un
 * yaourt aux fruits contient du lait ET du fruit, ça n'aide pas à trancher).
 */

import { normalize } from './util.js';
import { CATEGORIES } from './nutrition.js';

const VALID_CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));

/**
 * Table OFF -> Nutriplan, indexée par identifiant de taxonomie OFF (slug
 * SANS préfixe de langue, ex. `categories_tags: ["en:meats", ...]` -> clé
 * `meats`). Choix déterminant : un identifiant de taxonomie est une
 * référence STABLE (vérifiée dans le fichier source de la taxonomie OFF,
 * openfoodfacts-server/taxonomies/food/categories.txt), contrairement à un
 * libellé traduit qui change de forme selon la langue.
 *
 * `categories_tags` contient, pour un produit donné, le tag le plus
 * spécifique ET tous ses ancêtres (OFF les ajoute automatiquement à partir
 * de la taxonomie — ex. un produit catégorisé « Beurres salés » reçoit aussi
 * « Produits laitiers », « Matières grasses », « Pâtes à tartiner »). Il
 * suffit donc qu'UN SEUL tag de la liste soit une clé connue de cette table
 * pour couvrir aussi bien un tag très spécifique (via son ancêtre général,
 * si lui seul est répertorié) qu'un tag déjà général.
 *
 * Volontairement NON exhaustif — ni un sous-ensemble de la taxonomie OFF
 * entière (des milliers d'entrées), ni une tentative de la reproduire :
 * seulement les groupes ayant une correspondance fiable et sans ambiguïté
 * avec l'un des 8 groupes `CATEGORIES` de Nutriplan (cf. nutrition.js).
 * Table lisible et volontairement plate (tableau de paires) pour rester
 * facile à étendre : ajouter une ligne, jamais modifier la logique.
 *
 * Exclusions délibérées (documentées pour ne pas être « redécouvertes » par
 * erreur plus tard) :
 *  - `plant-based-foods` / `plant-based-foods-and-beverages` et autres tags
 *    racines très généraux : couvrent légumes, fruits, légumineuses, noix,
 *    céréales... à la fois -> aucune valeur discriminante, exclus.
 *  - `seeds` (« Graines ») : couvre aussi bien des graines oléagineuses
 *    (tournesol, courge -> oléagineux) que des graines céréalières -> pas
 *    de correspondance fiable à un groupe unique, exclu (cf. règle
 *    « ne pas assimiler tous les produits d'une même famille à une
 *    catégorie unique lorsque des distinctions utiles existent »).
 *  - boissons végétales (« plant-based-beverages » et dérivés laitiers
 *    végétaux) : nutritionnellement très différentes d'un produit laitier
 *    réel (pas de protéine animale) -> jamais classées « laitier ».
 *  - `fruits-and-vegetables-based-foods` (parent commun fruits+légumes,
 *    OFF les déclare explicitement incompatibles entre eux par ailleurs) :
 *    exclu pour la même raison que `plant-based-foods`.
 */
const OFF_TAG_TO_CATEGORY = [
  // Protéines : viande, volaille, poisson, fruits de mer, œufs
  ['meats', 'proteine'],
  ['meats-and-their-products', 'proteine'],
  ['poultries', 'proteine'],
  ['fishes', 'proteine'],
  ['fishes-and-their-products', 'proteine'],
  ['seafood', 'proteine'],
  ['eggs', 'proteine'],
  ['eggs-and-their-products', 'proteine'],

  // Féculents : céréales, pains, pâtes, riz, pommes de terre
  ['cereals', 'feculent'],
  ['cereals-and-their-products', 'feculent'],
  ['breads', 'feculent'],
  ['pastas', 'feculent'],
  ['pastas-and-dumplings', 'feculent'],
  ['rices', 'feculent'],
  ['potatoes', 'feculent'],
  ['potatoes-and-their-products', 'feculent'],

  // Légumineuses (sens nutritionnel : légumes secs) — distinct de « légumes »
  // (faux-ami : la catégorie OFF anglaise « Legumes » correspond au français
  // « Légumineuses », vérifié dans le fichier source de la taxonomie : le
  // tag `en:legumes` y porte `fr: Légumineuses`, jamais « Légumes »).
  ['legumes', 'legumineuse'],
  ['legumes-and-their-products', 'legumineuse'],
  ['legume-seeds', 'legumineuse'],
  ['pulses', 'legumineuse'],

  // Légumes (au sens français courant : légumes frais/préparés)
  ['vegetables', 'legume'],
  ['vegetables-based-foods', 'legume'],
  ['fresh-vegetables', 'legume'],

  // Fruits
  ['fruits', 'fruit'],
  ['fresh-fruits', 'fruit'],

  // Laitier : lait, fromages, yaourts — jamais les alternatives végétales
  ['dairies', 'laitier'],
  ['milks', 'laitier'],
  ['cheeses', 'laitier'],
  ['yogurts', 'laitier'],
  ['fermented-dairy-desserts', 'laitier'],
  ['dairy-desserts', 'laitier'],

  // Matières grasses : huiles, beurres, margarines — jamais confondues avec
  // « laitier » (le beurre est nutritionnellement une matière grasse quasi
  // pure, pas un produit laitier au sens des portions de CATEGORY_PROFILE).
  ['fats', 'matiere_grasse'],
  ['vegetable-fats', 'matiere_grasse'],
  ['animal-fats', 'matiere_grasse'],
  ['margarines', 'matiere_grasse'],
  ['vegetable-oils', 'matiere_grasse'],
  ['oils', 'matiere_grasse'],
  ['butters', 'matiere_grasse'],

  // Noix & graines (sens Nutriplan : fruits à coque)
  ['nuts', 'oleagineux'],
  ['nuts-and-their-products', 'oleagineux'],
];

/** `Map` dérivée de la table ci-dessus — un seul passage, jamais reconstruite par appel. */
const TAG_MAP = new Map(OFF_TAG_TO_CATEGORY);

/**
 * Mots-clés du NOM produit, utilisés en repli uniquement (cf. en-tête du
 * fichier). Liste volontairement courte et non exhaustive — facile à
 * compléter, jamais un objectif d'exhaustivité linguistique. Inclut
 * singulier et pluriel quand les deux sont des formes usuelles courantes.
 * La marque n'apparaît jamais ici (cf. règle « jamais la marque seule »).
 */
const NAME_KEYWORDS = [
  ['proteine', ['poulet', 'boeuf', 'porc', 'dinde', 'jambon', 'saumon', 'thon', 'steak', 'viande', 'escalope', 'crevette', 'crevettes', 'merguez', 'saucisse', 'chicken', 'beef', 'turkey', 'salmon', 'tuna', 'shrimp']],
  // "oeuf"/"oeufs" sans le "b" de "boeuf" : le padding par espaces dans
  // textHasKeyword() empêche "boeuf" de déclencher un faux positif sur
  // "oeuf" (cf. tests — "b" immédiatement avant exclut la frontière de mot).
  ['proteine', ['oeuf', 'oeufs', 'egg', 'eggs']],
  ['feculent', ['pain', 'pates', 'riz', 'pomme de terre', 'pommes de terre', 'ble', 'avoine', "flocons d'avoine", 'cereales', 'bread', 'rice', 'pasta', 'potato', 'potatoes', 'oats', 'wheat']],
  ['legumineuse', ['lentilles', 'lentille', 'pois chiche', 'pois chiches', 'haricots secs', 'haricots rouges', 'lentils', 'chickpea', 'chickpeas']],
  ['legume', ['carotte', 'carottes', 'tomate', 'tomates', 'courgette', 'courgettes', 'brocoli', 'epinard', 'epinards', 'salade', 'poivron', 'oignon', 'oignons', 'carrot', 'carrots', 'tomato', 'tomatoes', 'broccoli', 'spinach', 'onion']],
  ['fruit', ['pomme', 'pommes', 'banane', 'bananes', 'orange', 'oranges', 'fraise', 'fraises', 'framboise', 'peche', 'peches', 'poire', 'poires', 'raisin', 'raisins', 'abricot', 'abricots', 'kiwi', 'cerise', 'cerises', 'apple', 'apples', 'banana', 'strawberry', 'grape', 'grapes']],
  ['laitier', ['yaourt', 'yaourts', 'yogourt', 'fromage', 'fromages', 'lait', 'creme fraiche', 'skyr', 'yogurt', 'cheese', 'milk']],
  ['matiere_grasse', ['huile', 'beurre', 'margarine', 'oil', 'butter']],
  ['oleagineux', ['amande', 'amandes', 'noix', 'noisette', 'noisettes', 'cacahuete', 'cacahuetes', 'pistache', 'pistaches', 'almond', 'almonds', 'walnut', 'hazelnut', 'peanut', 'peanuts', 'pistachio']],
];

/** Supprime le préfixe de langue d'un tag OFF (« en:meats » -> « meats »), en minuscule, accents retirés. */
function normalizeTag(tag) {
  return normalize(String(tag ?? '')).replace(/^[a-z]{2,3}:/, '').trim();
}

/** Texte normalisé, mots séparés par un espace unique, encadré d'espaces (frontières de mot par simple inclusion de chaîne). */
function normalizeText(s) {
  const cleaned = normalize(String(s ?? '')).replace(/[^a-z0-9]+/g, ' ').trim();
  return cleaned ? ` ${cleaned} ` : '';
}

/**
 * Un mot-clé (normalisé, encadré d'espaces) apparaît-il comme mot entier
 * dans le texte (lui aussi encadré d'espaces) ? Le padding par espaces est
 * ce qui empêche un mot-clé d'en « matcher » un autre qui le contient
 * (ex. « oeuf » ne matche jamais à l'intérieur de « boeuf »).
 */
function textHasKeyword(paddedText, keyword) {
  return paddedText.includes(normalizeText(keyword));
}

/**
 * Déduplique les catégories atteintes par plusieurs tags/mots-clés et
 * détecte l'ambiguïté : si deux signaux distincts pointent vers deux
 * catégories Nutriplan DIFFÉRENTES, aucune suggestion fiable n'est possible
 * (cf. règle « ne jamais présenter une certitude artificielle »).
 * @returns {{category: string, matches: string[]} | null}
 */
function resolveUnique(hits) {
  if (!hits.length) return null;
  const distinct = [...new Set(hits.map((h) => h.category))];
  if (distinct.length !== 1) return null; // ambigu : plusieurs catégories plausibles, ou aucune
  return { category: distinct[0], matches: hits.map((h) => h.matched) };
}

/**
 * Correspondance par taxonomie OFF (signal primaire). `categoriesTags` :
 * tableau brut tel que renvoyé par l'API (`p.categories_tags`), avec ou
 * sans préfixe de langue.
 */
function matchByTags(categoriesTags) {
  const tags = Array.isArray(categoriesTags) ? categoriesTags : [];
  const hits = [];
  for (const raw of tags) {
    const id = normalizeTag(raw);
    const category = TAG_MAP.get(id);
    if (category) hits.push({ category, matched: `tag:${id}` });
  }
  return resolveUnique(hits);
}

/**
 * Correspondance par mots-clés du nom (signal de repli). Gère les libellés
 * composites (« pomme de terre » contient « pomme ») en écartant tout
 * mot-clé qui n'est qu'une sous-chaîne d'un autre mot-clé EFFECTIVEMENT
 * trouvé dans le même nom : le plus spécifique l'emporte, jamais les deux
 * traités comme deux signaux distincts et donc faussement « ambigus ».
 */
function matchByName(name) {
  const padded = normalizeText(name);
  if (!padded.trim()) return null;
  const rawHits = [];
  for (const [category, keywords] of NAME_KEYWORDS) {
    for (const keyword of keywords) {
      if (textHasKeyword(padded, keyword)) rawHits.push({ category, matched: `name:${keyword}` });
    }
  }
  const hits = rawHits.filter((h) => {
    const kw = h.matched.slice('name:'.length);
    return !rawHits.some((other) => other !== h && other.matched.slice('name:'.length).includes(kw) && other.matched.slice('name:'.length) !== kw);
  });
  return resolveUnique(hits);
}

/**
 * Point d'entrée : suggère une catégorie Nutriplan à partir des données OFF
 * disponibles, ou `null` si rien de fiable ne se dégage.
 * @param {{categoriesTags?: string[], name?: string}} input
 * @returns {{category: string, confidence: 'tag'|'name', matches: string[]} | null}
 */
export function suggestCategoryFromOff({ categoriesTags, name } = {}) {
  const byTags = matchByTags(categoriesTags);
  if (byTags) return { category: byTags.category, confidence: 'tag', matches: byTags.matches };
  const byName = matchByName(name);
  if (byName) return { category: byName.category, confidence: 'name', matches: byName.matches };
  return null;
}

/** Exposé pour les tests uniquement (vérifie que la table ne référence aucun id de catégorie invalide). */
export function _knownCategoryIdsForTests() {
  return VALID_CATEGORY_IDS;
}
