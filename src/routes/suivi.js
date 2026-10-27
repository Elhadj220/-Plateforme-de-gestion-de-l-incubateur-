/**
 * Suivi d'incubation : objectifs, jalons (calendrier), preuves, validation par le mentor,
 * suggestion de jalons par l'IA, financement, sortie d'incubation et suivi à 3 et 6 mois.
 */
const express = require('express');
const db = require('../db');
const s = require('../middleware/securite');
const P = require('../services/projets');
const ia = require('../services/ia');
const fichiers = require('../services/fichiers');
const { chargerProjet } = require('./projets');
const { regles: r, valider, entierOuNull } = require('../lib/validation');
const { aujourdhui, ajouterMois } = require('../lib/dates');

const router = express.Router();
const ongletSuivi = (id) => `/projets/${id}?onglet=suivi`;

/** Réservé au mentor du projet ou au coordonnateur, sur un projet en incubation. */
function exigerPilote(req, res, next) {
  if (!P.peutPiloterSuivi(req.user, req.projet)) return s.refuser(res);
  if (!P.enIncubation(req.projet)) {
    s.flash(req, 'erreur', "Cette action n'est possible que pour un projet en incubation.");
    return res.redirect(ongletSuivi(req.projet.id));
  }
  return next();
}

/** Charge un jalon et son projet, avec contrôle d'accès. */
function chargerJalon(req, res, next) {
  const j = db.get('SELECT * FROM jalons WHERE id = ?', Number(req.params.jid));
  if (!j) return res.status(404).render('erreur', { titre: 'Jalon introuvable', message: "Ce jalon n'existe pas." });
  req.params.id = String(j.projet_id);
  req.jalon = j;
  return chargerProjet(req, res, next);
}

/* ---------- Objectifs ---------- */

router.post('/projets/:id(\\d+)/objectifs', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, exigerPilote, (req, res) => {
  const { valeurs: v, ok, erreurs } = valider(req.body, { libelle: [r.requis, r.min(5), r.max(200)], indicateur: [r.max(200)], cible: [r.max(100)] });
  if (!ok) s.flash(req, 'erreur', `Objectif non enregistré : ${Object.values(erreurs)[0]}`);
  else {
    db.run('INSERT INTO objectifs (projet_id, libelle, indicateur, cible, cree_par) VALUES (?, ?, ?, ?, ?)', req.projet.id, v.libelle, v.indicateur, v.cible, req.user.id);
    s.flash(req, 'succes', 'Objectif ajouté.');
  }
  res.redirect(`${ongletSuivi(req.projet.id)}#objectifs`);
});

router.post('/objectifs/:oid(\\d+)/basculer', s.exigerRole('mentor', 'coordonnateur'), (req, res, next) => {
  const o = db.get('SELECT * FROM objectifs WHERE id = ?', Number(req.params.oid));
  if (!o) return res.redirect('/projets');
  req.params.id = String(o.projet_id);
  return chargerProjet(req, res, () => exigerPilote(req, res, () => {
    db.run('UPDATE objectifs SET atteint = 1 - atteint WHERE id = ?', o.id);
    res.redirect(`${ongletSuivi(o.projet_id)}#objectifs`);
  }));
});

router.post('/objectifs/:oid(\\d+)/supprimer', s.exigerRole('mentor', 'coordonnateur'), (req, res) => {
  const o = db.get('SELECT * FROM objectifs WHERE id = ?', Number(req.params.oid));
  if (!o) return res.redirect('/projets');
  req.params.id = String(o.projet_id);
  return chargerProjet(req, res, () => exigerPilote(req, res, () => {
    db.run('DELETE FROM objectifs WHERE id = ?', o.id);
    s.flash(req, 'succes', 'Objectif supprimé.');
    res.redirect(`${ongletSuivi(o.projet_id)}#objectifs`);
  }));
});

/* ---------- Jalons ---------- */

const schemaJalon = { titre: [r.requis, r.min(3), r.max(120)], description: [r.max(500)], date_echeance: [r.requis, r.date] };

router.post('/projets/:id(\\d+)/jalons', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, exigerPilote, (req, res) => {
  const { valeurs: v, ok, erreurs } = valider(req.body, schemaJalon);
  if (!ok) s.flash(req, 'erreur', `Jalon non enregistré : ${Object.entries(erreurs).map(([k, m]) => `${k} — ${m}`).join(' ; ')}`);
  else {
    db.run('INSERT INTO jalons (projet_id, titre, description, date_echeance, cree_par) VALUES (?, ?, ?, ?, ?)', req.projet.id, v.titre, v.description, v.date_echeance, req.user.id);
    s.flash(req, 'succes', 'Jalon ajouté au calendrier.');
  }
  res.redirect(`${ongletSuivi(req.projet.id)}#jalons`);
});

/** Suggestion de jalons par l'IA : affichée pour sélection et correction, rien n'est enregistré sans validation humaine. */
router.post('/projets/:id(\\d+)/jalons/suggestion-ia', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, exigerPilote, async (req, res, next) => {
  try {
    const r2 = await ia.suggererJalons(req.projet, req.user.id);
    res.render('projets/suggestion-jalons', { titre: 'Jalons proposés par l\'IA', p: req.projet, ...r2 });
  } catch (err) { next(err); }
});

router.post('/projets/:id(\\d+)/jalons/lot', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, exigerPilote, (req, res) => {
  const lignes = [];
  const n = Math.min(Number(req.body.nombre) || 0, 10);
  for (let i = 0; i < n; i += 1) {
    if (!req.body[`garder_${i}`]) continue;
    const { valeurs: v, ok } = valider({ titre: req.body[`titre_${i}`], description: req.body[`description_${i}`], date_echeance: req.body[`date_${i}`] }, schemaJalon);
    if (ok) lignes.push(v);
  }
  if (!lignes.length) {
    s.flash(req, 'erreur', 'Aucun jalon valide sélectionné.');
    return res.redirect(`${ongletSuivi(req.projet.id)}#jalons`);
  }
  db.transaction(() => lignes.forEach((v) => db.run(
    'INSERT INTO jalons (projet_id, titre, description, date_echeance, cree_par) VALUES (?, ?, ?, ?, ?)',
    req.projet.id, v.titre, v.description, v.date_echeance, req.user.id,
  )));
  P.journaliser(req.user.id, 'ajout_jalons_ia', req.projet.id, `${lignes.length} jalon(s) retenu(s)`);
  s.flash(req, 'succes', `${lignes.length} jalon(s) ajouté(s) après validation.`);
  return res.redirect(`${ongletSuivi(req.projet.id)}#jalons`);
});

router.post('/jalons/:jid(\\d+)/modifier', s.exigerRole('mentor', 'coordonnateur'), chargerJalon, exigerPilote, (req, res) => {
  const { valeurs: v, ok, erreurs } = valider(req.body, schemaJalon);
  if (!ok) s.flash(req, 'erreur', `Modification refusée : ${Object.values(erreurs)[0]}`);
  else {
    db.run('UPDATE jalons SET titre = ?, description = ?, date_echeance = ? WHERE id = ?', v.titre, v.description, v.date_echeance, req.jalon.id);
    s.flash(req, 'succes', 'Jalon modifié.');
  }
  res.redirect(`${ongletSuivi(req.projet.id)}#jalons`);
});

router.post('/jalons/:jid(\\d+)/supprimer', s.exigerRole('mentor', 'coordonnateur'), chargerJalon, exigerPilote, (req, res) => {
  const preuves = db.all('SELECT fichier FROM preuves WHERE jalon_id = ?', req.jalon.id);
  db.run('DELETE FROM jalons WHERE id = ?', req.jalon.id);
  preuves.forEach((p) => fichiers.supprimer(p.fichier));
  s.flash(req, 'succes', 'Jalon supprimé.');
  res.redirect(`${ongletSuivi(req.projet.id)}#jalons`);
});

/**
 * Cycle de vie d'un jalon :
 *   porteur : a_faire -> en_cours ; en_cours | a_reprendre -> soumis (au moins une preuve)
 *   mentor  : soumis -> valide | a_reprendre (commentaire obligatoire)
 */
router.post('/jalons/:jid(\\d+)/statut', s.exigerConnexion, chargerJalon, (req, res) => {
  const { jalon: j, projet: p, user: u } = req;
  const retour = `${ongletSuivi(p.id)}#jalon-${j.id}`;
  if (!P.enIncubation(p)) return s.refuser(res);
  const estPorteur = u.role === 'porteur' && p.porteur_id === u.id;
  const estPilote = P.peutPiloterSuivi(u, p);
  const action = req.body.action;

  if (action === 'demarrer' && estPorteur && j.statut === 'a_faire') {
    db.run("UPDATE jalons SET statut = 'en_cours' WHERE id = ?", j.id);
  } else if (action === 'soumettre' && estPorteur && ['en_cours', 'a_faire', 'a_reprendre'].includes(j.statut)) {
    if (!db.get('SELECT 1 AS x FROM preuves WHERE jalon_id = ?', j.id)) {
      s.flash(req, 'erreur', 'Déposez au moins une preuve de réalisation avant de soumettre le jalon.');
      return res.redirect(retour);
    }
    db.run("UPDATE jalons SET statut = 'soumis' WHERE id = ?", j.id);
    s.flash(req, 'succes', 'Jalon soumis au mentor pour validation.');
  } else if (action === 'valider' && estPilote && j.statut === 'soumis') {
    db.run("UPDATE jalons SET statut = 'valide', date_realisation = ? WHERE id = ?", aujourdhui(), j.id);
    P.journaliser(u.id, 'validation_jalon', p.id, j.titre);
    s.flash(req, 'succes', 'Jalon validé.');
  } else if (action === 'reprendre' && estPilote && j.statut === 'soumis') {
    const motif = String(req.body.motif || '').trim();
    if (motif.length < 10) {
      s.flash(req, 'erreur', 'Indiquez ce qui doit être repris (10 caractères minimum).');
      return res.redirect(retour);
    }
    db.transaction(() => {
      db.run("UPDATE jalons SET statut = 'a_reprendre' WHERE id = ?", j.id);
      db.run('INSERT INTO commentaires (projet_id, jalon_id, auteur_id, contenu) VALUES (?, ?, ?, ?)', p.id, j.id, u.id, `À reprendre : ${motif}`);
    });
    s.flash(req, 'succes', 'Le porteur a été invité à reprendre le jalon.');
  } else {
    return s.refuser(res);
  }
  return res.redirect(retour);
});

/* ---------- Preuves ---------- */

router.post('/jalons/:jid(\\d+)/preuves', s.exigerRole('porteur'), fichiers.recevoir('fichier'), s.verifierCsrfApresDepot, chargerJalon, (req, res) => {
  const { jalon: j, projet: p } = req;
  const retour = `${ongletSuivi(p.id)}#jalon-${j.id}`;
  if (p.porteur_id !== req.user.id || !P.enIncubation(p) || j.statut === 'valide') return s.refuser(res);
  const erreur = req.erreurFichier || fichiers.verifier(req.file);
  if (erreur) {
    s.flash(req, 'erreur', erreur);
    return res.redirect(retour);
  }
  const f = fichiers.enregistrer(req.file);
  const commentaire = String(req.body.commentaire || '').trim().slice(0, 500) || null;
  db.run('INSERT INTO preuves (jalon_id, nom_original, fichier, mime, taille, commentaire, depose_par) VALUES (?, ?, ?, ?, ?, ?, ?)',
    j.id, f.nomOriginal, f.fichier, f.mime, f.taille, commentaire, req.user.id);
  if (j.statut === 'a_faire') db.run("UPDATE jalons SET statut = 'en_cours' WHERE id = ?", j.id);
  s.flash(req, 'succes', 'Preuve déposée. Soumettez le jalon lorsque toutes les preuves sont réunies.');
  return res.redirect(retour);
});

router.get('/preuves/:pid(\\d+)', s.exigerConnexion, (req, res) => {
  const pr = db.get('SELECT pr.*, j.projet_id FROM preuves pr JOIN jalons j ON j.id = pr.jalon_id WHERE pr.id = ?', Number(req.params.pid));
  if (!pr) return res.status(404).render('erreur', { titre: 'Preuve introuvable', message: "Ce fichier n'existe pas." });
  if (!P.peutVoir(req.user, P.trouverProjet(pr.projet_id))) return s.refuser(res);
  return fichiers.envoyer(res, pr);
});

/* ---------- Financement ---------- */

router.post('/projets/:id(\\d+)/financement', s.exigerRole('mentor', 'coordonnateur'), chargerProjet, (req, res) => {
  if (!P.peutPiloterSuivi(req.user, req.projet) || !['en_incubation', 'termine'].includes(req.projet.statut)) return s.refuser(res);
  const err = r.requis(req.body.financement_obtenu) || r.entier(0, 10_000_000_000)(req.body.financement_obtenu);
  if (err) s.flash(req, 'erreur', `Montant invalide : ${err}`);
  else {
    db.run("UPDATE projets SET financement_obtenu = ?, modifie_le = datetime('now') WHERE id = ?", Number(req.body.financement_obtenu), req.projet.id);
    s.flash(req, 'succes', 'Financement obtenu mis à jour.');
  }
  res.redirect(ongletSuivi(req.projet.id));
});

/* ---------- Sortie d'incubation et suivi à 3 / 6 mois ---------- */

router.post('/projets/:id(\\d+)/sortie', s.exigerRole('coordonnateur'), chargerProjet, (req, res) => {
  const p = req.projet;
  if (!P.enIncubation(p)) return s.refuser(res);
  const sortie = aujourdhui();
  db.transaction(() => {
    db.run("UPDATE projets SET statut = 'termine', date_sortie = ?, modifie_le = datetime('now') WHERE id = ?", sortie, p.id);
    db.run("INSERT OR IGNORE INTO suivis (projet_id, echeance, date_prevue) VALUES (?, '3_mois', ?)", p.id, ajouterMois(sortie, 3));
    db.run("INSERT OR IGNORE INTO suivis (projet_id, echeance, date_prevue) VALUES (?, '6_mois', ?)", p.id, ajouterMois(sortie, 6));
  });
  P.journaliser(req.user.id, 'sortie_incubation', p.id);
  s.flash(req, 'succes', `Incubation clôturée. Les suivis à 3 mois (${ajouterMois(sortie, 3)}) et 6 mois (${ajouterMois(sortie, 6)}) ont été planifiés.`);
  return res.redirect(ongletSuivi(p.id));
});

router.post('/suivis/:sid(\\d+)', s.exigerRole('mentor', 'coordonnateur'), (req, res) => {
  const suivi = db.get('SELECT * FROM suivis WHERE id = ?', Number(req.params.sid));
  if (!suivi) return res.redirect('/projets');
  req.params.id = String(suivi.projet_id);
  return chargerProjet(req, res, () => {
    if (!P.peutPiloterSuivi(req.user, req.projet)) return s.refuser(res);
    const { valeurs: v, ok, erreurs } = valider(req.body, {
      date_realisee: [r.requis, r.date],
      statut_activite: [r.requis, r.parmi(['active', 'en_pause', 'arretee'])],
      chiffre_affaires: [r.entier(0, 10_000_000_000)],
      emplois_crees: [r.entier(0, 10000)],
      observations: [r.max(2000)],
    });
    if (!ok) s.flash(req, 'erreur', `Suivi non enregistré : ${Object.values(erreurs)[0]}`);
    else if (v.date_realisee > aujourdhui()) s.flash(req, 'erreur', 'La date de réalisation ne peut pas être dans le futur.');
    else {
      db.run('UPDATE suivis SET date_realisee = ?, statut_activite = ?, chiffre_affaires = ?, emplois_crees = ?, observations = ?, renseigne_par = ? WHERE id = ?',
        v.date_realisee, v.statut_activite, entierOuNull(v.chiffre_affaires), entierOuNull(v.emplois_crees), v.observations, req.user.id, suivi.id);
      s.flash(req, 'succes', 'Suivi post-incubation enregistré.');
    }
    return res.redirect(ongletSuivi(suivi.projet_id));
  });
});

module.exports = router;
