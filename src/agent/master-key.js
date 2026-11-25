// Gestion centralisee de la cle maitre de chiffrement (AES-256-GCM).
//
// La cle n'est PLUS stockee a cote des donnees chiffrees (data/). Ordre de resolution :
//   1. KEY_ENCRYPTION_SECRET (variable d'environnement) -> derivee par scrypt dans chaque store
//   2. Fichier CIVIS_MASTER_KEY_FILE (si defini)
//   3. Fichier par defaut : $XDG_CONFIG_HOME/civis/master.key (ou ~/.config/civis/master.key)
// Une ancienne cle data/.master.key est migree automatiquement (deplacee) au premier acces.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEGACY_MASTER_KEY_FILENAME = '.master.key';

function getDefaultMasterKeyPath(env = process.env) {
  const explicit = typeof env.CIVIS_MASTER_KEY_FILE === 'string' ? env.CIVIS_MASTER_KEY_FILE.trim() : '';
  if (explicit) return path.resolve(explicit);
  const configHome =
    typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim()
      ? env.XDG_CONFIG_HOME.trim()
      : path.join(os.homedir(), '.config');
  return path.join(configHome, 'civis', 'master.key');
}

function parseMasterKeyBuffer(rawBuf) {
  if (rawBuf.length === 32) return rawBuf;
  const trimmed = rawBuf.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const b64 = Buffer.from(trimmed, 'base64');
  if (b64.length === 32 && trimmed.length >= 43) {
    return b64;
  }
  return crypto.createHash('sha256').update(rawBuf).digest();
}

function ensurePrivateDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort permission hardening.
  }
}

function hardenFile(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission hardening.
  }
}

// Deplace une ancienne cle (ex: data/.master.key) vers le nouvel emplacement.
// La cle est copiee, relue et verifiee avant suppression de l'ancien fichier.
function migrateLegacyKey(legacyPath, keyPath) {
  if (!legacyPath || path.resolve(legacyPath) === path.resolve(keyPath)) return false;
  if (!fs.existsSync(legacyPath) || fs.existsSync(keyPath)) return false;

  const legacyBuf = fs.readFileSync(legacyPath);
  const legacyKey = parseMasterKeyBuffer(legacyBuf);

  ensurePrivateDir(path.dirname(keyPath));
  try {
    fs.writeFileSync(keyPath, legacyKey.toString('hex') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
  hardenFile(keyPath);

  const check = parseMasterKeyBuffer(fs.readFileSync(keyPath));
  if (!check.equals(legacyKey)) {
    throw new Error('Migration de la cle maitre echouee : verification impossible.');
  }

  fs.unlinkSync(legacyPath);
  console.log('[master-key] Cle maitre deplacee de ' + legacyPath + ' vers ' + keyPath);
  return true;
}

// Charge (ou cree) la cle maitre fichier. Retourne un Buffer de 32 octets.
function loadOrCreateFileMasterKey({ keyPath, legacyPaths = [] }) {
  if (!keyPath) throw new Error('Chemin de cle maitre manquant.');

  for (const legacy of legacyPaths) {
    migrateLegacyKey(legacy, keyPath);
  }

  if (fs.existsSync(keyPath)) {
    hardenFile(keyPath);
    return parseMasterKeyBuffer(fs.readFileSync(keyPath));
  }

  ensurePrivateDir(path.dirname(keyPath));
  const generated = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, generated.toString('hex') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    hardenFile(keyPath);
    return generated;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return parseMasterKeyBuffer(fs.readFileSync(keyPath));
    }
    throw err;
  }
}

// Options par defaut pour les stores "de production" : cle hors de data/,
// avec migration de l'ancienne data/.master.key.
function defaultKeyOptions(dataDir) {
  return {
    masterKeyPath: getDefaultMasterKeyPath(),
    legacyMasterKeyPaths: [path.join(dataDir, LEGACY_MASTER_KEY_FILENAME)],
  };
}

module.exports = {
  LEGACY_MASTER_KEY_FILENAME,
  getDefaultMasterKeyPath,
  parseMasterKeyBuffer,
  loadOrCreateFileMasterKey,
  migrateLegacyKey,
  defaultKeyOptions,
};
