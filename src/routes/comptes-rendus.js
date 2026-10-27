/**
 * Comptes rendus : rédaction manuelle ou brouillon généré par l'IA, relecture, validation humaine, export PDF.
 */
const express = require('express');
const db = require('../db');
const s = require('../middleware/securite');
const P = require('../services/projets');
const ia = require('../services/ia');
const exp = require('../services/exports');
const { chargerProjet } = require('./projets');
const { TYPES_CR } = require('../referentiel');
const { formatDate, aujourdhui } = require('../lib/dates');

const router = express.Router();

/** Types de comptes rendus autorisés selon le rôle (le PV du comité est réservé au coordonnateur). */
function typesAutorises(user) {
  return user.role === 'coordonnateur' ? Object.keys(TYPES_CR) : ['suivi', 'mentorat'];
}

function peutRediger(user, projet) {
  return P.peutPiloterSuivi(user, projet) && projet.statut !== 'brouillon';
}

/** Le porteur ne consulte que les comptes rendus validés qui le concernent (pas les PV internes du comité). */
function peutLire(user, cr, projet) {
  if (!P.peutVoir(user, projet) || user.role === 'evaluateur') return false;
  if (user.role === 'porteur') return cr.statut === 'valide' && cr.type_cr !== 'comite';
  return true;
}

function chargerCr(req, res, next) {
  const cr = db.get(
    `SELECT cr.*, a.prenom || ' ' || a.nom AS auteur_nom, v.prenom || ' ' || v.nom AS valide_par_nom
       FROM comptes_rendus cr JOIN utilisateurs a ON a.id = cr.auteur_id LEFT JOIN utilisateurs v ON v.id = cr.valide_par
      WHERE cr.id = ?`, Number(req.params.cid),
  );
  if (!cr) return res.status(404).render('erreur', { titre: 'Compte rendu introuvable', message: "Ce compte rendu n'existe pas." });
  const projet = P.trouverProjet(cr.projet_id);
  if (!peutLire(req.user, cr, projet)) return s.refuser(res);
  req.cr = cr;
  req.projet = projet;
  return next();
}

const titreParDefaut = (type, p) => `${TYPES_CR[type]} - ${p.titre} - ${formatDate(aujourdhui())}`;

/* ---------- Création ---------- */

router.get('/projets/:id(\\d+)/comptes-rendus/nouveau', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, (req, res) => {
  if (!peutRediger(req.user, req.projet)) return s.refuser(res);
  const type = typesAutorises(req.user).includes(req.query.type) ? req.query.type : 'suivi';
  return res.render('comptes-rendus/formulaire', {
    titre: 'Nouveau compte rendu', p: req.projet, types: typesAutorises(req.user),
    v: { type_cr: type, titre: titreParDefaut(type, req.projet), contenu: '', notes: '', genere_par_ia: 0 }, etape: 'notes',
  });
});

/** Génère un brouillon avec l'IA puis réaffiche le formulaire pour relecture : rien n'est enregistré à ce stade. */
router.post('/projets/:id(\\d+)/comptes-rendus/generer', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, async (req, res, next) => {
  try {
    const p = req.projet;
    if (!peutRediger(req.user, p)) return s.refuser(res);
    const type = typesAutorises(req.user).includes(req.body.type_cr) ? req.body.type_cr : 'suivi';
    const notes = String(req.body.notes || '').slice(0, 4000);
    const r = await ia.genererCompteRendu(p, type, notes, req.user.id);
    res.locals.flash = [r.source === 'gemini'
      ? { type: 'info', message: "Brouillon généré par l'IA. Relisez-le, corrigez les éventuelles erreurs puis enregistrez-le." }
      : { type: 'info', message: `IA indisponible (${r.erreur}). Un brouillon structuré a été préparé à partir des données du projet.` }];
    return res.render('comptes-rendus/formulaire', {
      titre: 'Relecture du brouillon', p, types: typesAutorises(req.user),
      v: { type_cr: type, titre: titreParDefaut(type, p), contenu: r.texte, notes, genere_par_ia: 1, source: r.source }, etape: 'relecture',
    });
  } catch (err) { return next(err); }
});

function lireFormulaire(req, user) {
  const v = {
    type_cr: typesAutorises(user).includes(req.body.type_cr) ? req.body.type_cr : null,
    titre: String(req.body.titre || '').trim(),
    contenu: String(req.body.contenu || '').trim(),
    genere_par_ia: req.body.genere_par_ia === '1' ? 1 : 0,
    notes: String(req.body.notes || ''),
  };
  let erreur = null;
  if (!v.type_cr) erreur = 'Type de compte rendu invalide.';
  else if (v.titre.length < 5 || v.titre.length > 200) erreur = 'Le titre doit contenir entre 5 et 200 caractères.';
  else if (v.contenu.length < 50) erreur = 'Le contenu doit contenir au moins 50 caractères.';
  else if (v.contenu.length > 20000) erreur = 'Le contenu ne doit pas dépasser 20 000 caractères.';
  return { v, erreur };
}

router.post('/projets/:id(\\d+)/comptes-rendus', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, (req, res) => {
  const p = req.projet;
  if (!peutRediger(req.user, p)) return s.refuser(res);
  const { v, erreur } = lireFormulaire(req, req.user);
  if (erreur) {
    res.locals.flash = [{ type: 'erreur', message: erreur }];
    return res.status(422).render('comptes-rendus/formulaire', { titre: 'Nouveau compte rendu', p, types: typesAutorises(req.user), v, etape: 'relecture' });
  }
  const { id } = db.run('INSERT INTO comptes_rendus (projet_id, type_cr, titre, contenu, genere_par_ia, auteur_id) VALUES (?, ?, ?, ?, ?, ?)',
    p.id, v.type_cr, v.titre, v.contenu, v.genere_par_ia, req.user.id);
  P.journaliser(req.user.id, 'creation_compte_rendu', p.id, v.genere_par_ia ? 'brouillon IA relu' : 'rédaction manuelle');
  s.flash(req, 'succes', 'Compte rendu enregistré en brouillon. Il pourra être validé après relecture.');
  return res.redirect(`/comptes-rendus/${id}`);
});

/* ---------- Consultation, modification, validation, PDF ---------- */

router.get('/comptes-rendus', s.exigerRole('coordonnateur', 'mentor'), (req, res) => {
  const where = req.user.role === 'mentor' ? 'WHERE p.mentor_id = ?' : '';
  const liste = db.all(
    `SELECT cr.id, cr.titre, cr.type_cr, cr.statut, cr.genere_par_ia, cr.cree_le, p.titre AS projet_titre, p.id AS projet_id,
            u.prenom || ' ' || u.nom AS auteur
       FROM comptes_rendus cr JOIN projets p ON p.id = cr.projet_id JOIN utilisateurs u ON u.id = cr.auteur_id
       ${where} ORDER BY cr.cree_le DESC`,
    ...(where ? [req.user.id] : []),
  );
  res.render('comptes-rendus/liste', { titre: 'Comptes rendus', liste });
});

router.get('/comptes-rendus/:cid(\\d+)', s.exigerConnexion, chargerCr, (req, res) => {
  const modifiable = req.cr.statut === 'brouillon' && (req.cr.auteur_id === req.user.id || req.user.role === 'coordonnateur');
  const validable = req.cr.statut === 'brouillon' && P.peutPiloterSuivi(req.user, req.projet) && typesAutorises(req.user).includes(req.cr.type_cr);
  res.render('comptes-rendus/voir', { titre: req.cr.titre, cr: req.cr, p: req.projet, modifiable, validable });
});

router.get('/comptes-rendus/:cid(\\d+)/modifier', s.exigerRole('mentor', 'coordonnateur'), chargerCr, (req, res) => {
  const { cr } = req;
  if (cr.statut !== 'brouillon' || (cr.auteur_id !== req.user.id && req.user.role !== 'coordonnateur')) return s.refuser(res);
  return res.render('comptes-rendus/formulaire', {
    titre: 'Modifier le compte rendu', p: req.projet, types: [cr.type_cr], v: cr, etape: 'modification', crId: cr.id,
  });
});

router.post('/comptes-rendus/:cid(\\d+)/modifier', s.exigerRole('mentor', 'coordonnateur'), chargerCr, (req, res) => {
  const { cr } = req;
  if (cr.statut !== 'brouillon' || (cr.auteur_id !== req.user.id && req.user.role !== 'coordonnateur')) return s.refuser(res);
  req.body.type_cr = cr.type_cr;
  req.body.genere_par_ia = String(cr.genere_par_ia);
  const { v, erreur } = lireFormulaire(req, { role: 'coordonnateur' });
  if (erreur) {
    res.locals.flash = [{ type: 'erreur', message: erreur }];
    return res.status(422).render('comptes-rendus/formulaire', { titre: 'Modifier le compte rendu', p: req.projet, types: [cr.type_cr], v, etape: 'modification', crId: cr.id });
  }
  db.run("UPDATE comptes_rendus SET titre = ?, contenu = ?, modifie_le = datetime('now') WHERE id = ?", v.titre, v.contenu, cr.id);
  s.flash(req, 'succes', 'Compte rendu modifié.');
  return res.redirect(`/comptes-rendus/${cr.id}`);
});

router.post('/comptes-rendus/:cid(\\d+)/valider', s.exigerRole('mentor', 'coordonnateur'), chargerCr, (req, res) => {
  const { cr, projet } = req;
  if (cr.statut !== 'brouillon' || !P.peutPiloterSuivi(req.user, projet) || !typesAutorises(req.user).includes(cr.type_cr)) return s.refuser(res);
  db.run("UPDATE comptes_rendus SET statut = 'valide', valide_par = ?, modifie_le = datetime('now') WHERE id = ?", req.user.id, cr.id);
  P.journaliser(req.user.id, 'validation_compte_rendu', projet.id, cr.titre);
  s.flash(req, 'succes', 'Compte rendu validé. Il est désormais visible par le porteur (sauf PV du comité).');
  return res.redirect(`/comptes-rendus/${cr.id}`);
});

router.get('/comptes-rendus/:cid(\\d+)/pdf', s.exigerConnexion, chargerCr, (req, res) => {
  exp.compteRenduPdf(res, req.cr, req.projet);
});

module.exports = router;
