const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { readTools, actionTools, allTools, getTool } = require('../src/agent/tools');
const {
  executeTool,
  searchAppDirectory,
  resolveAppDirectoryCategoryId,
} = require('../src/agent/tool-executor');
const brain = require('../src/agent/brain');
const planner = require('../src/agent/planner');
const plans = require('../src/discord/plans');
const { buildActionPrefix } = require('../src/discord/format');
const { V2_FLAG, extractV2Text, extractV2Buttons } = require('../src/discord/ui-v2');
const { Collection, PermissionsBitField } = require('discord.js');

function createMockGuild() {
  return {
    id: 'guild-1',
    name: 'Test Guild',
    ownerId: 'owner-1',
    members: {
      me: {
        id: 'bot-1',
        permissions: new PermissionsBitField(['Administrator']),
        roles: { highest: { position: 100 } },
      },
    },
    channels: { cache: new Collection() },
    roles: { cache: new Collection() },
  };
}

function createMockMember(id = 'user-1') {
  return {
    id,
    user: { id },
    permissions: new PermissionsBitField(['ViewChannel', 'SendMessages']),
    roles: { highest: { position: 1 } },
  };
}

describe('Action search_app_directory (App Directory Discord)', () => {
  it('est enregistree dans readTools, actionTools et sans doublon dans allTools', () => {
    assert.ok(readTools.some((t) => t.name === 'search_app_directory'));
    assert.ok(actionTools.some((t) => t.name === 'search_app_directory'));
    const occurrences = allTools.filter((t) => t.name === 'search_app_directory');
    assert.equal(occurrences.length, 1);
    assert.equal(getTool('search_app_directory')?.requiredPermission, null);
  });

  it('resolveAppDirectoryCategoryId mappe les categories FR/EN et ignore les inconnues', () => {
    assert.equal(resolveAppDirectoryCategoryId('jeux'), 6);
    assert.equal(resolveAppDirectoryCategoryId('Moderation'), 8);
    assert.equal(resolveAppDirectoryCategoryId('divertissements'), 4);
    assert.equal(resolveAppDirectoryCategoryId('social'), 9);
    assert.equal(resolveAppDirectoryCategoryId('services'), 10);
    assert.equal(resolveAppDirectoryCategoryId('8'), 8);
    assert.equal(resolveAppDirectoryCategoryId('inconnue'), null);
  });

  it('searchAppDirectory interroge l API Discord, formate les resultats et gere erreurs/vides', async () => {
    let capturedUrl = '';
    const mockFetch = async (url) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result_count: 42,
          results: [
            {
              type: 1,
              data: {
                id: '684773505157431347',
                name: 'FlaviBot',
                is_verified: true,
                categories: [{ id: 4, name: 'Divertissements' }],
                directory_entry: {
                  guild_count: 125000,
                  short_description: 'Bot de musique haute qualite avec playlists et filtres.',
                },
              },
            },
            {
              type: 1,
              data: {
                id: '123456789012345678',
                name: 'MusicTwo',
                is_verified: false,
                categories: [],
                directory_entry: {
                  guild_count: 300,
                  short_description: 'Autre bot musical.',
                },
              },
            },
          ],
        }),
      };
    };

    const res = await searchAppDirectory(
      { query: 'music', category: 'divertissements', limit: 1 },
      { fetchFn: mockFetch }
    );

    assert.equal(res.ok, true);
    assert.match(capturedUrl, /query=music/);
    assert.match(capturedUrl, /category_id=4/);
    assert.match(res.result, /FlaviBot/);
    assert.match(res.result, /Verifie/);
    assert.match(res.result, /125 000 serveurs/);
    assert.match(res.result, /https:\/\/discord\.com\/application-directory\/684773505157431347/);
    assert.doesNotMatch(res.result, /MusicTwo/);

    const emptyRes = await searchAppDirectory(
      { query: 'introuvable-xyz' },
      {
        fetchFn: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ result_count: 0, results: [] }),
        }),
      }
    );
    assert.equal(emptyRes.ok, true);
    assert.match(emptyRes.result, /Aucun bot ou application trouve/);

    const errQuery = await searchAppDirectory({ query: '   ' }, { fetchFn: mockFetch });
    assert.equal(errQuery.ok, false);
    assert.match(errQuery.error, /query/i);

    const errHttp = await searchAppDirectory(
      { query: 'music' },
      { fetchFn: async () => ({ ok: false, status: 503 }) }
    );
    assert.equal(errHttp.ok, false);
    assert.match(errHttp.error, /HTTP 503/);
  });

  it('executeTool autorise search_app_directory en mode chat et en mode agent', async () => {
    const guild = createMockGuild();
    const member = createMockMember();
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result_count: 1,
        results: [
          {
            data: {
              id: '999',
              name: 'ModHelper',
              is_verified: true,
              directory_entry: { guild_count: 500, short_description: 'Moderation simple.' },
            },
          },
        ],
      }),
    });

    const chatRes = await executeTool(
      'search_app_directory',
      { query: 'moderation' },
      { guild, member, mode: 'chat', fetchFn: mockFetch }
    );
    assert.equal(chatRes.ok, true);
    assert.match(chatRes.result, /ModHelper/);

    const agentRes = await executeTool(
      'search_app_directory',
      { query: 'moderation' },
      { guild, member, mode: 'agent', fetchFn: mockFetch }
    );
    assert.equal(agentRes.ok, true);
    assert.match(agentRes.result, /ModHelper/);
  });

  it('brain.js expose search_app_directory dans /chat et /agent et l execute', async () => {
    assert.match(brain.buildSystemPrompt('chat'), /search_app_directory/);
    assert.match(brain.buildSystemPrompt('agent'), /search_app_directory/);

    const guild = createMockGuild();
    const member = createMockMember();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result_count: 1,
        results: [
          {
            data: {
              id: '555666',
              name: 'TicketKing',
              is_verified: true,
              directory_entry: { guild_count: 1200, short_description: 'Gestion de tickets.' },
            },
          },
        ],
      }),
    });

    try {
      const agentOut = await brain.processMessage({
        userText: 'trouve un bot de tickets',
        channelId: 'chan-agent-appdir',
        authorName: 'TestUser',
        authorId: 'user-1',
        guild,
        member,
        mode: 'agent',
        userConfig: null,
        chatFn: async () => ({
          content: '{"tool": "search_app_directory", "args": {"query": "tickets"}}',
          stats: { elapsedMs: 10 },
        }),
      });
      assert.equal(agentOut.usedTool, 'search_app_directory');
      assert.equal(agentOut.actionOk, true);
      assert.match(agentOut.content, /TicketKing/);
      assert.match(agentOut.content, /https:\/\/discord\.com\/application-directory\/555666/);

      let callCount = 0;
      const chatOut = await brain.processMessage({
        userText: 'quels bots de tickets existent sur discord ?',
        channelId: 'chan-chat-appdir',
        authorName: 'TestUser',
        authorId: 'user-1',
        guild,
        member,
        mode: 'chat',
        userConfig: null,
        chatFn: async (messages) => {
          callCount += 1;
          if (callCount === 1) {
            return {
              content: '{"tool": "search_app_directory", "args": {"query": "tickets"}}',
              stats: { elapsedMs: 10 },
            };
          }
          const lastMsg = messages[messages.length - 1].content;
          assert.match(lastMsg, /TicketKing/);
          return {
            content:
              'Voici **TicketKing** : https://discord.com/application-directory/555666',
            stats: { elapsedMs: 12 },
          };
        },
      });
      assert.equal(callCount, 2);
      assert.equal(chatOut.usedTool, 'search_app_directory');
      assert.match(chatOut.content, /TicketKing/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('planner.js et plans.js supportent search_app_directory dans /plan et format.js formate le prefixe', async () => {
    assert.equal(
      buildActionPrefix('search_app_directory', { query: 'music' }),
      '-# Action : search_app_directory -> "music"\n'
    );

    const guild = createMockGuild();
    const member = createMockMember();

    const invalidPlan = await planner.buildValidatedPlan({
      userText: 'cherche un bot',
      guild,
      member,
      userConfig: null,
      chatFn: async () => ({
        content: '{"summary": "Recherche", "steps": [{"tool": "search_app_directory", "args": {}}]}',
        stats: { elapsedMs: 5 },
      }),
    });
    assert.equal(invalidPlan.ok, false);
    assert.match(invalidPlan.error, /query/i);

    const validPlan = await planner.buildValidatedPlan({
      userText: 'cherche un bot de quiz',
      guild,
      member,
      userConfig: null,
      chatFn: async () => ({
        content:
          '{"summary": "Recherche de bots de quiz", "steps": [{"tool": "search_app_directory", "args": {"query": "quiz", "limit": 3}}]}',
        stats: { elapsedMs: 5 },
      }),
    });
    assert.equal(validPlan.ok, true);
    assert.equal(validPlan.plan.steps[0].tool, 'search_app_directory');
    assert.match(validPlan.plan.steps[0].label, /Rechercher dans l App Directory Discord : "quiz"/);
    assert.equal(validPlan.security.requesterAuthorized, true);

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        result_count: 1,
        results: [
          {
            data: {
              id: '777888',
              name: 'QuizMaster',
              is_verified: true,
              directory_entry: { guild_count: 900, short_description: 'Quiz interactifs.' },
            },
          },
        ],
      }),
    });

    try {
      let repliedPayload = null;
      const followUps = [];
      const mockChannel = {
        id: 'chan-plan-1',
        send: async (p) => {
          repliedPayload = p;
          return { id: 'msg-plan-1', edit: async () => {} };
        },
      };

      const cmdInteraction = {
        deferred: true,
        replied: false,
        user: { id: member.id },
        member,
        guild,
        channel: mockChannel,
        channelId: 'chan-plan-1',
        client: { user: { id: 'bot-1' } },
        editReply: async (p) => {
          repliedPayload = p;
          return { id: 'msg-plan-1', edit: async () => {} };
        },
      };

      const planId = await plans.createPlanRequest({
        interaction: cmdInteraction,
        channel: mockChannel,
        guild,
        requester: { id: member.id },
        plan: validPlan.plan,
        security: validPlan.security,
        userText: 'cherche un bot de quiz',
        stepDelayMs: 0,
      });

      assert.ok(planId);
      assert.ok(repliedPayload);
      assert.equal(repliedPayload.flags, V2_FLAG);
      assert.equal(repliedPayload.content, undefined);
      assert.equal(repliedPayload.embeds, undefined);
      const confirmCustomId = extractV2Buttons(repliedPayload)[0].custom_id;

      const handled = await plans.handlePlanButton({
        customId: confirmCustomId,
        user: { id: member.id },
        member,
        guild,
        channel: mockChannel,
        client: { user: { id: 'bot-1' } },
        deferUpdate: async () => {},
        editReply: async () => {},
        followUp: async (p) => {
          followUps.push(p);
        },
      });

      assert.equal(handled, true);
      assert.equal(followUps.length, 1);
      assert.equal(followUps[0].flags, V2_FLAG);
      assert.equal(followUps[0].content, undefined);
      const followUpText = extractV2Text(followUps[0]);
      assert.match(followUpText, /QuizMaster/);
      assert.match(followUpText, /https:\/\/discord\.com\/application-directory\/777888/);
    } finally {
      plans.clearAllPendingPlans();
      globalThis.fetch = origFetch;
    }
  });
});
