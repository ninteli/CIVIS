const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ChannelType,
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} = require('discord.js');

const actionLogs = require('../src/discord/action-logs');
const approvals = require('../src/discord/approvals');
const plans = require('../src/discord/plans');
const commands = require('../src/discord/commands');
const {
  V2_FLAG,
  V2_EPHEMERAL_FLAGS,
  estimateV2Metrics,
  extractV2Text,
} = require('../src/discord/ui-v2');

function createMockMember({ id = 'user-1', perms = ['Administrator'], highestPosition = 50 } = {}) {
  return {
    id,
    user: { id },
    permissions: new PermissionsBitField(perms),
    roles: { highest: { position: highestPosition } },
  };
}

function createMockGuild({ id, name = 'Test Guild', botPerms = ['Administrator'] } = {}) {
  const everyoneRole = {
    id,
    name: '@everyone',
    position: 0,
    permissions: new PermissionsBitField([]),
  };
  const rolesCache = new Collection();
  rolesCache.set(id, everyoneRole);
  const channelsCache = new Collection();
  const me = {
    id: 'bot-1',
    user: { id: 'bot-1' },
    permissions: new PermissionsBitField(botPerms),
    roles: { highest: { position: 99 } },
  };

  return {
    id,
    name,
    ownerId: 'owner-1',
    roles: { cache: rolesCache, everyone: everyoneRole },
    channels: {
      cache: channelsCache,
      async create({ name: chName, type, topic, parent, permissionOverwrites }) {
        const created = createMockTextChannel({
          id: 'created-' + chName,
          name: chName,
          type: type ?? ChannelType.GuildText,
          parent: parent || null,
          channelsCache,
        });
        created.topic = topic || '';
        created.permissionOverwritesData = permissionOverwrites || [];
        channelsCache.set(created.id, created);
        return created;
      },
    },
    members: { me },
  };
}

function createMockTextChannel({
  id = 'chan-1',
  name = 'general',
  type = ChannelType.GuildText,
  parent = null,
  channelsCache = null,
  denyManageWebhooks = false,
  denySendMessages = false,
  initialWebhooks = [],
} = {}) {
  const sentMessages = [];
  const webhooks = [...initialWebhooks];
  const createWebhookCalls = [];
  const editCalls = [];

  const channel = {
    id,
    name,
    type,
    parent,
    parentId: parent ? parent.id : null,
    deleted: false,
    sentMessages,
    webhooks,
    createWebhookCalls,
    editCalls,
    isTextBased() {
      return (
        this.type === ChannelType.GuildText ||
        this.type === ChannelType.GuildAnnouncement ||
        this.type === ChannelType.PublicThread
      );
    },
    isThread() {
      return (
        this.type === ChannelType.PublicThread ||
        this.type === ChannelType.PrivateThread
      );
    },
    permissionsFor() {
      const denied = [];
      if (denyManageWebhooks) denied.push(PermissionFlagsBits.ManageWebhooks);
      if (denySendMessages) denied.push(PermissionFlagsBits.SendMessages);
      return {
        has(perm) {
          return !denied.includes(perm);
        },
      };
    },
    async fetchWebhooks() {
      return new Collection(webhooks.map((w) => [w.id, w]));
    },
    async createWebhook({ name: whName, reason }) {
      const idx = createWebhookCalls.length + 1;
      const created = {
        id: `12345678901234567${idx}`,
        token: `tok_${idx}_abcdef`,
        url: `https://discord.com/api/webhooks/12345678901234567${idx}/tok_${idx}_abcdef`,
        name: whName,
        owner: { id: 'bot-1' },
      };
      createWebhookCalls.push({ name: whName, reason, created });
      webhooks.push(created);
      return created;
    },
    async send(payload) {
      sentMessages.push(payload);
      return { id: 'msg-' + sentMessages.length, payload };
    },
    async edit(updates) {
      editCalls.push(updates);
      if (updates.name !== undefined) channel.name = updates.name;
      if (updates.parent !== undefined) {
        channel.parent = updates.parent;
        channel.parentId = updates.parent?.id || updates.parent || null;
      }
      return channel;
    },
    async delete() {
      channel.deleted = true;
      if (channelsCache) channelsCache.delete(channel.id);
    },
    permissionOverwrites: {
      cache: new Collection(),
      async set() {},
      async edit() {},
    },
  };
  return channel;
}

describe('Systeme de logs automatiques et webhook (action-logs.js)', () => {
  const tempDirs = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninteli-logs-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    approvals.clearAllPending();
    plans.clearAllPendingPlans();
    actionLogs.clearWebhookCache();
    delete process.env.KEY_ENCRYPTION_SECRET;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('valide les URLs webhook Discord officielles, rejette le SSRF et masque le token', () => {
    const valid = actionLogs.validateDiscordWebhookUrl(
      'https://discord.com/api/webhooks/123456789012345678/SecretToken_XYZ-999/'
    );
    assert.equal(valid.ok, true);
    assert.equal(
      valid.url,
      'https://discord.com/api/webhooks/123456789012345678/SecretToken_XYZ-999'
    );
    assert.equal(
      actionLogs.validateDiscordWebhookUrl(
        'https://ptb.discordapp.com/api/webhooks/123456789012345678/abc_123'
      ).ok,
      true
    );

    const masked = actionLogs.maskWebhookUrl(valid.url);
    assert.equal(masked, 'https://discord.com/api/webhooks/123456789012345678/••••-999');
    assert.ok(!masked.includes('SecretToken'));

    const invalidCases = [
      '',
      null,
      'not-a-url',
      'http://discord.com/api/webhooks/123456789012345678/abc',
      'https://127.0.0.1/api/webhooks/123456789012345678/abc',
      'https://evil.example/api/webhooks/123456789012345678/abc',
      'https://discord.com/api/webhooks/123456789012345678/abc?wait=true',
      'https://user:pass@discord.com/api/webhooks/123456789012345678/abc',
    ];
    for (const bad of invalidCases) {
      assert.equal(actionLogs.validateDiscordWebhookUrl(bad).ok, false, `Should reject: ${bad}`);
    }
    assert.equal(actionLogs.maskWebhookUrl('http://evil.com/x'), 'url-invalide');
  });

  it('chiffre les webhooks en AES-256-GCM sur disque et gere channel/off/reset', () => {
    const tmpDir = makeTempDir();
    const store = actionLogs.createGuildLogStore(tmpDir);

    const defCfg = store.getGuildLogConfig('g-1');
    assert.equal(defCfg.enabled, true);
    assert.equal(defCfg.mode, 'auto');
    assert.equal(defCfg.webhookUrl, null);

    const secretUrl = 'https://discord.com/api/webhooks/987654321098765432/TopSecretToken_WXYZ';
    const saveRes = store.setWebhookUrl('g-1', secretUrl, 'admin-1');
    assert.equal(saveRes.ok, true);
    assert.equal(
      saveRes.maskedUrl,
      'https://discord.com/api/webhooks/987654321098765432/••••WXYZ'
    );

    const rawFile = fs.readFileSync(path.join(tmpDir, 'guild-logs.json'), 'utf8');
    assert.ok(!rawFile.includes('TopSecretToken_WXYZ'));
    assert.ok(rawFile.includes('aes-256-gcm'));
    assert.equal(fs.statSync(path.join(tmpDir, 'guild-logs.json')).mode & 0o777, 0o600);

    const status = store.getGuildLogStatus('g-1');
    assert.equal(status.mode, 'webhook');
    assert.equal(status.hasWebhook, true);
    assert.equal(status.maskedWebhookUrl, saveRes.maskedUrl);
    assert.equal(store.getGuildLogConfig('g-1').webhookUrl, secretUrl);

    store.setLogChannel('g-1', 'chan-99', 'admin-2');
    const chanCfg = store.getGuildLogConfig('g-1');
    assert.equal(chanCfg.mode, 'channel');
    assert.equal(chanCfg.channelId, 'chan-99');
    assert.equal(chanCfg.webhookUrl, null);

    store.disableLogs('g-1', 'admin-3');
    assert.equal(store.getGuildLogConfig('g-1').enabled, false);
    assert.equal(store.getGuildLogConfig('g-1').mode, 'off');

    store.resetLogs('g-1');
    assert.equal(store.getGuildLogConfig('g-1').mode, 'auto');
    assert.equal(store.getGuildLogConfig('g-1').enabled, true);
  });

  it('detecte #logs, cache et recree le webhook sur code 10015, sinon repli sur channel.send', async () => {
    const tmpDir = makeTempDir();
    const store = actionLogs.createGuildLogStore(tmpDir);
    const guild = createMockGuild({ id: 'g-auto' });

    const voiceLogs = createMockTextChannel({
      id: 'c-voice',
      name: 'logs',
      type: ChannelType.GuildVoice,
    });
    const botLogs = createMockTextChannel({ id: 'c-bot-logs', name: 'bot-logs' });
    const mainLogs = createMockTextChannel({ id: 'c-logs', name: 'logs' });

    guild.channels.cache.set(voiceLogs.id, voiceLogs);
    guild.channels.cache.set(botLogs.id, botLogs);
    guild.channels.cache.set(mainLogs.id, mainLogs);

    const detected = actionLogs.findAutoLogChannel(guild, { user: { id: 'bot-1' } });
    assert.equal(detected.id, 'c-logs');

    const deliveredPayloads = [];
    let failFirst10015 = false;
    const webhookClientFactory = (url) => ({
      async send(payload) {
        if (failFirst10015 && url.includes('tok_1_')) {
          failFirst10015 = false;
          const err = new Error('Unknown Webhook');
          err.code = 10015;
          throw err;
        }
        deliveredPayloads.push({ url, payload });
      },
      destroy() {},
    });

    const embed = actionLogs.buildActionLogEmbed({
      trigger: 'direct',
      ok: true,
      toolName: 'create_channel',
      args: { name: 'annonces' },
      result: 'Salon cree',
      requesterId: 'u-1',
      channelId: 'c-gen',
      userText: 'cree un salon annonces',
      stats: {
        source: 'local',
        localRole: 'agent',
        model: 'qwen2.5:3B',
        keepAlive: '15m',
        elapsedMs: 420,
        tokensPerSecond: 38.5,
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
      },
    });

    const r1 = await actionLogs.sendLogEmbeds({
      guild,
      client: { user: { id: 'bot-1' } },
      embeds: [embed],
      store,
      webhookClientFactory,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.delivery, 'channel_webhook');
    assert.equal(mainLogs.createWebhookCalls.length, 1);

    // 2nd send reuses cached webhook
    const r2 = await actionLogs.sendLogEmbeds({
      guild,
      client: { user: { id: 'bot-1' } },
      embeds: [embed],
      store,
      webhookClientFactory,
    });
    assert.equal(r2.ok, true);
    assert.equal(mainLogs.createWebhookCalls.length, 1);

    // Simulate deleted webhook (Discord 10015) -> invalidates cache and recreates
    mainLogs.webhooks.length = 0;
    failFirst10015 = true;
    const r3 = await actionLogs.sendLogEmbeds({
      guild,
      client: { user: { id: 'bot-1' } },
      embeds: [embed],
      store,
      webhookClientFactory,
    });
    assert.equal(r3.ok, true);
    assert.equal(r3.delivery, 'channel_webhook_recreated');
    assert.equal(mainLogs.createWebhookCalls.length, 2);
    assert.equal(deliveredPayloads.length, 3);
    for (const dp of deliveredPayloads) {
      assert.equal(dp.payload.flags, V2_FLAG);
      assert.equal(dp.payload.withComponents, true);
      assert.equal(dp.payload.embeds, undefined);
      assert.equal(dp.payload.content, undefined);
      assert.ok(extractV2Text(dp.payload).includes('create_channel'));
    }

    // Missing ManageWebhooks -> clean fallback to channel.send V2
    const noWhGuild = createMockGuild({ id: 'g-nowh' });
    const noWhLogs = createMockTextChannel({
      id: 'c-logs-nowh',
      name: 'logs',
      denyManageWebhooks: true,
    });
    noWhGuild.channels.cache.set(noWhLogs.id, noWhLogs);

    const rFallback = await actionLogs.sendLogEmbeds({
      guild: noWhGuild,
      client: { user: { id: 'bot-1' } },
      embeds: [embed],
      store,
      webhookClientFactory,
    });
    assert.equal(rFallback.ok, true);
    assert.equal(rFallback.delivery, 'channel_send_fallback');
    assert.equal(noWhLogs.sentMessages.length, 1);
    assert.equal(noWhLogs.sentMessages[0].flags, V2_FLAG);
    assert.equal(noWhLogs.sentMessages[0].embeds, undefined);

    // /logs off disables sending
    store.disableLogs('g-auto', 'admin-1');
    const rOff = await actionLogs.sendLogEmbeds({
      guild,
      client: { user: { id: 'bot-1' } },
      embeds: [embed],
      store,
      webhookClientFactory,
    });
    assert.equal(rOff.ok, false);
    assert.equal(rOff.skipped, true);
    assert.equal(rOff.reason, 'disabled');
    assert.equal(deliveredPayloads.length, 3);
  });

  it('construit des embeds riches avec toutes les infos IA et decoupe les grands plans en plusieurs embeds', () => {
    const apiText = actionLogs.buildAiInfoText({
      source: 'api',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      elapsedMs: 1250,
      tokensPerSecond: 82.4,
      promptTokens: 300,
      completionTokens: 150,
      totalTokens: 450,
    });
    assert.ok(apiText.includes('API externe (gemini)'));
    assert.ok(apiText.includes('gemini-3.8-flash'));
    assert.ok(apiText.includes('1250 ms'));
    assert.ok(apiText.includes('82.4 tok/s'));
    assert.ok(apiText.includes('prompt 300 | completion 150 | total 450'));

    const fallbackText = actionLogs.buildAiInfoText({
      source: 'local_fallback',
      fallbackProvider: 'gemini',
      fallbackReason: 'limite de quota avec modele API personalisee',
      localRole: 'agent',
      keepAlive: '15m',
      model: 'qwen2.5:3B',
      elapsedMs: 900,
    });
    assert.ok(fallbackText.includes('fallback'));
    assert.ok(fallbackText.includes('depuis gemini'));
    assert.ok(fallbackText.includes('limite de quota'));
    assert.ok(fallbackText.includes('qwen2.5:3B'));
    assert.ok(fallbackText.includes('keep_alive: 15m'));

    const actionCard = actionLogs.buildActionLogEmbed({
      trigger: 'direct',
      ok: true,
      toolName: 'edit_channel_permissions',
      args: { channel_name: 'general', veryLong: 'x'.repeat(2000) },
      result: 'Permissions appliquees',
      requesterId: 'u-req',
      executorId: 'u-req',
      channelId: 'c-origin',
      userText: 'mets general en lecture seule',
      stats: { source: 'local', localRole: 'agent', model: 'qwen2.5:3B', keepAlive: '15m' },
    });

    const actionMetrics = estimateV2Metrics(actionCard);
    assert.ok(actionMetrics.totalChars <= 4000);
    assert.ok(actionMetrics.totalComponents <= 40);
    const actionText = extractV2Text(actionCard);
    assert.ok(actionText.includes('Parametres (JSON)'));
    assert.ok(actionText.includes('Informations IA'));
    assert.ok(actionText.includes('qwen2.5:3B'));

    const manySteps = Array.from({ length: 28 }, (_, i) => ({
      tool: 'create_channel',
      args: { name: `salon-${i + 1}` },
      label: `Creer #salon-${i + 1}`,
      ok: i !== 5,
      result: i === 5 ? 'Erreur permission' : `Salon #salon-${i + 1} cree`,
    }));
    const planCards = actionLogs.buildPlanLogEmbeds({
      planId: 'plan-big-1',
      plan: { summary: 'Creation massive', steps: manySteps },
      stepResults: manySteps,
      requesterId: 'u-1',
      executorId: 'u-2',
      channelId: 'c-1',
      userText: 'cree 28 salons',
      revision: 2,
      lastModification: 'Ajoute 3 salons supplementaires',
      lastModifiedBy: 'u-1',
      stats: { source: 'local', localRole: 'agent', model: 'qwen2.5:3B', keepAlive: '15m' },
    });

    assert.ok(planCards.length >= 2);
    const firstText = extractV2Text(planCards[0]);
    assert.ok(firstText.includes('v2'));
    assert.ok(firstText.includes('Derniere modification du plan'));
    for (const card of planCards) {
      const m = estimateV2Metrics(card);
      assert.ok(m.totalChars <= 4000, `Depassement 4000 chars: ${m.totalChars}`);
      assert.ok(m.totalComponents <= 40, `Depassement 40 composants: ${m.totalComponents}`);
    }
  });

  it('integration approvals.js : log confirmation bouton, suppression salon courant et auto-archivage timeout', async () => {
    const guildId = 'hermetic-approvals-guild-1';
    const guild = createMockGuild({ id: guildId });
    const logsChan = createMockTextChannel({
      id: 'chan-logs-1',
      name: 'logs',
      channelsCache: guild.channels.cache,
      denyManageWebhooks: true,
    });
    const originChan = createMockTextChannel({
      id: 'chan-origin-1',
      name: 'general',
      channelsCache: guild.channels.cache,
    });
    const targetChan = createMockTextChannel({
      id: 'chan-victim-1',
      name: 'a-supprimer',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(logsChan.id, logsChan);
    guild.channels.cache.set(originChan.id, originChan);
    guild.channels.cache.set(targetChan.id, targetChan);

    const admin = createMockMember({ id: 'admin-10', perms: ['Administrator'] });
    const aiStats = {
      source: 'local',
      localRole: 'agent',
      model: 'qwen2.5:3B',
      keepAlive: '15m',
      elapsedMs: 310,
      tokensPerSecond: 41.2,
      promptTokens: 88,
      completionTokens: 24,
      totalTokens: 112,
    };

    // 1. Confirmation destroying current origin channel (early return branch)
    let createdMsg1;
    const req1Id = await approvals.createApprovalRequest({
      interaction: {
        client: { user: { id: 'bot-1' } },
        async editReply(payload) {
          createdMsg1 = { id: 'm1', ...payload };
          return createdMsg1;
        },
      },
      channel: originChan,
      guild,
      requester: admin.user,
      approval: {
        kind: 'destructive',
        title: 'Supprimer #general',
        reason: 'Suppression demandee',
        toolName: 'delete_channel',
        args: { channel: 'general' },
        mode: 'agent',
        userText: 'supprime ce salon',
        timeoutMs: 30000,
      },
      stats: aiStats,
      isDebug: false,
    });
    assert.ok(req1Id);

    const handled1 = await approvals.handleApprovalButton({
      customId: `approval:approve:${req1Id}`,
      isButton: () => true,
      guild,
      user: admin.user,
      member: admin,
      client: { user: { id: 'bot-1' } },
      async reply() {},
      async deferUpdate() {},
      async editReply() {},
    });
    assert.equal(handled1, true);
    assert.equal(originChan.deleted, true);
    assert.equal(logsChan.sentMessages.length, 1);

    assert.equal(logsChan.sentMessages[0].flags, V2_FLAG);
    assert.equal(logsChan.sentMessages[0].embeds, undefined);
    const logText1 = extractV2Text(logsChan.sentMessages[0]);
    assert.ok(logText1.includes('Action confirmee'));
    assert.ok(logText1.includes('delete_channel'));
    assert.ok(logText1.includes('Informations IA'));
    assert.ok(logText1.includes('qwen2.5:3B'));

    // 2. Timeout auto-archive_channel logs approval_timeout
    const archiveCatOrChan = createMockTextChannel({
      id: 'chan-expire-1',
      name: 'temporaire',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(archiveCatOrChan.id, archiveCatOrChan);

    await approvals.createApprovalRequest({
      interaction: {
        client: { user: { id: 'bot-1' } },
        async editReply(payload) {
          return {
            id: 'm2',
            ...payload,
            async edit() {},
          };
        },
      },
      channel: targetChan,
      guild,
      requester: admin.user,
      approval: {
        kind: 'destructive',
        title: 'Supprimer #temporaire',
        reason: 'Archive apres timeout',
        toolName: 'delete_channel',
        args: { channel: 'temporaire' },
        mode: 'agent',
        userText: 'supprime temporaire',
        onTimeoutAction: 'archive_channel',
        targetChannelId: 'chan-expire-1',
        timeoutMs: 25,
      },
      stats: aiStats,
      isDebug: false,
      timeoutMs: 25,
    });

    await new Promise((r) => setTimeout(r, 90));
    assert.equal(logsChan.sentMessages.length, 2);
    assert.equal(logsChan.sentMessages[1].flags, V2_FLAG);
    const timeoutText = extractV2Text(logsChan.sentMessages[1]);
    assert.ok(timeoutText.includes('Archivage automatique'));
    assert.ok(timeoutText.includes('archive_channel'));
    assert.ok(timeoutText.includes('Informations IA'));
    assert.ok(timeoutText.includes('keep_alive: 15m'));
  });

  it('integration plans.js : logExecution apres execution multi-etapes meme si le salon d origine est supprime', async () => {
    const guild = createMockGuild({ id: 'hermetic-plans-guild-1' });
    const logsChan = createMockTextChannel({
      id: 'chan-logs-p',
      name: 'logs',
      channelsCache: guild.channels.cache,
      denyManageWebhooks: true,
    });
    const originChan = createMockTextChannel({
      id: 'chan-origin-p',
      name: 'planning',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(logsChan.id, logsChan);
    guild.channels.cache.set(originChan.id, originChan);

    const admin = createMockMember({ id: 'admin-p', perms: ['Administrator'] });
    const planId = await plans.createPlanRequest({
      interaction: {
        async editReply(payload) {
          return { id: 'mp-1', ...payload };
        },
      },
      channel: originChan,
      guild,
      requester: admin.user,
      requesterMember: admin,
      plan: {
        summary: 'Creer salon VIP et supprimer planning',
        steps: [
          { tool: 'create_channel', args: { name: 'vip-lounge', type: 'text' }, label: 'Creer #vip-lounge' },
          { tool: 'delete_channel', args: { channel: 'planning' }, label: 'Supprimer #planning' },
        ],
      },
      security: { requesterAuthorized: true, hasDestructive: true, destructiveSteps: [1], blockedSteps: [] },
      userText: 'cree vip-lounge puis supprime ce salon',
      stats: {
        source: 'local_fallback',
        fallbackProvider: 'gemini',
        fallbackReason: 'cle API incorrecte, merci de reconfigurer la clee API.',
        localRole: 'agent',
        model: 'qwen2.5:3B',
        keepAlive: '15m',
        elapsedMs: 650,
      },
      stepDelayMs: 0,
      timeoutMs: 30000,
    });

    const executed = await plans.handlePlanButton({
      customId: `plan:execute:${planId}`,
      isButton: () => true,
      guild,
      user: admin.user,
      member: admin,
      client: { user: { id: 'bot-1' } },
      async reply() {},
      async deferUpdate() {},
      async editReply() {},
    });

    assert.equal(executed, true);
    assert.equal(originChan.deleted, true);
    assert.equal(logsChan.sentMessages.length, 1);

    assert.equal(logsChan.sentMessages[0].flags, V2_FLAG);
    assert.equal(logsChan.sentMessages[0].embeds, undefined);
    const planLogText = extractV2Text(logsChan.sentMessages[0]);
    assert.ok(planLogText.includes('Plan execute'));
    assert.ok(planLogText.includes('Plan ID'));
    assert.ok(planLogText.includes(planId));
    assert.ok(planLogText.includes('Etape 1/2 — create_channel'));
    assert.ok(planLogText.includes('Etape 2/2 — delete_channel'));
    assert.ok(planLogText.includes('Informations IA'));
    assert.ok(planLogText.includes('fallback'));
  });

  it('/logs commande slash : bloque les non-admins et valide /logs status et /logs webhook invalide', async () => {
    const guild = createMockGuild({ id: 'hermetic-cmd-guild-1' });
    const logsChan = createMockTextChannel({ id: 'c-cmd-logs', name: 'logs' });
    guild.channels.cache.set(logsChan.id, logsChan);

    const replies = [];
    await commands.handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'logs',
      guild,
      channel: logsChan,
      user: { id: 'regular-user', username: 'user' },
      member: createMockMember({ id: 'regular-user', perms: ['SendMessages'] }),
      client: { user: { id: 'bot-1' } },
      options: { getSubcommand: () => 'status' },
      async reply(msg) {
        replies.push(msg);
      },
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.equal(replies[0].content, undefined);
    assert.ok(extractV2Text(replies[0]).includes('ManageGuild'));

    const adminReplies = [];
    await commands.handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'logs',
      guild,
      channel: logsChan,
      user: { id: 'admin-1', username: 'admin' },
      member: createMockMember({ id: 'admin-1', perms: ['ManageGuild'] }),
      client: { user: { id: 'bot-1' } },
      options: { getSubcommand: () => 'status' },
      async reply(msg) {
        adminReplies.push(msg);
      },
    });
    assert.equal(adminReplies.length, 1);
    assert.equal(adminReplies[0].flags, V2_EPHEMERAL_FLAGS);
    const adminText = extractV2Text(adminReplies[0]);
    assert.ok(adminText.includes('Detection automatique'));
    assert.ok(adminText.includes('<#c-cmd-logs>'));

    const badUrlReplies = [];
    await commands.handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'logs',
      guild,
      channel: logsChan,
      user: { id: 'admin-1', username: 'admin' },
      member: createMockMember({ id: 'admin-1', perms: ['ManageGuild'] }),
      client: { user: { id: 'bot-1' } },
      options: {
        getSubcommand: () => 'webhook',
        getString: () => 'http://127.0.0.1/ssrf',
      },
      async reply(msg) {
        badUrlReplies.push(msg);
      },
    });
    assert.equal(badUrlReplies.length, 1);
    assert.equal(badUrlReplies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.ok(extractV2Text(badUrlReplies[0]).includes('URL de webhook Discord invalide'));
  });
});
