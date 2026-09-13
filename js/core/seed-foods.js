/**
 * Banque alimentaire initiale.
 *
 * IMPORTANT : ces valeurs sont des valeurs GÉNÉRIQUES et indicatives pour des
 * aliments courants. Elles ne prétendent pas correspondre à une marque précise.
 * Pour un produit de marque (whey, Wasa, St Môret, skyr d'une marque donnée…),
 * crée ton propre aliment et recopie les valeurs de l'emballage.
 *
 * Tous les champs sont modifiables depuis l'écran ALIMENTS.
 * Valeurs nutritionnelles pour 100 g dans l'état de référence indiqué.
 *
 * Tuple : [id, nom, catégorie, kcal, P, G, L, fibres, état, coefCuisson,
 *          unité, g/unité, fractionnable, prix, poids conditionnement, batchable, favori]
 */

const T = [
  // ---------------------------------------------------------------- protéines
  ['poulet_filet', 'Blanc de poulet', 'proteine', 110, 23, 0, 1.6, 0, 'cru', 0.70, '', 0, true, 6.9, 500, true, true],
  ['poulet_tranches', 'Blanc de poulet en tranches', 'proteine', 105, 20, 1.5, 1.8, 0, 'pret', 1, 'tranche', 35, false, 2.9, 140, false, true],
  ['dinde_escalope', 'Escalope de dinde', 'proteine', 105, 22, 0, 1.5, 0, 'cru', 0.72, '', 0, true, 6.5, 450, true, false],
  ['poulet_cuisse', 'Cuisse de poulet sans peau', 'proteine', 145, 20, 0, 7, 0, 'cru', 0.72, '', 0, true, 5.2, 600, true, false],
  ['boeuf_hache5', 'Steak haché 5 % MG', 'proteine', 125, 21, 0, 5, 0, 'cru', 0.75, 'steak', 100, false, 5.6, 500, true, false],
  ['porc_filet', 'Filet mignon de porc', 'proteine', 130, 22, 0, 4.5, 0, 'cru', 0.74, '', 0, true, 8.5, 600, true, false],
  ['cabillaud', 'Filet de cabillaud', 'proteine', 78, 18, 0, 0.7, 0, 'cru', 0.80, '', 0, true, 7.9, 400, false, false],
  ['saumon', 'Pavé de saumon', 'proteine', 190, 20, 0, 12, 0, 'cru', 0.80, 'pavé', 130, false, 8.9, 260, false, false],
  ['colin', 'Filet de colin', 'proteine', 80, 17, 0, 1, 0, 'cru', 0.80, '', 0, true, 6.5, 400, false, false],
  ['thon_naturel', 'Thon au naturel', 'proteine', 105, 24, 0, 1, 0, 'egoutte', 1, 'boîte', 112, false, 2.3, 224, false, false],
  ['crevettes', 'Crevettes décortiquées cuites', 'proteine', 95, 21, 0, 1, 0, 'pret', 1, '', 0, true, 5.5, 200, false, false],
  ['oeuf', 'Œuf entier', 'proteine', 143, 12.6, 0.7, 9.9, 0, 'cru', 0.90, 'œuf', 60, false, 3.2, 360, false, true],
  ['blanc_oeuf', 'Blanc d’œuf', 'proteine', 48, 11, 0.7, 0.2, 0, 'cru', 1, '', 0, true, 3.9, 500, false, false],
  ['jambon', 'Jambon blanc découenné', 'proteine', 110, 20, 1, 3, 0, 'pret', 1, 'tranche', 40, false, 2.6, 160, false, false],
  ['lentilles', 'Lentilles cuites', 'proteine', 115, 9, 17, 0.5, 5, 'egoutte', 1, '', 0, true, 1.6, 400, true, false],
  ['pois_chiches', 'Pois chiches', 'proteine', 140, 7.5, 20, 2.5, 6, 'egoutte', 1, '', 0, true, 1.5, 400, true, false],
  ['haricots_rouges', 'Haricots rouges', 'proteine', 120, 8, 17, 0.6, 6.5, 'egoutte', 1, '', 0, true, 1.4, 400, true, false],
  ['proteine_poudre', 'Protéine en poudre (à personnaliser)', 'proteine', 380, 78, 6, 5, 0, 'pret', 1, 'dose', 30, true, 29.9, 1000, false, false],

  // --------------------------------------------------------------- féculents
  ['pates_completes', 'Pâtes complètes', 'feculent', 340, 13, 62, 2.5, 8, 'cru', 2.4, '', 0, true, 1.9, 500, true, true],
  ['pates', 'Pâtes', 'feculent', 355, 12, 71, 1.5, 3, 'cru', 2.4, '', 0, true, 1.4, 500, true, false],
  ['riz_basmati', 'Riz basmati', 'feculent', 350, 8, 77, 1, 1.5, 'cru', 2.6, '', 0, true, 2.6, 1000, true, true],
  ['riz_complet', 'Riz complet', 'feculent', 345, 8, 72, 2.5, 3.5, 'cru', 2.6, '', 0, true, 2.9, 1000, true, false],
  ['ble_precuit', 'Blé précuit (type Ebly)', 'feculent', 345, 12, 69, 1.5, 4, 'cru', 2.4, '', 0, true, 2.7, 500, true, false],
  ['boulgour', 'Boulgour', 'feculent', 345, 12, 66, 1.5, 6, 'cru', 2.8, '', 0, true, 2.4, 500, true, false],
  ['semoule', 'Semoule de blé', 'feculent', 355, 12, 72, 1, 4, 'cru', 2.7, '', 0, true, 1.8, 500, true, false],
  ['pdt', 'Pommes de terre', 'feculent', 80, 2, 17, 0.2, 2, 'cru', 0.95, '', 0, true, 2.4, 2000, true, false],
  ['patate_douce', 'Patate douce', 'feculent', 86, 1.6, 18, 0.1, 3, 'cru', 0.95, '', 0, true, 3.2, 1000, true, false],
  ['pain_complet', 'Pain complet', 'feculent', 245, 9, 43, 2, 6, 'pret', 1, 'tranche', 40, false, 1.9, 400, false, false],
  ['pain_mie_complet', 'Pain de mie complet', 'feculent', 250, 9.5, 40, 4, 6, 'pret', 1, 'tranche', 33, false, 2.1, 500, false, false],
  ['wrap', 'Tortilla / wrap froment', 'feculent', 300, 8, 50, 7, 3, 'pret', 1, 'wrap', 62, false, 2.2, 370, false, false],
  ['wasa_seigle', 'Pain croustillant de seigle', 'feculent', 335, 10, 60, 1.5, 16, 'pret', 1, 'tranche', 11, false, 1.8, 275, false, true],
  ['flocons_avoine', 'Flocons d’avoine', 'feculent', 370, 13, 59, 7, 9, 'pret', 1, '', 0, true, 2.2, 1000, false, true],
  ['gnocchis', 'Gnocchis à poêler', 'feculent', 180, 4, 36, 1.5, 2, 'pret', 1, '', 0, true, 1.9, 400, false, false],
  ['galette_sarrasin', 'Galette de sarrasin', 'feculent', 185, 5, 33, 3.5, 3, 'pret', 1, 'galette', 60, false, 2.4, 360, false, false],

  // ----------------------------------------------------------------- légumes
  ['haricots_verts', 'Haricots verts', 'legume', 30, 1.8, 3.5, 0.2, 3.5, 'egoutte', 1, '', 0, true, 1.6, 800, true, true],
  ['brocolis', 'Brocolis', 'legume', 34, 3, 3, 0.4, 3, 'cru', 0.9, '', 0, true, 2.3, 750, true, false],
  ['courgettes', 'Courgettes', 'legume', 20, 1.4, 2.5, 0.3, 1.2, 'cru', 0.75, '', 0, true, 2.1, 1000, true, false],
  ['poivrons', 'Poivrons', 'legume', 28, 1, 5, 0.3, 2, 'cru', 0.8, '', 0, true, 2.6, 500, true, false],
  ['carottes', 'Carottes', 'legume', 36, 0.9, 7, 0.2, 2.8, 'cru', 0.9, '', 0, true, 1.5, 1000, true, false],
  ['epinards', 'Épinards', 'legume', 25, 3, 1, 0.4, 2.5, 'cuit', 1, '', 0, true, 2.2, 750, true, false],
  ['champignons', 'Champignons de Paris', 'legume', 22, 3, 1, 0.3, 2, 'cru', 0.7, '', 0, true, 2.4, 500, true, false],
  ['tomates_concassees', 'Tomates concassées', 'legume', 30, 1.3, 4.5, 0.2, 1.5, 'pret', 1, 'boîte', 400, true, 1.1, 400, true, false],
  ['chou_fleur', 'Chou-fleur', 'legume', 26, 2.2, 2.5, 0.3, 2.5, 'cru', 0.9, '', 0, true, 2.4, 750, true, false],
  ['ratatouille', 'Mélange ratatouille', 'legume', 32, 1.2, 4, 0.5, 2, 'cru', 0.8, '', 0, true, 2.6, 1000, true, false],
  ['petits_pois', 'Petits pois', 'legume', 78, 5.5, 9.5, 0.5, 5.5, 'egoutte', 1, '', 0, true, 1.7, 800, true, false],
  ['poireaux', 'Poireaux', 'legume', 30, 1.5, 4, 0.3, 2.5, 'cru', 0.8, '', 0, true, 2.3, 1000, true, false],
  ['aubergines', 'Aubergines', 'legume', 25, 1, 3, 0.4, 2.5, 'cru', 0.75, '', 0, true, 2.8, 1000, true, false],
  ['oignon', 'Oignon', 'legume', 40, 1.2, 7, 0.2, 1.7, 'cru', 0.8, 'oignon', 110, true, 1.8, 1000, true, false],
  ['salade', 'Salade verte', 'legume', 15, 1.2, 1.5, 0.2, 1.5, 'pret', 1, '', 0, true, 1.2, 150, false, false],
  ['mais', 'Maïs doux', 'legume', 95, 3, 16, 1.2, 3, 'egoutte', 1, '', 0, true, 1.3, 285, true, false],

  // ------------------------------------------------------------------ fruits
  ['banane', 'Banane', 'fruit', 90, 1.1, 20, 0.3, 2.6, 'pret', 1, 'banane', 120, true, 1.9, 1000, false, true],
  ['pomme', 'Pomme', 'fruit', 52, 0.3, 12, 0.2, 2.4, 'pret', 1, 'pomme', 150, true, 2.5, 1000, false, false],
  ['fruits_rouges', 'Fruits rouges surgelés', 'fruit', 45, 1, 7.5, 0.3, 4, 'pret', 1, '', 0, true, 3.9, 450, false, true],
  ['ananas', 'Ananas', 'fruit', 50, 0.5, 11, 0.2, 1.4, 'pret', 1, '', 0, true, 2.5, 500, false, false],
  ['orange', 'Orange', 'fruit', 47, 0.9, 9, 0.2, 2.4, 'pret', 1, 'orange', 180, true, 2.2, 1000, false, false],
  ['kiwi', 'Kiwi', 'fruit', 58, 1.1, 11, 0.5, 3, 'pret', 1, 'kiwi', 90, true, 2.8, 500, false, false],
  ['compote_ssa', 'Compote sans sucres ajoutés', 'fruit', 48, 0.4, 10.5, 0.2, 1.5, 'pret', 1, 'pot', 100, false, 2.4, 400, false, true],
  ['raisins_secs', 'Raisins secs', 'fruit', 300, 3, 65, 0.5, 4, 'pret', 1, '', 0, true, 2.6, 250, false, false],
  ['dattes', 'Dattes dénoyautées', 'fruit', 285, 2, 65, 0.5, 7, 'pret', 1, 'datte', 8, false, 3.4, 250, false, false],

  // ---------------------------------------------------------- produits laitiers
  ['skyr', 'Skyr nature', 'laitier', 63, 11, 4, 0.2, 0, 'pret', 1, 'pot', 150, true, 2.2, 450, false, true],
  ['fromage_blanc0', 'Fromage blanc 0 %', 'laitier', 47, 8, 4, 0.2, 0, 'pret', 1, '', 0, true, 1.7, 500, false, false],
  ['yaourt_nature', 'Yaourt nature', 'laitier', 60, 4, 5, 3, 0, 'pret', 1, 'pot', 125, false, 1.9, 1000, false, false],
  ['lait_demi', 'Lait demi-écrémé', 'laitier', 46, 3.2, 4.8, 1.6, 0, 'pret', 1, '', 0, true, 1.1, 1000, false, true],
  ['fromage_tartinable', 'Fromage frais tartinable (type ail & fines herbes)', 'laitier', 210, 7, 3.5, 19, 0, 'pret', 1, '', 0, true, 2.5, 150, false, true],
  ['mozzarella', 'Mozzarella', 'laitier', 250, 18, 1.5, 19, 0, 'pret', 1, 'boule', 125, true, 1.3, 125, false, false],
  ['emmental_rape', 'Emmental râpé', 'laitier', 370, 27, 1, 29, 0, 'pret', 1, '', 0, true, 2.6, 200, false, false],
  ['parmesan', 'Parmesan râpé', 'laitier', 400, 33, 1, 29, 0, 'pret', 1, '', 0, true, 3.4, 100, false, false],
  ['feta', 'Feta', 'laitier', 270, 15, 1.5, 22, 0, 'pret', 1, '', 0, true, 2.6, 200, false, false],
  ['cottage', 'Cottage cheese', 'laitier', 98, 12, 3.5, 4, 0, 'pret', 1, '', 0, true, 2.3, 300, false, false],

  // ------------------------------------------------------------ matières grasses
  ['huile_olive', 'Huile d’olive', 'matiere_grasse', 900, 0, 0, 100, 0, 'pret', 1, 'c. à soupe', 10, true, 7.5, 1000, false, true],
  ['huile_colza', 'Huile de colza', 'matiere_grasse', 900, 0, 0, 100, 0, 'pret', 1, 'c. à soupe', 10, true, 4.2, 1000, false, false],
  ['beurre', 'Beurre', 'matiere_grasse', 750, 0.7, 0.6, 82, 0, 'pret', 1, '', 0, true, 2.6, 250, false, false],
  ['creme_15', 'Crème légère 15 %', 'matiere_grasse', 165, 3, 4, 15, 0, 'pret', 1, '', 0, true, 1.5, 200, false, false],
  ['beurre_cacahuete', 'Beurre de cacahuète', 'matiere_grasse', 600, 25, 12, 50, 6, 'pret', 1, 'c. à soupe', 15, true, 4.5, 350, false, false],
  ['puree_amande', 'Purée d’amande', 'matiere_grasse', 630, 21, 8, 56, 8, 'pret', 1, 'c. à soupe', 15, true, 7.9, 300, false, false],

  // ---------------------------------------------------------------- oléagineux
  ['amandes', 'Amandes', 'oleagineux', 600, 21, 7, 52, 12, 'pret', 1, '', 0, true, 4.5, 250, false, false],
  ['cajou', 'Noix de cajou', 'oleagineux', 580, 18, 27, 44, 3, 'pret', 1, '', 0, true, 4.2, 250, false, false],
  ['noix', 'Noix', 'oleagineux', 690, 15, 5, 65, 6, 'pret', 1, '', 0, true, 4.8, 250, false, false],
  ['noisettes', 'Noisettes', 'oleagineux', 630, 15, 7, 61, 10, 'pret', 1, '', 0, true, 5.2, 250, false, false],
  ['graines_courge', 'Graines de courge', 'oleagineux', 560, 30, 11, 45, 6, 'pret', 1, '', 0, true, 3.6, 250, false, false],
  ['chia', 'Graines de chia', 'oleagineux', 490, 17, 4, 31, 34, 'pret', 1, 'c. à soupe', 12, true, 4.9, 300, false, false],

  // --------------------------------------------------------------------- autres
  ['sauce_tomate', 'Sauce tomate nature', 'autre', 55, 1.5, 8, 1.5, 1.5, 'pret', 1, '', 0, true, 1.4, 400, true, false],
  ['sauce_soja', 'Sauce soja', 'autre', 60, 6, 5, 0.1, 0, 'pret', 1, 'c. à soupe', 15, true, 2.3, 250, false, false],
  ['moutarde', 'Moutarde', 'autre', 150, 7, 5, 11, 0, 'pret', 1, 'c. à café', 8, true, 1.3, 200, false, false],
  ['chocolat_noir', 'Chocolat noir 70 %', 'autre', 580, 8, 33, 42, 10, 'pret', 1, 'carré', 10, false, 2.2, 100, false, false],
  ['miel', 'Miel', 'autre', 320, 0.4, 80, 0, 0, 'pret', 1, 'c. à café', 8, true, 5.9, 500, false, false],
  ['stevia', 'Édulcorant stévia', 'autre', 0, 0, 0, 0, 0, 'pret', 1, 'dose', 1, false, 4.5, 75, false, true],
  ['cacao', 'Cacao non sucré', 'autre', 350, 22, 12, 22, 28, 'pret', 1, 'c. à soupe', 6, true, 3.2, 250, false, false],
];

export function seedFoods() {
  return T.map((r) => ({
    id: `f_${r[0]}`,
    name: r[1],
    category: r[2],
    brand: '',
    kcal: r[3],
    protein: r[4],
    carbs: r[5],
    fat: r[6],
    fiber: r[7],
    referenceState: r[8],
    cookedFactor: r[9],
    unitName: r[10] || '',
    gramsPerUnit: r[11] || 0,
    fractionable: r[12],
    price: r[13] ?? null,
    packageWeight: r[14] ?? null,
    batchAllowed: r[15],
    favorite: r[16],
    lastUsed: null,
  }));
}
