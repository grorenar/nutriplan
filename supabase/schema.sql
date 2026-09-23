-- =====================================================================
-- Nutriplan — schéma PostgreSQL pour Supabase
-- À exécuter dans : Supabase > SQL Editor > New query > Run
--
-- Modèle : UN COMPTE SUPABASE = UN ESPACE DE DONNÉES.
-- Thomas et Julie partagent les mêmes identifiants, donc les mêmes données.
-- Chaque ligne appartient au compte qui l'a créée (user_id = auth.uid()) et
-- n'est lisible/modifiable que par lui : aucun autre utilisateur authentifié
-- ne peut voir ces données. Pas de workspace, pas de membres, pas de rôles.
-- =====================================================================

-- Si tu as déjà appliqué la version précédente de ce schéma (tables sans
-- colonne user_id), supprime-les d'abord — leurs données n'étaient pas encore
-- utilisées puisque la synchronisation n'avait jamais été configurée :
--
--   drop table if exists meal_items, breakfast_items, snack_items,
--     shopping_items, batch_items, meals, breakfast_options, snack_options,
--     targets, settings, foods cascade;
--
-- ---------------------------------------------------------------- tables

create table if not exists foods (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                text not null,
  name              text not null,
  category          text not null,
  brand             text,
  kcal_per_100g     numeric not null default 0,
  protein_per_100g  numeric not null default 0,
  carbs_per_100g    numeric not null default 0,
  fat_per_100g      numeric not null default 0,
  fiber_per_100g    numeric default 0,
  reference_state   text not null default 'pret',   -- cru | cuit | egoutte | pret
  cooked_factor     numeric default 1,              -- 100 g crus -> 100 × facteur g cuits
  unit_name         text,
  grams_per_unit    numeric default 0,
  fractionable      boolean default true,
  price             numeric,
  package_weight    numeric,
  batch_allowed     boolean default false,
  shelf_life_days   numeric,                          -- conservation après préparation (null = non renseignée)
  requires_cooking  boolean default false,            -- propriété explicite, indépendante de reference_state
  favorite          boolean default false,
  last_used         timestamptz,
  unit_entry        boolean default false,          -- saisie des quantités en unités
  cooking_method    text,                           -- four, poêle, vapeur… (libre)
  cooking_temp      numeric,
  cooking_time      numeric,                        -- minutes
  prep_time         numeric,                        -- minutes
  equipment         text,
  instructions      text,                           -- consignes libres, reprises dans le plan de batch
  primary key (user_id, id)
);

-- ---------------------------------------------------------------------
-- Recettes/préparations (étape 5) — voir "SPÉCIFICATION D'ARCHITECTURE
-- FINALE" du même échange. Additif, aucune table existante modifiée.
-- Les macros d'une recette/préparation ne sont JAMAIS stockées : toujours
-- recalculées depuis recipe_items / preparations.recipe_snapshot.
-- ---------------------------------------------------------------------
create table if not exists recipes (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                text not null,
  name              text not null,
  kind              text not null default 'weight',     -- 'weight' | 'portion'
  base_grams        numeric,                             -- requis si kind = 'weight' ; poids RÉEL après cuisson de la composition de référence
  batch_allowed     boolean default false,
  shelf_life_days   numeric,
  cooking_method    text,
  cooking_temp      numeric,
  cooking_time      numeric,
  prep_time         numeric,
  equipment         text,
  instructions      text,
  primary key (user_id, id),
  check (kind in ('weight', 'portion'))
);

create table if not exists recipe_items (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                text not null,           -- "<recipe_id>:<food_id>" ou uid dédié
  recipe_id         text not null,
  food_id           text not null,
  quantity          numeric not null default 0,   -- grammes (base_grams si weight, 1 portion si portion)
  reference_state   text,
  primary key (user_id, id),
  foreign key (user_id, recipe_id) references recipes(user_id, id) on delete cascade
);
create index if not exists recipe_items_recipe_idx on recipe_items (user_id, recipe_id);

-- Une préparation est un événement RÉEL (quantité effectivement obtenue,
-- jamais recalculée) : recipe_snapshot fige la composition au moment de sa
-- création — modifier la recette source ensuite ne change JAMAIS une
-- préparation déjà créée. "on delete restrict" (pas cascade) : supprimer une
-- recette qui a des préparations existantes est refusé, pour ne jamais
-- perdre silencieusement leur historique.
create table if not exists preparations (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                text not null,
  recipe_id         text not null,
  label             text,
  prepared_quantity numeric not null default 0,
  created_at        timestamptz not null default now(),
  recipe_snapshot   jsonb not null,          -- copie figée de { kind, base_grams, items } au moment de la création
  primary key (user_id, id),
  foreign key (user_id, recipe_id) references recipes(user_id, id) on delete restrict
);
create index if not exists preparations_recipe_idx on preparations (user_id, recipe_id);

create table if not exists targets (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null,                          -- "thomas:lunch"
  person     text not null,                          -- thomas | julie
  meal_type  text not null,                          -- day | breakfast | lunch | snack_afternoon | dinner | snack_evening
  kcal       numeric not null default 0,
  protein    numeric not null default 0,
  carbs      numeric not null default 0,
  fat        numeric not null default 0,
  primary key (user_id, id)
);

create table if not exists settings (
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                   text not null default 'main',
  budget               numeric not null default 100,
  batch_duration       int not null default 3,
  batch_enabled        boolean not null default true,
  cycle_start_weekday  int not null default 1,       -- 0 = lundi
  cycle_duration       int not null default 4,
  tolerance            numeric not null default 0.05,
  auto_adjust          boolean not null default true,
  updated_at           timestamptz not null default now(),
  primary key (user_id, id)
);

-- Le cycle courant n'est pas historisé : un seul cycle vit à la fois.
create table if not exists meals (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                text not null,
  day_index         int not null,
  meal_type         text not null,                   -- lunch | dinner
  name              text,
  same_composition  boolean not null default true,
  -- nom généré automatiquement depuis la composition (P2.4) vs saisi par
  -- l'utilisateur : pilote la régénération, jamais l'inverse (cf. migration
  -- ci-dessous, qui protège les noms déjà saisis).
  name_auto         boolean not null default true,
  primary key (user_id, id)
);

create table if not exists meal_items (
  user_id                   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                        text not null,           -- "<item_id>:<person>"
  item_id                   text not null,
  meal_id                   text not null,
  food_id                   text,                    -- null pour un ingrédient libre
  free_ingredient_name      text,
  free_ingredient_quantity  text,
  person                    text not null,
  quantity_g                numeric not null default 0,
  locked                    boolean not null default false,
  reference_state           text,
  primary key (user_id, id),
  foreign key (user_id, meal_id) references meals(user_id, id) on delete cascade
);
create index if not exists meal_items_meal_idx on meal_items (user_id, meal_id);

create table if not exists breakfast_options (
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                text not null,
  name              text,
  same_composition  boolean not null default true,
  -- utilisations dans le cycle en cours, par personne (0 = non utilisée, donc hors courses)
  uses_thomas       int not null default 0,
  uses_julie        int not null default 0,
  primary key (user_id, id)
);

create table if not exists breakfast_items (
  user_id                   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                        text not null,
  item_id                   text not null,
  option_id                 text not null,
  food_id                   text,
  free_ingredient_name      text,
  free_ingredient_quantity  text,
  person                    text not null,
  quantity_g                numeric not null default 0,
  locked                    boolean not null default false,
  reference_state           text,
  primary key (user_id, id),
  foreign key (user_id, option_id) references breakfast_options(user_id, id) on delete cascade
);
create index if not exists breakfast_items_option_idx on breakfast_items (user_id, option_id);

-- Catalogue UNIQUE de collations : 16 h et soir ne sont que des affectations
-- de consommation dans le cycle, pas deux compositions différentes.
create table if not exists snack_options (
  user_id                uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                     text not null,
  type                   text not null default 'snack',
  name                   text,
  same_composition       boolean not null default true,
  target_slot            text not null default 'afternoon', -- objectif de référence : afternoon | evening
  uses_thomas_afternoon  int not null default 0,
  uses_thomas_evening    int not null default 0,
  uses_julie_afternoon   int not null default 0,
  uses_julie_evening     int not null default 0,
  primary key (user_id, id)
);

create table if not exists snack_items (
  user_id                   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                        text not null,
  item_id                   text not null,
  option_id                 text not null,
  food_id                   text,
  free_ingredient_name      text,
  free_ingredient_quantity  text,
  person                    text not null,
  quantity_g                numeric not null default 0,
  locked                    boolean not null default false,
  reference_state           text,
  primary key (user_id, id),
  foreign key (user_id, option_id) references snack_options(user_id, id) on delete cascade
);
create index if not exists snack_items_option_idx on snack_items (user_id, option_id);

-- Uniquement la case "acheté" : aucune gestion de stock.
create table if not exists shopping_items (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null,
  food_id    text not null,
  purchased  boolean not null default false,
  primary key (user_id, id)
);

-- Quantités de batch modifiées manuellement (surplus volontaire).
create table if not exists batch_items (
  user_id              uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id                   text not null,
  preparation_session  int not null,
  food_id              text not null,
  preparation_quantity numeric not null default 0,
  primary key (user_id, id)
);

-- ---------------------------------------------------------------- montées de version
-- Colonnes ajoutées après coup : le script reste rejouable sans perte de données.
alter table foods add column if not exists unit_entry boolean default false;
alter table foods add column if not exists cooking_method text;
alter table foods add column if not exists cooking_temp numeric;
alter table foods add column if not exists cooking_time numeric;
alter table foods add column if not exists prep_time numeric;
alter table foods add column if not exists equipment text;
alter table foods add column if not exists instructions text;
alter table foods add column if not exists last_used timestamptz;
alter table foods add column if not exists shelf_life_days numeric;
-- « Nécessite une cuisson » : propriété explicite ajoutée en V1.3.
-- La colonne est ajoutée SANS valeur par défaut, pour qu'une ligne antérieure
-- se distingue (NULL = jamais renseignée) d'une ligne où l'utilisateur a
-- délibérément coché « non » (false).
alter table foods add column if not exists requires_cooking boolean;

-- Reprise UNE SEULE FOIS de l'ancien classement V1.2, pour les seules lignes
-- jamais renseignées. Rejouable : au second passage il n'y a plus de NULL,
-- donc plus rien à reprendre, et aucune valeur existante n'est recalculée.
update foods
   set requires_cooking = (coalesce(cooking_method, '') <> '' or reference_state = 'cru')
 where requires_cooking is null;

-- À partir d'ici, la valeur est persistée et pilotée par la fiche aliment.
alter table foods alter column requires_cooking set default false;
alter table breakfast_options add column if not exists uses_thomas int not null default 0;
alter table breakfast_options add column if not exists uses_julie int not null default 0;
alter table snack_options add column if not exists target_slot text not null default 'afternoon';
alter table snack_options add column if not exists uses_thomas_afternoon int not null default 0;
alter table snack_options add column if not exists uses_thomas_evening int not null default 0;
alter table snack_options add column if not exists uses_julie_afternoon int not null default 0;
alter table snack_options add column if not exists uses_julie_evening int not null default 0;
alter table snack_options alter column type set default 'snack';

-- Auto-nommage des repas (P2.4) : la colonne est ajoutée avec DEFAULT true
-- (obligatoire pour satisfaire NOT NULL sur les lignes déjà existantes), puis
-- immédiatement corrigée pour toute ligne qui portait déjà un nom saisi par
-- l'utilisateur — jamais l'inverse, sous peine d'écraser silencieusement un
-- nom réel au premier recalcul de repas (ex. « Repas post-entraînement »).
-- Rejouable : au second passage il n'y a plus de ligne nommée avec
-- name_auto = true, donc plus rien à corriger.
alter table meals add column if not exists name_auto boolean not null default true;
update meals set name_auto = false where name is not null and name <> '';

-- Recettes/préparations (étape 5) : un item peut désormais référencer une
-- recette (mode "molle", calcul inverse) ou une préparation (utilisation
-- ferme, tire sur son stock) au lieu d'un aliment.
--
-- IMPORTANT : ces colonnes sont volontairement NULLABLES, DEFAULT compris.
-- nutriplan_replace_all() insère via jsonb_populate_record() à partir du
-- payload JSON envoyé par le client ; pour une clé absente du JSON (un ancien
-- item local, jamais réécrit — décision verrouillée : "ne pas convertir
-- activement les anciennes données"), jsonb_populate_record() insère NULL et
-- N'APPLIQUE PAS le DEFAULT de la colonne. Une contrainte NOT NULL ferait donc
-- échouer la synchronisation de tout item existant. 'plat' reste le défaut
-- pour une ligne insérée directement en SQL (hors de ce chemin JSON) ; côté
-- application, l'absence de section est déjà interprétée comme 'plat' à la
-- lecture (store.js::sectionsUsed/itemLabel) — la même convention s'applique
-- ici : NULL == 'plat', jamais recalculé ni réécrit.
alter table meal_items add column if not exists section text default 'plat';
alter table meal_items add column if not exists recipe_id text;
alter table meal_items add column if not exists preparation_id text;
alter table meal_items add column if not exists zero_waste boolean default false;

alter table breakfast_items add column if not exists section text default 'plat';
alter table breakfast_items add column if not exists recipe_id text;
alter table breakfast_items add column if not exists preparation_id text;
alter table breakfast_items add column if not exists zero_waste boolean default false;

alter table snack_items add column if not exists section text default 'plat';
alter table snack_items add column if not exists recipe_id text;
alter table snack_items add column if not exists preparation_id text;
alter table snack_items add column if not exists zero_waste boolean default false;

-- PostgreSQL ne propose pas "add constraint if not exists" : on supprime puis
-- recrée (comme les policies RLS plus bas), pour que le script reste rejouable.
do $$
begin
  alter table meal_items drop constraint if exists meal_items_one_ref;
  alter table meal_items add constraint meal_items_one_ref
    check (num_nonnulls(food_id, recipe_id, preparation_id, free_ingredient_name) <= 1);
  alter table breakfast_items drop constraint if exists breakfast_items_one_ref;
  alter table breakfast_items add constraint breakfast_items_one_ref
    check (num_nonnulls(food_id, recipe_id, preparation_id, free_ingredient_name) <= 1);
  alter table snack_items drop constraint if exists snack_items_one_ref;
  alter table snack_items add constraint snack_items_one_ref
    check (num_nonnulls(food_id, recipe_id, preparation_id, free_ingredient_name) <= 1);
end $$;

-- ---------------------------------------------------------------------
-- Sécurité : chaque compte ne voit QUE ses propres lignes.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'foods','recipes','recipe_items','preparations','targets','settings','meals','meal_items',
    'breakfast_options','breakfast_items','snack_options','snack_items',
    'shopping_items','batch_items'
  ] loop
    execute format('alter table %I enable row level security', t);
    -- policy trop permissive de la v1 : retirée si elle existe encore
    execute format('drop policy if exists "authenticated_all" on %I', t);
    execute format('drop policy if exists "own_rows" on %I', t);
    execute format(
      'create policy "own_rows" on %I for all to authenticated
         using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Écriture ATOMIQUE de l'état complet.
--
-- Le client envoie un seul objet JSON contenant toutes les tables.
-- La fonction s'exécute dans UNE transaction : si une seule insertion échoue,
-- PostgreSQL annule l'intégralité de l'opération et la base reste dans son
-- état précédent — jamais à moitié vide.
--
-- security invoker : les policies RLS ci-dessus s'appliquent normalement.
-- La fonction renvoie le nombre de lignes écrites par table : le client ne
-- considère la synchronisation réussie qu'après avoir vérifié ces compteurs.
-- ---------------------------------------------------------------------
create or replace function nutriplan_replace_all(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid    uuid := auth.uid();
  t      text;
  n      int;
  counts jsonb := '{}'::jsonb;
  -- ordre parents -> enfants (les suppressions se font en sens inverse) :
  -- recipes avant recipe_items/preparations (FK), preparations avant recipes
  -- à la SUPPRESSION (ordre inverse de ce tableau) pour respecter le
  -- "on delete restrict" plutôt que d'échouer dessus.
  tables text[] := array[
    'foods','recipes','recipe_items','preparations','targets','settings','meals','meal_items',
    'breakfast_options','breakfast_items','snack_options','snack_items',
    'shopping_items','batch_items'
  ];
begin
  if uid is null then
    raise exception 'nutriplan: utilisateur non authentifié';
  end if;

  for i in reverse array_length(tables, 1) .. 1 loop
    execute format('delete from %I where user_id = $1', tables[i]) using uid;
  end loop;

  foreach t in array tables loop
    execute format(
      'insert into %I select (jsonb_populate_record(null::%I,
          e || jsonb_build_object(''user_id'', $2))).*
       from jsonb_array_elements(coalesce($1 -> %L, ''[]''::jsonb)) e',
      t, t, t)
    using payload, to_jsonb(uid);
    get diagnostics n = row_count;
    counts := counts || jsonb_build_object(t, n);
  end loop;

  return counts;
end
$$;

grant execute on function nutriplan_replace_all(jsonb) to authenticated;
