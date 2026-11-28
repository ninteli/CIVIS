const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} = require('discord.js');

const uiV2 = require('../src/discord/ui-v2');
const format = require('../src/discord/format');
const registerEvents = require('../src/discord/events');
const { handleInteraction } = require('../src/discord/commands');
const brain = require('../src/agent/brain');
const debug = require('../src/agent/debug');
const rateLimit = require('../src/agent/rate-limit');
const userKeys = require('../src/agent/user-keys');

function assertValidV2Payload(payload, { ephemeral = false, withComponents = false } = {}) {
  assert.ok(payload && typeof payload === 'object');
  const expectedFlag = ephemeral ? uiV2.V2_EPHEMERAL_FLAGS : uiV2.V2_FLAG;
  assert.equal(payload.flags, expectedFlag);
  assert.equal(Boolean(payload.flags & MessageFlags.IsComponentsV2), true);
  assert.equal(Boolean(payload.flags & MessageFlags.Ephemeral), ephemeral);
  assert.equal(payload.content, undefined, 'content interdit avec IsComponentsV2');
  assert.equal(payload.embeds, undefined, 'embeds interdit avec IsComponentsV2');
  if (withComponents) {
    assert.equal(payload.withComponents, true);
  }
  assert.ok(Array.isArray(payload.components) && payload.components.length >= 1);
  const firstPlain = uiV2.toPlainComponent(payload.components[0]);
  assert.equal(firstPlain.type, ComponentType.Container);

  const metrics = uiV2.estimateV2Metrics(payload);
  assert.ok(metrics.totalChars <= 4000, `Trop de caracteres V2: ${metrics.totalChars}`);
  assert.ok(metrics.totalComponents <= 40, `Trop de composants V2: ${metrics.totalComponents}`);
}

describe('Interface Components V2 (ui-v2.js, format.js, events.js, commands.js)', () => {
  afterEach(() => {
    rateLimit.clearAll();
  });

  it('buildV2Card et buildV2Message gerent flags, couleur, troncature Markdown (code fence), 40 composants max et sections vides', () => {
    // 1. Troncature avec bloc de code non ferme -> fermeture propre et <= 3900 chars
    const longCode = '```json\n' + '{\n  "k": "' + 'a'.repeat(5000) + '"\n}\n```';
    const longCard = uiV2.buildV2Card({
      color: uiV2.COLORS.PRIMARY,
      title: '🦊 Test long',
      subtitle: 'Sous-titre',
      sections: [
        '',
        null,
        { heading: 'Code long', body: longCode },
        { heading: '', body: '' },
      ],
      footer: 'CIVIS • Footer',
      notice: '-# Notice fallback',
      actionRows: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('btn:1')
            .setLabel('OK')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
        ),
      ],
    });

    const msg = uiV2.buildV2Message(longCard, {
      ephemeral: true,
      withComponents: true,
      allowedMentions: format.SAFE_ALLOWED_MENTIONS,
    });

    assertValidV2Payload(msg, { ephemeral: true, withComponents: true });
    const metrics = uiV2.estimateV2Metrics(msg);
    assert.ok(metrics.totalChars <= uiV2.MAX_V2_TOTAL_CHARS);

    const plain = uiV2.toPlainComponent(longCard);
    assert.equal(plain.accent_color, uiV2.COLORS.PRIMARY);
    const fullText = uiV2.extractV2Text(msg);
    const fenceCount = (fullText.match(/```/g) || []).length;
    assert.equal(fenceCount % 2, 0, 'Le bloc de code doit rester ferme apres troncature');
    assert.ok(fullText.includes('-# Notice fallback'));
    assert.ok(fullText.includes('-# CIVIS • Footer'));
    assert.equal(uiV2.extractV2Buttons(msg).length, 1);
    assert.equal(uiV2.extractV2Buttons(msg)[0].emoji.name, '✅');

    // 2. Beaucoup de sections -> plafond <= 40 composants respecte
    const manySections = Array.from({ length: 25 }, (_, i) => ({
      heading: `Section ${i + 1}`,
      body: `Contenu ${i + 1}`,
    }));
    const denseCard = uiV2.buildV2Card({
      color: uiV2.COLORS.INFO,
      title: 'Dense',
      sections: manySections,
    });
    const denseMetrics = uiV2.estimateV2Metrics(denseCard);
    assert.ok(denseMetrics.totalComponents <= uiV2.MAX_V2_COMPONENTS);

    // 3. Carte completement vide -> au moins 1 TextDisplay non vide
    const emptyCard = uiV2.buildV2Card({ color: uiV2.COLORS.NEUTRAL, sections: ['', null] });
    assert.ok(uiV2.extractV2Text(emptyCard).trim().length >= 1);
    assertValidV2Payload(uiV2.buildV2Message(emptyCard));
  });

  it('buildChatReplyPayload gere chat, agent succes/echec, App Directory, fallback local et debug', () => {
    const chatMsg = format.buildChatReplyPayload({
      content: 'Bonjour citoyen !',
      mode: 'chat',
    });
    assertValidV2Payload(chatMsg);
    assert.equal(uiV2.toPlainComponent(chatMsg.components[0]).accent_color, uiV2.COLORS.PRIMARY);
    assert.match(uiV2.extractV2Text(chatMsg), /🦊 CIVIS/);
    assert.match(uiV2.extractV2Text(chatMsg), /Bonjour citoyen !/);

    const agentOkMsg = format.buildChatReplyPayload({
      content: 'Salon #annonces cree.',
      usedTool: 'create_channel',
      toolArgs: { name: 'annonces' },
      mode: 'agent',
      actionOk: true,
    });
    assertValidV2Payload(agentOkMsg);
    assert.equal(uiV2.toPlainComponent(agentOkMsg.components[0]).accent_color, uiV2.COLORS.SUCCESS);
    assert.match(uiV2.extractV2Text(agentOkMsg), /Action exécutée/);
    assert.match(uiV2.extractV2Text(agentOkMsg), /create_channel/);

    const agentErrMsg = format.buildChatReplyPayload({
      content: 'Erreur permission.',
      usedTool: 'delete_channel',
      toolArgs: { channel: 'general' },
      mode: 'agent',
      actionOk: false,
    });
    assertValidV2Payload(agentErrMsg);
    assert.equal(uiV2.toPlainComponent(agentErrMsg.components[0]).accent_color, uiV2.COLORS.DANGER);
    assert.match(uiV2.extractV2Text(agentErrMsg), /Échec/);

    const appDirMsg = format.buildChatReplyPayload({
      content: '1. QuizBot',
      usedTool: 'search_app_directory',
      toolArgs: { query: 'quiz' },
      mode: 'chat',
    });
    assertValidV2Payload(appDirMsg);
    assert.equal(uiV2.toPlainComponent(appDirMsg.components[0]).accent_color, uiV2.COLORS.INFO);
    assert.match(uiV2.extractV2Text(appDirMsg), /App Directory/);

    const fallbackDebugMsg = format.buildChatReplyPayload({
      content: 'Reponse debug',
      usedTool: 'list_channels',
      question: 'liste les salons',
      isDebug: true,
      stats: {
        elapsedMs: 320,
        tokensPerSecond: 42.5,
        promptTokens: 100,
        completionTokens: 50,
        model: 'gemma3:1B',
        source: 'local_fallback',
        fallbackProvider: 'OpenAI',
        fallbackReason: 'limite de quota',
      },
    });
    assertValidV2Payload(fallbackDebugMsg);
    assert.equal(
      uiV2.toPlainComponent(fallbackDebugMsg.components[0]).accent_color,
      uiV2.COLORS.ACCENT
    );
    const dbgText = uiV2.extractV2Text(fallbackDebugMsg);
    assert.match(dbgText, /Mode Debug/);
    assert.match(dbgText, /320 ms/);
    assert.match(dbgText, /42\.50 tok\/s/);
    assert.match(dbgText, /list_channels/);
    assert.match(dbgText, /Réponse via le modèle local/);
  });

  it('events.js repond en Components V2 sur mention vide, reponse normale, debug, rate-limit et erreur', async () => {
    const handlers = {};
    const mockClient = {
      user: { id: 'bot-v2', tag: 'CIVIS#0001' },
      once(ev, fn) {
        handlers['once:' + ev] = fn;
      },
      on(ev, fn) {
        handlers[ev] = fn;
      },
    };
    registerEvents(mockClient);

    const origProcess = brain.processMessage;
    const chId = 'ch-events-v2';
    debug.disable(chId);

    try {
      const makeMessage = (text, authorId = 'user-ev-1') => {
        const replies = [];
        return {
          replies,
          author: { id: authorId, username: 'Alice', bot: false },
          member: { displayName: 'Alice' },
          guild: { id: 'g-v2', name: 'GuildV2' },
          channel: {
            id: chId,
            sendTyping: async () => {},
          },
          mentions: { has: (u) => u?.id === 'bot-v2' },
          content: text,
          reply: async (payload) => {
            replies.push(payload);
            return payload;
          },
        };
      };

      // 1. Mention vide
      const emptyMsg = makeMessage('<@bot-v2>', 'user-empty');
      await handlers.messageCreate(emptyMsg);
      assert.equal(emptyMsg.replies.length, 1);
      assertValidV2Payload(emptyMsg.replies[0]);
      assert.match(uiV2.extractV2Text(emptyMsg.replies[0]), /Oui \?/);

      // 2. Reponse normale
      brain.processMessage = async () => ({
        content: 'Tout fonctionne parfaitement !',
        stats: { elapsedMs: 120, source: 'local', model: 'gemma3:1B' },
        usedTool: null,
      });
      const normalMsg = makeMessage('<@bot-v2> salut', 'user-norm');
      await handlers.messageCreate(normalMsg);
      assert.equal(normalMsg.replies.length, 1);
      assertValidV2Payload(normalMsg.replies[0]);
      assert.match(uiV2.extractV2Text(normalMsg.replies[0]), /Tout fonctionne parfaitement/);

      // 3. Rate-limit immediat sur le meme utilisateur
      const spamMsg = makeMessage('<@bot-v2> encore', 'user-norm');
      await handlers.messageCreate(spamMsg);
      assert.equal(spamMsg.replies.length, 1);
      assertValidV2Payload(spamMsg.replies[0]);
      assert.equal(uiV2.toPlainComponent(spamMsg.replies[0].components[0]).accent_color, uiV2.COLORS.WARNING);
      assert.match(uiV2.extractV2Text(spamMsg.replies[0]), /Un instant/);

      // 4. Mode debug active
      debug.enable(chId);
      const dbgMsg = makeMessage('<@bot-v2> etat ?', 'user-dbg');
      await handlers.messageCreate(dbgMsg);
      assert.equal(dbgMsg.replies.length, 1);
      assertValidV2Payload(dbgMsg.replies[0]);
      assert.match(uiV2.extractV2Text(dbgMsg.replies[0]), /Mode Debug/);
      debug.disable(chId);

      // 5. Erreur lors de processMessage (ne fuite pas err.message brut)
      brain.processMessage = async () => {
        throw new Error('Serveur LLM indisponible');
      };
      const errMsg = makeMessage('<@bot-v2> boom', 'user-err');
      await handlers.messageCreate(errMsg);
      assert.equal(errMsg.replies.length, 1);
      assertValidV2Payload(errMsg.replies[0]);
      assert.equal(uiV2.toPlainComponent(errMsg.replies[0].components[0]).accent_color, uiV2.COLORS.DANGER);
      const errText = uiV2.extractV2Text(errMsg.replies[0]);
      assert.match(errText, /Une erreur interne est survenue/);
      assert.doesNotMatch(errText, /Serveur LLM indisponible/);
    } finally {
      brain.processMessage = origProcess;
      debug.disable(chId);
      rateLimit.clearAll();
    }
  });

  it('/ping et /apikey status repondent en Components V2 ephemeres', async () => {
    let pingReply = null;
    await handleInteraction({
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      commandName: 'ping',
      channel: { id: 'c-1' },
      user: { id: 'u-ping' },
      member: null,
      client: { ws: { ping: 42 } },
      reply: async (p) => {
        pingReply = p;
      },
    });
    assertValidV2Payload(pingReply, { ephemeral: true });
    const pingText = uiV2.extractV2Text(pingReply);
    assert.match(pingText, /Pong !/);
    assert.match(pingText, /42 ms/);

    const origGetStatus = userKeys.getUserStatus;
    userKeys.getUserStatus = () => null;
    try {
      let statusReply = null;
      await handleInteraction({
        isButton: () => false,
        isModalSubmit: () => false,
        isChatInputCommand: () => true,
        commandName: 'apikey',
        channel: { id: 'c-1' },
        user: { id: 'u-status-none' },
        member: null,
        options: { getSubcommand: () => 'status' },
        reply: async (p) => {
          statusReply = p;
        },
      });
      assertValidV2Payload(statusReply, { ephemeral: true });
      assert.match(uiV2.extractV2Text(statusReply), /IA locale gratuite/);
    } finally {
      userKeys.getUserStatus = origGetStatus;
    }
  });
});
