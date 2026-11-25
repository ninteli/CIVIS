const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const net = require('net');
const path = require('path');
const masterKeyLib = require('./master-key');

const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
  },
  custom: {
    id: 'custom',
    label: 'Personnalise',
    baseUrl: null,
    defaultModel: null,
  },
};

function maskApiKey(key) {
  const s = String(key || '');
  if (!s || s.length <= 8) return '****';
  return s.slice(0, 4) + '...' + s.slice(-4);
}

function isBlockedIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = nums;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedIpv6(host) {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1') return true;
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  if (h.startsWith('::ffff:')) {
    const mapped = h.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isBlockedIpv4(mapped);
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      const ipv4 = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
      return isBlockedIpv4(ipv4);
    }
    return true;
  }
  return false;
}

function validateCustomUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  if (!str) {
    return { ok: false, error: 'L URL personnalisee est requise pour le fournisseur Personnalise.' };
  }

  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    return { ok: false, error: 'URL invalide.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Seules les URL HTTPS sont autorisees.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Les identifiants dans l URL sont interdits.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) {
    return { ok: false, error: 'Nom d hote invalide dans l URL.' };
  }

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.nip.io') ||
    host.endsWith('.sslip.io') ||
    host.endsWith('.xip.io') ||
    host.endsWith('.localtest.me') ||
    host.endsWith('.lvh.me')
  ) {
    return { ok: false, error: 'Les adresses locales ou internes ne sont pas autorisees.' };
  }

  if (net.isIPv4(host) && isBlockedIpv4(host)) {
    return { ok: false, error: 'Les adresses IP privees ou locales ne sont pas autorisees.' };
  }

  if (net.isIPv6(host) && isBlockedIpv6(host)) {
    return { ok: false, error: 'Les adresses IPv6 privees ou locales ne sont pas autorisees.' };
  }

  const cleanPath = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');

  return { ok: true, url: parsed.origin + cleanPath };
}

function isBlockedIp(ip) {
  const clean = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (!clean) return true;
  if (net.isIPv4(clean)) return isBlockedIpv4(clean);
  if (net.isIPv6(clean)) return isBlockedIpv6(clean);
  return true;
}

async function validateCustomUrlDns(rawUrl, { lookupFn } = {}) {
  const syncCheck = validateCustomUrl(rawUrl);
  if (!syncCheck.ok) return syncCheck;

  const host = new URL(syncCheck.url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    return syncCheck;
  }

  const doLookup =
    lookupFn ||
    ((hostname) => dns.promises.lookup(hostname, { all: true }));

  let records;
  try {
    records = await doLookup(host);
  } catch {
    return {
      ok: false,
      error: 'Impossible de resoudre le nom de domaine de l URL personnalisee.',
    };
  }

  const list = Array.isArray(records) ? records : records ? [records] : [];
  if (list.length === 0) {
    return {
      ok: false,
      error: 'Aucune adresse IP resolue pour l URL personnalisee.',
    };
  }

  for (const entry of list) {
    const addr = typeof entry === 'string' ? entry : entry?.address;
    if (isBlockedIp(addr)) {
      return {
        ok: false,
        error: 'Le nom de domaine pointe vers une adresse IP privee ou locale interdite.',
      };
    }
  }

  return syncCheck;
}

function createUserKeyStore(dataDir, options = {}) {
  // Par defaut (tests / stores isoles) la cle reste dans dataDir ;
  // le store de production passe un chemin HORS de data/ (voir defaultStore).
  const masterKeyPath =
    options.masterKeyPath || path.join(dataDir, masterKeyLib.LEGACY_MASTER_KEY_FILENAME);
  const legacyMasterKeyPaths = Array.isArray(options.legacyMasterKeyPaths)
    ? options.legacyMasterKeyPaths
    : [];
  const keysPath = path.join(dataDir, 'user-keys.json');
  let cachedFileKey = null;

  function ensureDir() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }

  function getMasterKey() {
    if (process.env.KEY_ENCRYPTION_SECRET) {
      return crypto.scryptSync(
        process.env.KEY_ENCRYPTION_SECRET,
        'ninteli-user-keys-v1',
        32
      );
    }

    if (!cachedFileKey) {
      cachedFileKey = masterKeyLib.loadOrCreateFileMasterKey({
        keyPath: masterKeyPath,
        legacyPaths: legacyMasterKeyPaths,
      });
    }
    return cachedFileKey;
  }

  function readStore() {
    try {
      if (!fs.existsSync(keysPath)) return {};
      const raw = fs.readFileSync(keysPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeStore(store) {
    ensureDir();
    const tmpPath = keysPath + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, keysPath);
    fs.chmodSync(keysPath, 0o600);
  }

  function encryptSecret(plaintext) {
    const masterKey = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };
  }

  function decryptSecret(secret) {
    if (!secret || !secret.iv || !secret.tag || !secret.data) return null;
    try {
      const masterKey = getMasterKey();
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        masterKey,
        Buffer.from(secret.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(secret.data, 'base64')),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      return null;
    }
  }

  function setUserConfig(userId, { provider, apiKey, model, customUrl }) {
    const uid = String(userId || '').trim();
    if (!uid) {
      return { ok: false, error: 'Identifiant utilisateur invalide.' };
    }

    const providerKey = String(provider || '').trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, providerKey)) {
      return { ok: false, error: 'Fournisseur inconnu : ' + provider };
    }
    const preset = PROVIDERS[providerKey];

    const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (cleanKey.length < 8 || cleanKey.length > 512 || /\s/.test(cleanKey)) {
      return {
        ok: false,
        error: 'Cle API invalide (8 a 512 caracteres sans espaces ni retours a la ligne).',
      };
    }

    let baseUrl = preset.baseUrl;
    if (providerKey === 'custom') {
      const urlCheck = validateCustomUrl(customUrl);
      if (!urlCheck.ok) {
        return { ok: false, error: urlCheck.error };
      }
      baseUrl = urlCheck.url;
    }

    const cleanModel = typeof model === 'string' ? model.trim() : '';
    const resolvedModel = cleanModel || preset.defaultModel || '';
    if (!resolvedModel) {
      return {
        ok: false,
        error: 'Le nom du modele est requis pour le fournisseur Personnalise.',
      };
    }

    const maskedKey = maskApiKey(cleanKey);
    const store = readStore();
    store[uid] = {
      provider: preset.id,
      label: preset.label,
      baseUrl,
      model: resolvedModel,
      maskedKey,
      updatedAt: new Date().toISOString(),
      secret: encryptSecret(cleanKey),
    };
    writeStore(store);

    return {
      ok: true,
      summary: {
        provider: preset.id,
        label: preset.label,
        baseUrl,
        model: resolvedModel,
        maskedKey,
      },
    };
  }

  function getUserConfig(userId) {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    const store = readStore();
    const record = Object.prototype.hasOwnProperty.call(store, uid) ? store[uid] : null;
    if (!record || !record.secret) return null;

    const apiKey = decryptSecret(record.secret);
    if (!apiKey) return null;

    return {
      provider: record.provider,
      label: record.label,
      baseUrl: record.baseUrl,
      model: record.model,
      apiKey,
      maskedKey: record.maskedKey,
    };
  }

  function getUserStatus(userId) {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    const store = readStore();
    const record = Object.prototype.hasOwnProperty.call(store, uid) ? store[uid] : null;
    if (!record) return null;

    return {
      provider: record.provider,
      label: record.label,
      baseUrl: record.baseUrl,
      model: record.model,
      maskedKey: record.maskedKey,
      updatedAt: record.updatedAt,
    };
  }

  function clearUserConfig(userId) {
    const uid = String(userId || '').trim();
    if (!uid) return false;
    const store = readStore();
    if (!Object.prototype.hasOwnProperty.call(store, uid)) {
      return false;
    }
    delete store[uid];
    writeStore(store);
    return true;
  }

  function updateUserModel(userId, newModel) {
    const uid = String(userId || '').trim();
    if (!uid) {
      return { ok: false, error: 'Identifiant utilisateur invalide.' };
    }

    const cleanModel = typeof newModel === 'string' ? newModel.trim() : '';
    if (!cleanModel || cleanModel.length > 120 || /\s/.test(cleanModel)) {
      return {
        ok: false,
        error: 'Nom de modele invalide (1 a 120 caracteres sans espaces).',
      };
    }

    const store = readStore();
    if (!Object.prototype.hasOwnProperty.call(store, uid)) {
      return {
        ok: false,
        error: 'Aucune cle API configuree. Utilise d abord /apikey set.',
      };
    }

    const record = store[uid];
    record.model = cleanModel;
    record.updatedAt = new Date().toISOString();
    writeStore(store);

    return {
      ok: true,
      summary: {
        provider: record.provider,
        label: record.label,
        baseUrl: record.baseUrl,
        model: cleanModel,
        maskedKey: record.maskedKey,
      },
    };
  }

  return {
    setUserConfig,
    getUserConfig,
    getUserStatus,
    clearUserConfig,
    updateUserModel,
  };
}

const DEFAULT_DATA_DIR = path.join(__dirname, '../../data');
const defaultStore = createUserKeyStore(
  DEFAULT_DATA_DIR,
  masterKeyLib.defaultKeyOptions(DEFAULT_DATA_DIR)
);

module.exports = {
  PROVIDERS,
  maskApiKey,
  validateCustomUrl,
  validateCustomUrlDns,
  isBlockedIp,
  createUserKeyStore,
  setUserConfig: defaultStore.setUserConfig,
  getUserConfig: defaultStore.getUserConfig,
  getUserStatus: defaultStore.getUserStatus,
  clearUserConfig: defaultStore.clearUserConfig,
  updateUserModel: defaultStore.updateUserModel,
};
