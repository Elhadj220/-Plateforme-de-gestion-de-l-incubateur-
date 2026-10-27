/**
 * Calcul des indicateurs du tableau de bord du coordonnateur.
 * Toutes les définitions sont documentées dans livrables/05_Base_de_donnees (dictionnaire des indicateurs).
 *
 * Filtres acceptés : cohorte (id), domaine, du / au (période sur la date de soumission ou de création).
 */
const db = require('../db');
const { aujourdhui, ajouterJours } = require('../lib/dates');
const { DOMAINES, STATUTS } = require('../referentiel');

/** Construit la clause WHERE commune à partir des filtres validés. */
function clauseFiltres(f, alias = 'p') {
  const where = ['1=1'];
  const params = [];
  if (f.cohorte) { where.push(`${alias}.cohorte_id = ?`); params.push(Number(f.cohorte)); }
  if (f.domaine) { where.push(`${alias}.domaine = ?`); params.push(f.domaine); }
  if (f.du) { where.push(`date(COALESCE(${alias}.date_soumission, ${alias}.cree_le)) >= ?`); params.push(f.du); }
  if (f.au) { where.push(`date(COALESCE(${alias}.date_soumission, ${alias}.cree_le)) <= ?`); params.push(f.au); }
  return { sql: where.join(' AND '), params };
}

/** Ne garde que les filtres valides (protection contre les valeurs arbitraires). */
function nettoyerFiltres(q = {}) {
  const f = {};
  if (/^\d+$/.test(q.cohorte || '')) f.cohorte = q.cohorte;
  if (DOMAINES.includes(q.domaine)) f.domaine = q.domaine;
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.du || '')) f.du = q.du;
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.au || '')) f.au = q.au;
  return f;
}

/** Complète la série mensuelle avec les mois sans dépôt (valeur 0) sur 12 mois glissants. */
function completerMois(lignes, today) {
  const [y, m] = today.split('-').map(Number);
  const serie = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const mois = d.toISOString().slice(0, 7);
    serie.push({ mois, n: lignes.find((l) => l.mois === mois)?.n || 0 });
  }
  return serie;
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

function calculer(filtres = {}) {
  const { sql, params } = clauseFiltres(filtres);
  const today = aujourdhui();

  const base = db.get(
    `SELECT
       SUM(statut <> 'brouillon')                                         AS recus,
       SUM(statut IN ('retenu','en_incubation','termine'))                AS selectionnes,
       SUM(statut IN ('retenu','ajourne','refuse','en_incubation','termine')) AS decides,
       SUM(statut IN ('soumis','en_evaluation'))                          AS en_attente,
       SUM(statut = 'en_incubation')                                      AS en_incubation,
       SUM(statut = 'termine')                                            AS termines,
       SUM(statut IN ('en_incubation','termine') AND stade IN ('prototype','pre_serie','commercialisation')) AS prototypes,
       COALESCE(SUM(CASE WHEN statut IN ('en_incubation','termine') THEN financement_obtenu END), 0) AS financement_total,
       COUNT(*)                                                           AS total
     FROM projets p WHERE ${sql}`,
    ...params,
  );

  const jalons = db.get(
    `SELECT COUNT(*) AS total,
            SUM(j.statut = 'valide') AS valides,
            SUM(j.statut <> 'valide' AND j.date_echeance < ?) AS en_retard,
            SUM(j.statut <> 'valide' AND j.date_echeance BETWEEN ? AND ?) AS bientot
       FROM jalons j JOIN projets p ON p.id = j.projet_id
      WHERE p.statut = 'en_incubation' AND ${sql}`,
    today, today, ajouterJours(today, 7), ...params,
  );

  const projetsEnRetard = db.get(
    `SELECT COUNT(DISTINCT p.id) AS n FROM jalons j JOIN projets p ON p.id = j.projet_id
      WHERE p.statut = 'en_incubation' AND j.statut <> 'valide' AND j.date_echeance < ? AND ${sql}`,
    today, ...params,
  ).n;

  const suivis = db.get(
    `SELECT SUM(s.date_realisee IS NULL AND s.date_prevue < ?) AS en_retard,
            SUM(s.date_realisee IS NULL AND s.date_prevue >= ?) AS a_venir,
            SUM(s.date_realisee IS NOT NULL) AS realises,
            SUM(s.statut_activite = 'active') AS actives,
            COALESCE(SUM(s.emplois_crees), 0) AS emplois
       FROM suivis s JOIN projets p ON p.id = s.projet_id WHERE ${sql}`,
    today, today, ...params,
  );

  const parStatut = db.all(`SELECT statut, COUNT(*) AS n FROM projets p WHERE ${sql} GROUP BY statut`, ...params);
  const parDomaine = db.all(
    `SELECT domaine,
            SUM(statut <> 'brouillon') AS recus,
            SUM(statut IN ('retenu','en_incubation','termine')) AS selectionnes
       FROM projets p WHERE ${sql} GROUP BY domaine ORDER BY recus DESC`,
    ...params,
  );
  const parGenre = db.all(
    `SELECT COALESCE(u.genre, 'NR') AS genre,
            SUM(p.statut <> 'brouillon') AS recus,
            SUM(p.statut IN ('retenu','en_incubation','termine')) AS selectionnes
       FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id
      WHERE ${sql} GROUP BY COALESCE(u.genre, 'NR')`,
    ...params,
  );
  const parCohorte = db.all(
    `SELECT c.id, c.nom,
            COUNT(p.id) AS projets,
            SUM(p.statut IN ('en_incubation','termine')) AS incubes,
            ROUND(AVG(d.score_moyen), 1) AS score_moyen,
            COALESCE(SUM(p.financement_obtenu), 0) AS financement
       FROM cohortes c
  LEFT JOIN projets p ON p.cohorte_id = c.id AND ${sql}
  LEFT JOIN (SELECT projet_id, MAX(score_moyen) AS score_moyen FROM decisions GROUP BY projet_id) d ON d.projet_id = p.id
   GROUP BY c.id ORDER BY c.date_debut`,
    ...params,
  );
  // Soumissions par mois (12 derniers mois glissants)
  const parMois = db.all(
    `SELECT substr(p.date_soumission, 1, 7) AS mois, COUNT(*) AS n
       FROM projets p
      WHERE p.date_soumission IS NOT NULL AND p.date_soumission >= ? AND ${sql}
   GROUP BY mois ORDER BY mois`,
    ajouterJours(today, -365), ...params,
  );

  const avancementProjets = db.all(
    `SELECT p.id, p.titre, p.domaine, m.prenom || ' ' || m.nom AS mentor_nom,
            COUNT(j.id) AS jalons, SUM(j.statut = 'valide') AS valides,
            SUM(j.statut <> 'valide' AND j.date_echeance < ?) AS retards
       FROM projets p
  LEFT JOIN jalons j ON j.projet_id = p.id
  LEFT JOIN utilisateurs m ON m.id = p.mentor_id
      WHERE p.statut = 'en_incubation' AND ${sql}
   GROUP BY p.id ORDER BY retards DESC, p.titre`,
    today, ...params,
  );

  return {
    filtres,
    kpi: {
      recus: base.recus || 0,
      selectionnes: base.selectionnes || 0,
      tauxSelection: pct(base.selectionnes || 0, base.decides || 0),
      enAttente: base.en_attente || 0,
      enIncubation: base.en_incubation || 0,
      termines: base.termines || 0,
      prototypes: base.prototypes || 0,
      financementTotal: base.financement_total || 0,
      jalonsTotal: jalons.total || 0,
      tauxJalonsValides: pct(jalons.valides || 0, jalons.total || 0),
      jalonsEnRetard: jalons.en_retard || 0,
      jalonsBientot: jalons.bientot || 0,
      projetsEnRetard,
      suivisEnRetard: suivis.en_retard || 0,
      suivisAVenir: suivis.a_venir || 0,
      suivisRealises: suivis.realises || 0,
      tauxActivite: pct(suivis.actives || 0, suivis.realises || 0),
      emploisCrees: suivis.emplois || 0,
    },
    parStatut: Object.keys(STATUTS).map((s) => ({ statut: s, libelle: STATUTS[s].libelle, n: parStatut.find((r) => r.statut === s)?.n || 0 })),
    parDomaine,
    parGenre,
    parCohorte,
    parMois: completerMois(parMois, today),
    avancementProjets,
  };
}

/** Contrôle qualité des données : incohérences détectables automatiquement. */
function controleQualite() {
  const today = aujourdhui();
  const controles = [
    {
      code: 'Q1', libelle: 'Projets incubés sans mentor',
      lignes: db.all(`SELECT id, titre FROM projets WHERE statut = 'en_incubation' AND mentor_id IS NULL`),
    },
    {
      code: 'Q2', libelle: 'Projets incubés sans cohorte',
      lignes: db.all(`SELECT id, titre FROM projets WHERE statut IN ('retenu','en_incubation','termine') AND cohorte_id IS NULL`),
    },
    {
      code: 'Q3', libelle: 'Dossiers décidés sans décision enregistrée',
      lignes: db.all(`SELECT id, titre FROM projets p WHERE statut IN ('retenu','ajourne','refuse','en_incubation','termine')
                       AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.projet_id = p.id)`),
    },
    {
      code: 'Q4', libelle: 'Dossiers soumis sans date de soumission',
      lignes: db.all(`SELECT id, titre FROM projets WHERE statut <> 'brouillon' AND date_soumission IS NULL`),
    },
    {
      code: 'Q5', libelle: 'Projets en incubation sans aucun jalon',
      lignes: db.all(`SELECT id, titre FROM projets p WHERE statut = 'en_incubation'
                       AND NOT EXISTS (SELECT 1 FROM jalons j WHERE j.projet_id = p.id)`),
    },
    {
      code: 'Q6', libelle: 'Jalons validés sans date de réalisation',
      lignes: db.all(`SELECT j.projet_id AS id, p.titre || ' — ' || j.titre AS titre FROM jalons j JOIN projets p ON p.id = j.projet_id
                       WHERE j.statut = 'valide' AND j.date_realisation IS NULL`),
    },
    {
      code: 'Q7', libelle: 'Financement obtenu supérieur au besoin déclaré',
      lignes: db.all(`SELECT id, titre FROM projets WHERE besoin_financement IS NOT NULL AND financement_obtenu > besoin_financement`),
    },
    {
      code: 'Q8', libelle: 'Suivis post-incubation échus non renseignés',
      lignes: db.all(`SELECT s.projet_id AS id, p.titre || ' — ' || s.echeance AS titre FROM suivis s JOIN projets p ON p.id = s.projet_id
                       WHERE s.date_realisee IS NULL AND s.date_prevue < ?`, today),
    },
    {
      code: 'Q9', libelle: 'Porteurs sans genre renseigné (biais possible des analyses par genre)',
      lignes: db.all(`SELECT p.id, p.titre FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id WHERE u.genre IS NULL`),
    },
  ];
  const completudeChamps = db.get(
    `SELECT COUNT(*) AS n,
            SUM(resume IS NOT NULL AND resume <> '') AS resume,
            SUM(marche_cible IS NOT NULL AND marche_cible <> '') AS marche,
            SUM(modele_economique IS NOT NULL AND modele_economique <> '') AS modele,
            SUM(besoin_financement IS NOT NULL) AS besoin,
            SUM(stade IS NOT NULL) AS stade
       FROM projets WHERE statut <> 'brouillon'`,
  );
  return { controles, completudeChamps };
}

module.exports = { calculer, nettoyerFiltres, controleQualite };
