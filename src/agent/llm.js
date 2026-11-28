const { validateCustomUrlDns } = require('./user-keys');
let undici = null;
try {
  undici = require('undici');
} catch {
  undici = null;
}

const LLM_URL = process.env.LLM_URL || 'http://127.0.0.1:8080';
const MAX_LLM_RESPONSE_BYTES = 1024 * 1024; // 1 Mo
const MAX_LLM_ERROR_BYTES = 64 * 1024; // 64 Ko

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

async function readResponseTextWithLimit(res, maxBytes) {
  const contentLengthHeader = res?.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declaredLen = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      try {
        await res.body?.cancel?.();
      } catch {
        // Ignore body cancel failure
      }
      const err = new Error('Reponse HTTP trop volumineuse (' + declaredLen + ' octets).');
      err.apiMessage = 'Réponse serveur trop volumineuse';
      throw err;
    }
  }

  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const buf = Buffer.from(value);
        totalBytes += buf.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore reader cancel failure
          }
          const err = new Error('Reponse HTTP trop volumineuse (> ' + maxBytes + ' octets).');
          err.apiMessage = 'Réponse serveur trop volumineuse';
          throw err;
        }
        chunks.push(buf);
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  if (typeof res?.text === 'function') {
    const text = await res.text();
    const byteLen = Buffer.byteLength(text, 'utf8');
    if (byteLen > maxBytes) {
      const err = new Error('Reponse HTTP trop volumineuse (' + byteLen + ' octets).');
      err.apiMessage = 'Réponse serveur trop volumineuse';
      throw err;
    }
    return text;
  }

  return null;
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
  dispatcher,
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
  if (dispatcher) {
    fetchOptions.dispatcher = dispatcher;
  }
  if (timeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
    fetchOptions.signal = AbortSignal.timeout(timeoutMs);
  }

  const startedAt = Date.now();
  const res = await fetchFn(endpoint, fetchOptions);

  if (!res.ok) {
    const errText = await readResponseTextWithLimit(res, MAX_LLM_ERROR_BYTES).catch(() => '');
    const apiMessage = extractSafeApiErrorMessage(errText || '', apiKey);
    const err = new Error('LLM HTTP ' + res.status + (apiMessage ? ': ' + apiMessage : ''));
    err.status = res.status;
    err.apiMessage = apiMessage;
    throw err;
  }

  const rawText = await readResponseTextWithLimit(res, MAX_LLM_RESPONSE_BYTES);
  const data = rawText !== null ? JSON.parse(rawText) : await res.json();
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
  if (!userConfig || userConfig.provider !== 'custom') return null;
  if (fetchFn && !lookupFn) return null;
  const check = await validateCustomUrlDns(userConfig.baseUrl, { lookupFn });
  if (!check.ok) {
    const err = new Error(check.error);
    err.apiMessage = check.error;
    throw err;
  }
  return check;
}

async function withPinnedCustomFetch(userConfig, { fetchFn, lookupFn } = {}, runner) {
  const endpointCheck = await assertSafeCustomEndpoint(userConfig, { fetchFn, lookupFn });
  if (
    fetchFn ||
    !userConfig ||
    userConfig.provider !== 'custom' ||
    !endpointCheck?.addresses?.length ||
    !undici?.Agent ||
    !undici?.fetch
  ) {
    return runner(fetchFn || fetch, undefined);
  }

  const expectedHost = new URL(userConfig.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const pinnedAddresses = endpointCheck.addresses;
  const agent = new undici.Agent({
    connect: {
      lookup(hostname, options, callback) {
        const cleanHost = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
        if (cleanHost !== expectedHost) {
          callback(new Error('Hote inattendu lors de la connexion DNS epinglee.'));
          return;
        }
        if (options && options.all) {
          callback(null, pinnedAddresses);
          return;
        }
        callback(null, pinnedAddresses[0].address, pinnedAddresses[0].family);
      },
    },
  });

  try {
    return await runner(undici.fetch, agent);
  } finally {
    await agent.close().catch(() => {});
  }
}

async function listAvailableModels(
  userConfig,
  { timeoutMs = 10_000, fetchFn, lookupFn } = {}
) {
  if (!userConfig || !userConfig.baseUrl || !userConfig.apiKey) {
    return { ok: false, status: null, error: 'Configuration API incomplete.' };
  }

  const endpoint = String(userConfig.baseUrl).replace(/\/+$/, '') + '/models';

  try {
    return await withPinnedCustomFetch(userConfig, { fetchFn, lookupFn }, async (fetchImpl, dispatcher) => {
      const fetchOptions = {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + userConfig.apiKey,
        },
        redirect: 'error',
      };
      if (dispatcher) {
        fetchOptions.dispatcher = dispatcher;
      }
      if (timeoutMs > 0 && typeof AbortSignal?.timeout === 'function') {
        fetchOptions.signal = AbortSignal.timeout(timeoutMs);
      }

      const res = await fetchImpl(endpoint, fetchOptions);
      if (!res.ok) {
        const errText = await readResponseTextWithLimit(res, MAX_LLM_ERROR_BYTES).catch(() => '');
        return {
          ok: false,
          status: res.status,
          error: extractSafeApiErrorMessage(errText || '', userConfig.apiKey),
        };
      }

      const rawText = await readResponseTextWithLimit(res, MAX_LLM_RESPONSE_BYTES);
      const data = rawText !== null ? JSON.parse(rawText) : await res.json();
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
    });
  } catch (err) {
    return {
      ok: false,
      status: err?.status || null,
      error: err?.apiMessage || classifyApiError(err, err?.status),
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
  try {
    const res = await withPinnedCustomFetch(
      userConfig,
      { fetchFn, lookupFn },
      (fetchImpl, dispatcher) =>
        callOpenAICompatible({
          url: userConfig.baseUrl,
          apiKey: userConfig.apiKey,
          model: userConfig.model,
          messages: [{ role: 'user', content: 'Reply OK' }],
          maxTokens: 256,
          temperature: undefined,
          timeoutMs,
          fetchFn: fetchImpl,
          dispatcher,
        })
    );
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
  { allowAutoPick = true, timeoutMs = 15_000, fetchFn, lookupFn } = {}
) {
  const first = await testUserConfig(userConfig, { timeoutMs, fetchFn, lookupFn });

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
      fetchFn,
      lookupFn,
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
          { timeoutMs: Math.min(timeoutMs, 12_000), fetchFn, lookupFn }
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
    const localApiKey = (process.env.LLM_API_KEY || '').trim() || undefined;
    const localRes = await callOpenAICompatible({
      url: LLM_URL + '/v1',
      apiKey: localApiKey,
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
      const ext = await withPinnedCustomFetch(
        userConfig,
        { fetchFn: options.fetchFn, lookupFn: options.lookupFn },
        (effectiveFetch, dispatcher) =>
          callOpenAICompatible({
            url: userConfig.baseUrl,
            apiKey: userConfig.apiKey,
            model: userConfig.model,
            messages,
            maxTokens: resolvedMaxTokens,
            temperature: resolvedTemperature,
            timeoutMs: options.timeoutMs ?? 25_000,
            fetchFn: effectiveFetch,
            dispatcher,
          })
      );

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
  MAX_LLM_RESPONSE_BYTES,
  MAX_LLM_ERROR_BYTES,
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
