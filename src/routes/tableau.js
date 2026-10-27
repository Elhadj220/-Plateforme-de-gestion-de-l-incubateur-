/**
 * Tableaux de bord : page d'accueil adaptée au rôle, tableau de bord analytique du coordonnateur,
 * alertes de retard, contrôle qualité des données et exports.
 */
const express = require('express');
const db = require('../db');
const s = require('../middleware/securite');
const ind = require('../services/indicateurs');
const exp = require('../services/exports');
const { jalonsEnRetard, avancement, completude } = require('../services/projets');
const { aujourdhui, ajouterJours } = require('../lib/dates');

const router = express.Router();

router.get('/tableau-de-bord', s.exigerConnexion, (req, res) => {
  const u = req.user;
  const today = aujourdhui();

  if (u.role === 'porteur') {
    const projets = db.all(
      `SELECT p.*, m.prenom || ' ' || m.nom AS mentor_nom, c.nom AS cohorte_nom
         FROM projets p LEFT JOIN utilisateurs m ON m.id = p.mentor_id LEFT JOIN cohortes c ON c.id = p.cohorte_id
        WHERE p.porteur_id = ? ORDER BY p.modifie_le DESC`, u.id,
    ).map((p) => ({ ...p, completude: completude(p), avancement: avancement(p.id) }));
    const prochains = db.all(
      `SELECT j.*, p.titre AS projet_titre FROM jalons j JOIN projets p ON p.id = j.projet_id
        WHERE p.porteur_id = ? AND p.statut = 'en_incubation' AND j.statut NOT IN ('valide')
     ORDER BY j.date_echeance LIMIT 6`, u.id,
    );
    return res.render('tableaux/porteur', { titre: 'Mon espace', projets, prochains, retards: jalonsEnRetard({ porteurId: u.id }), today });
  }

  if (u.role === 'mentor') {
    const projets = db.all(
      `SELECT p.*, u.prenom || ' ' || u.nom AS porteur_nom, c.nom AS cohorte_nom
         FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id LEFT JOIN cohortes c ON c.id = p.cohorte_id
        WHERE p.mentor_id = ? ORDER BY p.statut = 'en_incubation' DESC, p.titre`, u.id,
    ).map((p) => ({ ...p, avancement: avancement(p.id) }));
    const aValider = db.all(
      `SELECT j.*, p.titre AS projet_titre FROM jalons j JOIN projets p ON p.id = j.projet_id
        WHERE p.mentor_id = ? AND j.statut = 'soumis' ORDER BY j.date_echeance`, u.id,
    );
    return res.render('tableaux/mentor', { titre: 'Espace mentor', projets, aValider, retards: jalonsEnRetard({ mentorId: u.id }) });
  }

  if (u.role === 'evaluateur') {
    const aEvaluer = db.all(
      `SELECT p.*, (SELECT COUNT(*) FROM evaluations e WHERE e.projet_id = p.id) AS nb_eval
         FROM projets p
        WHERE p.statut IN ('soumis','en_evaluation')
          AND NOT EXISTS (SELECT 1 FROM evaluations e WHERE e.projet_id = p.id AND e.evaluateur_id = ?)
     ORDER BY p.date_soumission`, u.id,
    );
    const evalues = db.all(
      `SELECT p.id, p.titre, p.domaine, p.statut, e.score, e.recommandation, e.evalue_le
         FROM evaluations e JOIN projets p ON p.id = e.projet_id
        WHERE e.evaluateur_id = ? ORDER BY e.evalue_le DESC`, u.id,
    );
    return res.render('tableaux/evaluateur', { titre: 'Espace comité de sélection', aEvaluer, evalues });
  }

  // Coordonnateur
  const k = ind.calculer({}).kpi;
  const aDecider = db.all(
    `SELECT p.*, u.prenom || ' ' || u.nom AS porteur_nom,
            (SELECT COUNT(*) FROM evaluations e WHERE e.projet_id = p.id) AS nb_eval,
            (SELECT ROUND(AVG(score), 1) FROM evaluations e WHERE e.projet_id = p.id) AS score_moyen
       FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id
      WHERE p.statut IN ('soumis','en_evaluation') ORDER BY nb_eval DESC, p.date_soumission`,
  );
  const sansMentor = db.all(`SELECT p.id, p.titre, p.domaine, c.nom AS cohorte_nom FROM projets p LEFT JOIN cohortes c ON c.id = p.cohorte_id WHERE p.statut = 'retenu' ORDER BY p.date_decision`);
  const suivisDus = db.all(
    `SELECT s.*, p.titre FROM suivis s JOIN projets p ON p.id = s.projet_id
      WHERE s.date_realisee IS NULL AND s.date_prevue <= ? ORDER BY s.date_prevue`, ajouterJours(today, 30),
  );
  return res.render('tableaux/coordonnateur', {
    titre: 'Espace coordonnateur', k, aDecider, sansMentor, suivisDus, retards: jalonsEnRetard().slice(0, 8), today,
  });
});

/* ---------- Tableau de bord analytique ---------- */

function libelleFiltres(f) {
  const parts = [];
  if (f.cohorte) parts.push(`cohorte ${db.get('SELECT nom FROM cohortes WHERE id = ?', Number(f.cohorte))?.nom || f.cohorte}`);
  if (f.domaine) parts.push(`domaine ${f.domaine}`);
  if (f.du) parts.push(`depuis le ${f.du}`);
  if (f.au) parts.push(`jusqu'au ${f.au}`);
  return parts.length ? parts.join(', ') : 'aucun (toutes les données)';
}

router.get('/coordination/tableau-de-bord', s.exigerRole('coordonnateur'), (req, res) => {
  const filtres = ind.nettoyerFiltres(req.query);
  const donnees = ind.calculer(filtres);
  const cohortes = db.all('SELECT id, nom FROM cohortes ORDER BY date_debut');
  const query = new URLSearchParams(filtres).toString();
  res.render('tableaux/analytique', { titre: 'Tableau de bord analytique', d: donnees, cohortes, filtres, query, libelle: libelleFiltres(filtres) });
});

router.get('/coordination/export.pdf', s.exigerRole('coordonnateur'), (req, res) => {
  const filtres = ind.nettoyerFiltres(req.query);
  exp.tableauDeBordPdf(res, ind.calculer(filtres), libelleFiltres(filtres));
});

router.get('/coordination/export.xlsx', s.exigerRole('coordonnateur'), async (req, res, next) => {
  try {
    const filtres = ind.nettoyerFiltres(req.query);
    const where = ['1=1'];
    const params = [];
    if (filtres.cohorte) { where.push('p.cohorte_id = ?'); params.push(Number(filtres.cohorte)); }
    if (filtres.domaine) { where.push('p.domaine = ?'); params.push(filtres.domaine); }
    if (filtres.du) { where.push('date(COALESCE(p.date_soumission, p.cree_le)) >= ?'); params.push(filtres.du); }
    if (filtres.au) { where.push('date(COALESCE(p.date_soumission, p.cree_le)) <= ?'); params.push(filtres.au); }
    const projets = db.all(
      `SELECT p.*, u.prenom || ' ' || u.nom AS porteur_nom, u.genre AS porteur_genre, m.prenom || ' ' || m.nom AS mentor_nom,
              c.nom AS cohorte_nom, (SELECT ROUND(AVG(score), 1) FROM evaluations e WHERE e.projet_id = p.id) AS score_moyen
         FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id
    LEFT JOIN utilisateurs m ON m.id = p.mentor_id LEFT JOIN cohortes c ON c.id = p.cohorte_id
        WHERE ${where.join(' AND ')} ORDER BY p.id`, ...params,
    );
    const ids = new Set(projets.map((p) => p.id));
    const retards = jalonsEnRetard().filter((j) => ids.has(j.projet_id));
    await exp.exportExcel(res, { projets, ind: ind.calculer(filtres), retards, libelleFiltres: libelleFiltres(filtres) });
  } catch (err) { next(err); }
});

/* ---------- Alertes de retard ---------- */

router.get('/alertes', s.exigerRole('coordonnateur', 'mentor', 'porteur'), (req, res) => {
  const u = req.user;
  const filtre = u.role === 'mentor' ? { mentorId: u.id } : u.role === 'porteur' ? { porteurId: u.id } : {};
  const retards = jalonsEnRetard(filtre);
  const today = aujourdhui();
  const where = u.role === 'mentor' ? 'AND p.mentor_id = ?' : u.role === 'porteur' ? 'AND p.porteur_id = ?' : '';
  const bientot = db.all(
    `SELECT j.*, p.titre AS projet_titre FROM jalons j JOIN projets p ON p.id = j.projet_id
      WHERE p.statut = 'en_incubation' AND j.statut <> 'valide' AND j.date_echeance BETWEEN ? AND ? ${where}
   ORDER BY j.date_echeance`,
    today, ajouterJours(today, 7), ...(where ? [u.id] : []),
  );
  res.render('alertes', { titre: 'Alertes de retard', retards, bientot });
});

/* ---------- Contrôle qualité ---------- */

router.get('/coordination/qualite', s.exigerRole('coordonnateur'), (req, res) => {
  res.render('tableaux/qualite', { titre: 'Qualité des données', q: ind.controleQualite() });
});

module.exports = router;
