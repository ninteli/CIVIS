const { validateCustomUrlDns } = require('./user-keys');

const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8080';

const LOCAL_MODELS = {
  chat: process.env.LLM_CHAT_MODEL || 'gemma3:1B',
  agent: process.env.LLM_AGENT_MODEL || 'qwen2.5:3B',
};
const LOCAL_KEEP_ALIVE = process.env.LLM_KEEP_ALIVE || '15m';

function resolveLocalModel(localRole, explicitModel) {
  if (typeof explicitModel === 'string' && explicitModel.trim()) {
    return explicitModel.trim();
  }
  return localRole === 'agent' ? LOCAL_MODELS.agent : LOCAL_MODELS.chat;
}

function normalizeAlternatingMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const systemParts = [];
  const alternating = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || '').trim().toLowerCase();
    const content = msg.content === undefined || msg.content === null ? '' : String(msg.content);

    if (role === 'system') {
      const trimmed = content.trim();
      if (trimmed) systemParts.push(trimmed);
      continue;
    }

    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'assistant' && alternating.length === 0) continue;

    const prev = alternating[alternating.length - 1];
    if (prev && prev.role === role) {
      if (prev.content && content) {
        prev.content = prev.content + '\n\n' + content;
      } else if (content) {
        prev.content = content;
      }
    } else {
      alternating.push({ role, content });
    }
  }

  if (systemParts.length > 0) {
    return [{ role: 'system', content: systemParts.join('\n\n') }, ...alternating];
  }
  return alternating;
}

const NON_CHAT_MODEL_RE =
  /(embed|imagen|veo|tts|whisper|audio|transcribe|moderation|dall-e|sora|realtime|aqa|image|robotics|computer-use|babbage|davinci|speech|live)/i;

const FALLBACK_REASONS = {
  QUOTA: 'limite de quota avec le modèle API personnalisé',
  HIGH_USAGE: 'impossible d\'utiliser le modèle API par fort usage',
  INVALID_KEY: 'clé API incorrecte, merci de reconfigurer la clé API',
  MODEL_NOT_FOUND: 'modèle API ou endpoint introuvable (utilise /apikey model)',
  TIMEOUT: 'délai de réponse dépassé sur le modèle API',
  NETWORK: 'erreur réseau vers le serveur API',
};

const QUOTA_RE =
  /(quota|rate[\s_-]*limit|resource_exhausted|insufficient_quota|too many requests|limit exceeded|tokens per minute|requests per minute|credit balance|billing)/i;
const HIGH_USAGE_RE =
  /(high demand|overload|capacity|too busy|busy|temporarily unavailable|spikes in demand|try again later|server is overloaded)/i;
const INVALID_KEY_RE =
  /(api[\s_-]*key.*(invalid|not valid|expired|missing|incorrect|revoked)|invalid[\s_-]*api[\s_-]*key|incorrect[\s_-]*api[\s_-]*key|api_key_invalid|authentication|unauthenticated|permission_denied)/i;

function classifyApiError(err, status) {
  const apiMsg = String(err?.apiMessage || err?.message || '');

  if (
    status === 429 ||
    (typeof status === 'number' && status >= 400 && status < 500 && QUOTA_RE.test(apiMsg))
  ) {
    return FALLBACK_REASONS.QUOTA;
  }
  if (
    status === 401 ||
    status === 403 ||
    (status === 400 && INVALID_KEY_RE.test(apiMsg))
  ) {
    return FALLBACK_REASONS.INVALID_KEY;
  }
  if (
    status === 503 ||
    status === 529 ||
    (typeof status === 'number' && status >= 500 && HIGH_USAGE_RE.test(apiMsg))
  ) {
    return FALLBACK_REASONS.HIGH_USAGE;
  }
  if (status === 404) return FALLBACK_REASONS.MODEL_NOT_FOUND;
  if (typeof status === 'number' && status >= 500) {
    return 'erreur serveur API (' + status + ')';
  }
  if (typeof status === 'number' && status >= 400) {
    return 'erreur API (HTTP ' + status + ')';
  }
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return FALLBACK_REASONS.TIMEOUT;
  }
  return FALLBACK_REASONS.NETWORK;
}

function extractSafeApiErrorMessage(rawText, apiKey) {
  if (!rawText || typeof rawText !== 'string') return '';

  let message = '';
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed) && parsed[0]?.error?.message) {
        message = String(parsed[0].error.message);
      } else if (parsed.error?.message) {
        message = String(parsed.error.message);
      } else if (parsed.message) {
        message = String(parsed.message);
      }
    }
  } catch {
    message = rawText;
  }

  if (!message) {
    message = rawText;
  }

  if (apiKey && typeof apiKey === 'string') {
    message = message.split(apiKey).join('[REDACTED]');
  }

  return message.replace(/\s+/g, ' ').trim().slice(0, 180);
}

async function callOpenAICompatible({
  url,
  apiKey,
  model,
  messages,
  maxTokens,
  temperature,
  timeoutMs,
  fetchFn,
}) {
  const endpoint = String(url).replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = 'Bearer ' + apiKey;
  }

  const body = {
    messages,
    stream: false,
  };
  if (maxTokens !== undefined && maxTokens !== null) {
    body.max_tokens = maxTokens;
  }
  if (temperature !== undefined && temperature !== null) {
    body.temperature = temperature;
  }
  if (model) {
    body.model = model;
  }

  const fetchOptions = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'error',
  };
  if (timeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
    fetchOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  const startedAt = Date.now();
  const res = await fetchFn(endpoint, fetchOptions);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const apiMessage = extractSafeApiErrorMessage(errText, apiKey);
    const err = new Error('LLM HTTP ' + res.status + (apiMessage ? ': ' + apiMessage : ''));
    err.status = res.status;
    err.apiMessage = apiMessage;
    throw err;
  }

  const data = await res.json();
  const elapsedMs = Date.now() - startedAt;

  const content = data.choices?.[0]?.message?.content ?? '';
  const usage = data.usage || {};
  const timings = data.timings || {};

  return {
    content,
    stats: {
      model: data.model || model || null,
      elapsedMs,
      promptTokens: usage.prompt_tokens ?? timings.prompt_n ?? null,
      completionTokens: usage.completion_tokens ?? timings.predicted_n ?? null,
      totalTokens: usage.total_tokens ?? null,
      tokensPerSecond: timings.predicted_per_second ?? null,
    },
  };
}

async function assertSafeCustomEndpoint(userConfig, { fetchFn, lookupFn } = {}) {
  if (!userConfig || userConfig.provider !== 'custom') return;
  if (fetchFn && !lookupFn) return;
  const check = await validateCustomUrlDns(userConfig.baseUrl, { lookupFn });
  if (!check.ok) {
    const err = new Error(check.error);
    err.apiMessage = check.error;
    throw err;
  }
}

async function listAvailableModels(
  userConfig,
  { timeoutMs = 10_000, fetchFn, lookupFn } = {}
) {
  const fetchImpl = fetchFn || fetch;
  if (!userConfig || !userConfig.baseUrl || !userConfig.apiKey) {
    return { ok: false, status: null, error: 'Configuration API incomplete.' };
  }

  try {
    await assertSafeCustomEndpoint(userConfig, { fetchFn, lookupFn });
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }

  const endpoint = String(userConfig.baseUrl).replace(/\/+$/, '') + '/models';
  const fetchOptions = {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + userConfig.apiKey,
    },
    redirect: 'error',
  };
  if (timeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
    fetchOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  try {
    const res = await fetchImpl(endpoint, fetchOptions);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: extractSafeApiErrorMessage(errText, userConfig.apiKey),
      };
    }

    const data = await res.json();
    const rawList = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.models)
        ? data.models
        : [];

    const seen = new Set();
    const models = [];
    for (const item of rawList) {
      const rawId = typeof item === 'string' ? item : item?.id || item?.name || '';
      const id = String(rawId).replace(/^models\//i, '').trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        models.push(id);
      }
    }

    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      status: err?.status || null,
      error: classifyApiError(err, err?.status),
    };
  }
}

function rankWithPriorityList(list, preferredIds, patternRe) {
  const ordered = [];
  const seen = new Set();

  for (const pref of preferredIds) {
    if (list.includes(pref) && !seen.has(pref)) {
      seen.add(pref);
      ordered.push(pref);
    }
  }

  if (patternRe) {
    for (const id of list) {
      if (patternRe.test(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
  }

  for (const id of list) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  return ordered;
}

function scoreGeminiModel(id) {
  const lower = id.toLowerCase();
  const verMatch = lower.match(/gemini-(\d+(?:\.\d+)?)/);
  const version = verMatch ? parseFloat(verMatch[1]) : 0;
  const isFlash = lower.includes('flash');
  const isPro = lower.includes('pro');
  const isLite = lower.includes('lite');
  const isUnstable = /\b(exp|preview)\b|-\d{3,}/i.test(lower);

  return (
    (isFlash ? 50000 : isPro ? 20000 : 0) +
    Math.round(version * 1000) +
    (isLite ? 0 : 20) +
    (isUnstable ? 0 : 10)
  );
}

function pickCandidateModels(provider, modelIds) {
  const unique = [];
  const seen = new Set();
  for (const raw of Array.isArray(modelIds) ? modelIds : []) {
    const id = String(raw || '').trim();
    if (id && !seen.has(id) && !NON_CHAT_MODEL_RE.test(id)) {
      seen.add(id);
      unique.push(id);
    }
  }

  if (provider === 'gemini') {
    const geminiOnly = unique.filter((id) => /gemini/i.test(id));
    const pool = geminiOnly.length > 0 ? geminiOnly : unique;
    return [...pool].sort((a, b) => scoreGeminiModel(b) - scoreGeminiModel(a));
  }

  if (provider === 'openai') {
    return rankWithPriorityList(
      unique,
      ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini', 'gpt-4o', 'gpt-4.1'],
      /^gpt-/i
    );
  }

  if (provider === 'groq') {
    return rankWithPriorityList(
      unique,
      ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
      /(llama|qwen)/i
    );
  }

  if (provider === 'mistral') {
    return rankWithPriorityList(
      unique,
      ['mistral-small-latest', 'mistral-medium-latest'],
      /^mistral-/i
    );
  }

  return unique;
}

async function testUserConfig(userConfig, { timeoutMs = 15_000, fetchFn, lookupFn } = {}) {
  const fetchImpl = fetchFn || fetch;
  try {
    await assertSafeCustomEndpoint(userConfig, { fetchFn, lookupFn });
    const res = await callOpenAICompatible({
      url: userConfig.baseUrl,
      apiKey: userConfig.apiKey,
      model: userConfig.model,
      messages: [{ role: 'user', content: 'Reply OK' }],
      maxTokens: 256,
      temperature: undefined,
      timeoutMs,
      fetchFn: fetchImpl,
    });
    return {
      ok: true,
      model: res.stats.model || userConfig.model,
      elapsedMs: res.stats.elapsedMs,
    };
  } catch (err) {
    return {
      ok: false,
      status: err?.status || null,
      reason: classifyApiError(err, err?.status),
      apiMessage: err?.apiMessage || '',
    };
  }
}

async function verifyAndResolveModel(
  userConfig,
  { allowAutoPick = true, timeoutMs = 15_000, fetchFn } = {}
) {
  const fetchImpl = fetchFn || fetch;
  const first = await testUserConfig(userConfig, { timeoutMs, fetchFn: fetchImpl });

  if (first.ok) {
    return {
      ok: true,
      model: userConfig.model,
      elapsedMs: first.elapsedMs,
      autoSelected: false,
    };
  }

  if (first.status === 404) {
    const list = await listAvailableModels(userConfig, {
      timeoutMs: Math.min(timeoutMs, 10_000),
      fetchFn: fetchImpl,
    });
    const candidates = list.ok
      ? pickCandidateModels(userConfig.provider, list.models).filter(
          (m) => m !== userConfig.model
        )
      : [];

    const attemptErrors = [];
    if (allowAutoPick) {
      for (const candidate of candidates.slice(0, 4)) {
        const attempt = await testUserConfig(
          { ...userConfig, model: candidate },
          { timeoutMs: Math.min(timeoutMs, 12_000), fetchFn: fetchImpl }
        );
        if (attempt.ok) {
          return {
            ok: true,
            model: candidate,
            previousModel: userConfig.model,
            elapsedMs: attempt.elapsedMs,
            autoSelected: true,
          };
        }
        attemptErrors.push(
          candidate +
            ': ' +
            attempt.reason +
            (attempt.apiMessage ? ' (' + attempt.apiMessage + ')' : '')
        );
      }
    }

    if (attemptErrors.length > 0) {
      console.warn(
        '[llm] Auto-selection echec (' +
          userConfig.label +
          ') : ' +
          attemptErrors.join(' | ')
      );
    }

    return {
      ok: false,
      status: 404,
      reason: first.reason,
      apiMessage: first.apiMessage,
      suggestedModels: candidates.slice(0, 8),
      attemptErrors,
    };
  }

  return {
    ok: false,
    status: first.status,
    reason: first.reason,
    apiMessage: first.apiMessage,
    suggestedModels: [],
  };
}

async function chat(messages, options = {}) {
  const fetchImpl = options.fetchFn || fetch;
  const userConfig = options.userConfig || null;
  const resolvedMaxTokens = options.maxTokens ?? 512;
  const resolvedTemperature = options.temperature ?? 0.7;
  const localRole = options.localRole || 'chat';
  const localModel = resolveLocalModel(localRole, options.localModel);

  async function invokeLocalLLM(fallbackMeta = null) {
    const normalizedMessages = normalizeAlternatingMessages(messages);
    const localRes = await callOpenAICompatible({
      url: LLM_URL + '/v1',
      model: localModel,
      messages: normalizedMessages,
      maxTokens: resolvedMaxTokens,
      temperature: resolvedTemperature,
      timeoutMs: options.localTimeoutMs ?? 0,
      fetchFn: fetchImpl,
    });

    const baseStats = {
      ...localRes.stats,
      model: localRes.stats.model || localModel,
      localRole,
      keepAlive: LOCAL_KEEP_ALIVE,
    };

    if (fallbackMeta) {
      return {
        content: localRes.content,
        stats: {
          ...baseStats,
          source: 'local_fallback',
          provider: 'IA locale',
          fallbackProvider: fallbackMeta.providerLabel || 'API',
          fallbackReason: fallbackMeta.reason,
        },
      };
    }

    return {
      content: localRes.content,
      stats: {
        ...baseStats,
        source: 'local',
        provider: 'IA locale',
      },
    };
  }

  if (userConfig && userConfig.decryptFailed) {
    console.warn(
      '[llm] Cle API impossible a dechiffrer (' +
        (userConfig.label || 'API') +
        ') -> bascule sur IA locale'
    );
    return invokeLocalLLM({
      reason: FALLBACK_REASONS.INVALID_KEY,
      providerLabel: userConfig.label,
    });
  }

  if (userConfig && userConfig.baseUrl && userConfig.apiKey) {
    try {
      await assertSafeCustomEndpoint(userConfig, {
        fetchFn: options.fetchFn,
        lookupFn: options.lookupFn,
      });
      const ext = await callOpenAICompatible({
        url: userConfig.baseUrl,
        apiKey: userConfig.apiKey,
        model: userConfig.model,
        messages,
        maxTokens: resolvedMaxTokens,
        temperature: resolvedTemperature,
        timeoutMs: options.timeoutMs ?? 25_000,
        fetchFn: fetchImpl,
      });

      return {
        content: ext.content,
        stats: {
          ...ext.stats,
          model: ext.stats.model || userConfig.model,
          source: 'api',
          provider: userConfig.label,
        },
      };
    } catch (err) {
      const reason = classifyApiError(err, err?.status);
      console.warn(
        '[llm] Echec API externe (' +
          userConfig.label +
          ', modele ' +
          userConfig.model +
          ') : ' +
          reason +
          (err?.apiMessage ? ' | ' + err.apiMessage : '') +
          ' -> bascule sur IA locale'
      );

      return invokeLocalLLM({
        reason,
        providerLabel: userConfig.label,
      });
    }
  }

  return invokeLocalLLM(null);
}

module.exports = {
  LOCAL_MODELS,
  LOCAL_KEEP_ALIVE,
  FALLBACK_REASONS,
  resolveLocalModel,
  normalizeAlternatingMessages,
  chat,
  classifyApiError,
  extractSafeApiErrorMessage,
  listAvailableModels,
  pickCandidateModels,
  testUserConfig,
  verifyAndResolveModel,
};
