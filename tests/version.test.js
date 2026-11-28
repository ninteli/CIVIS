const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ActivityType } = require('discord.js');

const versionManager = require('../src/version');
const registerEvents = require('../src/discord/events');
const { applyVersionPresence } = registerEvents;
const { handleInteraction } = require('../src/discord/commands');
const uiV2 = require('../src/discord/ui-v2');

function makeTempProject(initialVersion = '1.0.0') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'civis-version-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'civis-test',
        version: initialVersion,
        dependencies: { dotenv: '^18.0.8' },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("init");\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'start.sh'), '#!/bin/bash\necho start\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = () => 1;\n', 'utf8');
  return dir;
}

describe('Systeme de Snapshot de version et statut Discord', () => {
  it('cree src/version.json et met a jour package.json au premier snapshot', () => {
    const dir = makeTempProject('1.0.0');
    try {
      const now = new Date(2026, 10, 28, 17, 0, 0);
      const res = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });

      assert.equal(res.changed, true);
      assert.equal(res.reason, 'initial');
      assert.equal(res.version, '1.0.0-snapshot.20261128.1');
      assert.equal(res.baseVersion, '1.0.0');
      assert.equal(res.date, '20261128');
      assert.equal(res.build, 1);
      assert.equal(res.gitCommit, null);

      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'src', 'version.json'), 'utf8'));
      assert.equal(stored.version, '1.0.0-snapshot.20261128.1');
      assert.equal(stored.hash, res.hash);

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.equal(pkg.version, '1.0.0-snapshot.20261128.1');
      assert.equal(versionManager.getCurrentVersion(dir), '1.0.0-snapshot.20261128.1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('est idempotent si aucune modification du code n a eu lieu', () => {
    const dir = makeTempProject('1.0.0');
    try {
      const t1 = new Date(2026, 10, 28, 17, 0, 0);
      const first = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now: t1,
        includeGitCommit: false,
      });
      const t2 = new Date(2026, 10, 28, 18, 30, 0);
      const second = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now: t2,
        includeGitCommit: false,
      });

      assert.equal(second.changed, false);
      assert.equal(second.reason, 'unchanged');
      assert.equal(second.version, first.version);
      assert.equal(second.hash, first.hash);
      assert.equal(second.updatedAt, first.updatedAt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('incremente le compteur sur modification le meme jour et reinitialise a 1 un nouveau jour', () => {
    const dir = makeTempProject('1.0.0');
    try {
      const day1 = new Date(2026, 10, 28, 10, 0, 0);
      const v1 = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now: day1,
        includeGitCommit: false,
      });
      assert.equal(v1.version, '1.0.0-snapshot.20261128.1');

      fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'module.exports = () => 2;\n', 'utf8');
      const v2 = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now: new Date(2026, 10, 28, 12, 0, 0),
        includeGitCommit: false,
      });
      assert.equal(v2.changed, true);
      assert.equal(v2.reason, 'code_changed');
      assert.equal(v2.version, '1.0.0-snapshot.20261128.2');

      fs.writeFileSync(path.join(dir, 'index.js'), 'console.log("changed");\n', 'utf8');
      const v3 = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now: new Date(2026, 10, 29, 9, 0, 0),
        includeGitCommit: false,
      });
      assert.equal(v3.changed, true);
      assert.equal(v3.reason, 'code_changed');
      assert.equal(v3.version, '1.0.0-snapshot.20261129.1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detecte ajout/suppression dans src/ et ignore data/, tests/, .env et logs', () => {
    const dir = makeTempProject('1.0.0');
    try {
      const now = new Date(2026, 10, 28, 14, 0, 0);
      const base = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });

      fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'data', 'guild-logs.json'), '{"a":1}\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'tests', 'foo.test.js'), 'test();\n', 'utf8');
      fs.writeFileSync(path.join(dir, '.env'), 'DISCORD_TOKEN=secret\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'llama-server.log'), 'log line\n', 'utf8');

      const afterIgnored = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });
      assert.equal(afterIgnored.changed, false);
      assert.equal(afterIgnored.hash, base.hash);

      fs.writeFileSync(path.join(dir, 'src', 'extra.js'), 'module.exports = true;\n', 'utf8');
      const afterAdd = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });
      assert.equal(afterAdd.changed, true);
      assert.equal(afterAdd.version, '1.0.0-snapshot.20261128.2');

      fs.unlinkSync(path.join(dir, 'src', 'extra.js'));
      const afterDelete = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });
      assert.equal(afterDelete.changed, true);
      assert.equal(afterDelete.version, '1.0.0-snapshot.20261128.3');
      assert.equal(afterDelete.hash, base.hash);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gere les modifications de package.json (dependances, nouvelle base, resync version)', () => {
    const dir = makeTempProject('1.0.0');
    try {
      const now = new Date(2026, 10, 28, 16, 0, 0);
      const pkgPath = path.join(dir, 'package.json');

      const v1 = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });
      assert.equal(v1.version, '1.0.0-snapshot.20261128.1');

      // Editer les dependances declenche un nouveau snapshot
      const pkgDep = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkgDep.dependencies['discord.js'] = '^14.27.0';
      fs.writeFileSync(pkgPath, JSON.stringify(pkgDep, null, 2) + '\n', 'utf8');

      const v2 = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });
      assert.equal(v2.changed, true);
      assert.equal(v2.reason, 'code_changed');
      assert.equal(v2.version, '1.0.0-snapshot.20261128.2');

      // Remettre manuellement package.json a 1.0.0 sans changer le code resynchronise sans incrementer
      const pkgReset = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkgReset.version = '1.0.0';
      fs.writeFileSync(pkgPath, JSON.stringify(pkgReset, null, 2) + '\n', 'utf8');

      const resynced = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });
      assert.equal(resynced.changed, false);
      assert.equal(resynced.version, '1.0.0-snapshot.20261128.2');
      assert.equal(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version, '1.0.0-snapshot.20261128.2');

      // Changer la version de base (1.0.0 -> 1.1.0) remet le compteur snapshot a 1
      const pkgBump = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkgBump.version = '1.1.0';
      fs.writeFileSync(pkgPath, JSON.stringify(pkgBump, null, 2) + '\n', 'utf8');

      const v3 = versionManager.syncSnapshotVersion({
        rootDir: dir,
        now,
        includeGitCommit: false,
      });
      assert.equal(v3.changed, true);
      assert.equal(v3.reason, 'base_version_changed');
      assert.equal(v3.version, '1.1.0-snapshot.20261128.1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applique la version en statut Discord Custom sur clientReady et supporte les mocks sans setPresence', () => {
    const presences = [];
    const handlers = {};
    const mockClient = {
      user: {
        id: 'bot-version',
        tag: 'CIVIS#0001',
        setPresence: (payload) => {
          presences.push(payload);
        },
      },
      once: (ev, fn) => {
        handlers['once:' + ev] = fn;
      },
      on: (ev, fn) => {
        handlers[ev] = fn;
      },
    };

    registerEvents(mockClient);
    assert.equal(typeof handlers['once:clientReady'], 'function');

    handlers['once:clientReady']();
    assert.equal(presences.length, 1);
    const expectedStatus = versionManager.formatStatusText(versionManager.getCurrentVersion());
    assert.deepEqual(presences[0], {
      status: 'online',
      activities: [
        {
          name: expectedStatus,
          state: expectedStatus,
          type: ActivityType.Custom,
        },
      ],
    });

    const explicit = applyVersionPresence(mockClient, '1.2.3-snapshot.20261128.4');
    assert.equal(explicit, 'v1.2.3-snapshot.20261128.4');
    assert.equal(presences[1].activities[0].state, 'v1.2.3-snapshot.20261128.4');

    // Client minimal sans setPresence ne doit pas jeter d erreur
    assert.equal(applyVersionPresence({ user: { id: 'minimal' } }, '1.0.0'), null);
    assert.equal(applyVersionPresence(null, '1.0.0'), null);
  });

  it('/ping inclut le numero de version actuel', async () => {
    let pingReply = null;
    await handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'ping',
      channel: { id: 'c-version' },
      user: { id: 'u-ping-ver' },
      member: null,
      client: { ws: { ping: 27 } },
      reply: async (payload) => {
        pingReply = payload;
      },
    });

    const text = uiV2.extractV2Text(pingReply);
    const currentVersion = versionManager.getCurrentVersion();
    assert.ok(text.includes(`v${currentVersion}`), `La reponse /ping doit contenir v${currentVersion}`);
  });
});
