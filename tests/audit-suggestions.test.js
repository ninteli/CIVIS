const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  AuditLogEvent,
  ChannelType,
  Collection,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} = require('discord.js');

const planner = require('../src/agent/planner');
const plans = require('../src/discord/plans');
const actionLogs = require('../src/discord/action-logs');
const auditSuggestions = require('../src/discord/audit-suggestions');
const commands = require('../src/discord/commands');
const {
  V2_FLAG,
  V2_EPHEMERAL_FLAGS,
  extractV2Text,
  extractV2Buttons,
} = require('../src/discord/ui-v2');

function createMockMember({
  id = 'user-1',
  username = 'Alice',
  perms = ['Administrator'],
  highestPosition = 50,
  bot = false,
} = {}) {
  return {
    id,
    displayName: username,
    user: { id, username, bot },
    permissions: new PermissionsBitField(perms),
    roles: { highest: { position: highestPosition } },
  };
}

function createMockGuild({
  id,
  name = 'Audit Test Guild',
  botPerms = ['Administrator'],
} = {}) {
  const everyoneRole = {
    id,
    name: '@everyone',
    position: 0,
    permissions: new PermissionsBitField([]),
  };
  const rolesCache = new Collection();
  rolesCache.set(id, everyoneRole);
  const channelsCache = new Collection();
  const membersCache = new Collection();
  const me = {
    id: 'bot-1',
    user: { id: 'bot-1', bot: true },
    permissions: new PermissionsBitField(botPerms),
    roles: { highest: { position: 99 } },
  };

  return {
    id,
    name,
    ownerId: 'owner-1',
    roles: {
      cache: rolesCache,
      everyone: everyoneRole,
      async create(opts) {
        const created = {
          id: 'role-' + opts.name,
          name: opts.name,
          position: 10,
          managed: false,
          permissions: new PermissionsBitField(opts.permissions || []),
          async edit() {
            return this;
          },
        };
        rolesCache.set(created.id, created);
        return created;
      },
    },
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
    members: {
      cache: membersCache,
      me,
    },
  };
}

function createMockTextChannel({
  id = 'chan-1',
  name = 'general',
  type = ChannelType.GuildText,
  parent = null,
  channelsCache = null,
  denyManageWebhooks = true,
  denySendMessages = false,
} = {}) {
  const sentMessages = [];
  const editedMessages = [];
  const overwriteMap = new Map();

  const channel = {
    id,
    name,
    type,
    parent,
    parentId: parent ? parent.id : null,
    deleted: false,
    sentMessages,
    editedMessages,
    isTextBased() {
      return (
        this.type === ChannelType.GuildText ||
        this.type === ChannelType.GuildAnnouncement
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
    async send(payload) {
      const msg = {
        id: 'msg-' + (sentMessages.length + 1),
        ...payload,
        async edit(nextPayload) {
          editedMessages.push(nextPayload);
          Object.assign(msg, nextPayload);
          return msg;
        },
      };
      sentMessages.push(msg);
      return msg;
    },
    async edit(updates) {
      if (updates.name !== undefined) channel.name = updates.name;
      if (updates.topic !== undefined) channel.topic = updates.topic;
      return channel;
    },
    permissionOverwrites: {
      cache: new Collection(),
      async edit(targetId, flags) {
        overwriteMap.set(targetId, flags);
      },
      async set(list) {
        overwriteMap.set('set', list);
      },
    },
    _overwrites: overwriteMap,
  };
  return channel;
}

describe('Suggestions proactives sur Audit Logs (planner.js, plans.js, audit-suggestions.js)', () => {
  const tempDirs = [];
  const managers = [];

  function makeTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ninteli-audit-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const m of managers.splice(0, managers.length)) {
      m.clearAll();
    }
    auditSuggestions.clearAll();
    plans.clearAllPendingPlans();
    actionLogs.clearWebhookCache();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persiste la config par serveur dans guild-suggestions.json (0o600) avec validation du cooldown', () => {
    const tmpDir = makeTempDir();
    const store = auditSuggestions.createGuildSuggestionsStore(tmpDir);

    const def = store.getGuildConfig('g-sug-1');
    assert.equal(def.enabled, true);
    assert.equal(def.mode, 'auto');
    assert.equal(def.channelId, null);
    assert.equal(def.cooldownSec, auditSuggestions.DEFAULT_COOLDOWN_SEC);

    store.setSuggestionChannel('g-sug-1', 'chan-sug-42', 'admin-1');
    let cfg = store.getGuildConfig('g-sug-1');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.mode, 'channel');
    assert.equal(cfg.channelId, 'chan-sug-42');

    assert.equal(store.setCooldown('g-sug-1', 9, 'admin-1').ok, false);
    assert.equal(store.setCooldown('g-sug-1', 3601, 'admin-1').ok, false);
    assert.equal(store.setCooldown('g-sug-1', 12.5, 'admin-1').ok, false);

    const cdOk = store.setCooldown('g-sug-1', 120, 'admin-2');
    assert.equal(cdOk.ok, true);
    assert.equal(cdOk.config.cooldownSec, 120);

    store.setAutoChannel('g-sug-1', 'admin-2');
    cfg = store.getGuildConfig('g-sug-1');
    assert.equal(cfg.mode, 'auto');
    assert.equal(cfg.cooldownSec, 120);

    store.disableSuggestions('g-sug-1', 'admin-3');
    assert.equal(store.getGuildConfig('g-sug-1').enabled, false);

    store.enableSuggestions('g-sug-1', 'admin-3');
    assert.equal(store.getGuildConfig('g-sug-1').enabled, true);

    const filePath = path.join(tmpDir, 'guild-suggestions.json');
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);

    store.resetGuildConfig('g-sug-1');
    assert.equal(store.getGuildConfig('g-sug-1').cooldownSec, auditSuggestions.DEFAULT_COOLDOWN_SEC);
  });

  it('decrit proprement les entrees Audit Log et deduplique les lots', () => {
    const guild = createMockGuild({ id: 'g-desc' });
    const staffCat = createMockTextChannel({
      id: 'cat-staff',
      name: 'Staff',
      type: ChannelType.GuildCategory,
    });
    const modRole = { id: 'role-mod', name: 'Moderateur' };
    guild.channels.cache.set(staffCat.id, staffCat);
    guild.roles.cache.set(modRole.id, modRole);

    const e1 = auditSuggestions.describeAuditEntry(
      {
        action: AuditLogEvent.RoleCreate,
        targetId: 'role-vip',
        target: { id: 'role-vip', name: 'VIP' },
        changes: [
          { key: 'name', new: 'VIP' },
          { key: 'color', new: 0xf1c40f },
          { key: 'hoist', new: true },
        ],
        executorId: 'u-1',
      },
      guild
    );
    assert.ok(e1.summaryLine.includes('Creation de role'));
    assert.ok(e1.summaryLine.includes('VIP'));
    assert.ok(e1.summaryLine.includes('#f1c40f'));

    const e2 = auditSuggestions.describeAuditEntry(
      {
        action: AuditLogEvent.ChannelCreate,
        targetId: 'cat-new',
        target: { id: 'cat-new', name: 'Tournois', type: ChannelType.GuildCategory },
        executorId: 'u-1',
      },
      guild
    );
    assert.equal(e2.isCategory, true);
    assert.ok(e2.summaryLine.includes('Creation de categorie'));

    const e3 = auditSuggestions.describeAuditEntry(
      {
        action: AuditLogEvent.ChannelOverwriteUpdate,
        targetId: 'cat-staff',
        extra: { id: 'role-mod', name: 'Moderateur' },
        changes: [{ key: 'allow', old: '0', new: '1024' }],
        executorId: 'u-1',
      },
      guild
    );
    assert.ok(e3.summaryLine.includes('Modification permissions sur categorie'));
    assert.ok(e3.summaryLine.includes('Moderateur'));

    const { auditSummary, shortTriggerSummary } = auditSuggestions.formatAuditBatchPrompt(
      [e1, e1, e2],
      'Alice'
    );
    assert.ok(auditSummary.includes('1. Creation de role'));
    assert.ok(auditSummary.includes('2. Creation de categorie'));
    assert.ok(!auditSummary.includes('3.'));
    assert.ok(shortTriggerSummary.includes('Alice'));
  });

  it('tryParseProactiveResponse et buildProactivePlanFromAudit gerent suggest=true/false, retry JSON et securite', async () => {
    const prompt = planner.buildProactivePlannerSystemPrompt('Serveur : "Test"');
    assert.ok(prompt.includes('create_category'));
    assert.ok(prompt.includes('create_channel'));
    assert.ok(prompt.includes('set_channel_permissions'));
    assert.ok(!prompt.includes('delete_channel'));
    assert.ok(!prompt.includes('delete_role'));

    assert.deepEqual(
      planner.tryParseProactiveResponse('```json\n{"suggest":false,"reason":"Rien a ajouter"}\n```'),
      { suggest: false, reason: 'Rien a ajouter' }
    );

    const parsedEmpty = planner.tryParseProactiveResponse('{"suggest":true,"summary":"Vide","steps":[]}');
    assert.equal(parsedEmpty.suggest, false);

    const guild = createMockGuild({ id: 'g-plan-audit', botPerms: ['Administrator'] });
    const member = createMockMember({ id: 'u-1', perms: ['Administrator'] });
    const rolesSeen = [];

    // 1. Malformed JSON -> strict retry -> valid plan
    let callNum = 0;
    const resRetry = await planner.buildProactivePlanFromAudit({
      auditSummary: 'Creation de categorie Tournois',
      actorName: 'Alice',
      guild,
      member,
      authorId: 'u-1',
      chatFn: async (_msgs, opts) => {
        rolesSeen.push(opts.localRole);
        callNum += 1;
        if (callNum === 1) {
          return { content: 'Voila une idee !', stats: { elapsedMs: 100, model: 'qwen2.5:3B' } };
        }
        return {
          content: JSON.stringify({
            suggest: true,
            summary: 'Completer la categorie Tournois',
            rationale: 'Ajouter des salons annonces et discussion pour la nouvelle categorie',
            steps: [
              { tool: 'create_channel', args: { name: 'tournois-annonces', type: 'announcement', category: 'Tournois' } },
              { tool: 'create_channel', args: { name: 'tournois-chat', type: 'text', category: 'Tournois' } },
            ],
          }),
          stats: { elapsedMs: 120, model: 'qwen2.5:3B', localRole: 'agent', keepAlive: '15m' },
        };
      },
    });
    assert.equal(callNum, 2);
    assert.deepEqual(rolesSeen, ['agent', 'agent']);
    assert.equal(resRetry.ok, true);
    assert.equal(resRetry.suggest, true);
    assert.equal(resRetry.plan.steps.length, 2);
    assert.ok(resRetry.rationale.includes('salons annonces'));

    // 2. Clean decline without retry
    let declineCalls = 0;
    const resDecline = await planner.buildProactivePlanFromAudit({
      auditSummary: 'Renommage mineur',
      actorName: 'Alice',
      guild,
      member,
      authorId: 'u-1',
      chatFn: async () => {
        declineCalls += 1;
        return {
          content: '{"suggest":false,"reason":"Action deja complete."}',
          stats: { elapsedMs: 80, model: 'qwen2.5:3B' },
        };
      },
    });
    assert.equal(declineCalls, 1);
    assert.equal(resDecline.ok, true);
    assert.equal(resDecline.suggest, false);
    assert.equal(resDecline.reason, 'Action deja complete.');

    // 3. Insufficient bot permissions blocks suggestion cleanly
    const limitedGuild = createMockGuild({ id: 'g-limited', botPerms: ['SendMessages'] });
    const resBlocked = await planner.buildProactivePlanFromAudit({
      auditSummary: 'Creation role VIP',
      actorName: 'Alice',
      guild: limitedGuild,
      member,
      authorId: 'u-1',
      chatFn: async () => ({
        content: JSON.stringify({
          suggest: true,
          summary: 'Creer salon VIP',
          steps: [{ tool: 'create_channel', args: { name: 'vip' } }],
        }),
        stats: { elapsedMs: 50, model: 'qwen2.5:3B' },
      }),
    });
    assert.equal(resBlocked.ok, false);
    assert.equal(resBlocked.suggest, false);
    assert.ok(resBlocked.error);
  });

  it('filtre bots/evenements ignores, regroupe en rafale, poste et execute/modifie/ignore un plan proactif avec logs IA', async () => {
    const tmpDir = makeTempDir();
    const store = auditSuggestions.createGuildSuggestionsStore(tmpDir);
    store.setCooldown('hermetic-proactive-guild-1', 60, 'admin-1');

    const guild = createMockGuild({ id: 'hermetic-proactive-guild-1', botPerms: ['Administrator'] });
    const sugChan = createMockTextChannel({
      id: 'chan-sug',
      name: 'suggestions-ia',
      channelsCache: guild.channels.cache,
    });
    const logsChan = createMockTextChannel({
      id: 'chan-logs',
      name: 'logs',
      channelsCache: guild.channels.cache,
      denyManageWebhooks: true,
    });
    guild.channels.cache.set(sugChan.id, sugChan);
    guild.channels.cache.set(logsChan.id, logsChan);

    const actor = createMockMember({ id: 'admin-u1', username: 'Chef', perms: ['Administrator'] });
    guild.members.cache.set(actor.id, actor);

    const client = { user: { id: 'bot-1', tag: 'Ninteli IA#3289' } };
    const llmCalls = [];
    let shouldSuggest = false;

    const manager = auditSuggestions.createAuditSuggestionsManager({
      store,
      debounceMs: 25,
      planTimeoutMs: 30000,
      plannerFn: async ({ auditSummary, actorName, guild: g, member }) => {
        llmCalls.push({ auditSummary, actorName });
        if (!shouldSuggest) {
          return {
            ok: true,
            suggest: false,
            reason: 'Aucune suite necessaire.',
            stats: { model: 'qwen2.5:3B' },
          };
        }
        return planner.buildProactivePlanFromAudit({
          auditSummary,
          actorName,
          guild: g,
          member,
          authorId: actor.id,
          chatFn: async () => ({
            content: JSON.stringify({
              suggest: true,
              summary: 'Amenager l espace Event',
              rationale: 'Un nouveau salon #events merite une categorie et un vocal dedies',
              steps: [
                { tool: 'create_category', args: { name: 'Events' } },
                { tool: 'create_channel', args: { name: 'events-vocal', type: 'voice', category: 'Events' } },
              ],
            }),
            stats: {
              source: 'local',
              localRole: 'agent',
              model: 'qwen2.5:3B',
              keepAlive: '15m',
              elapsedMs: 410,
              promptTokens: 200,
              completionTokens: 55,
              totalTokens: 255,
            },
          }),
        });
      },
    });
    managers.push(manager);

    // Ignored: self-bot, other bot, unwatched event
    assert.equal(
      manager.handleAuditLogEntry(
        { action: AuditLogEvent.ChannelCreate, executorId: 'bot-1', targetId: 'x' },
        guild,
        client
      ),
      false
    );
    assert.equal(
      manager.handleAuditLogEntry(
        {
          action: AuditLogEvent.ChannelCreate,
          executorId: 'other-bot',
          executor: { id: 'other-bot', bot: true },
          targetId: 'x',
        },
        guild,
        client
      ),
      false
    );
    assert.equal(
      manager.handleAuditLogEntry(
        { action: AuditLogEvent.MessageDelete, executorId: actor.id, targetId: 'm-1' },
        guild,
        client
      ),
      false
    );

    // When suggest=false, no message posted & no cooldown consumed
    manager.handleAuditLogEntry(
      {
        action: AuditLogEvent.ChannelUpdate,
        executorId: actor.id,
        targetId: 'chan-sug',
        changes: [{ key: 'topic', new: 'Infos' }],
      },
      guild,
      client
    );
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(llmCalls.length, 1);
    assert.equal(sugChan.sentMessages.length, 0);

    // Coalesce burst of 3 events into 1 LLM call, immediately without cooldown block!
    shouldSuggest = true;
    assert.equal(
      manager.handleAuditLogEntry(
        {
          action: AuditLogEvent.ChannelCreate,
          executorId: actor.id,
          targetId: 'ch-ev-1',
          target: { id: 'ch-ev-1', name: 'events', type: ChannelType.GuildText },
        },
        guild,
        client
      ),
      true
    );
    assert.equal(
      manager.handleAuditLogEntry(
        {
          action: AuditLogEvent.ChannelOverwriteCreate,
          executorId: actor.id,
          targetId: 'ch-ev-1',
          target: { id: 'ch-ev-1', name: 'events', type: ChannelType.GuildText },
          extra: { id: guild.id, name: '@everyone' },
        },
        guild,
        client
      ),
      true
    );
    assert.equal(
      manager.handleAuditLogEntry(
        {
          action: AuditLogEvent.ChannelOverwriteUpdate,
          executorId: actor.id,
          targetId: 'ch-ev-1',
          target: { id: 'ch-ev-1', name: 'events', type: ChannelType.GuildText },
          extra: { id: 'r-1', name: 'Animateur' },
        },
        guild,
        client
      ),
      true
    );

    await new Promise((r) => setTimeout(r, 70));
    assert.equal(llmCalls.length, 2);
    assert.ok(llmCalls[1].auditSummary.includes('Creation de salon'));
    assert.ok(llmCalls[1].auditSummary.includes('Ajout permissions sur salon'));
    assert.equal(sugChan.sentMessages.length, 1);

    const posted = sugChan.sentMessages[0];
    assert.equal(posted.flags, V2_FLAG);
    assert.equal(posted.embeds, undefined);
    const postedText = extractV2Text(posted);
    assert.ok(postedText.includes('Suggestion proactive'));
    assert.ok(postedText.includes('Modification manuelle detectee'));

    const buttons = extractV2Buttons(posted);
    assert.equal(buttons.length, 3);
    assert.equal(buttons[2].label, 'Ignorer');

    const planId = buttons[0].custom_id.split(':')[2];
    assert.equal(plans.hasPendingProactivePlanForGuild(guild.id), true);

    // Cooldown & pending proactive plan block second burst
    assert.equal(
      manager.handleAuditLogEntry(
        {
          action: AuditLogEvent.RoleCreate,
          executorId: actor.id,
          targetId: 'r-extra',
          target: { id: 'r-extra', name: 'VIP' },
        },
        guild,
        client
      ),
      false
    );

    // Execute proactive plan -> runs tools AND logs execution to #logs with AI stats
    const execHandled = await plans.handlePlanButton({
      customId: `plan:execute:${planId}`,
      isButton: () => true,
      guild,
      user: actor.user,
      member: actor,
      client,
      async reply() {},
      async deferUpdate() {},
      async editReply(payload) {
        return posted.edit(payload);
      },
    });
    assert.equal(execHandled, true);
    assert.equal(plans.hasPendingProactivePlanForGuild(guild.id), false);
    assert.ok(guild.channels.cache.some((c) => c.name === 'Events' && c.type === ChannelType.GuildCategory));
    assert.ok(guild.channels.cache.some((c) => c.name === 'events-vocal' && c.type === ChannelType.GuildVoice));

    assert.equal(logsChan.sentMessages.length, 1);
    assert.equal(logsChan.sentMessages[0].flags, V2_FLAG);
    const logText = extractV2Text(logsChan.sentMessages[0]);
    assert.ok(logText.includes('Plan ID'));
    assert.ok(logText.includes(planId));
    assert.ok(logText.includes('Informations IA'));
    assert.ok(logText.includes('qwen2.5:3B'));
  });

  it('permet de modifier puis ignorer une suggestion proactive via Modal et bouton', async () => {
    const guild = createMockGuild({ id: 'hermetic-proactive-revise-1', botPerms: ['Administrator'] });
    const sugChan = createMockTextChannel({
      id: 'chan-sug-r',
      name: 'ninteli-suggestions',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(sugChan.id, sugChan);
    const actor = createMockMember({ id: 'admin-r1', username: 'Bob', perms: ['Administrator'] });

    const planId = await plans.createPlanRequest({
      interaction: null,
      channel: sugChan,
      guild,
      requester: actor.user,
      requesterMember: actor,
      plan: {
        summary: 'Creer salon vocal VIP',
        steps: [{ tool: 'create_channel', args: { name: 'vip-voice', type: 'voice' }, label: 'Creer vocal VIP' }],
      },
      security: {
        requiredPermissions: ['ManageChannels'],
        requiredPermissionsLabel: 'Gerer les salons',
        requestedPermFlags: [],
        targetRoleIds: [],
        hasDestructive: false,
        requesterAuthorized: true,
        reason: null,
      },
      userText: '[Suggestion proactive - Audit Log] Creation role VIP',
      stats: { source: 'local', localRole: 'agent', model: 'qwen2.5:3B', elapsedMs: 150 },
      isDebug: false,
      timeoutMs: 30000,
      proactiveTrigger: {
        summary: 'Bob — Creation de role : role "VIP"',
        rationale: 'Salon dedie pour le nouveau role VIP',
      },
      revisePlanFn: async () => ({
        ok: true,
        plan: {
          summary: 'Creer texte et vocal VIP',
          steps: [
            { tool: 'create_channel', args: { name: 'vip-chat', type: 'text' }, label: 'Creer #vip-chat' },
            { tool: 'create_channel', args: { name: 'vip-voice', type: 'voice' }, label: 'Creer vocal VIP' },
          ],
        },
        security: {
          requiredPermissions: ['ManageChannels'],
          requiredPermissionsLabel: 'Gerer les salons',
          requestedPermFlags: [],
          targetRoleIds: [],
          hasDestructive: false,
          requesterAuthorized: true,
          reason: null,
        },
        stats: { source: 'local', localRole: 'agent', model: 'qwen2.5:3B', elapsedMs: 180 },
      }),
    });

    assert.ok(planId);
    const posted = sugChan.sentMessages[0];

    let shownModal = null;
    await plans.handlePlanButton({
      customId: `plan:modify:${planId}`,
      isButton: () => true,
      guild,
      user: actor.user,
      member: actor,
      async showModal(m) {
        shownModal = m;
      },
      async reply() {},
    });
    assert.ok(shownModal);

    await plans.handlePlanModal({
      customId: `plan:revise:${planId}`,
      guild,
      user: actor.user,
      member: actor,
      fields: { getTextInputValue: () => 'Ajoute aussi #vip-chat' },
      async deferUpdate() {},
      async editReply(payload) {
        return posted.edit(payload);
      },
      async reply() {},
    });

    assert.ok(sugChan.editedMessages.length >= 1);
    const latestEdit = sugChan.editedMessages[sugChan.editedMessages.length - 1];
    assert.equal(latestEdit.flags, V2_FLAG);
    assert.ok(extractV2Text(latestEdit).includes('Suggestion proactive (v2)'));
    assert.equal(extractV2Buttons(latestEdit)[2].label, 'Ignorer');

    let cancelPayload = null;
    await plans.handlePlanButton({
      customId: `plan:cancel:${planId}`,
      isButton: () => true,
      guild,
      user: actor.user,
      member: actor,
      async update(payload) {
        cancelPayload = payload;
      },
      async reply() {},
    });
    assert.ok(cancelPayload);
    assert.equal(plans.hasPendingProactivePlanForGuild(guild.id), false);
  });

  it('/suggestions commande slash : exige ManageGuild et affiche status + ViewAuditLog', async () => {
    const guild = createMockGuild({
      id: 'hermetic-sug-cmd-guild-1',
      botPerms: ['ManageChannels', 'ViewAuditLog'],
    });
    const sugChan = createMockTextChannel({
      id: 'c-sug-auto',
      name: 'ninteli-suggestions',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(sugChan.id, sugChan);

    const deniedReplies = [];
    await commands.handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'suggestions',
      guild,
      channel: sugChan,
      user: { id: 'u-norm', username: 'user' },
      member: createMockMember({ id: 'u-norm', perms: ['SendMessages'] }),
      client: { user: { id: 'bot-1' } },
      options: { getSubcommand: () => 'status' },
      async reply(msg) {
        deniedReplies.push(msg);
      },
    });
    assert.equal(deniedReplies.length, 1);
    assert.equal(deniedReplies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.equal(deniedReplies[0].content, undefined);
    assert.ok(extractV2Text(deniedReplies[0]).includes('ManageGuild'));

    const statusReplies = [];
    await commands.handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'suggestions',
      guild,
      channel: sugChan,
      user: { id: 'admin-1', username: 'admin' },
      member: createMockMember({ id: 'admin-1', perms: ['ManageGuild'] }),
      client: { user: { id: 'bot-1' } },
      options: { getSubcommand: () => 'status' },
      async reply(msg) {
        statusReplies.push(msg);
      },
    });
    assert.equal(statusReplies.length, 1);
    assert.equal(statusReplies[0].flags, V2_EPHEMERAL_FLAGS);
    const statusText = extractV2Text(statusReplies[0]);
    assert.ok(statusText.includes('Actives'));
    assert.ok(statusText.includes('<#c-sug-auto>'));
    assert.ok(statusText.includes('45s'));
    assert.ok(statusText.includes('Accordee'));

    // Also verify missing ViewAuditLog warning appears cleanly
    const guildNoAudit = createMockGuild({
      id: 'hermetic-sug-cmd-guild-2',
      botPerms: ['SendMessages'],
    });
    guildNoAudit.channels.cache.set(sugChan.id, sugChan);
    const missingAuditReplies = [];
    await commands.handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'suggestions',
      guild: guildNoAudit,
      channel: sugChan,
      user: { id: 'admin-1', username: 'admin' },
      member: createMockMember({ id: 'admin-1', perms: ['ManageGuild'] }),
      client: { user: { id: 'bot-1' } },
      options: { getSubcommand: () => 'status' },
      async reply(msg) {
        missingAuditReplies.push(msg);
      },
    });
    assert.equal(missingAuditReplies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.ok(extractV2Text(missingAuditReplies[0]).includes('Manquante'));
  });
});
