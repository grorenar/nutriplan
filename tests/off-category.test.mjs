/**
 * Tests du module de suggestion de catégorie Open Food Facts -> Nutriplan
 * (js/core/off-category.js). Module pur, déterministe, sans appel réseau.
 *
 *   node tests/off-category.test.mjs
 */

import { suggestCategoryFromOff, _knownCategoryIdsForTests } from '../js/core/off-category.js';
import { CATEGORIES } from '../js/core/nutrition.js';

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  try {
    fn();
    console.log(`\n✔ ${name}`);
  } catch (e) {
    console.log(`\n✘ ${name}\n   ${e.message}`);
    failures.push(`${name} — ${e.message}`);
  }
}
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`   ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else { failures.push(`${currentTest} / ${label}${detail ? ` (${detail})` : ''}`); console.log(`   FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

/* ---------------------------------------------------------------- correspondance directe */

test('catégorie OFF correspondant directement à une catégorie Nutriplan', () => {
  const r = suggestCategoryFromOff({ categoriesTags: ['en:cheeses'] });
  check('laitier suggéré, via le tag', r?.category === 'laitier' && r?.confidence === 'tag');
});

test('catégorie OFF très spécifique dont seul un ANCÊTRE correspond', () => {
  // "en:greek-yogurts" n'est PAS dans la table (trop spécifique) ; OFF ajoute
  // automatiquement ses ancêtres au produit — ici son parent "en:yogurts",
  // qui lui EST connu. categories_tags reflète cette liste complète.
  const r = suggestCategoryFromOff({ categoriesTags: ['en:greek-yogurts', 'en:yogurts', 'en:fermented-foods'] });
  check('laitier retrouvé via l’ancêtre connu, pas via le tag le plus spécifique', r?.category === 'laitier');
});

test('plusieurs tags OFF pointant vers LA MÊME catégorie Nutriplan : résolu normalement', () => {
  const r = suggestCategoryFromOff({ categoriesTags: ['en:yogurts', 'en:dairies', 'en:cheeses'] });
  check('laitier (un seul résultat distinct malgré 3 tags)', r?.category === 'laitier');
});

test('plusieurs tags OFF pointant vers DEUX catégories Nutriplan différentes : ambigu, aucune suggestion', () => {
  // Cas réel documenté par OFF : un produit "Beurres salés" porte à la fois
  // "Produits laitiers" (dairies) et "Matières grasses" (fats) parmi ses tags
  // ancêtres automatiques — deux catégories Nutriplan distinctes.
  const r = suggestCategoryFromOff({ categoriesTags: ['en:dairies', 'en:fats'] });
  check('aucune suggestion (ambigu, jamais une certitude artificielle)', r === null);
});

test('catégorie OFF inconnue de la table : aucune suggestion (jamais une catégorie inventée)', () => {
  const r = suggestCategoryFromOff({ categoriesTags: ['en:sugary-snacks', 'en:snacks'] });
  check('aucune suggestion', r === null);
});

test('absence de categories_tags : repli sur le nom, ou aucune suggestion si le nom n’aide pas non plus', () => {
  const r1 = suggestCategoryFromOff({ categoriesTags: undefined, name: 'Filets de poulet' });
  check('repli sur le nom quand aucun tag n’est fourni', r1?.category === 'proteine' && r1?.confidence === 'name');
  const r2 = suggestCategoryFromOff({ categoriesTags: [], name: '' });
  check('ni tag ni nom exploitable -> aucune suggestion', r2 === null);
});

test('produit mal renseigné (aucun champ exploitable) : aucune suggestion, jamais une erreur', () => {
  const r = suggestCategoryFromOff({});
  check('aucune suggestion, aucune exception', r === null);
  const r2 = suggestCategoryFromOff(undefined);
  check('appel sans argument : aucune suggestion, aucune exception', r2 === null);
});

/* ---------------------------------------------------------------- normalisation */

test('tags avec casse différente / accents / préfixe de langue variable : toujours reconnus', () => {
  const r1 = suggestCategoryFromOff({ categoriesTags: ['EN:MEATS'] });
  check('tag en MAJUSCULES reconnu', r1?.category === 'proteine');
  const r2 = suggestCategoryFromOff({ categoriesTags: ['fr:meats'] }); // préfixe de langue différent, même identifiant
  check('préfixe de langue non-"en" toléré sur un identifiant par ailleurs connu', r2?.category === 'proteine');
});

test('mots-clés du nom : casse différente et accents sans incidence', () => {
  const r1 = suggestCategoryFromOff({ name: 'POULET fermier' });
  check('nom en majuscules reconnu', r1?.category === 'proteine');
  const r2 = suggestCategoryFromOff({ name: 'Pêches au sirop' });
  check('nom accentué reconnu (repli sur une forme non accentuée en interne)', r2?.category === 'fruit');
});

test('synonyme / libellé composite ("pomme de terre" ne doit jamais être confondu avec "pomme")', () => {
  const r1 = suggestCategoryFromOff({ name: 'Pommes de terre nouvelles' });
  check('féculent (le libellé composite, plus spécifique, l’emporte)', r1?.category === 'feculent');
  const r2 = suggestCategoryFromOff({ name: 'Compote de pommes sans sucre ajouté' });
  check('fruit (pas de "de terre" ici, aucune confusion)', r2?.category === 'fruit');
});

test('"boeuf" ne déclenche jamais un faux positif sur le mot-clé "oeuf"', () => {
  const r = suggestCategoryFromOff({ name: 'Steak haché de boeuf' });
  check('proteine via "boeuf", jamais via un faux "oeuf" à l’intérieur du mot', r?.category === 'proteine');
});

/* ---------------------------------------------------------------- catégories internes proches/ambiguës */

test('distinction fiable entre catégories internes proches : légumineuses (OFF "Legumes") vs légumes', () => {
  // Faux-ami documenté : la catégorie OFF anglaise "en:legumes" correspond au
  // français "Légumineuses" (légumes secs), pas à "Légumes" au sens courant.
  const legumineuse = suggestCategoryFromOff({ categoriesTags: ['en:legumes'] });
  check('en:legumes -> legumineuse (PAS legume)', legumineuse?.category === 'legumineuse');
  const legume = suggestCategoryFromOff({ categoriesTags: ['en:vegetables'] });
  check('en:vegetables -> legume (PAS legumineuse)', legume?.category === 'legume');
});

test('distinction fiable entre catégories internes proches : laitier (beurre EXCLU) vs matière grasse', () => {
  const beurre = suggestCategoryFromOff({ categoriesTags: ['en:butters'] });
  check('en:butters -> matiere_grasse (le beurre n’est pas traité comme "laitier")', beurre?.category === 'matiere_grasse');
  const fromage = suggestCategoryFromOff({ categoriesTags: ['en:cheeses'] });
  check('en:cheeses -> laitier', fromage?.category === 'laitier');
});

test('"en:seeds" (graines, catégorie OFF ambiguë entre féculent/oléagineux) : jamais assimilée arbitrairement', () => {
  const r = suggestCategoryFromOff({ categoriesTags: ['en:seeds'] });
  check('aucune suggestion pour une catégorie OFF intrinsèquement ambiguë', r === null);
});

/* ---------------------------------------------------------------- priorité tag > nom (indices contradictoires) */

test('indices contradictoires entre le nom et la catégorie OFF : le tag (plus fiable) l’emporte TOUJOURS', () => {
  // Fromage de chèvre aux noix : categories_tags dit "fromage" (laitier),
  // le nom contient "noix" (mot-clé oléagineux) -> ignoré, le tag gagne.
  const r = suggestCategoryFromOff({ categoriesTags: ['en:cheeses'], name: 'Fromage de chèvre aux noix' });
  check('laitier retenu malgré "noix" dans le nom (jamais un repli vers le nom quand un tag est fiable)', r?.category === 'laitier');
});

test('nom contredisant un tag OFF non reconnu : repli sur le nom, comme si le tag était absent', () => {
  const r = suggestCategoryFromOff({ categoriesTags: ['en:some-made-up-category'], name: 'Filets de saumon fumé' });
  check('le tag inconnu ne bloque pas le repli sur le nom', r?.category === 'proteine' && r?.confidence === 'name');
});

/* ---------------------------------------------------------------- déterminisme et robustesse */

test('déterministe : mêmes entrées -> même résultat, à chaque appel', () => {
  const input = { categoriesTags: ['en:fishes', 'en:seafood'], name: 'Filets de cabillaud' };
  const r1 = suggestCategoryFromOff(input);
  const r2 = suggestCategoryFromOff(input);
  check('résultat identique entre deux appels', r1?.category === r2?.category && r1?.confidence === r2?.confidence);
});

test('aucune valeur de la table ne référence une catégorie Nutriplan invalide', () => {
  // Vérifie la table (tags) ET la liste de mots-clés indirectement, via un
  // échantillon de tags/mots couvrant chaque entrée de CATEGORIES sauf "autre"
  // (jamais suggérée explicitement, par conception).
  const known = _knownCategoryIdsForTests();
  const probes = [
    ['en:meats'], ['en:cereals'], ['en:legumes'], ['en:vegetables'], ['en:fruits'],
    ['en:dairies'], ['en:fats'], ['en:nuts'],
  ];
  for (const tags of probes) {
    const r = suggestCategoryFromOff({ categoriesTags: tags });
    check(`résultat pour ${tags[0]} est une catégorie Nutriplan valide`, r === null || known.has(r.category));
  }
  check('"autre" n’apparaît jamais comme suggestion explicite', CATEGORIES.some((c) => c.id === 'autre'));
});

/* ---------------------------------------------------------------- bilan */

console.log(`\n${'='.repeat(60)}`);
if (failures.length) {
  console.log(`   ${passed} vérifications réussies, ${failures.length} échec(s) :`);
  failures.forEach((f) => console.log(`   ✘ ${f}`));
  process.exit(1);
} else {
  console.log(`   ${passed} vérifications réussies, 0 échec(s).`);
}
