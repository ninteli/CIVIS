const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');
const SNAPSHOT_REGEX = /^(.+?)-snapshot\.(\d{8})\.(\d+)$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateYYYYMMDD(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Date invalide pour le snapshot.');
  }
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function parseVersionString(versionStr) {
  if (typeof versionStr !== 'string' || !versionStr.trim()) {
    return {
      baseVersion: '1.0.0',
      date: null,
      build: null,
      isSnapshot: false,
    };
  }
  const clean = versionStr.trim();
  const match = clean.match(SNAPSHOT_REGEX);
  if (match) {
    return {
      baseVersion: match[1],
      date: match[2],
      build: Number.parseInt(match[3], 10),
      isSnapshot: true,
    };
  }
  return {
    baseVersion: clean,
    date: null,
    build: null,
    isSnapshot: false,
  };
}

function formatSnapshotVersion(baseVersion, dateStr, build) {
  const base = typeof baseVersion === 'string' && baseVersion.trim() ? baseVersion.trim() : '1.0.0';
  return `${base}-snapshot.${dateStr}.${build}`;
}

function formatStatusText(version) {
  const raw = typeof version === 'string' ? version.trim().replace(/^v+/i, '') : '';
  const clean = raw || '1.0.0';
  return ('v' + clean).slice(0, 128);
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeJson(value[key]);
    }
    return sorted;
  }
  return value;
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      // ignore cleanup error
    }
    throw err;
  }
}

function getGitShortCommit(rootDir) {
  if (!fs.existsSync(path.join(rootDir, '.git'))) {
    return null;
  }
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = typeof out === 'string' ? out.trim() : '';
    return trimmed || null;
  } catch (_) {
    return null;
  }
}

function isIgnoredEntryName(name) {
  return name.startsWith('.') || /\.(tmp|swp|bak)$/i.test(name);
}

function computeCodeFingerprint(rootDir = DEFAULT_ROOT_DIR) {
  const items = [];

  if (fs.existsSync(rootDir)) {
    const rootEntries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile() || isIgnoredEntryName(entry.name)) continue;
      if (
        /\.(js|cjs|mjs)$/i.test(entry.name) ||
        entry.name === 'start.sh' ||
        entry.name === 'stop.sh'
      ) {
        items.push({
          relPath: entry.name,
          buf: fs.readFileSync(path.join(rootDir, entry.name)),
        });
      }
    }
  }

  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkgStat = fs.lstatSync(pkgPath);
    if (pkgStat.isFile()) {
      const rawBuf = fs.readFileSync(pkgPath);
      let pkgBuf = rawBuf;
      try {
        const parsed = JSON.parse(rawBuf.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const clone = { ...parsed };
          delete clone.version;
          pkgBuf = Buffer.from(JSON.stringify(canonicalizeJson(clone)), 'utf8');
        }
      } catch (_) {
        pkgBuf = rawBuf;
      }
      items.push({
        relPath: 'package.json',
        buf: pkgBuf,
      });
    }
  }

  const srcDir = path.join(rootDir, 'src');
  if (fs.existsSync(srcDir) && fs.lstatSync(srcDir).isDirectory()) {
    const walk = (absDir, relPrefix) => {
      const entries = fs.readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (isIgnoredEntryName(entry.name)) continue;
        const relPosix = `${relPrefix}/${entry.name}`;
        if (relPosix === 'src/version.json') continue;
        const absPath = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          walk(absPath, relPosix);
        } else if (entry.isFile()) {
          items.push({
            relPath: relPosix,
            buf: fs.readFileSync(absPath),
          });
        }
      }
    };
    walk(srcDir, 'src');
  }

  items.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hasher = crypto.createHash('sha256');
  for (const item of items) {
    hasher.update(item.relPath, 'utf8');
    hasher.update('\0');
    hasher.update(item.buf);
    hasher.update('\0');
  }

  return {
    hash: hasher.digest('hex'),
    fileCount: items.length,
  };
}

function readPackageJson(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { pkgPath, pkg: null, pkgVersion: '1.0.0' };
  }
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const pkgVersion =
        typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '1.0.0';
      return { pkgPath, pkg: parsed, pkgVersion };
    }
  } catch (_) {
    // ignore invalid package.json
  }
  return { pkgPath, pkg: null, pkgVersion: '1.0.0' };
}

function readStoredSnapshot(rootDir) {
  const versionJsonPath = path.join(rootDir, 'src', 'version.json');
  if (!fs.existsSync(versionJsonPath)) {
    return { versionJsonPath, prev: null };
  }
  try {
    const raw = fs.readFileSync(versionJsonPath, 'utf8');
    const data = JSON.parse(raw);
    if (
      data &&
      typeof data === 'object' &&
      !Array.isArray(data) &&
      typeof data.version === 'string' &&
      data.version.trim() &&
      typeof data.hash === 'string' &&
      data.hash.trim()
    ) {
      const version = data.version.trim();
      const parsed = parseVersionString(version);
      return {
        versionJsonPath,
        prev: {
          version,
          baseVersion:
            typeof data.baseVersion === 'string' && data.baseVersion.trim()
              ? data.baseVersion.trim()
              : parsed.baseVersion,
          date: typeof data.date === 'string' && data.date.trim() ? data.date.trim() : parsed.date,
          build: Number.isInteger(data.build) ? data.build : parsed.build,
          hash: data.hash.trim(),
          gitCommit: typeof data.gitCommit === 'string' ? data.gitCommit : null,
          updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        },
      };
    }
  } catch (_) {
    // ignore invalid version.json
  }
  return { versionJsonPath, prev: null };
}

function getCurrentVersionInfo(rootDir = DEFAULT_ROOT_DIR) {
  const { prev } = readStoredSnapshot(rootDir);
  if (prev) {
    return prev;
  }
  const { pkgVersion } = readPackageJson(rootDir);
  const parsed = parseVersionString(pkgVersion);
  return {
    version: pkgVersion,
    baseVersion: parsed.baseVersion,
    date: parsed.date,
    build: parsed.build,
    hash: null,
    gitCommit: null,
    updatedAt: null,
  };
}

function getCurrentVersion(rootDir = DEFAULT_ROOT_DIR) {
  return getCurrentVersionInfo(rootDir).version;
}

function syncSnapshotVersion({
  rootDir = DEFAULT_ROOT_DIR,
  now = new Date(),
  write = true,
  includeGitCommit = true,
} = {}) {
  const dateObj = now instanceof Date ? now : new Date(now);
  const today = formatDateYYYYMMDD(dateObj);
  const { pkgPath, pkg, pkgVersion } = readPackageJson(rootDir);
  const parsedPkg = parseVersionString(pkgVersion);
  const { versionJsonPath, prev } = readStoredSnapshot(rootDir);
  const { hash: currentHash, fileCount } = computeCodeFingerprint(rootDir);

  let changed = false;
  let reason = 'unchanged';
  let baseVersion;
  let build;
  let previousVersion;

  if (!prev) {
    reason = 'initial';
    baseVersion = parsedPkg.baseVersion;
    build =
      parsedPkg.isSnapshot && parsedPkg.date === today && parsedPkg.build > 0
        ? parsedPkg.build + 1
        : 1;
    changed = true;
    previousVersion = pkgVersion;
  } else if (parsedPkg.baseVersion !== prev.baseVersion) {
    reason = 'base_version_changed';
    baseVersion = parsedPkg.baseVersion;
    build = 1;
    changed = true;
    previousVersion = prev.version;
  } else if (prev.hash !== currentHash) {
    reason = 'code_changed';
    baseVersion = prev.baseVersion;
    build =
      prev.date === today && Number.isInteger(prev.build) && prev.build > 0 ? prev.build + 1 : 1;
    changed = true;
    previousVersion = prev.version;
  } else {
    if (write && pkg && pkgVersion !== prev.version) {
      pkg.version = prev.version;
      writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
    return {
      ...prev,
      changed: false,
      reason: 'unchanged',
      previousVersion: prev.version,
      fileCount,
    };
  }

  const version = formatSnapshotVersion(baseVersion, today, build);
  const record = {
    version,
    baseVersion,
    date: today,
    build,
    hash: currentHash,
    gitCommit: includeGitCommit ? getGitShortCommit(rootDir) : null,
    updatedAt: dateObj.toISOString(),
  };

  if (write) {
    writeFileAtomic(versionJsonPath, JSON.stringify(record, null, 2) + '\n');
    if (pkg && pkg.version !== version) {
      pkg.version = version;
      writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    }
  }

  return {
    ...record,
    changed: true,
    reason,
    previousVersion,
    fileCount,
  };
}

if (require.main === module) {
  const result = syncSnapshotVersion();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.changed) {
    console.log(
      `[version] Snapshot mis a jour (${result.reason}) : ${result.previousVersion} -> v${result.version}`
    );
  } else {
    console.log(`[version] Aucune modification detectee : v${result.version}`);
  }
}

module.exports = {
  SNAPSHOT_REGEX,
  formatDateYYYYMMDD,
  parseVersionString,
  formatSnapshotVersion,
  formatStatusText,
  computeCodeFingerprint,
  getCurrentVersionInfo,
  getCurrentVersion,
  syncSnapshotVersion,
};
