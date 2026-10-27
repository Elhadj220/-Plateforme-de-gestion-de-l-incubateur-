-- =====================================================================
-- Incub'ISEP - Plateforme de gestion de l'incubateur du CIAT
-- Schéma de la base de données (SQLite)
-- =====================================================================

PRAGMA foreign_keys = ON;

-- Comptes utilisateurs (tous profils)
CREATE TABLE IF NOT EXISTS utilisateurs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prenom          TEXT    NOT NULL,
  nom             TEXT    NOT NULL,
  email           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  mot_de_passe    TEXT    NOT NULL,                       -- empreinte bcrypt
  role            TEXT    NOT NULL CHECK (role IN ('porteur','mentor','evaluateur','coordonnateur')),
  genre           TEXT    CHECK (genre IN ('F','M') OR genre IS NULL),
  telephone       TEXT,
  structure       TEXT,                                   -- établissement, entreprise ou filière
  expertise       TEXT,                                   -- domaine d'expertise (mentors, évaluateurs)
  actif           INTEGER NOT NULL DEFAULT 1 CHECK (actif IN (0,1)),
  cree_le         TEXT    NOT NULL DEFAULT (datetime('now')),
  derniere_connexion TEXT
);

-- Cohortes d'incubation
CREATE TABLE IF NOT EXISTS cohortes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nom         TEXT NOT NULL UNIQUE,
  date_debut  TEXT NOT NULL,
  date_fin    TEXT NOT NULL,
  CHECK (date_fin > date_debut)
);

-- Projets (dossier de candidature puis projet incubé)
CREATE TABLE IF NOT EXISTS projets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  porteur_id            INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE RESTRICT,
  titre                 TEXT    NOT NULL,
  domaine               TEXT    NOT NULL,
  resume                TEXT,
  probleme              TEXT,
  solution              TEXT,
  marche_cible          TEXT,
  modele_economique     TEXT,
  taille_equipe         INTEGER CHECK (taille_equipe IS NULL OR taille_equipe BETWEEN 1 AND 50),
  stade                 TEXT    CHECK (stade IN ('idee','prototype','pre_serie','commercialisation') OR stade IS NULL),
  besoin_financement    INTEGER CHECK (besoin_financement IS NULL OR besoin_financement >= 0), -- FCFA
  financement_obtenu    INTEGER NOT NULL DEFAULT 0 CHECK (financement_obtenu >= 0),            -- FCFA
  statut                TEXT    NOT NULL DEFAULT 'brouillon'
                        CHECK (statut IN ('brouillon','soumis','en_evaluation','retenu','ajourne','refuse','en_incubation','termine')),
  cohorte_id            INTEGER REFERENCES cohortes(id) ON DELETE SET NULL,
  mentor_id             INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL,
  analyse_ia            TEXT,
  analyse_ia_le         TEXT,
  date_soumission       TEXT,
  date_decision         TEXT,
  date_debut_incubation TEXT,
  date_sortie           TEXT,
  cree_le               TEXT NOT NULL DEFAULT (datetime('now')),
  modifie_le            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projets_statut  ON projets(statut);
CREATE INDEX IF NOT EXISTS idx_projets_porteur ON projets(porteur_id);
CREATE INDEX IF NOT EXISTS idx_projets_mentor  ON projets(mentor_id);

-- Pièces du dossier
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id     INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  type_doc      TEXT    NOT NULL CHECK (type_doc IN ('piece_identite','cv','fiche_projet','business_plan','pitch','autre')),
  nom_original  TEXT    NOT NULL,
  fichier       TEXT    NOT NULL UNIQUE,                  -- nom aléatoire sur le disque
  mime          TEXT    NOT NULL,
  taille        INTEGER NOT NULL,
  depose_par    INTEGER NOT NULL REFERENCES utilisateurs(id),
  depose_le     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_projet ON documents(projet_id);

-- Grille d'évaluation (critères pondérés, somme des poids = 100)
CREATE TABLE IF NOT EXISTS criteres (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  libelle      TEXT NOT NULL,
  description  TEXT NOT NULL,
  poids        INTEGER NOT NULL CHECK (poids BETWEEN 1 AND 100),
  ordre        INTEGER NOT NULL DEFAULT 0
);

-- Évaluation d'un dossier par un membre du comité
CREATE TABLE IF NOT EXISTS evaluations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id       INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  evaluateur_id   INTEGER NOT NULL REFERENCES utilisateurs(id),
  score           REAL    NOT NULL CHECK (score BETWEEN 0 AND 100),
  recommandation  TEXT    NOT NULL CHECK (recommandation IN ('favorable','reserve','defavorable')),
  commentaire     TEXT    NOT NULL,
  evalue_le       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (projet_id, evaluateur_id)
);

CREATE TABLE IF NOT EXISTS evaluation_notes (
  evaluation_id INTEGER NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  critere_id    INTEGER NOT NULL REFERENCES criteres(id),
  note          INTEGER NOT NULL CHECK (note BETWEEN 0 AND 5),
  PRIMARY KEY (evaluation_id, critere_id)
);

-- Décision motivée du comité de sélection
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id     INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  decision      TEXT    NOT NULL CHECK (decision IN ('retenu','ajourne','refuse')),
  motivation    TEXT    NOT NULL,
  score_moyen   REAL,
  nb_evaluations INTEGER NOT NULL DEFAULT 0,
  decide_par    INTEGER NOT NULL REFERENCES utilisateurs(id),
  decide_le     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Objectifs fixés avec le mentor
CREATE TABLE IF NOT EXISTS objectifs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id   INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  libelle     TEXT    NOT NULL,
  indicateur  TEXT,
  cible       TEXT,
  atteint     INTEGER NOT NULL DEFAULT 0 CHECK (atteint IN (0,1)),
  cree_par    INTEGER NOT NULL REFERENCES utilisateurs(id),
  cree_le     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Jalons du calendrier d'incubation
CREATE TABLE IF NOT EXISTS jalons (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id         INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  titre             TEXT    NOT NULL,
  description       TEXT,
  date_echeance     TEXT    NOT NULL,
  statut            TEXT    NOT NULL DEFAULT 'a_faire'
                    CHECK (statut IN ('a_faire','en_cours','soumis','valide','a_reprendre')),
  date_realisation  TEXT,
  cree_par          INTEGER NOT NULL REFERENCES utilisateurs(id),
  cree_le           TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jalons_projet ON jalons(projet_id);
CREATE INDEX IF NOT EXISTS idx_jalons_echeance ON jalons(date_echeance);

-- Preuves de réalisation déposées sur un jalon
CREATE TABLE IF NOT EXISTS preuves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  jalon_id      INTEGER NOT NULL REFERENCES jalons(id) ON DELETE CASCADE,
  nom_original  TEXT    NOT NULL,
  fichier       TEXT    NOT NULL UNIQUE,
  mime          TEXT    NOT NULL,
  taille        INTEGER NOT NULL,
  commentaire   TEXT,
  depose_par    INTEGER NOT NULL REFERENCES utilisateurs(id),
  depose_le     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Commentaires (fil de discussion du projet, éventuellement rattaché à un jalon)
CREATE TABLE IF NOT EXISTS commentaires (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id  INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  jalon_id   INTEGER REFERENCES jalons(id) ON DELETE CASCADE,
  auteur_id  INTEGER NOT NULL REFERENCES utilisateurs(id),
  contenu    TEXT    NOT NULL,
  cree_le    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Suivi post-incubation à 3 et 6 mois
CREATE TABLE IF NOT EXISTS suivis (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id         INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  echeance          TEXT    NOT NULL CHECK (echeance IN ('3_mois','6_mois')),
  date_prevue       TEXT    NOT NULL,
  date_realisee     TEXT,
  statut_activite   TEXT    CHECK (statut_activite IN ('active','en_pause','arretee') OR statut_activite IS NULL),
  chiffre_affaires  INTEGER CHECK (chiffre_affaires IS NULL OR chiffre_affaires >= 0),   -- FCFA
  emplois_crees     INTEGER CHECK (emplois_crees IS NULL OR emplois_crees >= 0),
  observations      TEXT,
  renseigne_par     INTEGER REFERENCES utilisateurs(id),
  UNIQUE (projet_id, echeance)
);

-- Comptes rendus (rédigés ou générés par IA puis relus et validés par un humain)
CREATE TABLE IF NOT EXISTS comptes_rendus (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  projet_id     INTEGER NOT NULL REFERENCES projets(id) ON DELETE CASCADE,
  type_cr       TEXT    NOT NULL CHECK (type_cr IN ('suivi','comite','mentorat','sortie')),
  titre         TEXT    NOT NULL,
  contenu       TEXT    NOT NULL,
  genere_par_ia INTEGER NOT NULL DEFAULT 0 CHECK (genere_par_ia IN (0,1)),
  statut        TEXT    NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','valide')),
  auteur_id     INTEGER NOT NULL REFERENCES utilisateurs(id),
  valide_par    INTEGER REFERENCES utilisateurs(id),
  cree_le       TEXT    NOT NULL DEFAULT (datetime('now')),
  modifie_le    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Traçabilité des appels à l'IA générative
CREATE TABLE IF NOT EXISTS journal_ia (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  utilisateur_id INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL,
  fonction     TEXT    NOT NULL,                 -- analyse_dossier, compte_rendu, suggestion_jalons
  projet_id    INTEGER REFERENCES projets(id) ON DELETE SET NULL,
  modele       TEXT    NOT NULL,
  succes       INTEGER NOT NULL CHECK (succes IN (0,1)),
  duree_ms     INTEGER,
  prompt       TEXT    NOT NULL,
  reponse      TEXT,
  erreur       TEXT,
  cree_le      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Journal des actions importantes (audit)
CREATE TABLE IF NOT EXISTS journal_activite (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  utilisateur_id INTEGER REFERENCES utilisateurs(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  projet_id      INTEGER REFERENCES projets(id) ON DELETE SET NULL,
  details        TEXT,
  cree_le        TEXT NOT NULL DEFAULT (datetime('now'))
);
