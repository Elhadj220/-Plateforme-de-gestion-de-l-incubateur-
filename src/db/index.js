/**
 * Accès à la base de données SQLite (module natif node:sqlite, aucune compilation requise).
 * Expose des fonctions utilitaires get / all / run / transaction.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

/** SQLite n'accepte pas undefined : on le remplace par null. */
const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));

/** Convertit les objets à prototype nul renvoyés par node:sqlite en objets ordinaires. */
const plain = (row) => (row ? { ...row } : undefined);

function get(sql, ...params) {
  return plain(db.prepare(sql).get(...clean(params)));
}

function all(sql, ...params) {
  return db.prepare(sql).all(...clean(params)).map(plain);
}

function run(sql, ...params) {
  const r = db.prepare(sql).run(...clean(params));
  return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

/** Exécute fn dans une transaction ; annule tout en cas d'erreur. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Crée les tables si elles n'existent pas. */
function initSchema() {
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

function isEmpty() {
  return get('SELECT COUNT(*) AS n FROM utilisateurs').n === 0;
}

module.exports = { db, get, all, run, transaction, initSchema, isEmpty };
