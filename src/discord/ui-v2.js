const {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ComponentType,
  MessageFlags,
} = require('discord.js');

const COLORS = {
  PRIMARY: 0x2b9e6e,
  ACCENT: 0x5865f2,
  SUCCESS: 0x57f287,
  WARNING: 0xf0b232,
  DANGER: 0xed4245,
  INFO: 0x3498db,
  NEUTRAL: 0x99aab5,
};

const V2_FLAG = MessageFlags.IsComponentsV2;
const V2_EPHEMERAL_FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
const MAX_V2_TOTAL_CHARS = 3900;
const MAX_V2_COMPONENTS = 40;

function truncateMarkdownSafe(text, maxLen) {
  const str = String(text ?? '');
  if (!Number.isFinite(maxLen) || maxLen <= 0) return '';
  if (str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);

  let cut = str.slice(0, maxLen - 3) + '...';
  const fenceMatches = cut.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    const closing = '\n```';
    const reserve = 3 + closing.length;
    if (maxLen > reserve) {
      let body = str.slice(0, maxLen - reserve);
      const bodyFences = body.match(/```/g);
      if (bodyFences && bodyFences.length % 2 === 1) {
        cut = body + '...' + closing;
      } else {
        // Removing the partial fence put fences back to even
        cut = body + '...';
      }
    } else if (maxLen > closing.length) {
      cut = str.slice(0, maxLen - closing.length) + closing;
    }
  }
  return cut.slice(0, maxLen);
}

function formatDiscordTimestamp(ms = Date.now(), style = 'f') {
  const sec = Math.floor((Number(ms) || Date.now()) / 1000);
  return `<t:${sec}:${style}>`;
}

function normalizeSubtextLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('-# ')) return trimmed;
  return trimmed
    .split('\n')
    .map((l) => {
      const t = l.trim();
      if (!t) return '';
      return t.startsWith('-# ') ? t : '-# ' + t;
    })
    .filter(Boolean)
    .join('\n');
}

function countActionRowComponents(rows) {
  let count = 0;
  for (const row of rows) {
    if (!row) continue;
    const plain = toPlainComponent(row);
    count += 1 + (Array.isArray(plain?.components) ? plain.components.length : 0);
  }
  return count;
}

function buildV2Card({
  color,
  title,
  subtitle,
  sections = [],
  footer,
  notice,
  actionRows = [],
  spoiler = false,
  maxTotalChars = MAX_V2_TOTAL_CHARS,
} = {}) {
  const container = new ContainerBuilder();
  if (typeof color === 'number' && Number.isFinite(color)) {
    container.setAccentColor(color);
  }
  if (spoiler) {
    container.setSpoiler(true);
  }

  const blocks = [];

  const cleanTitle = title !== undefined && title !== null ? String(title).trim() : '';
  const cleanSubtitle =
    subtitle !== undefined && subtitle !== null ? String(subtitle).trim() : '';

  if (cleanTitle || cleanSubtitle) {
    const headerText = cleanTitle
      ? cleanSubtitle
        ? `### ${cleanTitle}\n${cleanSubtitle}`
        : `### ${cleanTitle}`
      : cleanSubtitle;
    blocks.push({ kind: 'header', text: headerText, dividerBefore: false });
  }

  const sectionItems = Array.isArray(sections) ? sections : [];
  let isFirstSection = true;
  for (const item of sectionItems) {
    if (!item) continue;
    let text = '';
    let divider = true;
    if (typeof item === 'string') {
      text = item.trim();
    } else if (typeof item === 'object') {
      const heading = item.heading !== undefined && item.heading !== null ? String(item.heading).trim() : '';
      const body = item.body !== undefined && item.body !== null ? String(item.body).trim() : '';
      divider = item.divider !== false;
      if (heading && body) {
        text = `**${heading}**\n${body}`;
      } else {
        text = heading || body;
      }
    }
    if (!text) continue;
    blocks.push({
      kind: 'section',
      text,
      dividerBefore: isFirstSection ? blocks.length > 0 : divider,
    });
    isFirstSection = false;
  }

  const footerParts = [];
  const cleanNotice = normalizeSubtextLine(notice);
  const cleanFooter = normalizeSubtextLine(footer);
  if (cleanNotice) footerParts.push(cleanNotice);
  if (cleanFooter) footerParts.push(cleanFooter);
  if (footerParts.length > 0) {
    blocks.push({
      kind: 'footer',
      text: footerParts.join('\n'),
      dividerBefore: blocks.length > 0,
    });
  }

  const validRows = Array.isArray(actionRows) ? actionRows.filter(Boolean) : [];

  // Si aucun bloc texte n'a ete fourni (ex: carte vide), assurer un contenu minimal valide
  if (blocks.length === 0) {
    blocks.push({ kind: 'section', text: '—', dividerBefore: false });
  }

  // Respect du budget global de caracteres (<= maxTotalChars)
  let totalChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  if (totalChars > maxTotalChars) {
    // Tronquer d'abord les sections les plus longues
    const sectionIndices = blocks
      .map((b, idx) => ({ idx, kind: b.kind, len: b.text.length }))
      .filter((x) => x.kind === 'section')
      .sort((a, b) => b.len - a.len);

    for (const item of sectionIndices) {
      if (totalChars <= maxTotalChars) break;
      const excess = totalChars - maxTotalChars;
      const currentLen = blocks[item.idx].text.length;
      const minKeep = Math.min(currentLen, 16);
      const targetLen = Math.max(minKeep, currentLen - excess);
      const truncated = truncateMarkdownSafe(blocks[item.idx].text, targetLen) || '…';
      totalChars -= currentLen - truncated.length;
      blocks[item.idx].text = truncated;
    }

    // Si ca depasse encore, reduire en-tete / footer proportionnellement
    if (totalChars > maxTotalChars) {
      for (let i = 0; i < blocks.length && totalChars > maxTotalChars; i += 1) {
        const currentLen = blocks[i].text.length;
        if (currentLen <= 10) continue;
        const excess = totalChars - maxTotalChars;
        const targetLen = Math.max(10, currentLen - excess);
        const truncated = truncateMarkdownSafe(blocks[i].text, targetLen) || '…';
        totalChars -= currentLen - truncated.length;
        blocks[i].text = truncated;
      }
    }
  }

  // Respect du plafond de 40 composants (container = 1)
  const rowComponentCount = countActionRowComponents(validRows);
  const availableForTextAndSep = MAX_V2_COMPONENTS - 1 - rowComponentCount;
  const maxSeparators = Math.max(0, availableForTextAndSep - blocks.length);
  let usedSeparators = 0;

  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (i > 0 && b.dividerBefore && usedSeparators < maxSeparators) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
      );
      usedSeparators += 1;
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(b.text));
  }

  const hasFooterBlock = blocks.some((b) => b.kind === 'footer');
  if (validRows.length > 0 && !hasFooterBlock && blocks.length > 0 && usedSeparators < maxSeparators) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
    );
  }

  for (const row of validRows) {
    container.addActionRowComponents(row);
  }

  return container;
}

function buildV2Message(
  containers,
  { ephemeral = false, allowedMentions, withComponents = false } = {}
) {
  const list = (Array.isArray(containers) ? containers : [containers]).filter(Boolean);
  const payload = {
    flags: ephemeral ? V2_EPHEMERAL_FLAGS : V2_FLAG,
    components: list,
  };
  if (allowedMentions !== undefined) {
    payload.allowedMentions = allowedMentions;
  }
  if (withComponents) {
    payload.withComponents = true;
  }
  return payload;
}

function toPlainComponent(comp) {
  if (!comp) return null;
  if (typeof comp.toJSON === 'function') {
    return comp.toJSON();
  }
  if (comp.data && typeof comp.data === 'object') {
    return comp.data;
  }
  return comp;
}

function walkComponentTree(node, visitor) {
  const plain = toPlainComponent(node);
  if (!plain || typeof plain !== 'object') return;
  visitor(plain);
  if (Array.isArray(plain.components)) {
    for (const child of plain.components) {
      walkComponentTree(child, visitor);
    }
  }
  if (plain.accessory) {
    walkComponentTree(plain.accessory, visitor);
  }
}

function getRootsFromPayloadOrComponent(payloadOrContainer) {
  if (!payloadOrContainer) return [];
  if (Array.isArray(payloadOrContainer)) return payloadOrContainer;
  if (Array.isArray(payloadOrContainer.components) && payloadOrContainer.type === undefined) {
    return payloadOrContainer.components;
  }
  return [payloadOrContainer];
}

function estimateV2Metrics(payloadOrContainer) {
  let totalChars = 0;
  let totalComponents = 0;
  for (const root of getRootsFromPayloadOrComponent(payloadOrContainer)) {
    walkComponentTree(root, (node) => {
      totalComponents += 1;
      if (node.type === ComponentType.TextDisplay && typeof node.content === 'string') {
        totalChars += node.content.length;
      }
    });
  }
  return { totalChars, totalComponents };
}

function extractV2Text(payloadOrContainer) {
  const parts = [];
  for (const root of getRootsFromPayloadOrComponent(payloadOrContainer)) {
    walkComponentTree(root, (node) => {
      if (node.type === ComponentType.TextDisplay && typeof node.content === 'string') {
        parts.push(node.content);
      }
    });
  }
  return parts.join('\n');
}

function extractV2Buttons(payloadOrContainer) {
  const buttons = [];
  for (const root of getRootsFromPayloadOrComponent(payloadOrContainer)) {
    walkComponentTree(root, (node) => {
      if (node.type === ComponentType.Button) {
        buttons.push(node);
      }
    });
  }
  return buttons;
}

module.exports = {
  COLORS,
  V2_FLAG,
  V2_EPHEMERAL_FLAGS,
  MAX_V2_TOTAL_CHARS,
  MAX_V2_COMPONENTS,
  truncateMarkdownSafe,
  formatDiscordTimestamp,
  buildV2Card,
  buildV2Message,
  toPlainComponent,
  estimateV2Metrics,
  extractV2Text,
  extractV2Buttons,
};
