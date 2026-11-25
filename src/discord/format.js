const {
  COLORS,
  buildV2Card,
  buildV2Message,
} = require('./ui-v2');

const SAFE_ALLOWED_MENTIONS = {
  parse: ['users'],
  repliedUser: true,
};

const NOTICE_STYLES = {
  primary: { color: COLORS.PRIMARY, emoji: '🦊' },
  success: { color: COLORS.SUCCESS, emoji: '✅' },
  warning: { color: COLORS.WARNING, emoji: '⚠️' },
  error: { color: COLORS.DANGER, emoji: '❌' },
  danger: { color: COLORS.DANGER, emoji: '❌' },
  info: { color: COLORS.INFO, emoji: 'ℹ️' },
  accent: { color: COLORS.ACCENT, emoji: '✨' },
  neutral: { color: COLORS.NEUTRAL, emoji: '📋' },
};

function buildActionPrefix(toolName, toolArgs) {
  if (!toolName) return '';
  let detail = '';
  if (toolArgs && typeof toolArgs === 'object') {
    if (
      toolName === 'set_channel_permissions' &&
      (toolArgs.target_type === 'category' || (!toolArgs.channel && toolArgs.category))
    ) {
      detail = ' -> categorie "' + (toolArgs.channel || toolArgs.category) + '"';
    } else if (toolArgs.name) detail = ' -> ' + toolArgs.name;
    else if (toolArgs.query) detail = ' -> "' + toolArgs.query + '"';
    else if (toolArgs.channel) detail = ' -> #' + toolArgs.channel;
    else if (toolArgs.role) detail = ' -> @' + toolArgs.role;
    else if (toolArgs.user) detail = ' -> @' + toolArgs.user;
  }
  return '-# Action : ' + toolName + detail + '\n';
}

function formatActionPill(toolName, toolArgs) {
  if (!toolName) return '';
  let detail = '';
  if (toolArgs && typeof toolArgs === 'object') {
    if (
      toolName === 'set_channel_permissions' &&
      (toolArgs.target_type === 'category' || (!toolArgs.channel && toolArgs.category))
    ) {
      detail = ' → categorie "' + (toolArgs.channel || toolArgs.category) + '"';
    } else if (toolArgs.name) detail = ' → **' + toolArgs.name + '**';
    else if (toolArgs.query) detail = ' → `"' + toolArgs.query + '"`';
    else if (toolArgs.channel) detail = ' → **#' + toolArgs.channel + '**';
    else if (toolArgs.role) detail = ' → **@' + toolArgs.role + '**';
    else if (toolArgs.user) detail = ' → **@' + toolArgs.user + '**';
  }
  return '🛠️ **Outil** : `' + toolName + '`' + detail;
}

function buildFallbackNotice(stats) {
  if (stats && stats.source === 'local_fallback') {
    const reason = stats.fallbackReason || 'API indisponible';
    if (stats.fallbackProvider) {
      return (
        '\n-# Réponse via le modèle local (API ' +
        stats.fallbackProvider +
        ' : ' +
        reason +
        ')'
      );
    }
    return '\n-# Réponse via le modèle local (' + reason + ')';
  }
  return '';
}

function composeDiscordReply(prefix, content, notice, maxLength = 2000) {
  const p = String(prefix || '');
  const c = String(content || '');
  const n = String(notice || '');
  if (p.length + c.length + n.length <= maxLength) {
    return p + c + n;
  }
  const available = maxLength - p.length - n.length;
  if (available <= 0) {
    return (p + n).slice(0, maxLength);
  }
  const truncated =
    available > 3 ? c.slice(0, available - 3) + '...' : c.slice(0, available);
  return p + truncated + n;
}

function formatSourceLabelForDebug(stats) {
  if (stats?.source === 'api') {
    return 'API (' + (stats.provider || 'externe') + ')';
  }
  if (stats?.source === 'local_fallback') {
    return (
      'IA locale (bascule depuis ' +
      stats.fallbackProvider +
      ' : ' +
      stats.fallbackReason +
      ')'
    );
  }
  return 'IA locale gratuite';
}

function buildDebugEmbed(reply, stats, question, usedTool = null) {
  const modelName = stats?.model ? String(stats.model).split('/').pop() : '-';
  const speedText = stats?.tokensPerSecond ? stats.tokensPerSecond.toFixed(2) + ' tok/s' : '-';
  const promptTok = stats?.promptTokens ?? '?';
  const genTok = stats?.completionTokens ?? '?';
  const telemetry = [
    `⏱️ **Temps** : \`${stats?.elapsedMs || 0} ms\`  •  ⚡ **Vitesse** : \`${speedText}\``,
    `🧮 **Tokens** : prompt \`${promptTok}\` | gen \`${genTok}\``,
    `🤖 **Modèle** : \`${modelName}\`  •  🔌 **Source** : ${formatSourceLabelForDebug(stats)}`,
  ];
  if (usedTool) {
    telemetry.push(`🛠️ **Outil** : \`${usedTool}\``);
  }

  const q = String(question || '').trim();
  const footer = q
    ? '💬 Question : ' + (q.length > 100 ? q.slice(0, 97) + '...' : q)
    : null;
  const fallbackLine = buildFallbackNotice(stats).trim();

  return buildV2Card({
    color: COLORS.ACCENT,
    title: '🧪 CIVIS — Mode Debug',
    sections: [String(reply || '—'), telemetry.join('\n')],
    footer,
    notice: fallbackLine || null,
  });
}

function buildNoticePayload({
  type = 'info',
  title,
  subtitle,
  description,
  sections = [],
  footer,
  notice,
  ephemeral = false,
  allowedMentions = SAFE_ALLOWED_MENTIONS,
} = {}) {
  const style = NOTICE_STYLES[type] || NOTICE_STYLES.info;
  let formattedTitle = title ? String(title).trim() : '';
  if (formattedTitle && !/\p{Extended_Pictographic}/u.test(formattedTitle.slice(0, 4))) {
    formattedTitle = `${style.emoji} ${formattedTitle}`;
  }

  const allSections = [];
  if (description !== undefined && description !== null && String(description).trim()) {
    allSections.push(String(description).trim());
  }
  if (Array.isArray(sections)) {
    for (const s of sections) {
      if (s) allSections.push(s);
    }
  }

  const card = buildV2Card({
    color: style.color,
    title: formattedTitle || undefined,
    subtitle,
    sections: allSections,
    footer,
    notice,
  });

  return buildV2Message(card, { ephemeral, allowedMentions });
}

function buildChatReplyPayload({
  content,
  usedTool,
  toolArgs,
  stats,
  question,
  isDebug = false,
  mode = 'chat',
  actionOk = true,
} = {}) {
  if (isDebug) {
    const card = buildDebugEmbed(content, stats, question, usedTool);
    return buildV2Message(card, { allowedMentions: SAFE_ALLOWED_MENTIONS });
  }

  let color = COLORS.PRIMARY;
  let title = '🦊 CIVIS';

  if (usedTool === 'search_app_directory') {
    color = COLORS.INFO;
    title = '🔎 CIVIS — App Directory Discord';
  } else if (mode === 'agent' && !usedTool) {
    color = COLORS.WARNING;
    title = '⚠️ CIVIS — Aucune action effectuée';
  } else if (mode === 'agent' && actionOk === false) {
    color = COLORS.DANGER;
    title = '❌ CIVIS — Échec de l\'action';
  } else if (mode === 'agent') {
    color = COLORS.SUCCESS;
    title = '✅ CIVIS — Action exécutée';
  }

  const subtitle = usedTool ? formatActionPill(usedTool, toolArgs) : null;
  const fallbackLine = buildFallbackNotice(stats).trim();

  const card = buildV2Card({
    color,
    title,
    subtitle,
    sections: [String(content || '—')],
    notice: fallbackLine || null,
  });

  return buildV2Message(card, { allowedMentions: SAFE_ALLOWED_MENTIONS });
}

module.exports = {
  COLORS,
  SAFE_ALLOWED_MENTIONS,
  buildActionPrefix,
  formatActionPill,
  buildDebugEmbed,
  buildFallbackNotice,
  composeDiscordReply,
  buildNoticePayload,
  buildChatReplyPayload,
};
