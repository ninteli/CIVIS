const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const masterKey = require('../src/agent/master-key');
const userKeys = require('../src/agent/user-keys');
const actionLogs = require('../src/discord/action-logs');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'civis-mk-'));
}

test('getDefaultMasterKeyPath : hors de data/, respecte CIVIS_MASTER_KEY_FILE et XDG_CONFIG_HOME', () => {
  assert.equal(
    masterKey.getDefaultMasterKeyPath({ CIVIS_MASTER_KEY_FILE: '/srv/secret/civis.key' }),
    '/srv/secret/civis.key'
  );
  assert.equal(
    masterKey.getDefaultMasterKeyPath({ XDG_CONFIG_HOME: '/tmp/cfg' }),
    path.join('/tmp/cfg', 'civis', 'master.key')
  );
  const def = masterKey.getDefaultMasterKeyPath({});
  assert.equal(def, path.join(os.homedir(), '.config', 'civis', 'master.key'));
  assert.ok(!def.includes(path.join('ninteli-ai', 'data')));
});

test('migration : data/.master.key est deplacee, conservee a l identique et en 0600', () => {
  const root = mkTmp();
  const dataDir = path.join(root, 'data');
  const keyPath = path.join(root, 'cfg', 'civis', 'master.key');
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyKey = crypto.randomBytes(32);
  const legacyPath = path.join(dataDir, '.master.key');
  fs.writeFileSync(legacyPath, legacyKey.toString('hex') + '\n', { mode: 0o600 });

  const loaded = masterKey.loadOrCreateFileMasterKey({ keyPath, legacyPaths: [legacyPath] });
  assert.ok(loaded.equals(legacyKey));
  assert.equal(fs.existsSync(legacyPath), false, 'ancienne cle supprimee de data/');
  assert.equal(fs.existsSync(keyPath), true);
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(keyPath)).mode & 0o777, 0o700);

  // Rechargement idempotent
  const again = masterKey.loadOrCreateFileMasterKey({ keyPath, legacyPaths: [legacyPath] });
  assert.ok(again.equals(legacyKey));
});

test('migration : ne remplace jamais une cle deja presente au nouvel emplacement', () => {
  const root = mkTmp();
  const legacyPath = path.join(root, 'data', '.master.key');
  const keyPath = path.join(root, 'cfg', 'master.key');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(legacyPath, crypto.randomBytes(32).toString('hex'));
  fs.writeFileSync(keyPath, newKey.toString('hex'));

  const loaded = masterKey.loadOrCreateFileMasterKey({ keyPath, legacyPaths: [legacyPath] });
  assert.ok(loaded.equals(newKey));
  assert.equal(fs.existsSync(legacyPath), true, 'ancienne cle laissee intacte en cas de conflit');
});

test('stores user-keys et guild-logs : donnees chiffrees avant migration toujours lisibles apres', () => {
  const prevSecret = process.env.KEY_ENCRYPTION_SECRET;
  delete process.env.KEY_ENCRYPTION_SECRET;
  try {
    const root = mkTmp();
    const dataDir = path.join(root, 'data');
    const keyPath = path.join(root, 'cfg', 'civis', 'master.key');

    // 1) Ancien comportement : cle dans data/
    const oldUserStore = userKeys.createUserKeyStore(dataDir);
    const setRes = oldUserStore.setUserConfig('42', { provider: 'openai', apiKey: 'sk-test-12345678' });
    assert.equal(setRes.ok, true);
    const oldLogStore = actionLogs.createGuildLogStore(dataDir);
    assert.ok(fs.existsSync(path.join(dataDir, '.master.key')));

    // 2) Nouveau comportement : cle hors de data/ avec migration
    const opts = { masterKeyPath: keyPath, legacyMasterKeyPaths: [path.join(dataDir, '.master.key')] };
    const newUserStore = userKeys.createUserKeyStore(dataDir, opts);
    const cfg = newUserStore.getUserConfig('42');
    assert.equal(cfg.apiKey, 'sk-test-12345678');
    assert.equal(fs.existsSync(path.join(dataDir, '.master.key')), false);
    assert.equal(fs.existsSync(keyPath), true);

    const newLogStore = actionLogs.createGuildLogStore(dataDir, opts);
    assert.equal(typeof newLogStore, 'object');
    assert.equal(typeof oldLogStore, 'object');
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.includes('master')), []);
  } finally {
    if (prevSecret === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
    else process.env.KEY_ENCRYPTION_SECRET = prevSecret;
  }
});
