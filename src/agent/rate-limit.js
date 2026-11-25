// Anti-spam / limiteur de requetes LLM par utilisateur.
// Evite les appels concurrents et le basculement rapide gemma <-> qwen sur llama-server (--models-max 1).
const DEFAULT_COOLDOWN_MS = 4000;

function createRateLimiter({ cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const inFlight = new Set();
  const lastEndedAt = new Map();

  function acquire(userId, now = Date.now()) {
    const uid = String(userId || '').trim();
    if (!uid) return { ok: true };

    if (inFlight.has(uid)) {
      return {
        ok: false,
        reason: 'in_flight',
        message: 'Une demande est deja en cours pour toi. Attends qu elle se termine.',
      };
    }

    const last = lastEndedAt.get(uid);
    if (last !== undefined && cooldownMs > 0 && now - last < cooldownMs) {
      const remainingSec = Math.max(1, Math.ceil((cooldownMs - (now - last)) / 1000));
      return {
        ok: false,
        reason: 'cooldown',
        retryAfterSec: remainingSec,
        message: `Doucement ! Attends encore ${remainingSec}s avant de relancer CIVIS.`,
      };
    }

    inFlight.add(uid);
    return { ok: true };
  }

  function release(userId, now = Date.now()) {
    const uid = String(userId || '').trim();
    if (!uid) return;
    inFlight.delete(uid);
    lastEndedAt.set(uid, now);
  }

  function clearAll() {
    inFlight.clear();
    lastEndedAt.clear();
  }

  return { acquire, release, clearAll };
}

const defaultLimiter = createRateLimiter();

module.exports = {
  DEFAULT_COOLDOWN_MS,
  createRateLimiter,
  acquire: defaultLimiter.acquire,
  release: defaultLimiter.release,
  clearAll: defaultLimiter.clearAll,
};
