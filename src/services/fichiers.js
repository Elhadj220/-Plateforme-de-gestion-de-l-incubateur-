/**
 * Gestion sécurisée des fichiers déposés.
 *  - réception en mémoire (multer) avec taille maximale ;
 *  - contrôle de l'extension ET de la signature binaire (« magic bytes ») ;
 *  - enregistrement hors du dossier public sous un nom aléatoire ;
 *  - téléchargement uniquement via une route qui vérifie les droits.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('../config');

fs.mkdirSync(config.uploadDir, { recursive: true });

const FORMATS = {
  '.pdf': { mime: 'application/pdf', signature: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  '.png': { mime: 'image/png', signature: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: 'image/jpeg', signature: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', signature: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // DOCX, XLSX et PPTX sont des archives ZIP
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', signature: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', signature: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', signature: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
};
const EXTENSIONS_ACCEPTEES = Object.keys(FORMATS).join(', ');

const reception = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 20 },
});

/** Middleware : reçoit un fichier unique et transforme les erreurs multer en message lisible. */
function recevoir(champ) {
  const mw = reception.single(champ);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) {
      req.erreurFichier = err.code === 'LIMIT_FILE_SIZE'
        ? `Le fichier dépasse la taille maximale de ${config.maxUploadMb} Mo.`
        : 'Le fichier n\'a pas pu être reçu.';
    }
    next();
  });
}

/** Vérifie le fichier reçu. Retourne un message d'erreur ou null. */
function verifier(file) {
  if (!file) return 'Aucun fichier sélectionné.';
  const ext = path.extname(file.originalname || '').toLowerCase();
  const format = FORMATS[ext];
  if (!format) return `Format non accepté. Formats autorisés : ${EXTENSIONS_ACCEPTEES}.`;
  if (!file.size) return 'Le fichier est vide.';
  if (!format.signature(file.buffer)) return 'Le contenu du fichier ne correspond pas à son extension.';
  return null;
}

/** Enregistre le fichier sur le disque et retourne ses métadonnées. */
function enregistrer(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const fichier = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(config.uploadDir, fichier), file.buffer);
  return {
    fichier,
    nomOriginal: nettoyerNom(file.originalname),
    mime: FORMATS[ext].mime,
    taille: file.size,
  };
}

function nettoyerNom(nom) {
  return path.basename(String(nom)).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 150);
}

function chemin(fichier) {
  // Le nom provient de la base (UUID) : on refuse tout ce qui ressemble à un chemin.
  if (!/^[0-9a-f-]{36}\.[a-z]{3,4}$/.test(fichier)) throw new Error('Nom de fichier invalide');
  return path.join(config.uploadDir, fichier);
}

function supprimer(fichier) {
  try { fs.unlinkSync(chemin(fichier)); } catch { /* fichier déjà absent */ }
}

/** Envoie le fichier au navigateur en téléchargement. */
function envoyer(res, { fichier, nom_original: nomOriginal, mime }) {
  const p = chemin(fichier);
  if (!fs.existsSync(p)) return res.status(404).render('erreur', { titre: 'Fichier introuvable', message: 'Ce fichier n\'est plus disponible sur le serveur.' });
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${nomOriginal.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(nomOriginal)}`);
  return res.sendFile(p);
}

module.exports = { recevoir, verifier, enregistrer, supprimer, envoyer, EXTENSIONS_ACCEPTEES };
