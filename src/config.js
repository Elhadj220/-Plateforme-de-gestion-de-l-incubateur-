/**
 * Configuration centralisée, lue depuis les variables d'environnement (.env).
 */
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const root = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

const sessionSecret = process.env.SESSION_SECRET || '';
if (isProd && sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET doit contenir au moins 32 caractères en production.');
}

const modelePrincipal = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const modelesRemplacement = (process.env.GEMINI_MODELES_REMPLACEMENT || 'gemini-3.8-flash,gemini-flash-latest')
  .split(',').map((m) => m.trim()).filter(Boolean);

module.exports = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  sessionSecret: sessionSecret || 'dev-uniquement-secret-a-remplacer-en-production-0123456789',
  dbPath: process.env.DB_PATH ? path.resolve(root, process.env.DB_PATH) : path.join(root, 'data', 'incubateur.db'),
  uploadDir: process.env.UPLOAD_DIR ? path.resolve(root, process.env.UPLOAD_DIR) : path.join(root, 'data', 'uploads'),
  maxUploadMb: 5,
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: modelePrincipal,
    modeles: [...new Set([modelePrincipal, ...modelesRemplacement])],
    timeoutMs: Number(process.env.GEMINI_TIMEOUT_MS) || 40000,
  },
  // Seuils métier
  scoreMinRetenu: 60,        // score moyen indicatif (/100) au-delà duquel un dossier est recommandé
  joursAlerteJalon: 7,       // un jalon à moins de 7 jours de l'échéance est signalé « bientôt dû »
};
