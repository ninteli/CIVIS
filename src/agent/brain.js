const config = require('../../config');
const { chat } = require('./llm');
const memory = require('./memory');
const userKeys = require('./user-keys');
const { getToolsPrompt, getTool, readTools, actionTools } = require('./tools');
const { executeTool } = require('./tool-executor');

const AGENT_NO_ACTION_REPLY =
  'Aucune action effectuee : cette demande ne correspond a aucun outil disponible.\n' +
  'Actions disponibles : creer des categories, creer/modifier/archiver/supprimer des salons ou roles, gerer les permissions de roles ou de salons, et rechercher des bots dans l App Directory Discord.';

// Construction du prompt selon le mode
function buildSystemPrompt(mode) {
  const isAgent = mode === 'agent';
  const tools = isAgent ? actionTools : readTools;

  if (isAgent) {
    return (
      'Tu es CIVIS en MODE AGENT. Tu ne discutes pas, tu choisis un outil et reponds en JSON.\n\n' +
      '## Outils\n' +
      getToolsPrompt(tools) +
      '\n\n' +
      '## Format de reponse\n' +
      'Si la demande correspond a un outil, reponds UNIQUEMENT en JSON : {"tool": "nom_outil", "args": {...}}\n' +
      'Exemples :\n' +
      '"cree un salon annonces" => {"tool": "create_channel", "args": {"name": "annonces", "category_hint": "important"}}\n' +
      '"cree un role moderateur rouge" => {"tool": "create_role", "args": {"name": "Moderateur", "color": "rouge"}}\n' +
      '"renomme general en accueil" => {"tool": "modify_channel", "args": {"channel": "general", "new_name": "accueil"}}\n' +
      '"change la couleur de VIP en vert" => {"tool": "modify_role_display", "args": {"role": "VIP", "color": "vert"}}\n' +
      '"donne ManageMessages a Modo" => {"tool": "modify_role_perm", "args": {"role": "Modo", "add": ["ManageMessages"]}}\n' +
      '"supprime le salon annonces" => {"tool": "delete_channel", "args": {"channel": "annonces"}}\n' +
      '"supprime le role VIP" => {"tool": "delete_role", "args": {"role": "VIP"}}\n' +
      '"archive le salon annonces" => {"tool": "archive_channel", "args": {"channel": "annonces"}}\n' +
      '"archive le role VIP" => {"tool": "archive_role", "args": {"role": "VIP"}}\n' +
      '"cree une categorie Staff" => {"tool": "create_category", "args": {"name": "Staff"}}\n' +
      '"cree un forum theories spoiler avec cooldown 30s" => {"tool": "create_channel", "args": {"name": "theories", "type": "forum", "spoiler": true, "slowmode": 30}}\n' +
      '"rends annonces en lecture seule" => {"tool": "set_channel_permissions", "args": {"channel": "annonces", "target_type": "channel", "role": "@everyone", "deny": ["SendMessages"]}}\n' +
      '"rends toute la categorie Staff privee pour @everyone" => {"tool": "set_channel_permissions", "args": {"channel": "Staff", "target_type": "category", "role": "@everyone", "deny": ["ViewChannel"]}}\n' +
      '"trouve des bots de musique sur discord" => {"tool": "search_app_directory", "args": {"query": "music"}}\n\n' +
      'Regles : ne jamais inventer d outil; si aucune action ne correspond, reponds REFUS.'
    );
  }

  return (
    config.systemPrompt +
    '\n\nTu es CIVIS en MODE CONVERSATION.\n\n' +
    '## Outils disponibles\n' +
    getToolsPrompt(tools) +
    '\n\n' +
    '## Regles\n' +
    '- Reponds naturellement en francais en mode conversation.\n' +
    '- Si l utilisateur demande la liste des salons/roles ou de rechercher des bots/applications Discord (App Directory), reponds UNIQUEMENT en JSON : {"tool": "list_channels", "args": {}}, {"tool": "list_roles", "args": {}} ou {"tool": "search_app_directory", "args": {"query": "..."}}.\n' +
    '- Tu ne peux PAS creer, modifier, archiver ou supprimer en mode conversation : indique d utiliser /agent.\n' +
    '- N invente jamais d outil et ne pretends jamais avoir fait une action.'
  );
}

function extractJsonObjectCandidates(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push({ json: text.slice(start, i + 1), end: i });
        start = -1;
      }
    }
  }

  return candidates;
}

function tryParseToolCall(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const candidates = extractJsonObjectCandidates(cleaned);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.json);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        typeof parsed.tool !== 'string'
      ) {
        continue;
      }

      const toolName = parsed.tool.trim().toLowerCase();

      if (toolName === 'aucun' || toolName === 'none' || toolName === 'null' || toolName === '') {
        const textPart = cleaned.substring(candidate.end + 1).trim();
        return { __chatText: textPart || cleaned };
      }

      const args =
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? parsed.args
          : {};

      return { tool: parsed.tool.trim(), args };
    } catch {
      // Ignore invalid JSON candidate and try the next one
    }
  }

  return null;
}

const MUTATION_INTENT_RE =
  /\b(cree|creer|crees|ajoute|ajouter|supprime|supprimer|efface|effacer|archive|archiver|modifie|modifier|renomme|renommer|change|changer|permission|permissions|droit|droits)\b/;
const LIST_QUERY_RE =
  /\b(liste|lister|affiche|afficher|montre|montrer|voir|donne|donner|quels?\s+sont|c\s*est\s+quoi|y\s+a\s*t\s*il|combien)\b/;

function detectReadToolIntent(userText) {
  if (typeof userText !== 'string') return null;
  const normalized = userText
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || MUTATION_INTENT_RE.test(normalized)) {
    return null;
  }

  const wantsChannels = /\b(salons?|channels?|canaux)\b/.test(normalized);
  const wantsRoles = /\b(roles?|grades?)\b/.test(normalized);
  const isBareList = /^(les\s+)?(salons?|channels?|canaux|roles?|grades?)\s*\??$/.test(normalized);

  if (wantsChannels && !wantsRoles && (LIST_QUERY_RE.test(normalized) || isBareList)) {
    return 'list_channels';
  }
  if (wantsRoles && !wantsChannels && (LIST_QUERY_RE.test(normalized) || isBareList)) {
    return 'list_roles';
  }

  return null;
}

function buildFollowupSystemPrompt() {
  return (
    config.systemPrompt +
    '\n\nReponds en francais de maniere naturelle, fidele et concise a partir du resultat fourni. ' +
    'Ne reponds JAMAIS en JSON et ne mentionne pas le nom de l outil.'
  );
}

function resolveEffectiveUserConfig(authorId, explicitUserConfig) {
  if (explicitUserConfig !== undefined) return explicitUserConfig;
  if (!authorId) return null;
  const cfg = userKeys.getUserConfig(authorId);
  if (cfg) return cfg;
  const status = userKeys.getUserStatus(authorId);
  if (status) {
    return {
      ...status,
      apiKey: null,
      decryptFailed: true,
    };
  }
  return null;
}

function mergeFollowupStats(firstStats, secondStats, totalElapsedMs) {
  const merged = {
    ...(secondStats || {}),
    elapsedMs: totalElapsedMs,
  };
  if (
    firstStats &&
    firstStats.source === 'local_fallback' &&
    merged.source !== 'local_fallback'
  ) {
    merged.source = firstStats.source;
    merged.fallbackProvider = firstStats.fallbackProvider;
    merged.fallbackReason = firstStats.fallbackReason;
  }
  return merged;
}

async function processMessage({
  userText,
  channelId,
  authorName,
  authorId,
  guild,
  member,
  client,
  mode,
  chatFn,
  userConfig,
}) {
  mode = mode || 'chat';
  const callLLM = chatFn || chat;
  const localRole = mode === 'agent' ? 'agent' : 'chat';
  const resolvedUserConfig = resolveEffectiveUserConfig(authorId, userConfig);
  const useExternalMaxTokens = Boolean(resolvedUserConfig && !resolvedUserConfig.decryptFailed);

  const isAgentMode = mode === 'agent';
  const recordMessage = (entry) => {
    if (isAgentMode) {
      memory.addActionMessage(channelId, authorId, entry);
    } else {
      memory.addMessage(channelId, entry);
    }
  };

  recordMessage({
    role: 'user',
    content: userText,
    authorName,
    authorId,
  });

  const systemPrompt = buildSystemPrompt(mode);
  // 256 tokens en local : 128 tronquait les JSON longs (ex: set_channel_permissions multi-permissions)
  const agentMaxTokens = useExternalMaxTokens ? 1024 : 256;
  const chatMaxTokens = useExternalMaxTokens ? 1024 : 512;

  const agentContext = isAgentMode
    ? memory.formatActionContextBlock(channelId, authorId, {
        excludeLast: true,
        maxMessages: 10,
      })
    : '';
  const agentUserLine = (authorName ? authorName + ': ' : '') + userText;
  const agentUserContent = agentContext
    ? `${agentContext}\n\nDemande actuelle a executer :\n${agentUserLine}`
    : agentUserLine;

  const messages =
    mode === 'agent'
      ? [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: agentUserContent },
        ]
      : memory.formatForLLM(channelId, systemPrompt);

  const first = await callLLM(messages, {
    maxTokens: mode === 'agent' ? agentMaxTokens : chatMaxTokens,
    temperature: mode === 'agent' ? 0.1 : 0.7,
    userConfig: resolvedUserConfig,
    localRole,
  });

  let toolCall = tryParseToolCall(first.content);
  let totalElapsedMs = first.stats?.elapsedMs || 0;
  let lastStats = first.stats || {};

  if (mode === 'agent') {
    if (!toolCall || toolCall.__chatText) {
      const retryMessages = messages.concat([
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content:
            'Tu es en MODE AGENT et tu n as appele aucun outil. Si la demande correspond a un outil disponible, reponds UNIQUEMENT par le JSON {"tool": "nom_outil", "args": {...}} sans aucun texte autour. Sinon, reponds exactement : REFUS',
        },
      ]);
      const retry = await callLLM(retryMessages, {
        maxTokens: agentMaxTokens,
        temperature: 0,
        userConfig: resolvedUserConfig,
        localRole: 'agent',
      });
      totalElapsedMs += retry.stats?.elapsedMs || 0;
      lastStats = mergeFollowupStats(lastStats, retry.stats, totalElapsedMs);
      toolCall = tryParseToolCall(retry.content);

      if (!toolCall || toolCall.__chatText) {
        console.warn('[brain] Aucune action appelee en mode agent pour : ' + userText);
        recordMessage({ role: 'assistant', content: AGENT_NO_ACTION_REPLY });
        return {
          content: AGENT_NO_ACTION_REPLY,
          stats: { ...lastStats, elapsedMs: totalElapsedMs },
          usedTool: null,
        };
      }
    }
  } else {
    if (toolCall && toolCall.__chatText) {
      const recovered = detectReadToolIntent(userText);
      if (recovered) {
        toolCall = { tool: recovered, args: {} };
      } else {
        recordMessage({ role: 'assistant', content: toolCall.__chatText });
        return {
          content: toolCall.__chatText,
          stats: { ...lastStats, elapsedMs: totalElapsedMs },
          usedTool: null,
        };
      }
    }

    if (!toolCall) {
      const recovered = detectReadToolIntent(userText);
      if (recovered) {
        toolCall = { tool: recovered, args: {} };
      } else {
        recordMessage({ role: 'assistant', content: first.content });
        return {
          content: first.content,
          stats: { ...lastStats, elapsedMs: totalElapsedMs },
          usedTool: null,
        };
      }
    }
  }

  const tool = getTool(toolCall.tool);
  const invalidForAgent =
    mode === 'agent' && (!tool || !actionTools.some((t) => t.name === tool.name));

  if (!tool || invalidForAgent) {
    console.warn('[brain] Outil inconnu : ' + toolCall.tool);
    if (mode === 'agent') {
      recordMessage({ role: 'assistant', content: AGENT_NO_ACTION_REPLY });
      return {
        content: AGENT_NO_ACTION_REPLY,
        stats: { ...lastStats, elapsedMs: totalElapsedMs },
        usedTool: null,
      };
    }

    const retryMessages = messages.concat([
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'Non, ne reponds pas en JSON. Aucun outil ne correspond. Reponds en texte normal en francais.',
      },
    ]);
    const retry = await callLLM(retryMessages, {
      maxTokens: chatMaxTokens,
      userConfig: resolvedUserConfig,
      localRole: 'chat',
    });
    totalElapsedMs += retry.stats?.elapsedMs || 0;
    lastStats = mergeFollowupStats(lastStats, retry.stats, totalElapsedMs);
    recordMessage({ role: 'assistant', content: retry.content });
    return {
      content: retry.content,
      stats: { ...lastStats, elapsedMs: totalElapsedMs },
      usedTool: null,
    };
  }

  const execution = await executeTool(toolCall.tool, toolCall.args, {
    guild,
    member,
    client,
    mode,
    userText,
  });

  if (execution.needsApproval) {
    recordMessage({
      role: 'assistant',
      content: '[Demande de validation en attente : ' + execution.approval.title + ']',
    });
    return {
      content: null,
      needsApproval: true,
      approval: execution.approval,
      stats: { ...lastStats, elapsedMs: totalElapsedMs },
      usedTool: toolCall.tool,
      toolArgs: toolCall.args,
    };
  }

  if (!execution.ok) {
    const msg = 'Erreur lors de l execution de ' + toolCall.tool + ' : ' + execution.error;
    recordMessage({ role: 'assistant', content: msg });
    return {
      content: msg,
      stats: { ...lastStats, elapsedMs: totalElapsedMs },
      usedTool: toolCall.tool,
      toolArgs: toolCall.args,
      actionOk: false,
      actionResult: null,
      actionError: execution.error,
    };
  }

  if (mode === 'agent') {
    recordMessage({ role: 'assistant', content: execution.result });
    return {
      content: execution.result,
      stats: { ...lastStats, elapsedMs: totalElapsedMs },
      usedTool: toolCall.tool,
      toolArgs: toolCall.args,
      actionOk: true,
      actionResult: execution.result,
      actionError: null,
    };
  }

  const followupInstruction =
    toolCall.tool === 'search_app_directory'
      ? '\n\nMaintenant, reponds a l utilisateur en francais de maniere claire et concise en conservant les noms exacts des bots/applications, leurs descriptions courtes et leurs liens App Directory.'
      : '\n\nMaintenant, reponds a l utilisateur en francais, de maniere naturelle et concise en listant exactement les elements ci-dessus. Ne reponds PAS en JSON et ne mentionne PAS l outil.';

  const followupHistory = messages.filter((m) => m.role !== 'system');
  const followupMessages = [
    { role: 'system', content: buildFollowupSystemPrompt() },
    ...followupHistory,
    {
      role: 'user',
      content:
        '[Resultat de l outil ' +
        toolCall.tool +
        '] :\n' +
        execution.result +
        followupInstruction,
    },
  ];

  const second = await callLLM(followupMessages, {
    maxTokens: chatMaxTokens,
    userConfig: resolvedUserConfig,
    localRole: 'chat',
  });
  totalElapsedMs += second.stats?.elapsedMs || 0;

  const finalContent =
    !second.content || !String(second.content).trim() || tryParseToolCall(second.content)
      ? execution.result
      : second.content;

  memory.addMessage(channelId, { role: 'assistant', content: finalContent });

  return {
    content: finalContent,
    stats: mergeFollowupStats(lastStats, second.stats, totalElapsedMs),
    usedTool: toolCall.tool,
    toolArgs: toolCall.args,
  };
}

async function warmupLocalLLM() {
  const payload = [
    { role: 'system', content: buildSystemPrompt('chat') },
    { role: 'user', content: 'ping' },
  ];

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    try {
      const res = await chat(payload, { maxTokens: 1, temperature: 0, localRole: 'chat' });
      console.log(
        '[brain] Prechauffage LLM local termine (' +
          (res.stats?.model || 'gemma3:1B') +
          ', ' +
          (res.stats?.elapsedMs || 0) +
          ' ms)'
      );
      return;
    } catch (err) {
      if (err?.status === 503 && attempt < 15) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      console.warn('[brain] Prechauffage LLM local ignore :', err.message);
      return;
    }
  }
}

module.exports = {
  processMessage,
  tryParseToolCall,
  detectReadToolIntent,
  buildSystemPrompt,
  warmupLocalLLM,
  resolveEffectiveUserConfig,
  mergeFollowupStats,
  AGENT_NO_ACTION_REPLY,
};
