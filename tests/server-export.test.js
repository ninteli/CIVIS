const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  ChannelType,
  ChannelFlags,
  ChannelFlagsBitField,
  PermissionsBitField,
  PermissionFlagsBits,
  OverwriteType,
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  GuildDefaultMessageNotifications,
  GuildMFALevel,
  GuildPremiumTier,
  GuildScheduledEventStatus,
  GuildScheduledEventEntityType,
  StickerFormatType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  WebhookType,
  MessageFlags,
  ComponentType,
} = require('discord.js');

const serverExport = require('../src/discord/server-export');
const { handleInteraction, exportRateLimit } = require('../src/discord/commands');
const { toPlainComponent, extractV2Text, V2_FLAG, V2_EPHEMERAL_FLAGS } = require('../src/discord/ui-v2');

function makeCollection(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.id ?? item.user?.id, item);
  }
  return map;
}

function makeMember({ id, username, perms = [] }) {
  const bitfield = new PermissionsBitField(perms);
  return {
    id,
    displayName: username,
    user: { id, username },
    permissions: bitfield,
  };
}

function createMockGuild({ botPerms = [PermissionFlagsBits.Administrator] } = {}) {
  const adminMember = makeMember({
    id: 'owner-1',
    username: 'Kleene',
    perms: [PermissionFlagsBits.Administrator],
  });
  const regularMember = makeMember({
    id: 'user-2',
    username: 'CitoyenLambda',
    perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
  });
  const modBanOnlyMember = makeMember({
    id: 'mod-3',
    username: 'ModBan',
    perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.BanMembers],
  });
  const botMember = makeMember({
    id: 'bot-1',
    username: 'CIVIS',
    perms: botPerms,
  });

  const roleEveryone = {
    id: 'guild-1',
    name: '@everyone',
    position: 0,
    hexColor: '#000000',
    hoist: false,
    mentionable: false,
    managed: false,
    permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
  };
  const roleAdmin = {
    id: 'role-admin',
    name: 'Administrateur',
    position: 3,
    hexColor: '#e74c3c',
    hoist: true,
    mentionable: false,
    managed: false,
    permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
  };
  const roleBot = {
    id: 'role-bot',
    name: 'CIVIS',
    position: 2,
    hexColor: '#2b9e6e',
    hoist: false,
    mentionable: false,
    managed: true,
    tags: { botId: 'bot-1' },
    permissions: new PermissionsBitField([
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageWebhooks,
    ]),
  };

  const makePermsFor = (visibleToRegular) => (m) => {
    if (m.id === adminMember.id || m.id === botMember.id) {
      return new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    }
    return new PermissionsBitField(visibleToRegular ? [PermissionFlagsBits.ViewChannel] : []);
  };

  const catPublic = {
    id: 'cat-1',
    name: 'Place Centrale',
    type: ChannelType.GuildCategory,
    rawPosition: 0,
    permissionOverwrites: { cache: new Map() },
    permissionsFor: makePermsFor(true),
  };

  const catPrivate = {
    id: 'cat-2',
    name: 'Administration Secrete',
    type: ChannelType.GuildCategory,
    rawPosition: 1,
    permissionOverwrites: {
      cache: makeCollection([
        {
          id: 'guild-1',
          type: OverwriteType.Role,
          allow: new PermissionsBitField([]),
          deny: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
        },
        {
          id: 'role-admin',
          type: OverwriteType.Role,
          allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
          deny: new PermissionsBitField([]),
        },
      ]),
    },
    permissionsFor: makePermsFor(false),
  };

  const chRules = {
    id: 'ch-rules',
    name: 'reglement',
    type: ChannelType.GuildText,
    rawPosition: 0,
    parentId: null,
    topic: 'Charte officielle | Furcitivas',
    nsfw: false,
    rateLimitPerUser: 0,
    flags: new ChannelFlagsBitField([]),
    permissionOverwrites: {
      cache: makeCollection([
        {
          id: 'guild-1',
          type: OverwriteType.Role,
          allow: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
          deny: new PermissionsBitField([PermissionFlagsBits.SendMessages]),
        },
      ]),
    },
    permissionsFor: makePermsFor(true),
  };

  const chGeneral = {
    id: 'ch-gen',
    name: 'general',
    type: ChannelType.GuildText,
    rawPosition: 1,
    parentId: 'cat-1',
    topic: 'Discussions des citoyens',
    nsfw: false,
    rateLimitPerUser: 5,
    flags: new ChannelFlagsBitField([ChannelFlags.IsSpoilerChannel]),
    permissionOverwrites: { cache: new Map() },
    permissionsFor: makePermsFor(true),
  };

  const chForum = {
    id: 'ch-forum',
    name: 'projets',
    type: ChannelType.GuildForum,
    rawPosition: 2,
    parentId: 'cat-1',
    topic: null,
    nsfw: false,
    rateLimitPerUser: 0,
    availableTags: [{ name: 'Idee' }, { name: 'En cours' }],
    permissionOverwrites: { cache: new Map() },
    permissionsFor: makePermsFor(true),
  };

  const chVoice = {
    id: 'ch-voice',
    name: 'Salon Vocal 1',
    type: ChannelType.GuildVoice,
    rawPosition: 3,
    parentId: 'cat-1',
    bitrate: 64000,
    userLimit: 10,
    rtcRegion: null,
    permissionOverwrites: { cache: new Map() },
    permissionsFor: makePermsFor(true),
  };

  const chSecretLogs = {
    id: 'ch-secret-logs',
    name: 'secret-staff-logs',
    type: ChannelType.GuildText,
    rawPosition: 4,
    parentId: 'cat-2',
    topic: 'Confidentiel admin uniquement',
    nsfw: false,
    rateLimitPerUser: 0,
    permissionsLocked: true,
    permissionOverwrites: { cache: new Map() },
    permissionsFor: makePermsFor(false),
  };

  const threadPublic = {
    id: 'th-pub',
    name: 'Thread public visible',
    type: ChannelType.PublicThread,
    parentId: 'ch-forum',
    parent: chForum,
    locked: false,
    autoArchiveDuration: 1440,
    messageCount: 12,
    memberCount: 5,
    permissionsFor: makePermsFor(true),
  };

  const threadPrivate = {
    id: 'th-priv',
    name: 'Thread secret staff',
    type: ChannelType.PrivateThread,
    parentId: 'ch-secret-logs',
    parent: chSecretLogs,
    locked: true,
    autoArchiveDuration: 60,
    messageCount: 3,
    memberCount: 2,
    permissionsFor: makePermsFor(false),
  };

  const guild = {
    id: 'guild-1',
    name: 'Furcitivas',
    ownerId: 'owner-1',
    createdAt: new Date('2024-03-14T16:20:00.000Z'),
    description: 'Cite virtuelle 2048',
    preferredLocale: 'fr',
    memberCount: 142,
    premiumTier: GuildPremiumTier.Tier2,
    premiumSubscriptionCount: 9,
    verificationLevel: GuildVerificationLevel.Medium,
    explicitContentFilter: GuildExplicitContentFilter.AllMembers,
    defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
    mfaLevel: GuildMFALevel.Elevated,
    vanityURLCode: 'furcitivas',
    vanityURLUses: 34,
    features: ['COMMUNITY', 'AUTO_MODERATION'],
    systemChannel: chSecretLogs, // Prive -> doit etre masque pour un membre standard
    rulesChannel: chRules,
    publicUpdatesChannel: chSecretLogs,
    afkChannel: chVoice,
    afkTimeout: 900,
    iconURL: () => 'https://cdn.discordapp.com/icons/guild-1/icon.png',
    bannerURL: () => null,
    splashURL: () => null,
    fetchOwner: async () => adminMember,
    roles: {
      cache: makeCollection([roleEveryone, roleAdmin, roleBot]),
    },
    channels: {
      cache: makeCollection([catPublic, catPrivate, chRules, chGeneral, chForum, chVoice, chSecretLogs]),
      fetchActiveThreads: async () => ({
        threads: makeCollection([threadPublic, threadPrivate]),
      }),
    },
    members: {
      me: botMember,
      cache: makeCollection([adminMember, regularMember, modBanOnlyMember, botMember]),
    },
    emojis: {
      cache: new Map(),
      fetch: async () =>
        makeCollection([
          { id: 'em-1', name: 'civis_fox', animated: false, available: true },
          { id: 'em-2', name: 'neon_wave', animated: true, available: true },
        ]),
    },
    stickers: {
      cache: new Map(),
      fetch: async () =>
        makeCollection([
          { id: 'st-1', name: 'Salut Civis', format: StickerFormatType.PNG, description: 'Coucou' },
        ]),
    },
    scheduledEvents: {
      cache: new Map(),
      fetch: async () =>
        makeCollection([
          {
            id: 'ev-1',
            name: 'Assemblee publique',
            status: GuildScheduledEventStatus.Scheduled,
            entityType: GuildScheduledEventEntityType.Voice,
            channelId: 'ch-voice',
            channel: chVoice,
            scheduledStartAt: new Date('2026-12-01T19:00:00.000Z'),
            userCount: 14,
            description: 'Reunion mensuelle',
          },
          {
            id: 'ev-secret',
            name: 'Reunion Staff Secrete',
            status: GuildScheduledEventStatus.Scheduled,
            entityType: GuildScheduledEventEntityType.Voice,
            channelId: 'ch-secret-logs',
            channel: chSecretLogs,
            scheduledStartAt: new Date('2026-12-02T19:00:00.000Z'),
            userCount: 2,
          },
        ]),
    },
    autoModerationRules: {
      fetch: async () =>
        makeCollection([
          {
            id: 'am-1',
            name: 'Anti-liens malveillants',
            enabled: true,
            triggerType: AutoModerationRuleTriggerType.Keyword,
            actions: [
              { type: AutoModerationActionType.BlockMessage },
              {
                type: AutoModerationActionType.SendAlertMessage,
                metadata: { channelId: 'ch-secret-logs' },
              },
            ],
          },
        ]),
    },
    invites: {
      fetch: async () =>
        makeCollection([
          {
            code: 'Furcitivas2048',
            channel: chGeneral,
            inviter: { username: 'Kleene' },
            uses: 12,
            maxUses: 0,
            expiresAt: null,
          },
        ]),
    },
    fetchWebhooks: async () =>
      makeCollection([
        {
          id: 'wh-1',
          name: 'CIVIS Logs',
          channelId: 'ch-secret-logs',
          type: WebhookType.Incoming,
          token: 'SUPER_SECRET_WEBHOOK_TOKEN_DO_NOT_LEAK',
          url: 'https://discord.com/api/webhooks/wh-1/SUPER_SECRET_WEBHOOK_TOKEN_DO_NOT_LEAK',
        },
      ]),
    bans: {
      fetch: async () => makeCollection([{ user: { id: 'banned-1' } }, { user: { id: 'banned-2' } }]),
    },
  };

  const mockActionLogs = {
    getGuildLogStatus: () => ({
      enabled: true,
      mode: 'webhook',
      channelId: null,
      maskedWebhookUrl: 'https://discord.com/api/webhooks/123456789012345678/••••abcd',
    }),
  };

  const mockAuditSuggestions = {
    getGuildConfig: () => ({
      enabled: true,
      mode: 'auto',
      channelId: null,
      cooldownSec: 45,
    }),
  };

  return {
    guild,
    adminMember,
    regularMember,
    modBanOnlyMember,
    mockActionLogs,
    mockAuditSuggestions,
  };
}

describe('Export Markdown du serveur (server-export.js & /export)', () => {
  beforeEach(() => {
    exportRateLimit.clearAll();
  });

  it('genere un export complet pour un administrateur sans jamais exposer de token webhook', async () => {
    const { guild, adminMember, mockActionLogs, mockAuditSuggestions } = createMockGuild();
    const fixedNow = new Date('2026-11-28T08:45:00.000Z');

    const exp = await serverExport.buildServerExport({
      guild,
      member: adminMember,
      client: { user: { username: 'CIVIS' } },
      actionLogs: mockActionLogs,
      auditSuggestions: mockAuditSuggestions,
      now: fixedNow,
    });

    assert.equal(exp.filename, 'export-furcitivas-20261128-0845.md');
    assert.equal(exp.access.isAdminOrOwner, true);
    assert.equal(exp.stats.rolesCount, 3);
    assert.equal(exp.stats.categoriesCount, 2);
    assert.equal(exp.stats.channelsCount, 5);
    assert.equal(exp.stats.threadsCount, 2);
    assert.equal(exp.stats.emojisCount, 2);
    assert.equal(exp.stats.stickersCount, 1);
    assert.equal(exp.stats.eventsCount, 2);
    assert.equal(exp.stats.hasModerationSection, true);
    assert.equal(exp.stats.hasCivisSection, true);

    const md = exp.markdown;
    assert.match(md, /# Export du serveur Discord — Furcitivas/);
    assert.match(md, /Complet \(Administrateur\)/);
    assert.match(md, /Administration Secrete/);
    assert.match(md, /#secret-staff-logs/);
    assert.match(md, /Thread secret staff/);
    assert.match(md, /Charte officielle \| Furcitivas/);
    assert.match(md, /Slowmode `5s`, Spoiler/);
    assert.match(md, /Bitrate `64 kbps`/);
    assert.match(md, /`Idee`, `En cours`/);
    assert.match(md, /## 6\. Modération & Intégrations/);
    assert.match(md, /Anti-liens malveillants/);
    assert.match(md, /Furcitivas2048/);
    assert.match(md, /CIVIS Logs/);
    assert.match(md, /Nombre total de bannissements.*`2`/);
    assert.match(md, /## 7\. Configuration CIVIS/);
    assert.match(md, /••••abcd/);

    // Securite absolue : le token brut du webhook ne doit JAMAIS apparaitre
    assert.doesNotMatch(md, /SUPER_SECRET_WEBHOOK_TOKEN_DO_NOT_LEAK/);
  });

  it('filtre strictement les salons prives, threads prives, evenements prives et sections admin pour un membre standard', async () => {
    const { guild, regularMember, mockActionLogs, mockAuditSuggestions } = createMockGuild();

    const exp = await serverExport.buildServerExport({
      guild,
      member: regularMember,
      client: { user: { username: 'CIVIS' } },
      actionLogs: mockActionLogs,
      auditSuggestions: mockAuditSuggestions,
    });

    assert.equal(exp.access.isAdminOrOwner, false);
    assert.equal(exp.stats.categoriesCount, 1);
    assert.equal(exp.stats.channelsCount, 4);
    assert.equal(exp.stats.threadsCount, 1);
    assert.equal(exp.stats.eventsCount, 1);
    assert.equal(exp.stats.hasModerationSection, false);
    assert.equal(exp.stats.hasCivisSection, false);

    const md = exp.markdown;
    assert.match(md, /Filtré selon vos permissions/);
    assert.match(md, /Place Centrale/);
    assert.match(md, /#general/);
    assert.match(md, /Thread public visible/);
    assert.match(md, /Assemblee publique/);

    // Aucune fuite de donnees privees ou admin
    assert.doesNotMatch(md, /Administration Secrete/);
    assert.doesNotMatch(md, /secret-staff-logs/);
    assert.doesNotMatch(md, /Thread secret staff/);
    assert.doesNotMatch(md, /Reunion Staff Secrete/);
    assert.doesNotMatch(md, /Anti-liens malveillants/);
    assert.doesNotMatch(md, /Furcitivas2048/);
    assert.doesNotMatch(md, /SUPER_SECRET_WEBHOOK_TOKEN_DO_NOT_LEAK/);
    assert.doesNotMatch(md, /Modération & Intégrations/);
    assert.doesNotMatch(md, /Configuration CIVIS/);
  });

  it('accorde un acces granulaire (ex: moderateur BanMembers voit uniquement les bannissements)', async () => {
    const { guild, modBanOnlyMember, mockActionLogs, mockAuditSuggestions } = createMockGuild();

    const exp = await serverExport.buildServerExport({
      guild,
      member: modBanOnlyMember,
      client: { user: { username: 'CIVIS' } },
      actionLogs: mockActionLogs,
      auditSuggestions: mockAuditSuggestions,
    });

    assert.equal(exp.access.canViewBans, true);
    assert.equal(exp.access.canViewInvites, false);
    assert.equal(exp.access.canViewAutoMod, false);
    assert.equal(exp.access.canViewWebhooks, false);
    assert.equal(exp.access.canViewCivisConfig, false);

    assert.match(exp.markdown, /## 6\. Modération & Intégrations/);
    assert.match(exp.markdown, /Nombre total de bannissements.*`2`/);
    assert.doesNotMatch(exp.markdown, /Règles AutoMod/);
    assert.doesNotMatch(exp.markdown, /Invitations actives/);
    assert.doesNotMatch(exp.markdown, /Configuration CIVIS/);
  });

  it('reste resilient si des appels Discord echouent ou si le bot manque de permissions', async () => {
    const { guild, adminMember } = createMockGuild({ botPerms: [PermissionFlagsBits.ViewChannel] });
    guild.emojis.fetch = async () => {
      throw new Error('Network error');
    };

    const exp = await serverExport.buildServerExport({
      guild,
      member: adminMember,
      client: { user: { username: 'CIVIS' } },
    });

    assert.match(exp.markdown, /Permission bot `ManageGuild` manquante/);
    assert.match(exp.markdown, /Permission bot `ManageWebhooks` manquante/);
    assert.match(exp.markdown, /Permission bot `BanMembers` manquante/);
  });

  it('commande /export : repond en V2 ephemere avec piece jointe .md et FileBuilder, reserve public:true a ManageGuild et applique rate-limit', async () => {
    const { guild, regularMember, adminMember } = createMockGuild();

    const makeInteraction = ({
      inGuild = true,
      isPublic = null,
      userId = regularMember.id,
      member = regularMember,
    } = {}) => {
      const replies = [];
      const defers = [];
      const edits = [];
      return {
        replies,
        defers,
        edits,
        isButton: () => false,
        isModalSubmit: () => false,
        isChatInputCommand: () => true,
        commandName: 'export',
        guild: inGuild ? guild : null,
        channel: { id: 'ch-gen' },
        user: { id: userId, username: member?.displayName || 'CitoyenLambda' },
        member,
        client: { user: { username: 'CIVIS' } },
        options: {
          getBoolean: (name) => (name === 'public' ? isPublic : null),
        },
        reply: async (payload) => replies.push(payload),
        deferReply: async (opts) => defers.push(opts || {}),
        editReply: async (payload) => edits.push(payload),
      };
    };

    // 1. Hors serveur -> erreur ephemere
    const dmInt = makeInteraction({ inGuild: false });
    await handleInteraction(dmInt);
    assert.equal(dmInt.replies.length, 1);
    assert.equal(dmInt.replies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.match(extractV2Text(dmInt.replies[0]), /serveur Discord/);

    // 2. Appel normal (ephemere par defaut)
    const int1 = makeInteraction({ inGuild: true, isPublic: null });
    await handleInteraction(int1);
    assert.equal(int1.defers.length, 1);
    assert.equal(int1.defers[0].flags, MessageFlags.Ephemeral);
    assert.equal(int1.edits.length, 1);

    const payload1 = int1.edits[0];
    assert.equal(payload1.flags, V2_EPHEMERAL_FLAGS);
    assert.ok(Array.isArray(payload1.files) && payload1.files.length === 1);
    assert.match(payload1.files[0].name, /^export-furcitivas-\d{8}-\d{4}\.md$/);
    assert.ok(Buffer.isBuffer(payload1.files[0].attachment));
    const mdContent = payload1.files[0].attachment.toString('utf8');
    assert.match(mdContent, /# Export du serveur Discord — Furcitivas/);
    assert.doesNotMatch(mdContent, /secret-staff-logs/);

    // Verifier la presence du composant V2 FileBuilder (ComponentType.File = 13)
    const plainCard = toPlainComponent(payload1.components[0]);
    const fileComp = plainCard.components.find((c) => c.type === ComponentType.File);
    assert.ok(fileComp, 'Le composant FileBuilder V2 doit etre present dans la carte');
    assert.equal(fileComp.file.url, `attachment://${payload1.files[0].name}`);

    // 3. Appel immediat par le meme utilisateur -> bloque par rate-limit
    const int2 = makeInteraction({ inGuild: true, isPublic: null });
    await handleInteraction(int2);
    assert.equal(int2.replies.length, 1);
    assert.match(extractV2Text(int2.replies[0]), /Doucement/);

    // 4. Appel public:true par un membre sans ManageGuild -> reste ephemere avec notice explicite
    const intPubDenied = makeInteraction({
      inGuild: true,
      isPublic: true,
      userId: 'other-user-9',
      member: regularMember,
    });
    await handleInteraction(intPubDenied);
    assert.equal(intPubDenied.defers.length, 1);
    assert.equal(intPubDenied.defers[0].flags, MessageFlags.Ephemeral);
    assert.equal(intPubDenied.edits.length, 1);
    assert.equal(intPubDenied.edits[0].flags, V2_EPHEMERAL_FLAGS);
    assert.equal(intPubDenied.edits[0].files.length, 1);
    assert.match(extractV2Text(intPubDenied.edits[0]), /ManageGuild/);

    // 5. Appel public:true par un membre avec ManageGuild/Administrator -> publie dans le salon
    const intPubAllowed = makeInteraction({
      inGuild: true,
      isPublic: true,
      userId: adminMember.id,
      member: adminMember,
    });
    await handleInteraction(intPubAllowed);
    assert.equal(intPubAllowed.defers.length, 1);
    assert.equal(intPubAllowed.defers[0].flags, undefined);
    assert.equal(intPubAllowed.edits.length, 1);
    assert.equal(intPubAllowed.edits[0].flags, V2_FLAG);
    assert.equal(intPubAllowed.edits[0].files.length, 1);
  });
});
