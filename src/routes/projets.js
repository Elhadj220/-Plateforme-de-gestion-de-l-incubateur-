/**
 * Projets : liste filtrable, création et modification du dossier, pièces jointes,
 * contrôle de complétude et soumission, fiche détaillée, export PDF de la fiche.
 */
const express = require('express');
const db = require('../db');
const s = require('../middleware/securite');
const fichiers = require('../services/fichiers');
const exp = require('../services/exports');
const P = require('../services/projets');
const { regles: r, valider, entierOuNull } = require('../lib/validation');
const { DOMAINES, STADES, STATUTS, TYPES_DOCUMENT } = require('../referentiel');
const { aujourdhui } = require('../lib/dates');

const router = express.Router();

/** Charge le projet et vérifie le droit de consultation ; place le projet dans req.projet. */
function chargerProjet(req, res, next) {
  const projet = P.trouverProjet(req.params.id);
  if (!projet) return res.status(404).render('erreur', { titre: 'Projet introuvable', message: "Ce projet n'existe pas." });
  if (!P.peutVoir(req.user, projet)) return s.refuser(res);
  req.projet = projet;
  return next();
}

/* ---------- Liste ---------- */

router.get('/projets', s.exigerConnexion, (req, res) => {
  const u = req.user;
  const where = ['1=1'];
  const params = [];
  if (u.role === 'porteur') { where.push('p.porteur_id = ?'); params.push(u.id); }
  if (u.role === 'mentor') { where.push('p.mentor_id = ?'); params.push(u.id); }
  if (u.role === 'evaluateur') {
    where.push(`(p.statut IN ('soumis','en_evaluation') OR EXISTS (SELECT 1 FROM evaluations e WHERE e.projet_id = p.id AND e.evaluateur_id = ?))`);
    params.push(u.id);
  }
  const f = {
    q: String(req.query.q || '').trim().slice(0, 80),
    statut: STATUTS[req.query.statut] ? req.query.statut : '',
    domaine: DOMAINES.includes(req.query.domaine) ? req.query.domaine : '',
    cohorte: /^\d+$/.test(req.query.cohorte || '') ? req.query.cohorte : '',
  };
  if (f.q) {
    where.push("(p.titre LIKE ? ESCAPE '\\' OR p.resume LIKE ? ESCAPE '\\' OR u.nom LIKE ? ESCAPE '\\' OR u.prenom LIKE ? ESCAPE '\\')");
    const motif = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(motif, motif, motif, motif);
  }
  if (f.statut) { where.push('p.statut = ?'); params.push(f.statut); }
  if (f.domaine) { where.push('p.domaine = ?'); params.push(f.domaine); }
  if (f.cohorte) { where.push('p.cohorte_id = ?'); params.push(Number(f.cohorte)); }

  const projets = db.all(
    `SELECT p.*, u.prenom || ' ' || u.nom AS porteur_nom, c.nom AS cohorte_nom, m.prenom || ' ' || m.nom AS mentor_nom,
            (SELECT ROUND(AVG(score), 1) FROM evaluations e WHERE e.projet_id = p.id) AS score_moyen
       FROM projets p JOIN utilisateurs u ON u.id = p.porteur_id
  LEFT JOIN cohortes c ON c.id = p.cohorte_id LEFT JOIN utilisateurs m ON m.id = p.mentor_id
      WHERE ${where.join(' AND ')}
   ORDER BY p.modifie_le DESC LIMIT 500`,
    ...params,
  );
  const cohortes = db.all('SELECT id, nom FROM cohortes ORDER BY date_debut');
  res.render('projets/liste', { titre: u.role === 'porteur' ? 'Mes projets' : 'Projets', projets, f, cohortes });
});

/* ---------- Création / modification du dossier ---------- */

const schemaProjet = {
  titre: [r.requis, r.min(5), r.max(120)],
  domaine: [r.requis, r.parmi(DOMAINES)],
  resume: [r.max(1500)],
  probleme: [r.max(2000)],
  solution: [r.max(2000)],
  marche_cible: [r.max(1500)],
  modele_economique: [r.max(1500)],
  stade: [r.parmi(Object.keys(STADES))],
  taille_equipe: [r.entier(1, 50)],
  besoin_financement: [r.entier(0, 10_000_000_000)],
};

router.get('/projets/nouveau', s.exigerRole('porteur'), (req, res) => {
  res.render('projets/formulaire', { titre: 'Nouveau dossier de candidature', v: {}, erreurs: {}, action: '/projets/nouveau' });
});

router.post('/projets/nouveau', s.exigerRole('porteur'), (req, res) => {
  const { valeurs: v, erreurs, ok } = valider(req.body, schemaProjet);
  if (!ok) return res.status(422).render('projets/formulaire', { titre: 'Nouveau dossier de candidature', v, erreurs, action: '/projets/nouveau' });
  const { id } = db.run(
    `INSERT INTO projets (porteur_id, titre, domaine, resume, probleme, solution, marche_cible, modele_economique, stade, taille_equipe, besoin_financement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, v.titre, v.domaine, v.resume, v.probleme, v.solution, v.marche_cible, v.modele_economique, v.stade,
    entierOuNull(v.taille_equipe), entierOuNull(v.besoin_financement),
  );
  P.journaliser(req.user.id, 'creation_dossier', id);
  s.flash(req, 'succes', 'Dossier enregistré en brouillon. Ajoutez maintenant les pièces obligatoires, puis soumettez-le.');
  return res.redirect(`/projets/${id}#documents`);
});

router.get('/projets/:id(\\d+)/modifier', s.exigerRole('porteur'), chargerProjet, (req, res) => {
  if (!P.dossierModifiable(req.projet)) {
    s.flash(req, 'erreur', 'Ce dossier est en cours d\'examen et ne peut plus être modifié.');
    return res.redirect(`/projets/${req.projet.id}`);
  }
  return res.render('projets/formulaire', { titre: 'Modifier le dossier', v: req.projet, erreurs: {}, action: `/projets/${req.projet.id}/modifier` });
});

router.post('/projets/:id(\\d+)/modifier', s.exigerRole('porteur'), chargerProjet, (req, res) => {
  if (!P.dossierModifiable(req.projet)) return s.refuser(res);
  const { valeurs: v, erreurs, ok } = valider(req.body, schemaProjet);
  if (!ok) return res.status(422).render('projets/formulaire', { titre: 'Modifier le dossier', v: { ...v, id: req.projet.id }, erreurs, action: `/projets/${req.projet.id}/modifier` });
  db.run(
    `UPDATE projets SET titre = ?, domaine = ?, resume = ?, probleme = ?, solution = ?, marche_cible = ?, modele_economique = ?,
            stade = ?, taille_equipe = ?, besoin_financement = ?, modifie_le = datetime('now') WHERE id = ?`,
    v.titre, v.domaine, v.resume, v.probleme, v.solution, v.marche_cible, v.modele_economique, v.stade,
    entierOuNull(v.taille_equipe), entierOuNull(v.besoin_financement), req.projet.id,
  );
  s.flash(req, 'succes', 'Dossier mis à jour.');
  return res.redirect(`/projets/${req.projet.id}`);
});

/* ---------- Soumission ---------- */

router.post('/projets/:id(\\d+)/soumettre', s.exigerRole('porteur'), chargerProjet, (req, res) => {
  const p = req.projet;
  if (!P.dossierModifiable(p)) return s.refuser(res);
  const c = P.completude(p);
  if (!c.complet) {
    s.flash(req, 'erreur', `Le dossier est incomplet : ${c.manquants.join(' ; ')}.`);
    return res.redirect(`/projets/${p.id}`);
  }
  db.run("UPDATE projets SET statut = 'soumis', date_soumission = datetime('now'), modifie_le = datetime('now') WHERE id = ?", p.id);
  P.journaliser(req.user.id, 'soumission_dossier', p.id);
  s.flash(req, 'succes', `Accusé de réception : votre dossier « ${p.titre} » a bien été soumis le ${new Date().toLocaleDateString('fr-FR')}. Il sera examiné par le comité de sélection.`);
  return res.redirect(`/projets/${p.id}`);
});

/* ---------- Documents ---------- */

router.post('/projets/:id(\\d+)/documents', s.exigerConnexion, fichiers.recevoir('fichier'), s.verifierCsrfApresDepot, chargerProjet, (req, res) => {
  const p = req.projet;
  const autorise = (req.user.role === 'porteur' && p.porteur_id === req.user.id) || req.user.role === 'coordonnateur';
  if (!autorise) return s.refuser(res);
  if (req.user.role === 'porteur' && !P.dossierModifiable(p) && p.statut !== 'en_incubation') {
    s.flash(req, 'erreur', 'Les pièces ne peuvent plus être modifiées pendant l\'examen du dossier.');
    return res.redirect(`/projets/${p.id}#documents`);
  }
  const type = TYPES_DOCUMENT[req.body.type_doc] ? req.body.type_doc : null;
  const erreur = req.erreurFichier || (!type ? 'Choisissez le type de document.' : fichiers.verifier(req.file));
  if (erreur) {
    s.flash(req, 'erreur', erreur);
    return res.redirect(`/projets/${p.id}#documents`);
  }
  const f = fichiers.enregistrer(req.file);
  db.run('INSERT INTO documents (projet_id, type_doc, nom_original, fichier, mime, taille, depose_par) VALUES (?, ?, ?, ?, ?, ?, ?)',
    p.id, type, f.nomOriginal, f.fichier, f.mime, f.taille, req.user.id);
  db.run("UPDATE projets SET modifie_le = datetime('now') WHERE id = ?", p.id);
  s.flash(req, 'succes', `Document « ${f.nomOriginal} » ajouté.`);
  return res.redirect(`/projets/${p.id}#documents`);
});

router.get('/documents/:id(\\d+)', s.exigerConnexion, (req, res) => {
  const d = db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).render('erreur', { titre: 'Document introuvable', message: "Ce document n'existe pas." });
  if (!P.peutVoir(req.user, P.trouverProjet(d.projet_id))) return s.refuser(res);
  return fichiers.envoyer(res, d);
});

router.post('/documents/:id(\\d+)/supprimer', s.exigerConnexion, (req, res) => {
  const d = db.get('SELECT * FROM documents WHERE id = ?', Number(req.params.id));
  if (!d) return res.redirect('/projets');
  const p = P.trouverProjet(d.projet_id);
  const autorise = req.user.role === 'coordonnateur' || (req.user.role === 'porteur' && p.porteur_id === req.user.id && P.dossierModifiable(p));
  if (!autorise) return s.refuser(res);
  db.run('DELETE FROM documents WHERE id = ?', d.id);
  fichiers.supprimer(d.fichier);
  s.flash(req, 'succes', 'Document supprimé.');
  return res.redirect(`/projets/${p.id}#documents`);
});

/* ---------- Fiche projet ---------- */

function donneesFiche(p) {
  const today = aujourdhui();
  return {
    documents: db.all(`SELECT d.*, u.prenom || ' ' || u.nom AS auteur FROM documents d JOIN utilisateurs u ON u.id = d.depose_par WHERE projet_id = ? ORDER BY d.depose_le`, p.id),
    synthese: P.syntheseEvaluations(p.id),
    decision: db.get(`SELECT d.*, u.prenom || ' ' || u.nom AS decideur FROM decisions d JOIN utilisateurs u ON u.id = d.decide_par WHERE projet_id = ? ORDER BY d.id DESC LIMIT 1`, p.id),
    objectifs: db.all('SELECT * FROM objectifs WHERE projet_id = ? ORDER BY id', p.id),
    jalons: db.all('SELECT * FROM jalons WHERE projet_id = ? ORDER BY date_echeance, id', p.id)
      .map((j) => ({ ...j, en_retard: j.statut !== 'valide' && j.date_echeance < today && p.statut === 'en_incubation' })),
    suivis: db.all('SELECT * FROM suivis WHERE projet_id = ? ORDER BY date_prevue', p.id),
    avancement: P.avancement(p.id),
  };
}

router.get('/projets/:id(\\d+)', s.exigerConnexion, chargerProjet, (req, res) => {
  const p = req.projet;
  const u = req.user;
  const d = donneesFiche(p);
  const preuves = db.all(
    `SELECT pr.*, u.prenom || ' ' || u.nom AS auteur FROM preuves pr JOIN jalons j ON j.id = pr.jalon_id JOIN utilisateurs u ON u.id = pr.depose_par
      WHERE j.projet_id = ? ORDER BY pr.depose_le`, p.id,
  );
  const commentaires = db.all(
    `SELECT c.*, u.prenom || ' ' || u.nom AS auteur, u.role AS auteur_role, j.titre AS jalon_titre
       FROM commentaires c JOIN utilisateurs u ON u.id = c.auteur_id LEFT JOIN jalons j ON j.id = c.jalon_id
      WHERE c.projet_id = ? ORDER BY c.cree_le DESC`, p.id,
  );
  const comptesRendus = db.all(
    `SELECT cr.id, cr.titre, cr.type_cr, cr.statut, cr.genere_par_ia, cr.cree_le, u.prenom || ' ' || u.nom AS auteur
       FROM comptes_rendus cr JOIN utilisateurs u ON u.id = cr.auteur_id WHERE cr.projet_id = ? ORDER BY cr.cree_le DESC`, p.id,
  );
  // Les membres du comité ne voient pas les notes détaillées des autres avant d'avoir évalué eux-mêmes.
  const monEvaluation = u.role === 'evaluateur' ? d.synthese.evaluations.find((e) => e.evaluateur_id === u.id) : null;
  const voitEvaluations = u.role === 'coordonnateur' || (u.role === 'evaluateur' && !!monEvaluation);
  const mentors = u.role === 'coordonnateur'
    ? db.all(`SELECT u.id, u.prenom || ' ' || u.nom AS nom, u.expertise,
                     (SELECT COUNT(*) FROM projets p WHERE p.mentor_id = u.id AND p.statut = 'en_incubation') AS charge
                FROM utilisateurs u WHERE role = 'mentor' AND actif = 1 ORDER BY charge, nom`)
    : [];
  const cohortes = u.role === 'coordonnateur' ? db.all('SELECT id, nom FROM cohortes ORDER BY date_debut DESC') : [];
  // Les porteurs ne voient la décision qu'une fois prise ; les commentaires internes du comité restent confidentiels.
  res.render('projets/fiche', {
    titre: p.titre, p, ...d, preuves, commentaires, comptesRendus, monEvaluation, voitEvaluations, mentors, cohortes,
    completude: P.completude(p), modifiable: P.dossierModifiable(p), pilote: P.peutPiloterSuivi(u, p), onglet: req.query.onglet || '',
  });
});

router.get('/projets/:id(\\d+)/fiche.pdf', s.exigerConnexion, chargerProjet, (req, res) => {
  if (req.user.role === 'evaluateur') return s.refuser(res);
  return exp.ficheProjetPdf(res, { projet: req.projet, ...donneesFiche(req.projet) });
});

/* ---------- Commentaires ---------- */

router.post('/projets/:id(\\d+)/commentaires', s.exigerConnexion, chargerProjet, (req, res) => {
  const contenu = String(req.body.contenu || '').trim();
  if (req.user.role === 'evaluateur') return s.refuser(res);
  if (contenu.length < 2 || contenu.length > 2000) {
    s.flash(req, 'erreur', 'Le commentaire doit contenir entre 2 et 2000 caractères.');
    return res.redirect(`/projets/${req.projet.id}?onglet=suivi#commentaires`);
  }
  let jalonId = null;
  if (/^\d+$/.test(req.body.jalon_id || '')) {
    const j = db.get('SELECT id FROM jalons WHERE id = ? AND projet_id = ?', Number(req.body.jalon_id), req.projet.id);
    jalonId = j ? j.id : null;
  }
  db.run('INSERT INTO commentaires (projet_id, jalon_id, auteur_id, contenu) VALUES (?, ?, ?, ?)', req.projet.id, jalonId, req.user.id, contenu);
  s.flash(req, 'succes', 'Commentaire publié.');
  return res.redirect(`/projets/${req.projet.id}?onglet=suivi#commentaires`);
});

module.exports = router;
module.exports.chargerProjet = chargerProjet;
