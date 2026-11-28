const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, Collection, PermissionsBitField, PermissionFlagsBits } = require('discord.js');

const antiNuke = require('../src/agent/anti-nuke');
const planner = require('../src/agent/planner');
const planImport = require('../src/discord/plan-import');
const plans = require('../src/discord/plans');
const { executeTool, executeUndoAction } = require('../src/agent/tool-executor');
const { handleInteraction } = require('../src/discord/commands');
const actionLogs = require('../src/discord/action-logs');
const rateLimit = require('../src/agent/rate-limit');
const { extractV2Text, extractV2Buttons } = require('../src/discord/ui-v2');

function makeTestEnv() {
  const ownerId = '900000000000000001';
  const adminId = '900000000000000002';
  const botId = '900000000000000099';
  const guildId = '800000000000000001';

  const ownerMember = {
    id: ownerId,
    displayName: 'Proprio',
    user: { id: ownerId, username: 'Proprio' },
    permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    roles: { highest: { position: 20 } },
  };
  const nonOwnerAdmin = {
    id: adminId,
    displayName: 'AdminCompromis',
    user: { id: adminId, username: 'AdminCompromis' },
    permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    roles: { highest: { position: 15 } },
  };
  const botMember = {
    id: botId,
    displayName: 'CIVIS',
    user: { id: botId, username: 'CIVIS' },
    permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    roles: { highest: { position: 18 } },
  };

  const logMessagesSent = [];
  const deletedChannels = [];
  const createdChannels = [];

  const chLogs = {
    id: '100000000000000001',
    name: 'logs',
    type: ChannelType.GuildText,
    topic: 'Journal du serveur',
    parentId: null,
    permissionOverwrites: { cache: new Map() },
    send: async (payload) => {
      logMessagesSent.push(payload);
      return { id: 'log-msg-' + logMessagesSent.length };
    },
    delete: async () => deletedChannels.push('100000000000000001'),
    edit: async () => {},
  };

  const chRules = {
    id: '100000000000000002',
    name: 'charte',
    type: ChannelType.GuildText,
    topic: 'Regles du serveur',
    parentId: null,
    permissionOverwrites: { cache: new Map() },
    delete: async () => deletedChannels.push('100000000000000002'),
    edit: async () => {},
  };

  const chUpdates = {
    id: '100000000000000003',
    name: 'actus-discord',
    type: ChannelType.GuildText,
    topic: '',
    parentId: null,
    permissionOverwrites: { cache: new Map() },
    delete: async () => deletedChannels.push('100000000000000003'),
    edit: async () => {},
  };

  const chSecurity = {
    id: '100000000000000004',
    name: '🔒・sécurité',
    type: ChannelType.GuildText,
    topic: '',
    parentId: null,
    permissionOverwrites: { cache: new Map() },
    delete: async () => deletedChannels.push('100000000000000004'),
    edit: async () => {},
  };

  const chProtectedFr = {
    id: '100000000000000005',
    name: 'tresor-fr',
    type: ChannelType.GuildText,
    topic: 'Archive importante — NE TOUCHE PAS À ÇA CIVIS merci',
    parentId: null,
    permissionOverwrites: { cache: new Map() },
    delete: async () => deletedChannels.push('100000000000000005'),
    edit: async () => {},
  };

  const chProtectedEn = {
    id: '100000000000000006',
    name: 'vault-en',
    type: ChannelType.GuildText,
    topic: 'Important stuff (DO NOT TOUCH CIVIS)',
    parentId: null,
    permissionOverwrites: { cache: new Map() },
    delete: async () => deletedChannels.push('100000000000000006'),
    edit: async () => {},
  };

  const chNormal = {
    id: '100000000000000007',
    name: 'general',
    type: ChannelType.GuildText,
    topic: 'Discussions normales',
    parentId: null,
    rateLimitPerUser: 0,
    nsfw: false,
    permissionOverwrites: { cache: new Map() },
    delete: async () => deletedChannels.push('100000000000000007'),
    edit: async (updates) => {
      Object.assign(chNormal, updates);
    },
  };

  const channelsMap = new Collection([
    [chLogs.id, chLogs],
    [chRules.id, chRules],
    [chUpdates.id, chUpdates],
    [chSecurity.id, chSecurity],
    [chProtectedFr.id, chProtectedFr],
    [chProtectedEn.id, chProtectedEn],
    [chNormal.id, chNormal],
  ]);

  const guild = {
    id: guildId,
    name: 'Serveur Protege',
    ownerId,
    rulesChannelId: chRules.id,
    rulesChannel: chRules,
    publicUpdatesChannelId: chUpdates.id,
    publicUpdatesChannel: chUpdates,
    roles: {
      cache: new Map([
        [
          guildId,
          {
            id: guildId,
            name: '@everyone',
            position: 0,
            managed: false,
            permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
          },
        ],
      ]),
      create: async (opts) => {
        const r = {
          id: '2000000000000000' + (guild.roles.cache.size + 10),
          name: opts.name,
          hexColor: '#000000',
          hoist: Boolean(opts.hoist),
          mentionable: Boolean(opts.mentionable),
          delete: async () => {
            guild.roles.cache.delete(r.id);
          },
        };
        guild.roles.cache.set(r.id, r);
        return r;
      },
    },
    channels: {
      cache: channelsMap,
      create: async (opts) => {
        const id = '1000000000000000' + (createdChannels.length + 50);
        const c = {
          id,
          name: opts.name,
          type: opts.type ?? ChannelType.GuildText,
          parentId: opts.parent ?? null,
          parent: null,
          permissionOverwrites: { cache: new Map() },
          delete: async () => {
            deletedChannels.push(id);
            channelsMap.delete(id);
          },
          edit: async (u) => Object.assign(c, u),
        };
        createdChannels.push(c);
        channelsMap.set(id, c);
        return c;
      },
    },
    members: {
      me: botMember,
      cache: new Map([
        [ownerId, ownerMember],
        [adminId, nonOwnerAdmin],
        [botId, botMember],
      ]),
    },
  };

  return {
    guild,
    ownerMember,
    nonOwnerAdmin,
    logMessagesSent,
    deletedChannels,
    createdChannels,
    channels: { chLogs, chRules, chUpdates, chSecurity, chProtectedFr, chProtectedEn, chNormal },
  };
}

describe('Securite Anti-Nuke, salons vitaux, arret d urgence et rollback 300s', () => {
  beforeEach(() => {
    antiNuke.clearAll();
    plans.clearAllPendingPlans();
    rateLimit.clearAll();
    actionLogs.clearWebhookCache();
  });

  it('interdit la suppression et l archivage des salons vitaux (regles, mises a jour Discord, topic protege FR/EN pour tous ; mots-cles logs/securite pour les non-proprietaires uniquement)', async () => {
    const { guild, ownerMember, nonOwnerAdmin, channels, deletedChannels } = makeTestEnv();

    const alwaysProtectedTargets = [
      channels.chRules,
      channels.chUpdates,
      channels.chProtectedFr,
      channels.chProtectedEn,
    ];
    const keywordProtectedTargets = [channels.chLogs, channels.chSecurity];

    // 1. Les protections absolues (regles, mises a jour, topic protege) bloquent meme le proprietaire
    for (const ch of alwaysProtectedTargets) {
      const delRes = await executeTool(
        'delete_channel',
        { channel: ch.id },
        { guild, member: ownerMember, mode: 'agent', confirmed: true }
      );
      assert.equal(delRes.ok, false, `delete_channel devait bloquer #${ch.name}`);
      assert.equal(delRes.protectedChannel, true);

      const archRes = await executeTool(
        'archive_channel',
        { channel: ch.id },
        { guild, member: ownerMember, mode: 'agent' }
      );
      assert.equal(archRes.ok, false, `archive_channel devait bloquer #${ch.name}`);
      assert.equal(archRes.protectedChannel, true);

      const planRes = planner.validateAndAnalyzePlan(
        { summary: 'Test', steps: [{ tool: 'delete_channel', args: { channel: ch.id } }] },
        guild,
        ownerMember
      );
      assert.equal(planRes.ok, false);
      assert.equal(planRes.protectedChannel, true);
    }

    // 2. Les salons proteges uniquement par mot-cle (logs, securite) bloquent toujours les non-proprietaires
    for (const ch of keywordProtectedTargets) {
      const delRes = await executeTool(
        'delete_channel',
        { channel: ch.id },
        { guild, member: nonOwnerAdmin, mode: 'agent', confirmed: true }
      );
      assert.equal(delRes.ok, false, `delete_channel devait bloquer #${ch.name} pour un non-proprietaire`);
      assert.equal(delRes.protectedChannel, true);

      const archRes = await executeTool(
        'archive_channel',
        { channel: ch.id },
        { guild, member: nonOwnerAdmin, mode: 'agent' }
      );
      assert.equal(archRes.ok, false, `archive_channel devait bloquer #${ch.name} pour un non-proprietaire`);
      assert.equal(archRes.protectedChannel, true);

      const planRes = planner.validateAndAnalyzePlan(
        { summary: 'Test', steps: [{ tool: 'archive_channel', args: { channel: ch.id } }] },
        guild,
        nonOwnerAdmin
      );
      assert.equal(planRes.ok, false);
      assert.equal(planRes.protectedChannel, true);
    }

    assert.equal(deletedChannels.length, 0);

    // 3. Le proprietaire peut archiver/supprimer/planifier sur un salon uniquement matche par mot-cle (ex: #logs, #securite)
    for (const ch of keywordProtectedTargets) {
      const planRes = planner.validateAndAnalyzePlan(
        { summary: 'Archivage vieux logs', steps: [{ tool: 'archive_channel', args: { channel: ch.id } }] },
        guild,
        ownerMember
      );
      assert.equal(planRes.ok, true, `Le proprietaire doit pouvoir planifier sur #${ch.name}`);

      const delRes = await executeTool(
        'delete_channel',
        { channel: ch.id },
        { guild, member: ownerMember, mode: 'agent', confirmed: true }
      );
      assert.equal(delRes.ok, true, `Le proprietaire doit pouvoir supprimer #${ch.name}`);
    }

    assert.equal(deletedChannels.length, keywordProtectedTargets.length);
  });

  it('bloque en pre-validation les tentatives de raid pour un non-proprietaire (mais pas pour le proprietaire)', async () => {
    const { guild, ownerMember, nonOwnerAdmin } = makeTestEnv();

    const raidPlan = {
      summary: 'Raid test',
      steps: [
        { tool: 'create_channel', args: { name: 'raid by HACKER', type: 'text' } },
        { tool: 'create_channel', args: { name: 'raid by HACKER', type: 'text' } },
        { tool: 'create_channel', args: { name: 'raid by HACKER', type: 'text' } },
        { tool: 'create_channel', args: { name: 'raid by HACKER', type: 'text' } },
      ],
    };

    const nonOwnerRes = planner.validateAndAnalyzePlan(raidPlan, guild, nonOwnerAdmin);
    assert.equal(nonOwnerRes.ok, true);
    assert.equal(nonOwnerRes.security.antiNukeBlocked, true);
    assert.equal(nonOwnerRes.security.requiresOwnerApproval, true);
    assert.equal(nonOwnerRes.security.requesterAuthorized, false);
    assert.match(nonOwnerRes.security.antiNukeReason, /Motif de raid/i);

    // Le proprietaire reste libre de creer un serveur entier (ex: 10 salons normaux)
    const serverBuildPlan = {
      summary: 'Creation serveur complet',
      steps: Array.from({ length: 10 }, (_, i) => ({
        tool: 'create_channel',
        args: { name: `salon-officiel-${i + 1}`, type: 'text' },
      })),
    };
    const ownerRes = planner.validateAndAnalyzePlan(serverBuildPlan, guild, ownerMember);
    assert.equal(ownerRes.ok, true);
    assert.equal(ownerRes.security.antiNukeBlocked, false);
    assert.equal(ownerRes.security.requesterAuthorized, true);
  });

  it('declenche un blocage de 10 minutes en cas de rafale, alerte #logs en mentionnant le proprietaire, et seul le proprietaire peut debloquer', async () => {
    const { guild, ownerMember, nonOwnerAdmin, logMessagesSent } = makeTestEnv();

    // 1. /import d'un script de raid par un non-proprietaire -> bloque 10 min + alerte #logs + demande proprietaire
    const raidJson = JSON.stringify({
      summary: 'Nuke serveur',
      steps: [
        { tool: 'create_channel', args: { name: 'raid by EVE', type: 'text' } },
        { tool: 'create_channel', args: { name: 'raid by EVE', type: 'text' } },
      ],
    });

    const edits = [];
    const importInt = {
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'import',
      guild,
      channel: { id: '100000000000000007' },
      user: nonOwnerAdmin.user,
      member: nonOwnerAdmin,
      client: { user: { username: 'CIVIS' } },
      options: {
        getAttachment: () => null,
        getString: (name) => (name === 'json' ? raidJson : null),
      },
      reply: async () => {},
      deferReply: async () => {},
      editReply: async (payload) => {
        edits.push(payload);
        return { id: 'plan-msg-1', edit: async () => {} };
      },
    };

    await handleInteraction(importInt);

    // Verifier blocage de 10 minutes actif
    const lock = antiNuke.checkUserLockout(guild.id, nonOwnerAdmin.id);
    assert.equal(lock.locked, true);
    assert.ok(lock.remainingSec > 580 && lock.remainingSec <= 600);

    // Verifier alerte envoyee dans #logs avec mention du proprietaire
    assert.equal(logMessagesSent.length, 1);
    assert.match(extractV2Text(logMessagesSent[0]), new RegExp(`<@${ownerMember.id}>`));
    assert.deepEqual(logMessagesSent[0].allowedMentions, { users: [ownerMember.id] });

    // Verifier carte d'approbation proprietaire
    assert.equal(edits.length, 1);
    const buttons = extractV2Buttons(edits[0]);
    const unlockBtn = buttons.find((b) => b.custom_id.startsWith('plan:owner_unlock:'));
    const denyBtn = buttons.find((b) => b.custom_id.startsWith('plan:owner_deny:'));
    assert.ok(unlockBtn, 'Bouton deblocage proprietaire attendu');
    assert.ok(denyBtn, 'Bouton refus proprietaire attendu');

    // 2. Toute nouvelle commande de l'utilisateur bloque est refusee pendant 10 min
    const blockedReplies = [];
    await handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'ping',
      guild,
      channel: { id: '100000000000000007' },
      user: nonOwnerAdmin.user,
      member: nonOwnerAdmin,
      client: { user: { username: 'CIVIS' } },
      reply: async (p) => blockedReplies.push(p),
    });
    assert.equal(blockedReplies.length, 1);
    assert.match(extractV2Text(blockedReplies[0]), /bloque par l anti-nuke/i);

    // 3. Le proprietaire clique sur "Maintenir le blocage" -> accepte ; un autre admin serait refuse
    const ownerUpdates = [];
    await plans.handlePlanButton({
      customId: denyBtn.custom_id,
      guild,
      user: ownerMember.user,
      member: ownerMember,
      client: { user: { username: 'CIVIS' } },
      update: async (p) => ownerUpdates.push(p),
      reply: async () => {},
    });
    assert.equal(ownerUpdates.length, 1);
    assert.equal(antiNuke.checkUserLockout(guild.id, nonOwnerAdmin.id).locked, true);
  });

  it('bouton Arret d urgence interrompt l execution et le bouton Retour en arriere (300s) annule les changements', async () => {
    const { guild, ownerMember, createdChannels, deletedChannels } = makeTestEnv();

    const planRes = planner.validateAndAnalyzePlan(
      {
        summary: 'Creer 3 salons',
        steps: [
          { tool: 'create_channel', args: { name: 'alpha', type: 'text' } },
          { tool: 'create_channel', args: { name: 'beta', type: 'text' } },
          { tool: 'create_channel', args: { name: 'gamma', type: 'text' } },
        ],
      },
      guild,
      ownerMember
    );
    assert.equal(planRes.ok, true);

    const cardEdits = [];
    const planId = await plans.createPlanRequest({
      interaction: {
        member: ownerMember,
        editReply: async (p) => {
          cardEdits.push(p);
          return { id: 'msg-exec', edit: async () => {} };
        },
      },
      channel: { id: '100000000000000007' },
      guild,
      requester: ownerMember.user,
      plan: planRes.plan,
      security: planRes.security,
      userText: 'Creer 3 salons',
      stepDelayMs: 60,
    });

    // Lancer l'execution en parallele et declencher l'arret d'urgence pendant le delai de l'etape 1
    let stopTriggered = false;
    const stopReplies = [];
    const execEdits = [];

    const execPromise = plans.handlePlanButton({
      customId: `plan:execute:${planId}`,
      guild,
      user: ownerMember.user,
      member: ownerMember,
      client: { user: { username: 'CIVIS' } },
      deferUpdate: async () => {},
      editReply: async (p) => {
        execEdits.push(p);
        // Des que le bouton Arret d'urgence apparait et que le 1er salon est cree, cliquer STOP
        const btns = extractV2Buttons(p);
        const stopBtn = btns.find((b) => b.custom_id === `plan:stop:${planId}`);
        if (stopBtn && !stopTriggered) {
          stopTriggered = true;
          // Laisser le 1er step s'executer puis cliquer STOP pendant stepDelayMs
          setTimeout(() => {
            plans.handlePlanButton({
              customId: `plan:stop:${planId}`,
              guild,
              user: ownerMember.user,
              member: ownerMember,
              client: { user: { username: 'CIVIS' } },
              reply: async (r) => stopReplies.push(r),
            });
          }, 15);
        }
      },
      reply: async () => {},
    });

    await execPromise;

    assert.equal(stopReplies.length, 1);
    assert.match(extractV2Text(stopReplies[0]), /Arret d urgence declenche/);
    // L'execution a ete interrompue avant de creer les 3 salons
    assert.ok(createdChannels.length >= 1 && createdChannels.length < 3);

    // La carte finale doit contenir le bouton Retour en arriere (300s)
    const lastCard = execEdits[execEdits.length - 1];
    assert.match(extractV2Text(lastCard), /Execution arretee en urgence/);
    const rollbackBtn = extractV2Buttons(lastCard).find(
      (b) => b.custom_id === `plan:rollback:${planId}`
    );
    assert.ok(rollbackBtn, 'Bouton Retour en arriere (300s) doit etre present');
    assert.equal(rollbackBtn.disabled, false);

    // Cliquer sur Retour en arriere -> supprime les salons qui avaient ete crees !
    const rbEdits = [];
    await plans.handlePlanButton({
      customId: `plan:rollback:${planId}`,
      guild,
      user: ownerMember.user,
      member: ownerMember,
      client: { user: { username: 'CIVIS' } },
      deferUpdate: async () => {},
      editReply: async (p) => rbEdits.push(p),
      reply: async () => {},
    });

    assert.equal(deletedChannels.length, createdChannels.length);
    const finalRbCard = rbEdits[rbEdits.length - 1];
    assert.match(extractV2Text(finalRbCard), /Retour en arriere termine/);
  });

  it('executeUndoAction restaure proprement un salon modifie', async () => {
    const { guild, ownerMember, channels } = makeTestEnv();

    const modRes = await executeTool(
      'modify_channel',
      { channel: channels.chNormal.id, new_name: 'renomme-temp', slowmode: 30 },
      { guild, member: ownerMember, mode: 'agent' }
    );
    assert.equal(modRes.ok, true);
    assert.equal(channels.chNormal.name, 'renomme-temp');
    assert.equal(channels.chNormal.rateLimitPerUser, 30);

    const undoRes = await executeUndoAction(guild, modRes.undo);
    assert.equal(undoRes.ok, true);
    assert.equal(channels.chNormal.name, 'general');
    assert.equal(channels.chNormal.rateLimitPerUser, 0);
  });
});
