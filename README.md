# Nutriplan — Thomas & Julie

Application web de planification nutritionnelle et de batch cooking pour deux personnes.
Frontend statique (HTML / CSS / JavaScript modules, aucune dépendance de build), données locales
avec synchronisation Supabase optionnelle.

---

## 1. Architecture

```
index.html                point d'entrée unique
css/app.css               interface
css/print.css             impression A4 (#print uniquement)
js/config.js              ← les 2 clés Supabase à renseigner
js/app.js                 coquille : navigation, rendu de la vue active, cycle de sync
js/core/util.js           formatage, helpers
js/core/nutrition.js      MOTEUR : macros, conversions cru/cuit, ajustement automatique
js/core/meal-volume.js    analyse du volume d'un repas — couche informative, séparée du moteur
js/core/seed-foods.js     banque alimentaire initiale (~95 aliments génériques)
js/core/store.js          état applicatif, localStorage, export/import
js/core/derive.js         batch cooking, liste de courses, budget, suggestions
js/core/similarity.js     détection d'aliments similaires (avertissement uniquement)
js/core/sync.js           Supabase : auth + envoi/récupération atomiques
js/views/*.js             une vue par écran + l'éditeur de repas partagé
supabase/schema.sql       schéma PostgreSQL + RLS par compte + fonction transactionnelle
tests/engine.test.mjs     moteur nutritionnel, batch, courses (aucune dépendance)
tests/volume.test.mjs     analyse du volume d'un repas (aucune dépendance)
tests/sync.test.mjs       schéma + transaction + RLS, sur un PostgreSQL local
tests/autosync.test.mjs   synchronisation automatique (client Supabase simulé)
tests/ui.test.mjs         parcours complet de l'interface (jsdom)
```

Séparation stricte : `core/nutrition.js` et `core/derive.js` ne touchent jamais au DOM et ne
connaissent ni le stockage ni le réseau. Ce sont des fonctions pures, directement testables.

## 2. Modèle de données

État applicatif (et fichier d'export JSON) :

```
foods[]            id, name, category, brand, kcal, protein, carbs, fat, fiber,
                   referenceState, cookedFactor, unitName, gramsPerUnit, fractionable,
                   unitEntry, price, packageWeight, batchAllowed, shelfLifeDays,
                   requiresCooking, favorite,
                   cookingMethod, cookingTemp, cookingTime, prepTime, equipment, instructions
settings           targets{thomas|julie}{day|breakfast|lunch|snack_afternoon|dinner|snack_evening}
                   tolerance, cycle{startWeekday,duration}, budget, batch{enabled,maxDays}, autoAdjust
meals[]            id, dayIndex, mealType(lunch|dinner), name, sameComposition, items[]
breakfasts[]       id, name, sameComposition, uses{thomas,julie}, items[]
snacks[]           id, name, sameComposition, targetSlot, items[],
                   uses{thomas:{afternoon,evening}, julie:{afternoon,evening}}
coverage.forced    {breakfast|snack_afternoon|snack_evening: bool}  écarts assumés
items[]            id, foodId|null, free{name,quantity}|null, state,
                   qty{thomas,julie}, locked{thomas,julie}
shopping.purchased {foodId: bool}        ← simple case "acheté", aucun stock
batch.overrides    {"session:foodId": grammes préparés}
```

Côté PostgreSQL, la même chose est normalisée dans `supabase/schema.sql`
(`foods`, `targets`, `settings`, `meals`, `meal_items`, `breakfast_options`, `breakfast_items`,
`snack_options`, `snack_items`, `shopping_items`, `batch_items`). Un ingrédient donne une ligne
par personne (colonne `person`), conformément au schéma demandé.

Toutes les valeurs nutritionnelles sont stockées **pour 100 g**, dans l'état de référence de
l'aliment. Tous les calculs internes sont en grammes.

## 3. Logique de calcul et d'ajustement

**États.** Chaque aliment déclare l'**état des valeurs nutritionnelles** saisies pour 100 g
(cru / brut, cuit, égoutté, prêt à consommer). Dans un repas, chaque ingrédient déclare l'état
réellement pesé, affiché à côté de la quantité. Quand les deux diffèrent, la conversion utilise le
rendement après cuisson (200 g cuits ÷ 2,50 = 80 g crus). Aucun coefficient n'est inventé pour les
états « égoutté » et « prêt à consommer » ni quand le rendement n'est pas renseigné : dans ce cas
les macros de l'ingrédient ne sont pas calculées (« — kcal · — P · — G · — L »), il est exclu du
total du repas, et l'éditeur affiche « Conversion impossible » avec la marche à suivre. Deux états
différents ne sont jamais supposés équivalents.

**Macros.** Les grammes saisis sont d'abord ramenés à l'état de référence de l'aliment
(coefficient `cookedFactor`, ex. pâtes 100 g crus → 240 g cuits), puis multipliés par les valeurs
pour 100 g. La cuisson change le poids, jamais les macros.

**Ajustement continu — architecture C (V1.4).** À chaque ajout, suppression, changement de
quantité, d'état ou de verrou, `adjustQuantities()` est relancé pour chaque personne. Il n'y a plus
d'ancrage sur la quantité de départ (mécanisme `anchor` de V1.3, supprimé : il créait un point fixe
mathématique où un légume fortement ancré ne bougeait quasiment jamais). Chaque aliment déverrouillé
a désormais une **référence de portion**, un point de départ pour des proportions réalistes —
**jamais une cible nutritionnelle** :

```
réf = clamp( √(réf_cat × E_cat × 100 / densité) , réf_cat/3 , réf_cat×3 )
```

`réf_cat` est la portion type de la catégorie (`def` dans `CATEGORY_PROFILE`, déjà existante),
`E_cat` l'énergie type d'une portion de cette catégorie (nouveau), `densité` les kcal pour 100 g de
l'aliment dans son état de référence. C'est la moyenne géométrique entre une référence en masse
(chaque aliment de la catégorie : même poids) et une référence iso-énergétique (chaque aliment :
même apport calorique) — elle seule distingue correctement un aliment dense (avocat) d'un aliment
peu dense (courgette) de la même catégorie, sans traiter aucune catégorie comme un cas particulier.
Le clamp ne borne que les densités extrêmes (whey, huile).

Le coût minimisé, par personne :

```
coût = Σ_macro  W · ρ_C( (valeur − cible) / cible )  +  β · [ Σᵢ (uᵢ − ū)²  +  γ · n · ū² ]

  W : kcal 0,35 · P 1,4 · C 1 · L 1
  ρ_C(d) = C · (1 − exp(−d²/2C))     perte bornée (Welsch), C = 0,08
  uᵢ = ln(qᵢ / réfᵢ)                 β = 0,006 · γ = 3
```

Le premier terme rapproche les 4 macros de leurs cibles avec une perte **bornée** : au-delà d'un
certain écart, elle « accepte » de manquer la cible plutôt que de produire une composition absurde
(essayé avec une perte de Huber : elle envoie une macro structurellement inatteignable à sa borne
maximale, car son gradient ne décroît jamais). Le second terme est une **pénalité de disproportion**,
fondée sur des variations relatives aux références (jamais des grammes bruts) : elle pénalise un
aliment qui s'écarte des autres (dispersion) et un repas globalement gonflé ou rétréci (échelle) —
jamais une interdiction absolue.

**Minimisation.** Descente par coordonnées en espace logarithmique ; chaque coordonnée est résolue
par une grille de 48 points puis une recherche en section dorée autour de chaque vallée détectée (le
coût 1D n'est pas garanti unimodal — mesuré). Multi-départ (quantité actuelle, référence, quantité
mise à l'échelle du besoin calorique) : le résultat de coût le plus bas est retenu.

La quantité finale est arrondie : pas de la catégorie pour les aliments fractionnables, unités
entières pour les autres (jamais 1,37 œuf). Aucune logique de pas par aliment dans l'optimiseur —
`roundQuantity()` s'en charge seul, après coup.

**Unités.** Pour tout aliment non fractionnable possédant un poids par unité, la quantité stockée
est toujours un multiple entier de ce poids — que tu saisisses en unités (3 tranches) ou en grammes
(25 g deviennent 22 g pour une tranche de 11 g). La règle est générique et s'applique partout :
planning, petits-déjeuners, collations, ajustement automatique, batch, courses. Le bouton
« Saisie : … » sur la ligne d'ingrédient bascule entre unités et grammes ; les calculs internes
restent en grammes dans les deux cas. Les boutons + et − du champ utilisent le poids d'une unité
comme pas (13 → 26 → 39 → 52 pour une tranche de 13 g), jamais 1 g.

| Catégorie | Bornes | réf_cat (`def`) | E_cat |
|---|---|---|---|
| Protéine | 50–250 g | 150 | 164 |
| Féculent | 20–400 g | 90 | 266 |
| Légumineuse | 40–300 g | 150 | 207 |
| Légume | 60–320 g | 200 | 65 |
| Fruit | 30–260 g | 120 | 78 |
| Produit laitier | 40–500 g | 150 | 112 |
| Matière grasse | 2–45 g | 10 | 90 |
| Noix & graines (id `oleagineux`) | 5–80 g | 20 | 148 |
| Autre | 5–300 g | 60 | 100 |

Les catégories ne sont ni une classification nutritionnelle ni une taxonomie : elles ne donnent
qu'un ordre de grandeur de proportion réaliste dans un repas.

Garanties de l'algorithme :
- une quantité 🔒 verrouillée n'est **jamais** modifiée ;
- une quantité que tu viens de saisir est traitée comme fixe pendant le recalcul (« épinglée ») ;
- aucun aliment n'est jamais ajouté ni supprimé automatiquement ;
- aucun plafond de masse spécifique à une catégorie (la référence en joue déjà le rôle, en plus
  souple, car négociable contre la nutrition au lieu de l'interdire) ;
- si la cible est inatteignable, le repas est conservé tel quel, les écarts sont affichés et une
  piste est proposée (« manque protéine maigre… ») — rien n'est déformé pour atteindre les chiffres.

Le bouton **« Ajuster maintenant »** force un ajustement explicite même quand le réglage
« Ajustement automatique » est décoché — seul l'ajustement déclenché automatiquement (ajout,
saisie, duplication…) reste soumis à ce réglage.

**Tolérance.** ±5 % par défaut (modifiable). Vert = dans la cible, orange = proche, rouge = éloigné.

**Volume du repas (V1.4).** Un repas peut atteindre ses objectifs nutritionnels tout en
représentant une quantité de nourriture très importante à consommer en une seule fois. C'est un
problème **distinct** du problème nutritionnel : `js/core/meal-volume.js` est une couche
strictement séparée de l'optimiseur — purement informative, elle ne modifie jamais une quantité, une
macro, ni l'optimiseur, et ne bloque jamais la validation d'un repas. La supprimer (avec son import
dans l'éditeur) laisse le moteur nutritionnel strictement identique.

La masse d'assiette est la somme des ingrédients dans l'état **réellement présent dans l'assiette**
(pas la somme brute des quantités saisies, qui n'est pas une grandeur physique quand les états
diffèrent) : un ingrédient pesé cru contribue `quantité × cookedFactor`, un ingrédient déjà pesé
cuit / égoutté / prêt contribue sa quantité telle quelle. Un ingrédient pesé cru sans `cookedFactor`
renseigné n'invente aucun facteur : il est exclu du total, qui est alors signalé comme une
estimation partielle.

```
≤ 600 g              aucun avertissement
> 600 g et ≤ 750 g    « Repas volumineux »
> 750 g et ≤ 900 g    « Repas très volumineux »
> 900 g               « Repas extrêmement volumineux »
```

Ces seuils sont des constantes internes (pas de réglage utilisateur en V1.4). L'avertissement
n'apparaît que dans l'éditeur de repas, jamais dans le planning.

## 4. Écrans

| Écran | Contenu |
|---|---|
| Planning | cycle de N jours, déjeuner + dîner par jour, macros des deux personnes visibles sur chaque carte, duplication, bouton « Optimiser le cycle » (suggestions uniquement) |
| Aliments | banque complète, recherche, favoris, création/modification/suppression |
| Petits-déjeuners | catalogue indépendant, sans jour ni date ; compteur d'utilisations **par personne**, avec contrôle de couverture du cycle |
| Collations | **catalogue unique** : une collation a une composition unique, 16 h et Soir ne sont que des affectations de consommation (compteurs par personne et par créneau) |
| Batch cooking | classement fondé sur deux propriétés explicites de l'aliment — `batchAllowed` puis `requiresCooking`, jamais sur l'état de référence — et plan opératoire par session : **à préparer en batch** (méthode, température, durée, rendement, quantités crues et cuites, consignes), **à cuire le jour même**, **à assembler le jour même**, puis le détail de chaque gamelle personne par personne |
| Courses | tout le cycle (déjeuners, dîners et options de catalogue utilisées) : besoin vs quantité à acheter, surplus, prix, cases à cocher, budget ; les aliments sans prix sont listés par leur nom et cliquables pour ouvrir leur fiche |
| Paramètres | objectifs, cycle, budget, batch, export/import JSON, réinitialisation du cycle, compte |

Le bouton **Imprimer** (en haut à droite) permet de choisir les sections : planning, batch,
courses, détails nutritionnels, catalogues.

## 5. Mise en service

### 5.1 Fonctionnement immédiat (local, sans compte)

Ouvre `index.html` via un petit serveur statique (les modules ES ne se chargent pas en `file://`) :

```bash
python3 -m http.server 8080     # puis http://localhost:8080
```

Tout fonctionne : banque alimentaire, repas, batch, courses, impression, export/import JSON.
Les données sont dans le `localStorage` du navigateur.

### 5.2 GitHub Pages

1. Crée un dépôt et pousse le contenu de ce dossier à la racine.
2. Settings → Pages → Source : `Deploy from a branch`, branche `main`, dossier `/ (root)`.
3. L'application est servie sur `https://<utilisateur>.github.io/<dépôt>/`.

Aucune étape de build : ce sont des fichiers statiques.

### 5.3 Supabase (synchronisation entre appareils)

1. Crée un projet sur supabase.com.
2. SQL Editor → New query → colle **tout** `supabase/schema.sql` → Run.
   (Ce script crée aussi la fonction `nutriplan_replace_all`, indispensable à l'envoi.)
3. Authentication → Providers → Email : activé. (Pratique : désactive « Confirm email » pour
   créer le compte partagé sans validation.)
4. Project Settings → API : copie `Project URL` et la clé `anon public`.
5. Renseigne-les dans **`js/config.js`** :

```js
export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

6. Recharge l'application → Paramètres → Compte : crée le compte partagé, connecte-toi.
   Le premier envoi pousse ta base locale vers Supabase.

La clé `anon` est publique par nature : la sécurité vient de l'authentification et des policies
RLS. Chaque ligne porte un `user_id` (`auth.uid()` par défaut) et n'est lisible ou modifiable que
par le compte propriétaire — un autre utilisateur authentifié de ce projet Supabase ne voit rien.
Un compte Supabase = un espace de données ; Thomas et Julie partagent les identifiants, donc les
données. Aucune notion de workspace ou de membre.

**Envoi atomique.** L'état complet part en un seul appel à `nutriplan_replace_all(payload jsonb)`,
exécutée dans une transaction PostgreSQL : si une insertion échoue, tout est annulé et la base
reste dans son état précédent — jamais à moitié vide. La fonction renvoie le nombre de lignes
écrites par table ; l'envoi n'est considéré réussi qu'après vérification de ces compteurs côté
client. En cas d'échec, les données locales restent la référence, la mention « Échec de
synchronisation » s'affiche dans la barre latérale et les modifications restent en attente.

**Récupération automatique.** Au démarrage, au retour sur l'onglet et au retour de connexion,
l'application interroge `settings.updated_at` — une seule ligne, une seule colonne — et ne
télécharge la base que si cet horodatage a changé depuis la dernière fois que cet appareil l'a vue.
Une modification locale en attente part toujours **avant** toute récupération, donc elle ne peut
jamais être écrasée. « Récupérer du cloud » reste disponible comme forçage manuel, mais n'est plus
nécessaire en usage normal.

Avant de remplacer l'état local par celui du cloud, l'application en conserve
une copie : Paramètres → Compte → « Restaurer la sauvegarde locale » permet de revenir en arrière.

### 5.4 Hors ligne

Toute modification est écrite dans le `localStorage` immédiatement. Si le réseau est absent,
l'application continue de fonctionner et marque les données « à synchroniser » ; l'envoi repart
automatiquement au retour de la connexion (ou via Paramètres → Envoyer vers le cloud).
Comme Thomas et Julie n'utilisent jamais l'application en même temps, la synchronisation est un
remplacement complet : aucune gestion de conflit.

## 6. Catalogues et couverture du cycle

Les petits-déjeuners et les collations ne sont jamais rattachés à une date. On déclare seulement
combien de fois chaque option est utilisée dans le cycle, séparément pour Thomas et Julie — et,
pour les collations, séparément à 16 h et le soir. La même collation peut donc être consommée
3 fois à 16 h et 2 fois le soir sans avoir deux définitions.

L'application compare ces totaux au nombre théorique (un par jour de cycle et par personne) :

```
Thomas  6 / 6 ✓
Julie   5 / 6 ⚠️   il manque 1 option
Julie   7 / 6 ℹ️   1 option supplémentaire est planifiée
```

Rien n'est jamais choisi, ajouté ni corrigé automatiquement. Un bouton « Forcer quand même »
permet d'assumer un cycle volontairement incomplet ; l'avertissement reste affiché.

Les besoins sont ensuite calculés par personne avant agrégation — quantité de Thomas × ses
utilisations + quantité de Julie × les siennes — puis passent dans le système de courses existant
(conditionnements, surplus, prix, budget, case « acheté »). Une collation a un « objectif de
référence » (16 h ou Soir) qui sert uniquement de repère pour les macros et l'ajustement ±5 %.

## 7. Fiche aliment

« Nécessite une cuisson » est une case à cocher de la fiche, indépendante de l'état de référence :
un aliment cru peut se consommer tel quel, un aliment prêt à consommer peut demander une cuisson.
C'est elle, et elle seule, qui distingue « à cuire le jour même » de « à assembler le jour même »
lorsque l'aliment n'est pas batchable. Sur une base créée avant son introduction, la migration
SQL reprend une seule fois l'ancien classement pour les lignes jamais renseignées (colonne NULL),
puis n'y touche plus : rejouer `schema.sql` ne recalcule rien.

Chaque aliment porte ses propres paramètres de préparation : méthode de cuisson, température,
durée, temps de préparation, matériel, consignes libres, la durée maximale de conservation après
préparation (en jours, vide si inconnue) et le **rendement après cuisson**.

Le rendement est un coefficient : **poids cuit ÷ poids cru**. 2,00 signifie que 100 g crus donnent
200 g cuits ; 0,75 que 100 g crus donnent 75 g cuits. Il se saisit directement, ou se calcule via
« Calculer le rendement » : on entre un poids cru et un poids cuit réellement pesés, l'application
affiche le coefficient et l'équivalence pour 100 g, puis « Utiliser ce rendement » le reporte dans
la fiche. Les poids vides, négatifs, non numériques ou nuls sont refusés avec un message ; aucune
division par zéro n'est possible.

Quand la durée de conservation d'un composant est plus courte que la période couverte par une
session de batch, le plan affiche une alerte. Rien n'est retiré, le planning n'est pas modifié et
aucune solution n'est inventée. Le plan de batch reprend ces informations telles quelles — aucune méthode, aucune
association et aucune habitude alimentaire n'est codée dans l'application. Les valeurs livrées avec
la banque initiale sont des données par défaut, modifiables ou supprimables.

À la création d'un aliment, une **popup de confirmation bloquante** signale les produits déjà
présents qui lui ressemblent (nom proche, même marque, même poids par unité, valeurs voisines),
avec leurs macros pour 100 g face à celles de l'élément en cours de création : « Annuler » ne crée
rien, « Créer quand même » poursuit. C'est le seul mécanisme utilisé pour ce cas — aucun toast ni
message en bas de fenêtre en parallèle. Le même contrôle tourne après un import JSON et liste les doublons
possibles. Rien n'est jamais fusionné ni supprimé automatiquement.

## 8. Tests

```bash
node tests/engine.test.mjs    # moteur, batch, courses, unités, cru/cuit — sans dépendance
node tests/volume.test.mjs    # analyse du volume d'un repas — sans dépendance
npm i jsdom && node tests/ui.test.mjs   # parcours réel de l'interface
```

Le test de synchronisation vérifie le schéma, la transaction et les policies RLS sur un
PostgreSQL **local** (jamais sur ta base Supabase) : il crée une base jetable, émule `auth.uid()`
et applique `supabase/schema.sql`.

```bash
apt-get install -y postgresql && service postgresql start
node tests/sync.test.mjs
```

## 9. Sauvegarde

Paramètres → Données → **Exporter en JSON** produit un fichier complet (banque, objectifs,
planning, catalogues, paramètres). **Importer un JSON** le restaure intégralement.

## 10. Données livrées

La banque initiale contient des aliments courants avec des valeurs **génériques** : protéines,
féculents, légumineuses, légumes, fruits, produits laitiers, matières grasses, noix & graines, pains et wraps.
Elles ne prétendent correspondre à aucune marque. Pour un produit précis (whey, pain croustillant,
fromage tartinable, skyr d'une marque donnée…), crée l'aliment et recopie les valeurs de
l'emballage. Les prix et conditionnements sont eux aussi indicatifs et modifiables.

Aucune habitude alimentaire n'est codée en dur : aucune association obligatoire, aucun aliment
imposé. L'application fournit les outils, tu construis les repas.
