const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionsBitField, PermissionFlagsBits } = require('discord.js');

const planImport = require('../src/discord/plan-import');
const serverExport = require('../src/discord/server-export');
const { handleInteraction } = require('../src/discord/commands');
const rateLimit = require('../src/agent/rate-limit');
const plans = require('../src/discord/plans');
const planner = require('../src/agent/planner');
const { executeTool } = require('../src/agent/tool-executor');
const { extractV2Text, extractV2Buttons, V2_EPHEMERAL_FLAGS } = require('../src/discord/ui-v2');

function makeGuildAndMembers() {
  const adminMember = {
    id: 'admin-1',
    displayName: 'Admin',
    user: { id: 'admin-1', username: 'Admin' },
    permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    roles: { highest: { position: 10 } },
  };
  const regularMember = {
    id: 'user-1',
    displayName: 'Citoyen',
    user: { id: 'user-1', username: 'Citoyen' },
    permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
    roles: { highest: { position: 1 } },
  };
  const botMember = {
    id: 'bot-1',
    displayName: 'CIVIS',
    user: { id: 'bot-1', username: 'CIVIS' },
    permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
    roles: { highest: { position: 9 } },
  };

  const chGeneral = {
    id: 'ch-1',
    name: 'general',
    type: ChannelType.GuildText,
    rawPosition: 0,
    parentId: null,
    permissionOverwrites: { cache: new Map() },
    permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
  };

  const guild = {
    id: 'guild-import-1',
    name: 'Furcitivas',
    ownerId: 'admin-1',
    roles: {
      cache: new Map([
        [
          'guild-import-1',
          {
            id: 'guild-import-1',
            name: '@everyone',
            position: 0,
            managed: false,
            permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
          },
        ],
      ]),
    },
    channels: {
      cache: new Map([['ch-1', chGeneral]]),
    },
    members: {
      me: botMember,
      cache: new Map([
        ['admin-1', adminMember],
        ['user-1', regularMember],
        ['bot-1', botMember],
      ]),
    },
  };

  return { guild, adminMember, regularMember };
}

describe('Import de scripts JSON (plan-import.js & /import)', () => {
  beforeEach(() => {
    rateLimit.clearAll();
  });

  it('parseImportedPlanJson gere JSON brut, bloc markdown json et diagnostics d erreur precis', () => {
    const raw = JSON.stringify({
      summary: 'Creer une categorie',
      steps: [{ tool: 'create_category', args: { name: 'Communaute' } }],
    });

    const ok1 = planImport.parseImportedPlanJson(raw);
    assert.equal(ok1.ok, true);
    assert.equal(ok1.plan.summary, 'Creer une categorie');
    assert.equal(ok1.plan.steps.length, 1);

    const ok2 = planImport.parseImportedPlanJson('```json\n' + raw + '\n```');
    assert.equal(ok2.ok, true);
    assert.equal(ok2.plan.steps[0].tool, 'create_category');

    const badSyntax = planImport.parseImportedPlanJson('{invalid json');
    assert.equal(badSyntax.ok, false);
    assert.match(badSyntax.error, /syntaxe JSON/i);

    const emptySteps = planImport.parseImportedPlanJson('{"summary":"Vide","steps":[]}');
    assert.equal(emptySteps.ok, false);
    assert.match(emptySteps.error, /steps/);

    const badStep = planImport.parseImportedPlanJson(
      '{"summary":"Test","steps":[{"tool":"create_channel","args":"pas-un-objet"}]}'
    );
    assert.equal(badStep.ok, false);
    assert.match(badStep.error, /Etape 1.*args/);
  });

  it('validateDiscordAttachment et fetchAttachmentText bloquent SSRF, taille excessive et extensions invalides', async () => {
    // SSRF / domaine non Discord
    const ssrf = planImport.validateDiscordAttachment({
      name: 'plan.json',
      size: 200,
      url: 'https://evil.example/plan.json',
    });
    assert.equal(ssrf.ok, false);
    assert.match(ssrf.error, /Origine de fichier non autorisee/);

    // HTTP non chiffre
    const httpOnly = planImport.validateDiscordAttachment({
      name: 'plan.json',
      size: 200,
      url: 'http://cdn.discordapp.com/attachments/1/2/plan.json',
    });
    assert.equal(httpOnly.ok, false);

    // Extension invalide
    const badExt = planImport.validateDiscordAttachment({
      name: 'malware.exe',
      size: 200,
      contentType: 'application/octet-stream',
      url: 'https://cdn.discordapp.com/attachments/1/2/malware.exe',
    });
    assert.equal(badExt.ok, false);
    assert.match(badExt.error, /Format de fichier non supporte/);

    // Trop volumineux (> 256 Ko)
    const tooBig = planImport.validateDiscordAttachment({
      name: 'plan.json',
      size: planImport.MAX_IMPORT_BYTES + 1,
      url: 'https://cdn.discordapp.com/attachments/1/2/plan.json',
    });
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.error, /trop volumineux/i);

    // Telechargement valide depuis cdn.discordapp.com
    const validDl = await planImport.fetchAttachmentText(
      {
        name: 'plan.json',
        size: 120,
        url: 'https://cdn.discordapp.com/attachments/1/2/plan.json',
      },
      {
        fetchFn: async (url, opts) => {
          assert.equal(url, 'https://cdn.discordapp.com/attachments/1/2/plan.json');
          assert.equal(opts.redirect, 'error');
          return {
            ok: true,
            status: 200,
            headers: { get: () => '42' },
            text: async () => '{"summary":"OK","steps":[]}',
          };
        },
      }
    );
    assert.equal(validDl.ok, true);
    assert.equal(validDl.text, '{"summary":"OK","steps":[]}');
  });

  it('loadAndValidateImportedPlan accepte jusqu a 50 etapes, rejette 51 etapes et detecte les actions destructrices', async () => {
    const { guild, adminMember, regularMember } = makeGuildAndMembers();

    // 20 etapes (> limite 15 de /plan, <= limite 50 de /import)
    const steps20 = Array.from({ length: 20 }, (_, i) => ({
      tool: 'create_channel',
      args: { name: `salon-${i + 1}`, type: 'text' },
    }));
    const res20 = await planImport.loadAndValidateImportedPlan({
      rawJsonText: JSON.stringify({ summary: 'Creation 20 salons', steps: steps20 }),
      guild,
      member: adminMember,
    });
    assert.equal(res20.ok, true);
    assert.equal(res20.plan.steps.length, 20);
    assert.equal(res20.security.requesterAuthorized, true);
    assert.equal(res20.security.hasDestructive, false);

    // 51 etapes -> rejete
    const steps51 = Array.from({ length: 51 }, (_, i) => ({
      tool: 'create_channel',
      args: { name: `salon-${i + 1}`, type: 'text' },
    }));
    const res51 = await planImport.loadAndValidateImportedPlan({
      rawJsonText: JSON.stringify({ summary: 'Trop grand', steps: steps51 }),
      guild,
      member: adminMember,
    });
    assert.equal(res51.ok, false);
    assert.match(res51.error, /50 etapes/);

    // Action destructrice + membre sans permissions -> requesterAuthorized: false, hasDestructive: true
    const resDel = await planImport.loadAndValidateImportedPlan({
      rawJsonText: JSON.stringify({
        summary: 'Supprimer general',
        steps: [{ tool: 'delete_channel', args: { channel: 'general' } }],
      }),
      guild,
      member: regularMember,
    });
    assert.equal(resDel.ok, true);
    assert.equal(resDel.security.hasDestructive, true);
    assert.equal(resDel.security.requesterAuthorized, false);
  });

  it('export inclut par defaut le guide JSON IA externe et permet de le desactiver avec includeAiGuide:false', async () => {
    const { guild, adminMember } = makeGuildAndMembers();

    const withGuide = await serverExport.buildServerExport({
      guild,
      member: adminMember,
      client: { user: { username: 'CIVIS' } },
    });
    assert.match(withGuide.markdown, /Guide pour IA externe \(Format JSON CIVIS\)/);
    assert.match(withGuide.markdown, /`create_category`/);
    assert.match(withGuide.markdown, /`set_channel_permissions`/);
    assert.match(withGuide.markdown, /\/import/);

    const withoutGuide = await serverExport.buildServerExport({
      guild,
      member: adminMember,
      client: { user: { username: 'CIVIS' } },
      includeAiGuide: false,
    });
    assert.doesNotMatch(withoutGuide.markdown, /Guide pour IA externe/);
  });

  it('commande /import : valide hors serveur, sans argument, JSON invalide et JSON valide avec carte de boutons', async () => {
    const { guild, adminMember } = makeGuildAndMembers();

    const makeInteraction = ({ inGuild = true, attachment = null, json = null } = {}) => {
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
        commandName: 'import',
        guild: inGuild ? guild : null,
        channel: { id: 'ch-1' },
        user: adminMember.user,
        member: adminMember,
        client: { user: { username: 'CIVIS' } },
        options: {
          getAttachment: (name) => (name === 'fichier' ? attachment : null),
          getString: (name) => (name === 'json' ? json : null),
        },
        reply: async (payload) => replies.push(payload),
        deferReply: async (opts) => defers.push(opts || {}),
        editReply: async (payload) => {
          edits.push(payload);
          return { id: 'msg-1', edit: async () => {} };
        },
      };
    };

    // 1. Hors serveur
    const dmInt = makeInteraction({ inGuild: false, json: '{}' });
    await handleInteraction(dmInt);
    assert.equal(dmInt.replies.length, 1);
    assert.equal(dmInt.replies[0].flags, V2_EPHEMERAL_FLAGS);

    // 2. Sans fichier ni json -> aide ephemere
    const emptyInt = makeInteraction({ inGuild: true });
    await handleInteraction(emptyInt);
    assert.equal(emptyInt.replies.length, 1);
    assert.equal(emptyInt.replies[0].flags, V2_EPHEMERAL_FLAGS);
    assert.match(extractV2Text(emptyInt.replies[0]), /fichier.*json/i);

    // 3. JSON invalide -> warning clair
    const badInt = makeInteraction({ inGuild: true, json: '{oops' });
    await handleInteraction(badInt);
    assert.equal(badInt.edits.length, 1);
    assert.match(extractV2Text(badInt.edits[0]), /Script JSON invalide/);
    rateLimit.clearAll();

    // 4. JSON valide -> carte interactive de plan avec boutons
    const validJson = JSON.stringify({
      summary: 'Creer salon annonces-ia',
      steps: [{ tool: 'create_channel', args: { name: 'annonces-ia', type: 'text' } }],
    });
    const okInt = makeInteraction({ inGuild: true, json: validJson });
    await handleInteraction(okInt);
    assert.equal(okInt.defers.length, 1);
    assert.equal(okInt.edits.length, 1);

    const cardPayload = okInt.edits[0];
    assert.match(extractV2Text(cardPayload), /Creer salon annonces-ia/);
    const buttons = extractV2Buttons(cardPayload);
    assert.equal(buttons.length, 4);
    assert.ok(buttons.some((b) => b.custom_id.startsWith('plan:execute:')));
    assert.ok(buttons.some((b) => b.custom_id.startsWith('plan:json:')));

    // Nettoyage des timers de plan en attente
    plans.clearAllPendingPlans?.();
  });

  it('tool-executor : resout en priorite par ID Snowflake (salons/roles homonymes, categories, @everyone par ID)', async () => {
    const guildId = '900000000000000001';
    const cat1Id = '300000000000000001';
    const cat2Id = '300000000000000002';
    const chan1Id = '100000000000000001';
    const chan2Id = '100000000000000002';
    const role1Id = '200000000000000001';
    const role2Id = '200000000000000002';

    const editCalls = [];
    const overwriteCalls = [];
    const createdChannels = [];

    const adminMember = {
      id: '800000000000000001',
      displayName: 'Admin',
      user: { id: '800000000000000001', username: 'Admin' },
      permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
      roles: { highest: { position: 20 } },
    };
    const botMember = {
      id: '800000000000000002',
      displayName: 'CIVIS',
      user: { id: '800000000000000002', username: 'CIVIS' },
      permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
      roles: { highest: { position: 15 } },
    };

    const cat1 = {
      id: cat1Id,
      name: 'Cat A',
      type: ChannelType.GuildCategory,
      permissionOverwrites: {
        edit: async (targetId, obj) => overwriteCalls.push({ channelId: cat1Id, targetId, obj }),
      },
    };
    const cat2 = {
      id: cat2Id,
      name: 'Cat B',
      type: ChannelType.GuildCategory,
      permissionOverwrites: {
        edit: async (targetId, obj) => overwriteCalls.push({ channelId: cat2Id, targetId, obj }),
      },
    };

    const chan1 = {
      id: chan1Id,
      name: 'general',
      type: ChannelType.GuildText,
      parentId: cat1Id,
      parent: cat1,
      edit: async (updates) => editCalls.push({ type: 'channel', id: chan1Id, updates }),
      permissionOverwrites: {
        edit: async (targetId, obj) => overwriteCalls.push({ channelId: chan1Id, targetId, obj }),
      },
    };
    const chan2 = {
      id: chan2Id,
      name: 'general',
      type: ChannelType.GuildText,
      parentId: cat2Id,
      parent: cat2,
      edit: async (updates) => editCalls.push({ type: 'channel', id: chan2Id, updates }),
      permissionOverwrites: {
        edit: async (targetId, obj) => overwriteCalls.push({ channelId: chan2Id, targetId, obj }),
      },
    };

    const roleEveryone = {
      id: guildId,
      name: '@everyone',
      position: 0,
      managed: false,
      permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
    };
    const role1 = {
      id: role1Id,
      name: 'VIP',
      position: 2,
      managed: false,
      hexColor: '#111111',
      permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
      edit: async (updates) => editCalls.push({ type: 'role', id: role1Id, updates }),
    };
    const role2 = {
      id: role2Id,
      name: 'VIP',
      position: 3,
      managed: false,
      hexColor: '#222222',
      permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
      edit: async (updates) => editCalls.push({ type: 'role', id: role2Id, updates }),
    };

    const guild = {
      id: guildId,
      name: 'Guild ID Test',
      ownerId: adminMember.id,
      roles: {
        cache: new Map([
          [guildId, roleEveryone],
          [role1Id, role1],
          [role2Id, role2],
        ]),
      },
      channels: {
        cache: new Map([
          [cat1Id, cat1],
          [cat2Id, cat2],
          [chan1Id, chan1],
          [chan2Id, chan2],
        ]),
        create: async (opts) => {
          const created = { id: '100000000000000099', ...opts };
          createdChannels.push(created);
          return created;
        },
      },
      members: { me: botMember },
    };

    // 1. modify_channel avec l'ID du 2e salon #general modifie uniquement chan2
    const modCh = await executeTool(
      'modify_channel',
      { channel: chan2Id, slowmode: 10 },
      { guild, member: adminMember, mode: 'agent' }
    );
    assert.equal(modCh.ok, true);
    assert.equal(editCalls.length, 1);
    assert.equal(editCalls[0].id, chan2Id);
    assert.equal(editCalls[0].updates.rateLimitPerUser, 10);

    // 2. modify_role_display avec l'ID du 2e role VIP cible uniquement role2
    const modRole = await executeTool(
      'modify_role_display',
      { role: role2Id, hoist: true },
      { guild, member: adminMember, mode: 'agent' }
    );
    assert.equal(modRole.ok, true);
    assert.equal(editCalls[1].id, role2Id);
    assert.equal(editCalls[1].updates.hoist, true);

    // 3. set_channel_permissions sur cat2 par ID (sans target_type) et @everyone par guild.id synchronise chan2
    const permRes = await executeTool(
      'set_channel_permissions',
      { channel: cat2Id, role: guildId, deny: ['ViewChannel'] },
      { guild, member: adminMember, mode: 'agent' }
    );
    assert.equal(permRes.ok, true);
    assert.equal(permRes.isCategory, true);
    assert.equal(permRes.syncedCount, 1);
    assert.deepEqual(
      overwriteCalls.map((c) => [c.channelId, c.targetId]),
      [
        [cat2Id, guildId],
        [chan2Id, guildId],
      ]
    );

    // 4. create_channel avec category = ID existant vs ID inexistant
    const createOk = await executeTool(
      'create_channel',
      { name: 'salon-b', type: 'text', category: cat2Id },
      { guild, member: adminMember, mode: 'agent' }
    );
    assert.equal(createOk.ok, true);
    assert.equal(createdChannels[0].parent, cat2Id);

    const createBadCat = await executeTool(
      'create_channel',
      { name: 'salon-bad', type: 'text', category: '999999999999999999' },
      { guild, member: adminMember, mode: 'agent' }
    );
    assert.equal(createBadCat.ok, false);
    assert.match(createBadCat.error, /999999999999999999/);

    // 5. create_channel & modify_channel preservent les emojis et separateurs Unicode ("📢・annonces")
    const createEmoji = await executeTool(
      'create_channel',
      { name: '📢・Annonces Générales', type: 'announcement', category: cat1Id },
      { guild, member: adminMember, mode: 'agent' }
    );
    assert.equal(createEmoji.ok, true);
    assert.equal(createdChannels[1].name, '📢・annonces-générales');

    const modEmoji = await executeTool(
      'modify_channel',
      { channel: chan1Id, new_name: '💬・discussion' },
      { guild, member: adminMember, mode: 'agent' }
    );
    assert.equal(modEmoji.ok, true);
    assert.equal(editCalls[2].updates.name, '💬・discussion');
  });

  it('planner & plan-import : valide les IDs Snowflake, genere des labels lisibles, consolide par ID et documente les IDs dans le guide IA', async () => {
    const guildId = '900000000000000010';
    const catId = '300000000000000010';
    const chan1Id = '100000000000000010';
    const chan2Id = '100000000000000011';
    const roleId = '200000000000000010';
    const highRoleId = '200000000000000099';

    const modMember = {
      id: '800000000000000010',
      displayName: 'Modo',
      user: { id: '800000000000000010', username: 'Modo' },
      permissions: new PermissionsBitField([
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.SendMessages,
      ]),
      roles: { highest: { position: 5 } },
    };
    const botMember = {
      id: '800000000000000011',
      displayName: 'CIVIS',
      user: { id: '800000000000000011', username: 'CIVIS' },
      permissions: new PermissionsBitField([PermissionFlagsBits.Administrator]),
      roles: { highest: { position: 15 } },
    };

    const cat = {
      id: catId,
      name: 'Communaute',
      type: ChannelType.GuildCategory,
      rawPosition: 0,
      permissionOverwrites: { cache: new Map() },
    };
    const ch1 = {
      id: chan1Id,
      name: 'annonces',
      type: ChannelType.GuildText,
      rawPosition: 0,
      parentId: catId,
      parent: cat,
      permissionOverwrites: { cache: new Map() },
    };
    const ch2 = {
      id: chan2Id,
      name: 'blabla',
      type: ChannelType.GuildText,
      rawPosition: 1,
      parentId: catId,
      parent: cat,
      permissionOverwrites: { cache: new Map() },
    };
    const roleOk = {
      id: roleId,
      name: 'Membre',
      position: 2,
      managed: false,
      permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
    };
    const roleHigh = {
      id: highRoleId,
      name: 'Chef',
      position: 10,
      managed: false,
      permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]),
    };

    const guild = {
      id: guildId,
      name: 'Furcitivas',
      ownerId: '800000000000000000',
      roles: {
        cache: new Map([
          [guildId, { id: guildId, name: '@everyone', position: 0, managed: false, permissions: new PermissionsBitField([]) }],
          [roleId, roleOk],
          [highRoleId, roleHigh],
        ]),
      },
      channels: {
        cache: new Map([
          [catId, cat],
          [chan1Id, ch1],
          [chan2Id, ch2],
        ]),
      },
      members: { me: botMember },
    };

    // 1. Pre-validation avec IDs Snowflake : deduit target_type, verifie la hierarchie et rend des labels lisibles
    const resValid = await planImport.loadAndValidateImportedPlan({
      rawJsonText: JSON.stringify({
        summary: 'Ajuster salons et permissions par ID',
        steps: [
          { tool: 'modify_channel', args: { channel: chan1Id, slowmode: 5 } },
          { tool: 'set_channel_permissions', args: { channel: catId, role: guildId, deny: ['SendMessages'] } },
          { tool: 'modify_role_display', args: { role: roleId, color: '#3498DB' } },
        ],
      }),
      guild,
      member: modMember,
    });
    assert.equal(resValid.ok, true);
    assert.equal(resValid.security.requesterAuthorized, true);
    assert.equal(resValid.plan.steps[1].args.target_type, 'category');
    assert.equal(resValid.plan.steps[0].label, `Modifier #annonces (${chan1Id}) (cooldown 5s)`);
    assert.equal(
      resValid.plan.steps[1].label,
      `Permissions categorie "Communaute" (${catId}) pour @everyone (-SendMessages)`
    );
    assert.equal(
      resValid.plan.steps[2].label,
      `Modifier le role "Membre" (${roleId}) (couleur #3498DB)`
    );

    // 2. Hierarchie verifiee meme lorsque le role est cible par ID
    const resHighRole = await planImport.loadAndValidateImportedPlan({
      rawJsonText: JSON.stringify({
        summary: 'Modifier role superieur par ID',
        steps: [{ tool: 'modify_role_display', args: { role: highRoleId, hoist: true } }],
      }),
      guild,
      member: modMember,
    });
    assert.equal(resHighRole.ok, true);
    assert.equal(resHighRole.security.requesterAuthorized, false);

    // 3. ID inexistant rejete des la pre-validation
    const resUnknownChan = await planImport.loadAndValidateImportedPlan({
      rawJsonText: JSON.stringify({
        summary: 'ID inexistant',
        steps: [{ tool: 'modify_channel', args: { channel: '999999999999999991', slowmode: 5 } }],
      }),
      guild,
      member: modMember,
    });
    assert.equal(resUnknownChan.ok, false);
    assert.match(resUnknownChan.error, /999999999999999991/);

    const resUnknownRole = await planImport.loadAndValidateImportedPlan({
      rawJsonText: JSON.stringify({
        summary: 'Role ID inexistant',
        steps: [{ tool: 'archive_role', args: { role: '999999999999999992' } }],
      }),
      guild,
      member: modMember,
    });
    assert.equal(resUnknownRole.ok, false);
    assert.match(resUnknownRole.error, /999999999999999992/);

    // 4. Consolidation des permissions de categorie sur des etapes par IDs
    const consolidated = planner.consolidateCategoryPermissions(
      [
        { tool: 'set_channel_permissions', args: { channel: chan1Id, role: roleId, allow: ['ViewChannel'] } },
        { tool: 'set_channel_permissions', args: { channel: chan2Id, role: roleId, allow: ['ViewChannel'] } },
      ],
      guild
    );
    assert.equal(consolidated.length, 1);
    assert.equal(consolidated[0].args.target_type, 'category');
    assert.equal(consolidated[0].args.channel, catId);

    // 5. Le guide IA recommande explicitement l usage des IDs pour les elements existants
    const guide = planImport.buildAiJsonGuideMarkdown();
    assert.match(guide, /Privilégie toujours les IDs Discord/);
    assert.match(guide, /100000000000000010/);
  });
});
