// Mode debug activé/désactivé par salon
const debugChannels = new Set();

function isEnabled(channelId) {
  return debugChannels.has(channelId);
}

function enable(channelId) {
  debugChannels.add(channelId);
}

function disable(channelId) {
  debugChannels.delete(channelId);
}

function toggle(channelId) {
  if (debugChannels.has(channelId)) {
    debugChannels.delete(channelId);
    return false;
  }
  debugChannels.add(channelId);
  return true;
}

module.exports = { isEnabled, enable, disable, toggle };
