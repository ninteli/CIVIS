const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  ButtonStyle,
  ChannelFlags,
  ChannelFlagsBitField,
  ChannelType,
  Collection,
  MessageFlags,
  PermissionsBitField,
} = require('discord.js');

const { executeTool } = require('../src/agent/tool-executor');
const planner = require('../src/agent/planner');
const plans = require('../src/discord/plans');
const {
  V2_FLAG,
  V2_EPHEMERAL_FLAGS,
  extractV2Text,
  extractV2Buttons,
} = require('../src/discord/ui-v2');

function createMockMember({
  id = 'user-1',
  perms = [],
  highestPosition = 5,
  channelPerms = new Map(),
} = {}) {
  return {
    id,
    user: { id },
    permissions: new PermissionsBitField(perms),
    roles: { highest: { position: highestPosition } },
    _channelPerms: channelPerms,
  };
}

function createMockRole({
  id = 'role-1',
  name = 'Membre',
  position = 5,
  perms = [],
  hexColor = '#000000',
} = {}) {
  const role = {
    id,
    name,
    position,
    managed: false,
    hexColor,
    hoist: false,
    mentionable: false,
    permissions: new PermissionsBitField(perms),
    editCalls: [],
    async edit(updates) {
      role.editCalls.push(updates);
      if (updates.name !== undefined) role.name = updates.name;
      if (updates.hoist !== undefined) role.hoist = updates.hoist;
      if (updates.mentionable !== undefined) role.mentionable = updates.mentionable;
      if (updates.colors?.primaryColor !== undefined) {
        role.hexColor =
          '#' + updates.colors.primaryColor.toString(16).padStart(6, '0');
      }
      if (updates.permissions !== undefined) {
        role.permissions = new PermissionsBitField(updates.permissions);
      }
      return role;
    },
    deleted: false,
    deleteCalls: [],
    async delete(reason) {
      role.deleted = true;
      role.deleteCalls.push(reason);
      return role;
    },
  };
  return role;
}

function createMockChannel({
  id = 'chan-1',
  name = 'general',
  type = ChannelType.GuildText,
  parent = null,
  topic = '',
  rateLimitPerUser = 0,
  nsfw = false,
  flags = new ChannelFlagsBitField(0),
  channelsCache = null,
} = {}) {
  const overwriteMap = new Map();
  const overwriteEditCalls = [];

  const channel = {
    id,
    name,
    type,
    parent,
    parentId: parent ? parent.id : null,
    topic,
    rateLimitPerUser,
    nsfw,
    flags:
      typeof flags?.has === 'function' ? flags : new ChannelFlagsBitField(flags || 0),
    editCalls: [],
    permissionOverwrites: {
      cache: overwriteMap,
      calls: overwriteEditCalls,
      async edit(targetId, overwriteObj) {
        overwriteEditCalls.push({ targetId, overwriteObj });
        const existing = overwriteMap.get(targetId) || {};
        overwriteMap.set(targetId, { ...existing, ...overwriteObj });
      },
    },
    permissionsFor(member) {
      if (member?._channelPerms?.has(channel.id)) {
        return new PermissionsBitField(member._channelPerms.get(channel.id));
      }
      return member?.permissions || new PermissionsBitField();
    },
    async edit(updates) {
      channel.editCalls.push(updates);
      if (updates.name !== undefined) channel.name = updates.name;
      if (updates.type !== undefined) channel.type = updates.type;
      if (updates.rateLimitPerUser !== undefined) {
        channel.rateLimitPerUser = updates.rateLimitPerUser;
      }
      if (updates.nsfw !== undefined) channel.nsfw = updates.nsfw;
      if (updates.topic !== undefined) channel.topic = updates.topic;
      if (updates.flags !== undefined) {
        channel.flags =
          typeof updates.flags?.has === 'function'
            ? updates.flags
            : new ChannelFlagsBitField(updates.flags || 0);
      }
      if (updates.parent !== undefined) {
        channel.parentId = updates.parent;
        channel.parent = channelsCache ? channelsCache.get(updates.parent) || null : null;
      }
      return channel;
    },
    deleted: false,
    deleteCalls: [],
    async delete(reason) {
      channel.deleted = true;
      channel.deleteCalls.push(reason);
      return channel;
    },
  };
  return channel;
}

function createMockGuild({
  id = 'guild-1',
  name = 'Serveur Test',
  ownerId = 'owner-1',
  botPerms = ['Administrator'],
  botPosition = 50,
} = {}) {
  const channelsCache = new Collection();
  const rolesCache = new Collection();

  const everyoneRole = createMockRole({ id, name: '@everyone', position: 0 });
  rolesCache.set(everyoneRole.id, everyoneRole);

  const me = createMockMember({
    id: 'bot-1',
    perms: botPerms,
    highestPosition: botPosition,
  });

  const createdChannels = [];
  const createdRoles = [];

  const guild = {
    id,
    name,
    ownerId,
    createdChannels,
    createdRoles,
    channels: {
      cache: channelsCache,
      async create(options) {
        const parent = options.parent ? channelsCache.get(options.parent) || null : null;
        const ch = createMockChannel({
          id: 'chan-new-' + (createdChannels.length + 1),
          name: options.name,
          type: options.type,
          parent,
          topic: options.topic || '',
          rateLimitPerUser: options.rateLimitPerUser || 0,
          nsfw: Boolean(options.nsfw),
          channelsCache,
        });
        channelsCache.set(ch.id, ch);
        createdChannels.push(options);
        return ch;
      },
    },
    roles: {
      cache: rolesCache,
      async create(options) {
        const hex =
          options.colors?.primaryColor !== undefined
            ? '#' + options.colors.primaryColor.toString(16).padStart(6, '0')
            : '#000000';
        const r = createMockRole({
          id: 'role-new-' + (createdRoles.length + 1),
          name: options.name,
          position: 1,
          hexColor: hex,
        });
        r.hoist = Boolean(options.hoist);
        r.mentionable = Boolean(options.mentionable);
        rolesCache.set(r.id, r);
        createdRoles.push(options);
        return r;
      },
    },
    members: { me },
  };

  return guild;
}

function createSlashInteraction({ guild, channel, user, member }) {
  const editReplies = [];
  const sentMessageEdits = [];
  const sentMessage = {
    id: 'msg-plan-1',
    edits: sentMessageEdits,
    async edit(payload) {
      sentMessageEdits.push(payload);
      return sentMessage;
    },
  };

  return {
    guild,
    channel,
    user,
    member,
    editReplies,
    sentMessage,
    async editReply(payload) {
      editReplies.push(payload);
      return sentMessage;
    },
  };
}

function createButtonInteraction({
  customId,
  guild,
  channel,
  user,
  member,
  client = {},
  deferDelayMs = 0,
}) {
  const replies = [];
  const updates = [];
  const deferUpdates = [];
  const editReplies = [];
  const shownModals = [];

  return {
    customId,
    guild,
    channel,
    user,
    member,
    client,
    replies,
    updates,
    deferUpdates,
    editReplies,
    shownModals,
    async reply(payload) {
      replies.push(payload);
    },
    async update(payload) {
      updates.push(payload);
    },
    async deferUpdate() {
      deferUpdates.push(true);
      if (deferDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, deferDelayMs));
      }
    },
    async editReply(payload) {
      editReplies.push(payload);
    },
    async showModal(modal) {
      shownModals.push(modal);
    },
  };
}

function createModalSubmitInteraction({
  customId,
  guild,
  channel,
  user,
  member,
  client = {},
  instructions = '',
  deferDelayMs = 0,
}) {
  const replies = [];
  const deferUpdates = [];
  const editReplies = [];
  const followUps = [];

  return {
    customId,
    guild,
    channel,
    user,
    member,
    client,
    replies,
    deferUpdates,
    editReplies,
    followUps,
    fields: {
      getTextInputValue(fieldId) {
        if (fieldId === 'instructions') return instructions;
        return '';
      },
    },
    async reply(payload) {
      replies.push(payload);
    },
    async deferUpdate() {
      deferUpdates.push(true);
      if (deferDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, deferDelayMs));
      }
    },
    async editReply(payload) {
      editReplies.push(payload);
    },
    async followUp(payload) {
      followUps.push(payload);
    },
  };
}

afterEach(() => {
  plans.clearAllPendingPlans();
});

describe('Nouveaux outils de structuration serveur (categories, permissions salons)', () => {
  it('create_category cree une categorie, la reutilise si deja existante et verifie ManageChannels', async () => {
    const guild = createMockGuild();
    const admin = createMockMember({
      id: 'admin-1',
      perms: ['ManageChannels'],
      highestPosition: 20,
    });

    const res1 = await executeTool(
      'create_category',
      { name: 'Communauté' },
      { guild, member: admin, mode: 'agent', userText: 'cree categorie Communauté' }
    );
    assert.equal(res1.ok, true);
    assert.equal(guild.createdChannels.length, 1);
    assert.equal(guild.createdChannels[0].type, ChannelType.GuildCategory);

    const res2 = await executeTool(
      'create_category',
      { name: 'communaute' },
      { guild, member: admin, mode: 'agent', userText: 'cree categorie communaute' }
    );
    assert.equal(res2.ok, true);
    assert.equal(res2.reused, true);
    assert.equal(guild.createdChannels.length, 1);

    const basicUser = createMockMember({ id: 'user-1', perms: [] });
    const res3 = await executeTool(
      'create_category',
      { name: 'VIP' },
      { guild, member: basicUser, mode: 'agent', userText: 'cree categorie VIP' }
    );
    assert.equal(res3.ok, false);
    assert.equal(res3.needsApproval, true);
    assert.equal(res3.approval.requiredPermission, 'ManageChannels');
  });

  it('create_channel supporte category/topic explicites et modify_channel peut deplacer vers une categorie', async () => {
    const guild = createMockGuild();
    const staffCat = createMockChannel({
      id: 'cat-staff',
      name: 'Staff',
      type: ChannelType.GuildCategory,
      channelsCache: guild.channels.cache,
    });
    const general = createMockChannel({
      id: 'chan-gen',
      name: 'general',
      type: ChannelType.GuildText,
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(staffCat.id, staffCat);
    guild.channels.cache.set(general.id, general);

    const admin = createMockMember({
      id: 'admin-1',
      perms: ['ManageChannels'],
      highestPosition: 20,
    });

    const createRes = await executeTool(
      'create_channel',
      {
        name: 'annonces-staff',
        type: 'text',
        category: 'Staff',
        topic: 'Annonces internes de l equipe',
      },
      { guild, member: admin, mode: 'agent', userText: 'cree salon annonces-staff dans Staff' }
    );
    assert.equal(createRes.ok, true);
    assert.equal(guild.createdChannels[0].parent, 'cat-staff');
    assert.equal(guild.createdChannels[0].topic, 'Annonces internes de l equipe');

    const moveRes = await executeTool(
      'modify_channel',
      { channel: 'general', category: 'Staff' },
      { guild, member: admin, mode: 'agent', userText: 'deplace general dans Staff' }
    );
    assert.equal(moveRes.ok, true);
    assert.equal(general.parentId, 'cat-staff');
  });

  it('set_channel_permissions exige ManageChannels + ManageRoles, bloque l escalade et protege l acces du bot', async () => {
    const guild = createMockGuild({
      botPerms: ['ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages', 'ManageMessages'],
      botPosition: 50,
    });
    const staffChan = createMockChannel({
      id: 'chan-staff',
      name: 'staff',
      type: ChannelType.GuildText,
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(staffChan.id, staffChan);

    const modoRole = createMockRole({ id: 'role-modo', name: 'Moderateur', position: 5 });
    guild.roles.cache.set(modoRole.id, modoRole);

    const onlyManageChannels = createMockMember({
      id: 'user-ch',
      perms: ['ManageChannels', 'ViewChannel'],
      highestPosition: 10,
    });
    const partialPermRes = await executeTool(
      'set_channel_permissions',
      { channel: 'staff', role: '@everyone', deny: ['ViewChannel'] },
      { guild, member: onlyManageChannels, mode: 'agent', userText: 'cache staff' }
    );
    assert.equal(partialPermRes.ok, false);
    assert.equal(partialPermRes.needsApproval, true);
    assert.deepEqual(partialPermRes.approval.requiredPermissions, [
      'ManageChannels',
      'ManageRoles',
    ]);

    const managerWithoutAdmin = createMockMember({
      id: 'user-mgr',
      perms: ['ManageChannels', 'ManageRoles', 'ViewChannel'],
      highestPosition: 10,
    });
    const escalateRes = await executeTool(
      'set_channel_permissions',
      { channel: 'staff', role: 'Moderateur', allow: ['ManageMessages'] },
      { guild, member: managerWithoutAdmin, mode: 'agent', userText: 'donne ManageMessages sur staff' }
    );
    assert.equal(escalateRes.ok, false);
    assert.equal(escalateRes.needsApproval, true);

    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });
    const hideRes = await executeTool(
      'set_channel_permissions',
      { channel: 'staff', role: '@everyone', deny: ['ViewChannel'] },
      { guild, member: admin, mode: 'agent', userText: 'cache staff pour everyone' }
    );
    assert.equal(hideRes.ok, true);
    assert.equal(staffChan.permissionOverwrites.calls.length, 2);
    assert.equal(staffChan.permissionOverwrites.calls[0].targetId, 'bot-1');
    assert.equal(staffChan.permissionOverwrites.calls[0].overwriteObj.ViewChannel, true);
    assert.equal(staffChan.permissionOverwrites.calls[1].targetId, 'guild-1');
    assert.equal(staffChan.permissionOverwrites.calls[1].overwriteObj.ViewChannel, false);
  });
});

describe('Moteur de planification multi-etapes (planner.js et plans.js)', () => {
  it('tryParsePlan gere objet JSON, blocs markdown, tableau brut, action unique et texte invalide', () => {
    const p1 = planner.tryParsePlan(
      '{"summary":"Setup","steps":[{"tool":"create_category","args":{"name":"Info"}}]}'
    );
    assert.equal(p1.summary, 'Setup');
    assert.equal(p1.steps.length, 1);

    const p2 = planner.tryParsePlan(
      '```json\n[{"tool":"create_role","args":{"name":"VIP"}},{"tool":"create_channel","args":{"name":"vip"}}]\n```'
    );
    assert.equal(p2.steps.length, 2);

    const p3 = planner.tryParsePlan('{"tool":"create_channel","args":{"name":"test"}}');
    assert.equal(p3.steps.length, 1);
    assert.equal(p3.steps[0].tool, 'create_channel');

    assert.equal(planner.tryParsePlan('Bonjour comment ca va ?'), null);
  });

  it('buildValidatedPlan injecte le contexte serveur, valide les limites/permissions bot et distingue autorise vs non-autorise', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const existingCat = createMockChannel({
      id: 'cat-1',
      name: 'Communauté',
      type: ChannelType.GuildCategory,
      channelsCache: guild.channels.cache,
    });
    const existingChan = createMockChannel({
      id: 'chan-1',
      name: 'general',
      type: ChannelType.GuildText,
      parent: existingCat,
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(existingCat.id, existingCat);
    guild.channels.cache.set(existingChan.id, existingChan);

    const basicUser = createMockMember({ id: 'user-1', perms: ['ViewChannel', 'SendMessages'] });
    const capturedPrompts = [];
    const resBasic = await planner.buildValidatedPlan({
      userText: 'cree une categorie Staff et un salon staff-chat',
      guild,
      member: basicUser,
      chatFn: async (messages) => {
        capturedPrompts.push(messages[0].content);
        return {
          content: JSON.stringify({
            summary: 'Creation espace Staff',
            steps: [
              { tool: 'create_category', args: { name: 'Staff' } },
              {
                tool: 'create_channel',
                args: { name: 'staff-chat', type: 'text', category: 'Staff' },
              },
            ],
          }),
          stats: { elapsedMs: 20, model: 'test-model' },
        };
      },
      userConfig: null,
    });

    assert.equal(resBasic.ok, true);
    assert.ok(capturedPrompts[0].includes('Communauté'));
    assert.ok(capturedPrompts[0].includes('#general'));
    assert.equal(resBasic.security.requesterAuthorized, false);

    const tooManySteps = Array.from({ length: 16 }, (_, i) => ({
      tool: 'create_channel',
      args: { name: 'chan-' + i },
    }));
    const resTooLong = await planner.buildValidatedPlan({
      userText: 'cree 16 salons',
      guild,
      member: createMockMember({ id: 'admin', perms: ['Administrator'] }),
      chatFn: async () => ({
        content: JSON.stringify({ summary: 'Trop long', steps: tooManySteps }),
        stats: { elapsedMs: 10 },
      }),
      userConfig: null,
    });
    assert.equal(resTooLong.ok, false);
    assert.match(resTooLong.error, /15 etapes/);

    const weakBotGuild = createMockGuild({ botPerms: ['SendMessages'] });
    const resWeakBot = await planner.buildValidatedPlan({
      userText: 'cree categorie VIP',
      guild: weakBotGuild,
      member: basicUser,
      chatFn: async () => ({
        content: JSON.stringify({
          summary: 'VIP',
          steps: [{ tool: 'create_category', args: { name: 'VIP' } }],
        }),
        stats: { elapsedMs: 10 },
      }),
      userConfig: null,
    });
    assert.equal(resWeakBot.ok, false);
    assert.match(resWeakBot.error, /Le bot n a pas la permission/);
  });

  it('plans.js execute un plan complet de configuration serveur (roles couleurs distinctes, categorie, salon, permissions) en 6/6', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const logChan = createMockChannel({
      id: 'chan-logs',
      name: 'logs',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(logChan.id, logChan);

    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });

    const analyzed = planner.validateAndAnalyzePlan(
      {
        summary: 'Espace Staff complet',
        steps: [
          { tool: 'create_role', args: { name: 'Staff', color: 'rouge', hoist: true } },
          { tool: 'create_role', args: { name: 'Helper', color: 'bleu' } },
          { tool: 'create_category', args: { name: 'Zone Staff' } },
          {
            tool: 'create_channel',
            args: { name: 'staff-chat', type: 'text', category: 'Zone Staff' },
          },
          {
            tool: 'set_channel_permissions',
            args: { channel: 'staff-chat', role: '@everyone', deny: ['ViewChannel'] },
          },
          {
            tool: 'set_channel_permissions',
            args: {
              channel: 'staff-chat',
              role: 'Staff',
              allow: ['ViewChannel', 'SendMessages'],
            },
          },
        ],
      },
      guild,
      admin
    );
    assert.equal(analyzed.ok, true);
    assert.equal(analyzed.security.requesterAuthorized, true);

    const slash = createSlashInteraction({
      guild,
      channel: logChan,
      user: { id: admin.id },
      member: admin,
    });
    const planId = await plans.createPlanRequest({
      interaction: slash,
      channel: logChan,
      guild,
      requester: { id: admin.id },
      plan: analyzed.plan,
      security: analyzed.security,
      userText: 'cree un role Staff rouge et un role Helper bleu avec salon prive',
      stepDelayMs: 0,
    });
    assert.ok(planId);

    const execBtn = createButtonInteraction({
      customId: 'plan:execute:' + planId,
      guild,
      channel: logChan,
      user: { id: admin.id },
      member: admin,
    });
    await plans.handlePlanButton(execBtn);

    const staffRole = guild.roles.cache.find((r) => r.name === 'Staff');
    const helperRole = guild.roles.cache.find((r) => r.name === 'Helper');
    assert.ok(staffRole && helperRole);
    assert.equal(staffRole.hexColor, '#ff0000');
    assert.equal(helperRole.hexColor, '#0000ff');

    const staffCat = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === 'Zone Staff'
    );
    const staffChan = guild.channels.cache.find((c) => c.name === 'staff-chat');
    assert.ok(staffCat && staffChan);
    assert.equal(staffChan.parentId, staffCat.id);
    assert.equal(staffChan.permissionOverwrites.cache.get('guild-1')?.ViewChannel, false);
    assert.equal(staffChan.permissionOverwrites.cache.get(staffRole.id)?.SendMessages, true);

    const finalReply = execBtn.editReplies[execBtn.editReplies.length - 1];
    assert.equal(finalReply.flags, V2_FLAG);
    assert.equal(finalReply.embeds, undefined);
    assert.match(extractV2Text(finalReply), /6\/6 reussies/);
    assert.equal(extractV2Buttons(finalReply)[0].disabled, true);
  });

  it('plans.js demande validation publique pour un non-autorise, bloque les non-autorises, gere le double-clic et continue sur erreur partielle', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const chan = createMockChannel({
      id: 'chan-1',
      name: 'general',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(chan.id, chan);

    const requester = createMockMember({ id: 'req-1', perms: [] });
    const analyzed = planner.validateAndAnalyzePlan(
      {
        summary: 'Test erreur partielle + validation',
        steps: [
          { tool: 'create_category', args: { name: 'Jeux' } },
          { tool: 'modify_channel', args: { channel: 'inexistant', slowmode: 10 } },
          { tool: 'create_channel', args: { name: 'gaming', category: 'Jeux' } },
        ],
      },
      guild,
      requester
    );
    assert.equal(analyzed.ok, true);
    assert.equal(analyzed.security.requesterAuthorized, false);

    const slash = createSlashInteraction({
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
    });
    const planId = await plans.createPlanRequest({
      interaction: slash,
      channel: chan,
      guild,
      requester: { id: requester.id },
      plan: analyzed.plan,
      security: analyzed.security,
      userText: 'configure jeux',
      stepDelayMs: 0,
    });
    assert.ok(planId);

    const slashSpam = createSlashInteraction({
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
    });
    const spamId = await plans.createPlanRequest({
      interaction: slashSpam,
      channel: chan,
      guild,
      requester: { id: requester.id },
      plan: analyzed.plan,
      security: analyzed.security,
      userText: 'spam',
    });
    assert.equal(spamId, null);

    const badClick = createButtonInteraction({
      customId: 'plan:execute:' + planId,
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
    });
    await plans.handlePlanButton(badClick);
    assert.equal(badClick.replies.length, 1);
    assert.equal(badClick.replies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.equal(badClick.replies[0].content, undefined);
    assert.equal(guild.createdChannels.length, 0);

    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });
    const click1 = createButtonInteraction({
      customId: 'plan:execute:' + planId,
      guild,
      channel: chan,
      user: { id: admin.id },
      member: admin,
      deferDelayMs: 25,
    });
    const click2 = createButtonInteraction({
      customId: 'plan:execute:' + planId,
      guild,
      channel: chan,
      user: { id: admin.id },
      member: admin,
    });

    await Promise.all([
      plans.handlePlanButton(click1),
      plans.handlePlanButton(click2),
    ]);

    assert.equal(click2.replies.length, 1);
    assert.equal(click2.replies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.equal(guild.createdChannels.length, 2);

    const finalReply = click1.editReplies[click1.editReplies.length - 1];
    assert.equal(finalReply.flags, V2_FLAG);
    const finalReplyText = extractV2Text(finalReply);
    assert.match(finalReplyText, /2\/3 reussies/);
    assert.match(finalReplyText, /Erreurs/);
    assert.match(finalReplyText, /Etape 2/);
  });

  it('plans.js permet d annuler un plan et expire proprement sans rien executer', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'] });
    const chan = createMockChannel({
      id: 'chan-1',
      name: 'general',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(chan.id, chan);

    const admin = createMockMember({ id: 'admin-1', perms: ['Administrator'] });
    const analyzed = planner.validateAndAnalyzePlan(
      {
        summary: 'Test annulation et expiration',
        steps: [{ tool: 'create_category', args: { name: 'Temp' } }],
      },
      guild,
      admin
    );

    const slash1 = createSlashInteraction({
      guild,
      channel: chan,
      user: { id: admin.id },
      member: admin,
    });
    const planId1 = await plans.createPlanRequest({
      interaction: slash1,
      channel: chan,
      guild,
      requester: { id: admin.id },
      plan: analyzed.plan,
      security: analyzed.security,
      timeoutMs: 200,
    });
    const cancelBtn = createButtonInteraction({
      customId: 'plan:cancel:' + planId1,
      guild,
      channel: chan,
      user: { id: admin.id },
      member: admin,
    });
    await plans.handlePlanButton(cancelBtn);
    assert.equal(cancelBtn.updates.length, 1);
    assert.equal(cancelBtn.updates[0].flags, V2_FLAG);
    assert.equal(extractV2Buttons(cancelBtn.updates[0])[0].disabled, true);
    assert.equal(guild.createdChannels.length, 0);

    const slash2 = createSlashInteraction({
      guild,
      channel: chan,
      user: { id: admin.id },
      member: admin,
    });
    const planId2 = await plans.createPlanRequest({
      interaction: slash2,
      channel: chan,
      guild,
      requester: { id: admin.id },
      plan: analyzed.plan,
      security: analyzed.security,
      timeoutMs: 30,
    });

    await new Promise((resolve) => setTimeout(resolve, 65));

    assert.equal(guild.createdChannels.length, 0);
    assert.equal(slash2.sentMessage.edits.length, 1);
    assert.equal(slash2.sentMessage.edits[0].flags, V2_FLAG);
    assert.equal(extractV2Buttons(slash2.sentMessage.edits[0])[0].disabled, true);

    const lateClick = createButtonInteraction({
      customId: 'plan:execute:' + planId2,
      guild,
      channel: chan,
      user: { id: admin.id },
      member: admin,
    });
    await plans.handlePlanButton(lateClick);
    assert.equal(lateClick.replies.length, 1);
    assert.equal(lateClick.replies[0].flags, V2_EPHEMERAL_FLAGS);
  });
});

describe('Permissions de categorie entiere et modification interactive de plan', () => {
  it('set_channel_permissions desambigue categorie vs salon, synchronise les enfants et gere sync_children=false et enfants bloques', async () => {
    const guild = createMockGuild({
      botPerms: ['ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages'],
      botPosition: 50,
    });

    const staffCat = createMockChannel({
      id: 'cat-staff',
      name: 'Staff',
      type: ChannelType.GuildCategory,
      channelsCache: guild.channels.cache,
    });
    const sameNameChan = createMockChannel({
      id: 'chan-same',
      name: 'staff',
      type: ChannelType.GuildText,
      channelsCache: guild.channels.cache,
    });
    const childChat = createMockChannel({
      id: 'chan-chat',
      name: 'staff-chat',
      type: ChannelType.GuildText,
      parent: staffCat,
      channelsCache: guild.channels.cache,
    });
    const childVocal = createMockChannel({
      id: 'chan-vocal',
      name: 'staff-vocal',
      type: ChannelType.GuildVoice,
      parent: staffCat,
      channelsCache: guild.channels.cache,
    });
    const childLocked = createMockChannel({
      id: 'chan-locked',
      name: 'staff-secret',
      type: ChannelType.GuildText,
      parent: staffCat,
      channelsCache: guild.channels.cache,
    });

    guild.channels.cache.set(staffCat.id, staffCat);
    guild.channels.cache.set(sameNameChan.id, sameNameChan);
    guild.channels.cache.set(childChat.id, childChat);
    guild.channels.cache.set(childVocal.id, childVocal);
    guild.channels.cache.set(childLocked.id, childLocked);

    const modoRole = createMockRole({ id: 'role-modo', name: 'Moderateur', position: 5 });
    guild.roles.cache.set(modoRole.id, modoRole);

    const manager = createMockMember({
      id: 'mgr-1',
      perms: ['ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages'],
      highestPosition: 20,
      channelPerms: new Map([['chan-locked', ['ViewChannel']]]),
    });

    // 1. Disambiguation : #staff cible le salon, { target_type: 'category' } et { category } ciblent la categorie
    const chanOnlyRes = await executeTool(
      'set_channel_permissions',
      { channel: '#staff', role: 'Moderateur', allow: ['ViewChannel'] },
      { guild, member: manager, mode: 'agent', userText: 'autorise Moderateur dans #staff' }
    );
    assert.equal(chanOnlyRes.ok, true);
    assert.equal(chanOnlyRes.isCategory, false);
    assert.equal(sameNameChan.permissionOverwrites.cache.get(modoRole.id)?.ViewChannel, true);
    assert.equal(staffCat.permissionOverwrites.cache.has(modoRole.id), false);

    // 2. Categorie avec anti-lockout bot + sync partielle (1 enfant bloque par permissionsFor)
    const catHideRes = await executeTool(
      'set_channel_permissions',
      { channel: 'Staff', target_type: 'category', role: '@everyone', deny: ['ViewChannel'] },
      { guild, member: manager, mode: 'agent', userText: 'cache categorie Staff' }
    );
    assert.equal(catHideRes.ok, true);
    assert.equal(catHideRes.isCategory, true);
    assert.equal(catHideRes.syncedCount, 2);
    assert.deepEqual(catHideRes.skippedChildren, ['#staff-secret']);
    assert.equal(staffCat.permissionOverwrites.cache.get('bot-1')?.ViewChannel, true);
    assert.equal(staffCat.permissionOverwrites.cache.get('guild-1')?.ViewChannel, false);
    assert.equal(childChat.permissionOverwrites.cache.get('bot-1')?.ViewChannel, true);
    assert.equal(childChat.permissionOverwrites.cache.get('guild-1')?.ViewChannel, false);
    assert.equal(childVocal.permissionOverwrites.cache.get('guild-1')?.ViewChannel, false);
    assert.equal(childLocked.permissionOverwrites.cache.has('guild-1'), false);

    // 3. Fallback { category: 'Staff' } + sync_children: false ne touche que la categorie
    const callsBefore = childChat.permissionOverwrites.calls.length;
    const catNoSyncRes = await executeTool(
      'set_channel_permissions',
      {
        category: 'Staff',
        role: 'Moderateur',
        allow: ['ViewChannel'],
        sync_children: false,
      },
      { guild, member: manager, mode: 'agent', userText: 'autorise Moderateur sur Staff' }
    );
    assert.equal(catNoSyncRes.ok, true);
    assert.equal(catNoSyncRes.isCategory, true);
    assert.equal(catNoSyncRes.syncedCount, 0);
    assert.equal(staffCat.permissionOverwrites.cache.get(modoRole.id)?.ViewChannel, true);
    assert.equal(childChat.permissionOverwrites.calls.length, callsBefore);
  });

  it('planner.js instruit target_type:category, consolide les plans repetitifs (y compris >15 etapes brutes) et deduplique les enfants redondants', () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });

    const catArchive = createMockChannel({
      id: 'cat-1',
      name: 'Projet',
      type: ChannelType.GuildCategory,
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(catArchive.id, catArchive);
    const partialIds = ['p1', 'p2', 'p3'];
    for (const pName of partialIds) {
      const ch = createMockChannel({
        id: 'chan-' + pName,
        name: pName,
        type: ChannelType.GuildText,
        parent: catArchive,
        channelsCache: guild.channels.cache,
      });
      guild.channels.cache.set(ch.id, ch);
    }

    const prompt = planner.buildPlannerSystemPrompt(planner.buildGuildContext(guild));
    assert.match(prompt, /target_type.*category/i);

    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });

    // Plan brut de 18 etapes :
    // - nouvelle categorie VIP avec 6 salons * 2 roles (= 12 set_channel_permissions -> consolides en 2 etapes)
    // - categorie Projet existante (3 salons) : seulement 2/3 salons cibles (NE DOIT PAS fusionner)
    // - categorie Info : etape categorie suivie d une etape enfant redondante (doit etre dedupliquee)
    const rawSteps = [
      { tool: 'create_category', args: { name: 'VIP' } },
      ...['vip-1', 'vip-2', 'vip-3', 'vip-4', 'vip-5', 'vip-6'].map((name) => ({
        tool: 'create_channel',
        args: { name, type: 'text', category: 'VIP' },
      })),
      ...['vip-1', 'vip-2', 'vip-3', 'vip-4', 'vip-5', 'vip-6'].map((channel) => ({
        tool: 'set_channel_permissions',
        args: { channel, role: '@everyone', deny: ['ViewChannel'] },
      })),
      { tool: 'set_channel_permissions', args: { channel: 'p1', role: '@everyone', deny: ['SendMessages'] } },
      { tool: 'set_channel_permissions', args: { channel: 'p2', role: '@everyone', deny: ['SendMessages'] } },
      { tool: 'create_category', args: { name: 'Info' } },
      { tool: 'create_channel', args: { name: 'regles', type: 'text', category: 'Info' } },
      { tool: 'create_channel', args: { name: 'annonces', type: 'text', category: 'Info' } },
      {
        tool: 'set_channel_permissions',
        args: { channel: 'Info', role: '@everyone', deny: ['SendMessages'] },
      },
      {
        tool: 'set_channel_permissions',
        args: { channel: 'regles', role: 'everyone', deny: ['SendMessages'] },
      },
    ];

    assert.ok(rawSteps.length > planner.MAX_PLAN_STEPS);

    const analyzed = planner.validateAndAnalyzePlan(
      { summary: 'Consolidation categories', steps: rawSteps },
      guild,
      admin
    );
    assert.equal(analyzed.ok, true);

    const vipPermStep = analyzed.plan.steps.find(
      (s) => s.tool === 'set_channel_permissions' && s.args.channel === 'VIP'
    );
    assert.ok(vipPermStep);
    assert.equal(vipPermStep.args.target_type, 'category');
    assert.match(vipPermStep.label, /^Permissions categorie "VIP"/);

    // Projet (2/3 seulement) ne doit PAS etre consolide
    const projetPermSteps = analyzed.plan.steps.filter(
      (s) => s.tool === 'set_channel_permissions' && (s.args.channel === 'p1' || s.args.channel === 'p2')
    );
    assert.equal(projetPermSteps.length, 2);

    // Info avait deja une etape categorie (auto-detectee sans target_type explicite) et l etape redondante sur #regles est supprimee
    const infoStep = analyzed.plan.steps.find(
      (s) => s.tool === 'set_channel_permissions' && s.args.channel === 'Info'
    );
    assert.equal(infoStep.args.target_type, 'category');
    const reglesRedundant = analyzed.plan.steps.find(
      (s) => s.tool === 'set_channel_permissions' && s.args.channel === 'regles'
    );
    assert.equal(reglesRedundant, undefined);
  });

  it('reviseValidatedPlan envoie le plan courant + modifications au LLM, gere le retry JSON et refuse un texte vide', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });

    const emptyMod = await planner.reviseValidatedPlan({
      originalUserText: 'cree categorie Staff',
      currentPlan: {
        summary: 'Setup Staff',
        steps: [{ tool: 'create_category', args: { name: 'Staff' } }],
      },
      modificationRequest: '   ',
      guild,
      member: admin,
      userConfig: null,
    });
    assert.equal(emptyMod.ok, false);
    assert.match(emptyMod.error, /Aucune instruction/);

    const calls = [];
    const revised = await planner.reviseValidatedPlan({
      originalUserText: 'cree un role Moderateur et une categorie Staff',
      currentPlan: {
        summary: 'Setup Staff v1',
        steps: [
          { tool: 'create_role', args: { name: 'Moderateur', color: 'vert' }, label: 'Creer le role "Moderateur" (vert)' },
          { tool: 'create_category', args: { name: 'Staff' }, label: 'Creer la categorie "Staff"' },
        ],
      },
      modificationRequest: 'Mets le role en bleu et ajoute un salon #staff-chat prive',
      guild,
      member: admin,
      userConfig: null,
      chatFn: async (messages) => {
        calls.push(messages);
        if (calls.length === 1) {
          return { content: 'Voici le plan modifie...', stats: { elapsedMs: 12 } };
        }
        return {
          content: JSON.stringify({
            summary: 'Setup Staff v2',
            steps: [
              { tool: 'create_role', args: { name: 'Moderateur', color: 'bleu' } },
              { tool: 'create_category', args: { name: 'Staff' } },
              { tool: 'create_channel', args: { name: 'staff-chat', type: 'text', category: 'Staff' } },
              {
                tool: 'set_channel_permissions',
                args: { channel: 'Staff', target_type: 'category', role: '@everyone', deny: ['ViewChannel'] },
              },
            ],
          }),
          stats: { elapsedMs: 18, model: 'test-model' },
        };
      },
    });

    assert.equal(revised.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1].content, 'cree un role Moderateur et une categorie Staff');
    const serializedPassed = JSON.parse(calls[0][2].content);
    assert.equal(serializedPassed.steps[0].label, undefined);
    assert.match(calls[0][3].content, /Mets le role en bleu/);
    assert.equal(revised.plan.summary, 'Setup Staff v2');
    assert.equal(revised.plan.steps.length, 4);
    assert.equal(revised.stats.elapsedMs, 30);
  });

  it('plans.js gere le bouton Modifier le plan, le Modal de revision (v2 destructive, erreur conserve v1, double soumission, expiration v2)', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const chan = createMockChannel({
      id: 'chan-logs',
      name: 'logs',
      channelsCache: guild.channels.cache,
    });
    const oldChan = createMockChannel({
      id: 'chan-old',
      name: 'ancien',
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(chan.id, chan);
    guild.channels.cache.set(oldChan.id, oldChan);

    const requester = createMockMember({ id: 'req-1', perms: [] });
    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });
    const bystander = createMockMember({ id: 'other-1', perms: ['SendMessages'] });

    const v1Analyzed = planner.validateAndAnalyzePlan(
      {
        summary: 'Espace VIP v1',
        steps: [{ tool: 'create_category', args: { name: 'VIP' } }],
      },
      guild,
      requester
    );
    assert.equal(v1Analyzed.ok, true);
    assert.equal(v1Analyzed.security.hasDestructive, false);

    let mode = 'fail';
    const revisePlanFn = async ({ currentPlan, modificationRequest }) => {
      if (mode === 'fail') {
        return {
          ok: false,
          error: 'Le plan depasse la limite autorisee.',
          stats: { elapsedMs: 15 },
        };
      }
      if (mode === 'delay') {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return planner.reviseValidatedPlan({
        originalUserText: 'configure VIP',
        currentPlan,
        modificationRequest,
        guild,
        member: requester,
        userConfig: null,
        chatFn: async () => ({
          content: JSON.stringify({
            summary: 'Espace VIP v2',
            steps: [
              { tool: 'create_category', args: { name: 'VIP' } },
              { tool: 'delete_channel', args: { channel: 'ancien' } },
            ],
          }),
          stats: { elapsedMs: 25, model: 'mock-llm' },
        }),
      });
    };

    const slash = createSlashInteraction({
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
    });

    const planId = await plans.createPlanRequest({
      interaction: slash,
      channel: chan,
      guild,
      requester: { id: requester.id },
      requesterMember: requester,
      plan: v1Analyzed.plan,
      security: v1Analyzed.security,
      userText: 'configure VIP',
      stepDelayMs: 0,
      revisePlanFn,
    });
    assert.ok(planId);

    // 3 boutons presents : Execute, Modifier, Annuler
    assert.equal(slash.editReplies[0].flags, V2_FLAG);
    const initialRow = extractV2Buttons(slash.editReplies[0]);
    assert.equal(initialRow.length, 3);
    assert.equal(initialRow[1].custom_id, 'plan:modify:' + planId);

    // Un tiers non autorise ne peut pas ouvrir le modal
    const badModifyBtn = createButtonInteraction({
      customId: 'plan:modify:' + planId,
      guild,
      channel: chan,
      user: { id: bystander.id },
      member: bystander,
    });
    await plans.handlePlanButton(badModifyBtn);
    assert.equal(badModifyBtn.shownModals.length, 0);
    assert.equal(badModifyBtn.replies.length, 1);
    assert.equal(badModifyBtn.replies[0].flags, V2_EPHEMERAL_FLAGS);

    // Le demandeur peut ouvrir le modal
    const reqModifyBtn = createButtonInteraction({
      customId: 'plan:modify:' + planId,
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
    });
    await plans.handlePlanButton(reqModifyBtn);
    assert.equal(reqModifyBtn.shownModals.length, 1);
    assert.equal(reqModifyBtn.shownModals[0].data.custom_id, 'plan:revise:' + planId);

    // Echec de revision -> conserve v1 et envoie un followUp ephemere
    const failModal = createModalSubmitInteraction({
      customId: 'plan:revise:' + planId,
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
      instructions: 'Ajoute 30 salons',
    });
    await plans.handlePlanModal(failModal);
    assert.equal(failModal.followUps.length, 1);
    assert.equal(failModal.followUps[0].flags, V2_EPHEMERAL_FLAGS);
    assert.match(extractV2Text(failModal.followUps[0]), /plan precedent est conserve/i);
    const restoredReply = failModal.editReplies[failModal.editReplies.length - 1];
    assert.equal(restoredReply.flags, V2_FLAG);
    assert.match(extractV2Text(restoredReply), /Espace VIP v1/);
    assert.equal(extractV2Buttons(restoredReply)[0].disabled, false);

    // Succes v2 + double soumission simultanee bloquee -> v2 destructive, Danger button, execute v2
    mode = 'delay';
    const modal1 = createModalSubmitInteraction({
      customId: 'plan:revise:' + planId,
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
      instructions: 'Supprime ancien en plus de VIP',
    });
    const modal2 = createModalSubmitInteraction({
      customId: 'plan:revise:' + planId,
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
      instructions: 'Double clic',
    });

    await Promise.all([
      plans.handlePlanModal(modal1),
      plans.handlePlanModal(modal2),
    ]);

    assert.equal(modal2.replies.length, 1);
    assert.equal(modal2.replies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.equal(modal1.followUps.length, 0);

    const v2Reply = modal1.editReplies[modal1.editReplies.length - 1];
    assert.equal(v2Reply.flags, V2_FLAG);
    const v2Text = extractV2Text(v2Reply);
    assert.match(v2Text, /\(v2\)/);
    assert.match(v2Text, /Espace VIP v2/);
    const v2Buttons = extractV2Buttons(v2Reply);
    assert.equal(v2Buttons[0].style, ButtonStyle.Danger);
    assert.equal(v2Buttons[0].disabled, false);

    // Execution du plan v2 par un admin
    const execBtn = createButtonInteraction({
      customId: 'plan:execute:' + planId,
      guild,
      channel: chan,
      user: { id: admin.id },
      member: admin,
    });
    await plans.handlePlanButton(execBtn);
    assert.equal(guild.createdChannels.length, 1);
    assert.equal(guild.createdChannels[0].name, 'VIP');
    assert.equal(oldChan.deleted, true);

    // Verifie que l expiration apres revision affiche la version v2 mise a jour
    const slashExp = createSlashInteraction({
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
    });
    const planIdExp = await plans.createPlanRequest({
      interaction: slashExp,
      channel: chan,
      guild,
      requester: { id: requester.id },
      requesterMember: requester,
      plan: v1Analyzed.plan,
      security: v1Analyzed.security,
      userText: 'configure VIP',
      timeoutMs: 80,
      revisePlanFn: async ({ currentPlan, modificationRequest }) =>
        planner.reviseValidatedPlan({
          originalUserText: 'configure VIP',
          currentPlan,
          modificationRequest,
          guild,
          member: requester,
          userConfig: null,
          chatFn: async () => ({
            content: JSON.stringify({
              summary: 'Plan Expire v2',
              steps: [{ tool: 'create_category', args: { name: 'VIP-Rev2' } }],
            }),
            stats: { elapsedMs: 5 },
          }),
        }),
    });

    const revBeforeExp = createModalSubmitInteraction({
      customId: 'plan:revise:' + planIdExp,
      guild,
      channel: chan,
      user: { id: requester.id },
      member: requester,
      instructions: 'Renomme VIP en VIP-Rev2',
    });
    await plans.handlePlanModal(revBeforeExp);

    await new Promise((resolve) => setTimeout(resolve, 110));
    const lastExpEdit = slashExp.sentMessage.edits[slashExp.sentMessage.edits.length - 1];
    assert.equal(lastExpEdit.flags, V2_FLAG);
    assert.match(extractV2Text(lastExpEdit), /Plan Expire v2/);
  });
});

describe('Types de salons complets, salon de spoiler, cooldown, accents et affichage enrichi', () => {
  it('create_channel et modify_channel supportent texte, forum, annonce, voix, conference, spoiler (IsSpoilerChannel), cooldown et NSFW', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });

    const cText = await executeTool(
      'create_channel',
      { name: 'blabla', type: 'texte', cooldown: 15, spoiler: true, nsfw: true, topic: 'Sujet libre' },
      { guild, member: admin, mode: 'agent', userText: 'cree salon blabla' }
    );
    const cForum = await executeTool(
      'create_channel',
      { name: 'theories', type: 'forum', spoiler: true, slowmode: 30, topic: 'Postez vos theories' },
      { guild, member: admin, mode: 'agent', userText: 'cree forum theories' }
    );
    const cAnn = await executeTool(
      'create_channel',
      { name: 'news', type: 'annonce', topic: 'Annonces officielles' },
      { guild, member: admin, mode: 'agent', userText: 'cree annonce news' }
    );
    const cVoice = await executeTool(
      'create_channel',
      { name: 'Salon Détente', type: 'voix', slowmode: 5 },
      { guild, member: admin, mode: 'agent', userText: 'cree voix Salon Détente' }
    );
    const cStage = await executeTool(
      'create_channel',
      { name: 'Conférence Live', type: 'conference' },
      { guild, member: admin, mode: 'agent', userText: 'cree conference Conférence Live' }
    );

    assert.equal(cText.ok && cForum.ok && cAnn.ok && cVoice.ok && cStage.ok, true);
    assert.equal(guild.createdChannels[0].type, ChannelType.GuildText);
    assert.equal(guild.createdChannels[0].rateLimitPerUser, 15);
    assert.equal(guild.createdChannels[0].nsfw, true);
    assert.equal(guild.createdChannels[1].type, ChannelType.GuildForum);
    assert.equal(guild.createdChannels[1].rateLimitPerUser, 30);
    assert.equal(guild.createdChannels[2].type, ChannelType.GuildAnnouncement);
    assert.equal(guild.createdChannels[3].type, ChannelType.GuildVoice);
    assert.equal(guild.createdChannels[3].name, 'Salon Détente');
    assert.equal(guild.createdChannels[4].type, ChannelType.GuildStageVoice);
    assert.equal(guild.createdChannels[4].name, 'Conférence Live');

    const textChan = guild.channels.cache.find((c) => c.name === 'blabla');
    const forumChan = guild.channels.cache.find((c) => c.name === 'theories');
    assert.equal(textChan.flags.has(ChannelFlags.IsSpoilerChannel), true);
    assert.equal(forumChan.flags.has(ChannelFlags.IsSpoilerChannel), true);
    assert.match(cForum.result, /Type : forum/);
    assert.match(cForum.result, /salon de spoiler/);
    assert.match(cForum.result, /cooldown 30s/);

    // modify_channel : desactiver spoiler, passer texte -> annonce, changer cooldown/nsfw
    const modText = await executeTool(
      'modify_channel',
      { channel: 'blabla', type: 'annonce', spoiler: false, cooldown: 0, nsfw: false },
      { guild, member: admin, mode: 'agent', userText: 'modifie blabla' }
    );
    assert.equal(modText.ok, true);
    assert.equal(textChan.type, ChannelType.GuildAnnouncement);
    assert.equal(textChan.flags.has(ChannelFlags.IsSpoilerChannel), false);
    assert.equal(textChan.rateLimitPerUser, 0);
    assert.equal(textChan.nsfw, false);

    // Refus spoiler sur vocal et conversion type invalide sur forum
    const badSpoilerVoice = await executeTool(
      'modify_channel',
      { channel: 'Salon Détente', spoiler: true },
      { guild, member: admin, mode: 'agent', userText: 'mets spoiler sur vocal' }
    );
    assert.equal(badSpoilerVoice.ok, false);
    assert.match(badSpoilerVoice.error, /salon de spoiler/i);

    const badConvert = await executeTool(
      'modify_channel',
      { channel: 'theories', type: 'texte' },
      { guild, member: admin, mode: 'agent', userText: 'convertis theories' }
    );
    assert.equal(badConvert.ok, false);
    assert.match(badConvert.error, /texte et annonce/i);
  });

  it('trouve les roles et salons meme quand les accents sont omis (modify, perm, archive, delete, sync)', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });

    const accentedCat = createMockChannel({
      id: 'cat-acc',
      name: 'Équipe',
      type: ChannelType.GuildCategory,
      channelsCache: guild.channels.cache,
    });
    const voiceChan = createMockChannel({
      id: 'chan-v',
      name: 'Général Vocal',
      type: ChannelType.GuildVoice,
      parent: accentedCat,
      channelsCache: guild.channels.cache,
    });
    const stageChan = createMockChannel({
      id: 'chan-s',
      name: 'Conférence Équipe',
      type: ChannelType.GuildStageVoice,
      parent: accentedCat,
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(accentedCat.id, accentedCat);
    guild.channels.cache.set(voiceChan.id, voiceChan);
    guild.channels.cache.set(stageChan.id, stageChan);

    const modoRole = createMockRole({ id: 'role-mod', name: 'Modérateur', position: 5 });
    const tempRole = createMockRole({ id: 'role-tmp', name: 'Référence', position: 4 });
    guild.roles.cache.set(modoRole.id, modoRole);
    guild.roles.cache.set(tempRole.id, tempRole);

    const modDisplay = await executeTool(
      'modify_role_display',
      { role: 'Moderateur', hoist: true },
      { guild, member: admin, mode: 'agent', userText: 'hoist Moderateur' }
    );
    assert.equal(modDisplay.ok, true);
    assert.equal(modoRole.hoist, true);

    const modPerm = await executeTool(
      'modify_role_perm',
      { role: 'Moderateur', add: ['ManageMessages'] },
      { guild, member: admin, mode: 'agent', userText: 'perm Moderateur' }
    );
    assert.equal(modPerm.ok, true);
    assert.equal(modoRole.permissions.has(PermissionsBitField.Flags.ManageMessages), true);

    const archRole = await executeTool(
      'archive_role',
      { role: 'Moderateur' },
      { guild, member: admin, mode: 'agent', userText: 'archive Moderateur' }
    );
    assert.equal(archRole.ok, true);

    const delRole = await executeTool(
      'delete_role',
      { role: 'Reference' },
      { guild, member: admin, mode: 'agent', userText: 'supprime Reference', confirmed: true }
    );
    assert.equal(delRole.ok, true);
    assert.equal(tempRole.deleted, true);

    // Categorie sync sur voix + conference sans accents
    const catSync = await executeTool(
      'set_channel_permissions',
      { channel: 'Equipe', target_type: 'category', role: '@everyone', deny: ['ViewChannel'] },
      { guild, member: admin, mode: 'agent', userText: 'cache Equipe' }
    );
    assert.equal(catSync.ok, true);
    assert.equal(catSync.syncedCount, 2);

    const modVoice = await executeTool(
      'modify_channel',
      { channel: 'General Vocal', slowmode: 10 },
      { guild, member: admin, mode: 'agent', userText: 'cooldown General Vocal' }
    );
    assert.equal(modVoice.ok, true);
    assert.equal(voiceChan.rateLimitPerUser, 10);

    const archStage = await executeTool(
      'archive_channel',
      { channel: 'Conference Equipe' },
      { guild, member: admin, mode: 'agent', userText: 'archive Conference Equipe' }
    );
    assert.equal(archStage.ok, true);

    const delVoice = await executeTool(
      'delete_channel',
      { channel: 'General Vocal' },
      { guild, member: admin, mode: 'agent', userText: 'supprime General Vocal', confirmed: true }
    );
    assert.equal(delVoice.ok, true);
    assert.equal(voiceChan.deleted, true);
  });

  it('validateAndAnalyzePlan valide en amont, describePlanStep affiche toutes les options et list_channels/buildGuildContext exposent les 5 types', async () => {
    const guild = createMockGuild({ botPerms: ['Administrator'], botPosition: 50 });
    const admin = createMockMember({
      id: 'admin-1',
      perms: ['Administrator'],
      highestPosition: 20,
    });

    const forumChan = createMockChannel({
      id: 'chan-f',
      name: 'entraide',
      type: ChannelType.GuildForum,
      rateLimitPerUser: 20,
      flags: new ChannelFlagsBitField().add(ChannelFlags.IsSpoilerChannel),
      channelsCache: guild.channels.cache,
    });
    const stageChan = createMockChannel({
      id: 'chan-s',
      name: 'scene',
      type: ChannelType.GuildStageVoice,
      channelsCache: guild.channels.cache,
    });
    guild.channels.cache.set(forumChan.id, forumChan);
    guild.channels.cache.set(stageChan.id, stageChan);

    // 1. Validations en amont
    const emptyModChan = planner.validateAndAnalyzePlan(
      { summary: 'Vide', steps: [{ tool: 'modify_channel', args: { channel: 'entraide' } }] },
      guild,
      admin
    );
    assert.equal(emptyModChan.ok, false);
    assert.match(emptyModChan.error, /aucune modification specifiee/i);

    const emptyModRole = planner.validateAndAnalyzePlan(
      { summary: 'Vide', steps: [{ tool: 'modify_role_display', args: { role: 'VIP' } }] },
      guild,
      admin
    );
    assert.equal(emptyModRole.ok, false);
    assert.match(emptyModRole.error, /aucune modification specifiee/i);

    const badTypeCreate = planner.validateAndAnalyzePlan(
      { summary: 'Inconnu', steps: [{ tool: 'create_channel', args: { name: 'x', type: 'podcast' } }] },
      guild,
      admin
    );
    assert.equal(badTypeCreate.ok, false);
    assert.match(badTypeCreate.error, /Type de salon invalide/i);

    const badTypeModify = planner.validateAndAnalyzePlan(
      { summary: 'Forum', steps: [{ tool: 'modify_channel', args: { channel: 'entraide', type: 'forum' } }] },
      guild,
      admin
    );
    assert.equal(badTypeModify.ok, false);
    assert.match(badTypeModify.error, /texte et annonce/i);

    // 2. Affichage complet des labels dans describePlanStep / validateAndAnalyzePlan
    const richPlan = planner.validateAndAnalyzePlan(
      {
        summary: 'Labels complets',
        steps: [
          {
            tool: 'create_channel',
            args: {
              name: 'spoilers-film',
              type: 'forum',
              category: 'Cinema',
              cooldown: 30,
              spoiler: true,
              nsfw: true,
              topic: 'Attention aux spoilers recents',
            },
          },
          { tool: 'create_channel', args: { name: 'annonces', type: 'announcement' } },
          { tool: 'create_channel', args: { name: 'vocal', type: 'voice' } },
          { tool: 'create_channel', args: { name: 'conf', type: 'stage' } },
          {
            tool: 'modify_channel',
            args: {
              channel: 'annonces',
              type: 'texte',
              slowmode: 0,
              spoiler: false,
              nsfw: false,
              topic: 'Discussions',
            },
          },
          {
            tool: 'create_role',
            args: { name: 'Animateur', color: 'bleu', hoist: true, mentionable: true },
          },
          {
            tool: 'modify_role_display',
            args: { role: 'Animateur', hoist: false, mentionable: false },
          },
        ],
      },
      guild,
      admin
    );
    assert.equal(richPlan.ok, true);
    assert.match(richPlan.plan.steps[0].label, /\(forum, cat: Cinema, cooldown 30s, salon de spoiler, NSFW, sujet: "Attention aux spoilers recents"\)/);
    assert.match(richPlan.plan.steps[1].label, /\(annonce\)/);
    assert.match(richPlan.plan.steps[2].label, /\(voix\)/);
    assert.match(richPlan.plan.steps[3].label, /\(conference\)/);
    assert.match(richPlan.plan.steps[4].label, /type: texte, cooldown desactive, salon de spoiler: desactive, NSFW: desactive, sujet: "Discussions"/);
    assert.match(richPlan.plan.steps[5].label, /couleur bleu, affiche separement, mentionnable/);
    assert.match(richPlan.plan.steps[6].label, /affiche separement: non, mentionnable: non/);

    // 3. list_channels et buildGuildContext
    const ctx = planner.buildGuildContext(guild);
    assert.match(ctx, /#entraide \(forum, racine, cooldown 20s, spoiler\)/);
    assert.match(ctx, /#scene \(conference, racine\)/);

    const listed = await executeTool('list_channels', {}, { guild, member: admin, mode: 'chat' });
    assert.equal(listed.ok, true);
    assert.match(listed.result, /#entraide \(forum, categorie: sans categorie, cooldown 20s, spoiler/);
    assert.match(listed.result, /#scene \(conference, categorie: sans categorie/);
  });
});
