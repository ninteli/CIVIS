const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, MessageFlags } = require('discord.js');

const memory = require('../src/agent/memory');
const debug = require('../src/agent/debug');
const { executeTool } = require('../src/agent/tool-executor');
const planner = require('../src/agent/planner');
const userKeys = require('../src/agent/user-keys');
const llm = require('../src/agent/llm');
const rateLimit = require('../src/agent/rate-limit');
const { handleInteraction } = require('../src/discord/commands');
const client = require('../src/discord/client');
const { SAFE_ALLOWED_MENTIONS } = require('../src/discord/format');
const { V2_EPHEMERAL_FLAGS, extractV2Text } = require('../src/discord/ui-v2');

describe('Durcissement securite CIVIS', () => {
  it('1. Isolation memoire (channelId, authorId) : un utilisateur ne voit pas le contexte d un autre en mode action', () => {
    const chId = 'chan-iso-1';
    memory.clearHistory(chId);

    memory.addActionMessage(chId, 'user-a', {
      role: 'user',
      content: 'Cree le salon secret-a',
      authorName: 'UserA',
    });
    memory.addActionMessage(chId, 'user-b', {
      role: 'user',
      content: 'Cree le salon public-b',
      authorName: 'UserB',
    });

    const ctxA = memory.formatActionContextBlock(chId, 'user-a');
    const ctxB = memory.formatActionContextBlock(chId, 'user-b');
    assert.match(ctxA, /secret-a/);
    assert.doesNotMatch(ctxA, /public-b/);
    assert.match(ctxB, /public-b/);
    assert.doesNotMatch(ctxB, /secret-a/);

    memory.clearHistory(chId);
    assert.equal(memory.getActionHistory(chId, 'user-a').length, 0);
  });

  it('2. list_channels masque les salons prives sans ViewChannel pour le demandeur', async () => {
    const publicChan = {
      id: 'c-pub',
      name: 'general',
      type: ChannelType.GuildText,
      parent: null,
      rateLimitPerUser: 0,
      nsfw: false,
      permissionsFor: () => new PermissionsBitField(['ViewChannel', 'SendMessages']),
    };
    const privateChan = {
      id: 'c-priv',
      name: 'staff-secret',
      type: ChannelType.GuildText,
      parent: null,
      rateLimitPerUser: 0,
      nsfw: false,
      permissionsFor: (m) =>
        m.id === 'admin-1'
          ? new PermissionsBitField(['ViewChannel', 'SendMessages'])
          : new PermissionsBitField([]),
    };

    const cache = new Map([
      [publicChan.id, publicChan],
      [privateChan.id, privateChan],
    ]);
    cache.filter = (fn) => {
      const arr = [];
      for (const v of cache.values()) {
        if (fn(v)) arr.push(v);
      }
      return arr;
    };

    const guild = { name: 'TestGuild', channels: { cache } };
    const normalMember = { id: 'member-1' };
    const adminMember = { id: 'admin-1' };

    const resMember = await executeTool('list_channels', {}, {
      guild,
      member: normalMember,
      mode: 'chat',
    });
    assert.equal(resMember.ok, true);
    assert.match(resMember.result, /#general/);
    assert.doesNotMatch(resMember.result, /#staff-secret/);

    const resAdmin = await executeTool('list_channels', {}, {
      guild,
      member: adminMember,
      mode: 'chat',
    });
    assert.equal(resAdmin.ok, true);
    assert.match(resAdmin.result, /#general/);
    assert.match(resAdmin.result, /#staff-secret/);
  });

  it('3. Anti-SSRF : bloque domaines wildcard, resolution DNS vers IP privee et redirections HTTP', async () => {
    assert.equal(userKeys.validateCustomUrl('https://127.0.0.1.nip.io/v1').ok, false);
    assert.equal(userKeys.validateCustomUrl('https://10.0.0.1.sslip.io/v1').ok, false);

    const dnsBlocked = await userKeys.validateCustomUrlDns('https://evil.example.com/v1', {
      lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    assert.equal(dnsBlocked.ok, false);

    const dnsIpv6Blocked = await userKeys.validateCustomUrlDns('https://evil6.example.com/v1', {
      lookupFn: async () => [{ address: '::1', family: 6 }],
    });
    assert.equal(dnsIpv6Blocked.ok, false);

    const dnsOk = await userKeys.validateCustomUrlDns('https://api.example.com/v1', {
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    assert.equal(dnsOk.ok, true);

    // llm.chat passe redirect:'error' et bloque via lookupFn
    let seenRedirect = null;
    await llm.chat([{ role: 'user', content: 'ping' }], {
      userConfig: {
        provider: 'custom',
        label: 'Personnalise',
        baseUrl: 'https://api.example.com/v1',
        model: 'm1',
        apiKey: 'sk-test-12345678',
      },
      lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchFn: async (url, opts) => {
        if (String(url).startsWith('https://api.example.com')) {
          seenRedirect = opts.redirect;
          return {
            ok: true,
            status: 200,
            async json() {
              return { choices: [{ message: { content: 'ok' } }] };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: 'local' } }] };
          },
        };
      },
    });
    assert.equal(seenRedirect, 'error');

    let externalFetched = false;
    const blockedRes = await llm.chat([{ role: 'user', content: 'ping' }], {
      userConfig: {
        provider: 'custom',
        label: 'Personnalise',
        baseUrl: 'https://rebind.example.com/v1',
        model: 'm1',
        apiKey: 'sk-test-12345678',
      },
      lookupFn: async () => [{ address: '192.168.1.10', family: 4 }],
      fetchFn: async (url) => {
        if (String(url).startsWith('https://rebind.example.com')) {
          externalFetched = true;
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { choices: [{ message: { content: 'local-fallback' } }] };
          },
        };
      },
    });
    assert.equal(externalFetched, false);
    assert.equal(blockedRes.stats.source, 'local_fallback');
  });

  it('4. set_channel_permissions verifie la hierarchie du role cible (executeTool et planner)', async () => {
    const channel = {
      id: 'ch-1',
      name: 'general',
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: async () => {} },
      permissionsFor: () => new PermissionsBitField(['ManageChannels', 'ManageRoles', 'ViewChannel']),
    };
    const highRole = { id: 'role-high', name: 'SuperAdmin', position: 30, managed: false };
    const lowRole = { id: 'role-low', name: 'Membre', position: 2, managed: false };

    const channelsCache = new Map([[channel.id, channel]]);
    channelsCache.find = (fn) => [...channelsCache.values()].find(fn);
    channelsCache.filter = (fn) => {
      const m = new Map();
      for (const [k, v] of channelsCache.entries()) if (fn(v)) m.set(k, v);
      m.find = (f) => [...m.values()].find(f);
      return m;
    };

    const rolesCache = new Map([
      [highRole.id, highRole],
      [lowRole.id, lowRole],
    ]);
    rolesCache.find = (fn) => [...rolesCache.values()].find(fn);

    const guild = {
      id: 'guild-1',
      name: 'Guild',
      ownerId: 'owner-1',
      members: {
        me: {
          id: 'bot-1',
          permissions: new PermissionsBitField(['Administrator']),
          roles: { highest: { position: 50 } },
        },
      },
      channels: { cache: channelsCache },
      roles: { cache: rolesCache },
    };

    const modMember = {
      id: 'mod-1',
      permissions: new PermissionsBitField(['ManageChannels', 'ManageRoles', 'ViewChannel']),
      roles: { highest: { position: 10 } },
    };

    const highRes = await executeTool(
      'set_channel_permissions',
      { channel: 'general', role: 'SuperAdmin', deny: ['ViewChannel'] },
      { guild, member: modMember, mode: 'agent', userText: 'cache general pour SuperAdmin' }
    );
    assert.equal(highRes.ok, false);
    assert.equal(highRes.needsApproval, true);
    assert.match(highRes.approval.reason, /hierarchie/i);

    const planCheck = planner.validateAndAnalyzePlan(
      {
        summary: 'Test hierarchie',
        steps: [
          {
            tool: 'set_channel_permissions',
            args: { channel: 'general', role: 'SuperAdmin', deny: ['ViewChannel'] },
          },
        ],
      },
      guild,
      modMember
    );
    assert.equal(planCheck.ok, true);
    assert.equal(planCheck.security.requesterAuthorized, false);
    assert.ok(planCheck.security.targetRoleIds.includes('role-high'));
  });

  it('5. /debugmod exige ManageGuild et rate-limit bloque concurrence + cooldown', async () => {
    const chId = 'c-debug-sec-test';
    debug.disable(chId);

    let deniedMemberReply = null;
    await handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'debugmod',
      guild: { id: 'g-1', name: 'G' },
      channel: { id: chId },
      user: { id: 'u-1', username: 'U1' },
      member: { permissions: new PermissionsBitField(['SendMessages']) },
      reply: async (p) => {
        deniedMemberReply = p;
      },
    });
    assert.equal(deniedMemberReply.flags, V2_EPHEMERAL_FLAGS);
    assert.equal(deniedMemberReply.content, undefined);
    assert.match(extractV2Text(deniedMemberReply), /ManageGuild/);

    let manageChannelsOnlyReply = null;
    await handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'debugmod',
      guild: { id: 'g-1', name: 'G' },
      channel: { id: chId },
      user: { id: 'u-2', username: 'U2' },
      member: { permissions: new PermissionsBitField(['ManageChannels']) },
      reply: async (p) => {
        manageChannelsOnlyReply = p;
      },
    });
    assert.equal(manageChannelsOnlyReply.flags, V2_EPHEMERAL_FLAGS);
    assert.match(extractV2Text(manageChannelsOnlyReply), /ManageGuild/);

    let manageGuildReply = null;
    await handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'debugmod',
      guild: { id: 'g-1', name: 'G' },
      channel: { id: chId },
      user: { id: 'u-admin', username: 'Admin' },
      member: { permissions: new PermissionsBitField(['ManageGuild']) },
      reply: async (p) => {
        manageGuildReply = p;
      },
    });
    assert.equal(manageGuildReply.flags, V2_EPHEMERAL_FLAGS);
    assert.match(extractV2Text(manageGuildReply), /Mode debug active/i);
    assert.equal(debug.isEnabled(chId), true);
    debug.disable(chId);

    const limiter = rateLimit.createRateLimiter({ cooldownMs: 4000 });
    assert.equal(limiter.acquire('u-1', 1000).ok, true);
    const concurrent = limiter.acquire('u-1', 1500);
    assert.equal(concurrent.ok, false);
    assert.equal(concurrent.reason, 'in_flight');
    limiter.release('u-1', 2000);
    const tooSoon = limiter.acquire('u-1', 3500);
    assert.equal(tooSoon.ok, false);
    assert.equal(tooSoon.reason, 'cooldown');
    assert.equal(limiter.acquire('u-1', 6500).ok, true);
  });

  it('6. allowedMentions bloque @everyone/@here/roles par defaut sur le client et SAFE_ALLOWED_MENTIONS', () => {
    assert.deepEqual(SAFE_ALLOWED_MENTIONS, { parse: ['users'], repliedUser: true });
    assert.deepEqual(client.options.allowedMentions, {
      parse: ['users'],
      repliedUser: true,
    });
  });

  it('7. set_channel_permissions autorise un role managed (bot), mais modify_role/delete_role et plans mixtes restent bloques', async () => {
    const channel = {
      id: 'ch-music',
      name: 'musique',
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: async () => {} },
      permissionsFor: () =>
        new PermissionsBitField(['ManageChannels', 'ManageRoles', 'ViewChannel']),
    };
    const botManagedRole = {
      id: 'role-music-bot',
      name: 'MusicBot',
      position: 5,
      managed: true,
    };

    const channelsCache = new Map([[channel.id, channel]]);
    channelsCache.find = (fn) => [...channelsCache.values()].find(fn);
    channelsCache.filter = (fn) => {
      const m = new Map();
      for (const [k, v] of channelsCache.entries()) if (fn(v)) m.set(k, v);
      m.find = (f) => [...m.values()].find(f);
      return m;
    };

    const rolesCache = new Map([[botManagedRole.id, botManagedRole]]);
    rolesCache.find = (fn) => [...rolesCache.values()].find(fn);

    const guild = {
      id: 'guild-1',
      name: 'Guild',
      ownerId: 'owner-1',
      members: {
        me: {
          id: 'bot-1',
          permissions: new PermissionsBitField(['Administrator']),
          roles: { highest: { position: 50 } },
        },
      },
      channels: { cache: channelsCache },
      roles: { cache: rolesCache },
    };

    const adminMember = {
      id: 'admin-1',
      permissions: new PermissionsBitField(['Administrator']),
      roles: { highest: { position: 30 } },
    };

    const allowManagedRes = await executeTool(
      'set_channel_permissions',
      { channel: 'musique', role: 'MusicBot', allow: ['ViewChannel', 'SendMessages'] },
      { guild, member: adminMember, mode: 'agent', userText: 'autorise MusicBot dans musique' }
    );
    assert.equal(allowManagedRes.ok, true);

    const modifyManagedRes = await executeTool(
      'modify_role_display',
      { role: 'MusicBot', new_name: 'AutreBot' },
      { guild, member: adminMember, mode: 'agent', userText: 'renomme MusicBot' }
    );
    assert.equal(modifyManagedRes.ok, false);
    assert.match(modifyManagedRes.error, /integration \(bot\)/i);

    const deleteManagedRes = await executeTool(
      'delete_role',
      { role: 'MusicBot' },
      { guild, member: adminMember, mode: 'agent', userText: 'supprime MusicBot' }
    );
    assert.equal(deleteManagedRes.ok, false);
    assert.match(deleteManagedRes.error, /integration \(bot\)/i);

    const planOnlyOverwrite = planner.validateAndAnalyzePlan(
      {
        summary: 'Autoriser MusicBot',
        steps: [
          {
            tool: 'set_channel_permissions',
            args: { channel: 'musique', role: 'MusicBot', allow: ['ViewChannel'] },
          },
        ],
      },
      guild,
      adminMember
    );
    assert.equal(planOnlyOverwrite.ok, true);
    assert.equal(planOnlyOverwrite.security.requesterAuthorized, true);

    // Plan mixte (set_channel_permissions + modify_role_display sur le meme role managed) -> bloque
    const mixedPlan = planner.validateAndAnalyzePlan(
      {
        summary: 'Plan mixte managed',
        steps: [
          {
            tool: 'set_channel_permissions',
            args: { channel: 'musique', role: 'MusicBot', allow: ['ViewChannel'] },
          },
          {
            tool: 'modify_role_display',
            args: { role: 'MusicBot', new_name: 'HackBot' },
          },
        ],
      },
      guild,
      adminMember
    );
    assert.equal(mixedPlan.ok, false);
    assert.match(mixedPlan.error, /integration \(bot\)/i);
  });

  it('8. buildGuildContext et buildValidatedPlan masquent les categories/salons prives aux membres sans ViewChannel', async () => {
    const publicCat = {
      id: 'cat-pub',
      name: 'Communaute',
      type: ChannelType.GuildCategory,
      permissionsFor: () => new PermissionsBitField(['ViewChannel', 'SendMessages']),
    };
    const privateCat = {
      id: 'cat-priv',
      name: 'DirectionSecrete',
      type: ChannelType.GuildCategory,
      permissionsFor: (m) =>
        m.id === 'admin-1'
          ? new PermissionsBitField(['ViewChannel', 'SendMessages'])
          : new PermissionsBitField([]),
    };
    const publicChan = {
      id: 'ch-pub',
      name: 'general',
      type: ChannelType.GuildText,
      parent: publicCat,
      rateLimitPerUser: 0,
      nsfw: false,
      permissionsFor: () => new PermissionsBitField(['ViewChannel', 'SendMessages']),
    };
    const privateChan = {
      id: 'ch-priv',
      name: 'salon-secret-staff',
      type: ChannelType.GuildText,
      parent: privateCat,
      rateLimitPerUser: 0,
      nsfw: false,
      permissionsFor: (m) =>
        m.id === 'admin-1'
          ? new PermissionsBitField(['ViewChannel', 'SendMessages'])
          : new PermissionsBitField([]),
    };

    const channelsCache = new Map([
      [publicCat.id, publicCat],
      [privateCat.id, privateCat],
      [publicChan.id, publicChan],
      [privateChan.id, privateChan],
    ]);
    channelsCache.filter = (fn) => {
      const arr = [];
      for (const v of channelsCache.values()) if (fn(v)) arr.push(v);
      arr.map = Array.prototype.map.bind(arr);
      return arr;
    };

    const rolesCache = new Map();
    rolesCache.filter = () => [];

    const guild = {
      id: 'guild-ctx',
      name: 'GuildCtx',
      ownerId: 'owner-1',
      members: {
        me: {
          id: 'bot-1',
          permissions: new PermissionsBitField(['Administrator']),
          roles: { highest: { position: 50 } },
        },
      },
      channels: { cache: channelsCache },
      roles: { cache: rolesCache },
    };

    const normalMember = {
      id: 'member-1',
      permissions: new PermissionsBitField(['ViewChannel', 'SendMessages']),
      roles: { highest: { position: 1 } },
    };
    const adminMember = {
      id: 'admin-1',
      permissions: new PermissionsBitField(['Administrator']),
      roles: { highest: { position: 30 } },
    };
    const ownerMember = {
      id: 'owner-1',
      permissions: new PermissionsBitField([]),
      roles: { highest: { position: 1 } },
    };

    const memberCtx = planner.buildGuildContext(guild, normalMember);
    assert.match(memberCtx, /Communaute/);
    assert.match(memberCtx, /#general/);
    assert.doesNotMatch(memberCtx, /DirectionSecrete/);
    assert.doesNotMatch(memberCtx, /#salon-secret-staff/);

    const adminCtx = planner.buildGuildContext(guild, adminMember);
    assert.match(adminCtx, /DirectionSecrete/);
    assert.match(adminCtx, /#salon-secret-staff/);

    const ownerCtx = planner.buildGuildContext(guild, ownerMember);
    assert.match(ownerCtx, /DirectionSecrete/);
    assert.match(ownerCtx, /#salon-secret-staff/);

    const defaultCtx = planner.buildGuildContext(guild);
    assert.match(defaultCtx, /DirectionSecrete/);
    assert.match(defaultCtx, /#salon-secret-staff/);

    let capturedPromptForMember = '';
    const planRes = await planner.buildValidatedPlan({
      userText: 'cree un salon aide',
      guild,
      member: normalMember,
      authorId: normalMember.id,
      channelId: 'ch-pub',
      userConfig: null,
      chatFn: async (msgs) => {
        capturedPromptForMember = msgs[0].content;
        return {
          content:
            '{"summary":"Creer aide","steps":[{"tool":"create_channel","args":{"name":"aide"}}]}',
          stats: { elapsedMs: 5, source: 'local' },
        };
      },
    });
    assert.equal(planRes.ok, true);
    assert.match(capturedPromptForMember, /#general/);
    assert.doesNotMatch(capturedPromptForMember, /DirectionSecrete/);
    assert.doesNotMatch(capturedPromptForMember, /#salon-secret-staff/);
  });
});
