// Mémoire par salon : garde les N derniers messages échangés
const MAX_MESSAGES = 20;
const MAX_CHANNELS = 500;
const MAX_ACTION_KEYS = 1000;

// Map : channelId -> tableau de { role, content, authorName, authorId }
const memory = new Map();

// Memoire isolee par couple (channelId, authorId) pour les modes d'action (/agent, /plan)
const actionMemory = new Map();

function setBoundedMap(map, key, value, maxSize) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function buildActionKey(channelId, authorId) {
  const ch = String(channelId || '').trim();
  const au = String(authorId || '').trim();
  if (!ch || !au) return null;
  return ch + ':' + au;
}

function getHistory(channelId) {
  return memory.get(channelId) || [];
}

function addMessage(channelId, { role, content, authorName, authorId }) {
  const history = memory.get(channelId) || [];
  setBoundedMap(memory, channelId, history, MAX_CHANNELS);
  history.push({ role, content, authorName, authorId });

  // Tronque si on dépasse la limite
  while (history.length > MAX_MESSAGES) {
    history.shift();
  }
}

function clearHistory(channelId) {
  memory.delete(channelId);
  const prefix = String(channelId || '') + ':';
  for (const key of actionMemory.keys()) {
    if (key.startsWith(prefix)) {
      actionMemory.delete(key);
    }
  }
}

function getActionHistory(channelId, authorId) {
  const key = buildActionKey(channelId, authorId);
  return key ? actionMemory.get(key) || [] : [];
}

function addActionMessage(channelId, authorId, { role, content, authorName }) {
  const key = buildActionKey(channelId, authorId);
  if (!key) return;
  const history = actionMemory.get(key) || [];
  setBoundedMap(actionMemory, key, history, MAX_ACTION_KEYS);
  history.push({ role, content, authorName, authorId });
  while (history.length > MAX_MESSAGES) {
    history.shift();
  }
}

function clearActionHistory(channelId, authorId) {
  const key = buildActionKey(channelId, authorId);
  if (key) actionMemory.delete(key);
}

function formatForLLM(channelId, systemPrompt) {
  const history = getHistory(channelId);
  const messages = [{ role: 'system', content: systemPrompt }];

  for (const msg of history) {
    if (msg.role === 'user') {
      // On préfixe avec le nom pour que le LLM sache qui parle
      messages.push({
        role: 'user',
        content: `${msg.authorName}: ${msg.content}`,
      });
    } else {
      messages.push({ role: 'assistant', content: msg.content });
    }
  }

  return messages;
}

function formatLinesForContextBlock(history, { excludeLast = false, maxMessages = 10, maxCharsPerMessage = 400 } = {}) {
  let slice = history;
  if (excludeLast && slice.length > 0) {
    slice = slice.slice(0, -1);
  }
  if (slice.length === 0) return '';

  const recent = slice.slice(-maxMessages);
  const lines = recent.map((msg) => {
    const raw = String(msg.content || '').replace(/\s+/g, ' ').trim();
    const snippet =
      raw.length > maxCharsPerMessage ? raw.slice(0, maxCharsPerMessage - 3) + '...' : raw;
    if (msg.role === 'user') {
      return `- ${msg.authorName || 'Utilisateur'}: ${snippet}`;
    }
    return `- Assistant: ${snippet}`;
  });

  return (
    'Contexte recent de la conversation dans ce salon (pour reference uniquement) :\n' +
    lines.join('\n')
  );
}

function formatContextBlock(
  channelId,
  { excludeLast = false, maxMessages = 10, maxCharsPerMessage = 400 } = {}
) {
  if (!channelId) return '';
  return formatLinesForContextBlock(getHistory(channelId), {
    excludeLast,
    maxMessages,
    maxCharsPerMessage,
  });
}

function formatActionContextBlock(
  channelId,
  authorId,
  { excludeLast = false, maxMessages = 10, maxCharsPerMessage = 400 } = {}
) {
  if (!channelId || !authorId) return '';
  return formatLinesForContextBlock(getActionHistory(channelId, authorId), {
    excludeLast,
    maxMessages,
    maxCharsPerMessage,
  });
}

module.exports = {
  getHistory,
  addMessage,
  clearHistory,
  getActionHistory,
  addActionMessage,
  clearActionHistory,
  formatForLLM,
  formatContextBlock,
  formatActionContextBlock,
};
