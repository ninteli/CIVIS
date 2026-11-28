const { ChannelType, ChannelFlags, ChannelFlagsBitField } = require('discord.js');

const MANAGED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildForum,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
];

const TEXT_FEATURE_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
];

function normalizeKey(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function isManagedChannelType(type) {
  return MANAGED_CHANNEL_TYPES.includes(type);
}

function supportsTextProperties(type) {
  return TEXT_FEATURE_CHANNEL_TYPES.includes(type);
}

function isVoiceLikeChannelType(type) {
  return type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;
}

const CHANNEL_TYPE_DEFINITIONS = [
  {
    type: ChannelType.GuildText,
    key: 'text',
    label: 'texte',
    aliases: ['text', 'texte', 'textuel', 'guildtext'],
  },
  {
    type: ChannelType.GuildForum,
    key: 'forum',
    label: 'forum',
    aliases: ['forum', 'guildforum'],
  },
  {
    type: ChannelType.GuildAnnouncement,
    key: 'announcement',
    label: 'annonce',
    aliases: ['announcement', 'annonce', 'annonces', 'news', 'guildannouncement', 'guildnews'],
  },
  {
    type: ChannelType.GuildVoice,
    key: 'voice',
    label: 'voix',
    aliases: ['voice', 'voix', 'vocal', 'vocale', 'guildvoice'],
  },
  {
    type: ChannelType.GuildStageVoice,
    key: 'stage',
    label: 'conference',
    aliases: ['stage', 'conference', 'stage_voice', 'stagevoice', 'guildstagevoice'],
  },
];

function resolveChannelTypeInput(rawType) {
  if (rawType === undefined || rawType === null || String(rawType).trim() === '') {
    return {
      ok: true,
      type: ChannelType.GuildText,
      key: 'text',
      label: 'texte',
    };
  }

  const normalized = normalizeKey(rawType);
  for (const def of CHANNEL_TYPE_DEFINITIONS) {
    if (def.aliases.includes(normalized)) {
      return {
        ok: true,
        type: def.type,
        key: def.key,
        label: def.label,
      };
    }
  }

  return {
    ok: false,
    error:
      'Type de salon invalide : "' +
      rawType +
      '". Types autorises : texte, forum, annonce, voix, conference.',
  };
}

function getChannelTypeLabel(channelType) {
  for (const def of CHANNEL_TYPE_DEFINITIONS) {
    if (def.type === channelType) return def.label;
  }
  if (channelType === ChannelType.GuildCategory) return 'categorie';
  return 'autre';
}

function isSpoilerChannel(channel) {
  const flags = channel?.flags;
  if (flags === undefined || flags === null) return false;
  if (typeof flags.has === 'function') {
    return flags.has(ChannelFlags.IsSpoilerChannel);
  }
  try {
    return new ChannelFlagsBitField(flags).has(ChannelFlags.IsSpoilerChannel);
  } catch {
    return false;
  }
}

function parseOptionalBoolean(val) {
  if (typeof val === 'boolean') return val;
  if (val === undefined || val === null) return undefined;
  const norm = normalizeKey(val);
  if (norm === 'true' || norm === 'oui') return true;
  if (norm === 'false' || norm === 'non') return false;
  return undefined;
}

function parseCooldownArg(args) {
  if (!args || typeof args !== 'object') return undefined;
  const raw = args.slowmode !== undefined ? args.slowmode : args.cooldown;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return undefined;
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) return undefined;
  return Math.min(parsed, 21600);
}

function extractSnowflakeId(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('<') !== s.endsWith('>')) return null;
  const match = /^(?:<#|<@&)?(\d{17,22})>?$/.exec(s);
  return match ? match[1] : null;
}

module.exports = {
  MANAGED_CHANNEL_TYPES,
  TEXT_FEATURE_CHANNEL_TYPES,
  normalizeKey,
  extractSnowflakeId,
  isManagedChannelType,
  supportsTextProperties,
  isVoiceLikeChannelType,
  resolveChannelTypeInput,
  getChannelTypeLabel,
  isSpoilerChannel,
  parseOptionalBoolean,
  parseCooldownArg,
};
