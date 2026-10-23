/*
 * Force Max Quality — background service worker.
 * Owns settings (chrome.storage.sync) and per-tab diagnostics (session storage).
 */

const DEFAULTS = {
  enabled: true,
  strategy: 'max',
  capMbps: 8,
  avoidHdr: false,
  pin: null,
  debug: false
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  await chrome.storage.sync.set({ ...DEFAULTS, ...stored });
});

async function getConfig() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

const tabQueues = new Map();

/**
 * Serializes read-modify-write cycles per tab. Without this, a `media` event
 * arriving while a `master` event is being written can overwrite the master
 * (both read the same snapshot), which is exactly the "the quality list shows
 * up only sometimes" symptom.
 */
function withTabLock(tabId, task) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  tabQueues.set(tabId, tail);
  tail.then(() => {
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  });
  return run;
}

function statsKey(tabId) {
  return `stats:${tabId}`;
}

async function readStats(tabId) {
  const key = statsKey(tabId);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function writeStats(tabId, stats) {
  await chrome.storage.session.set({ [statsKey(tabId)]: stats });
}

async function clearStatsNow(tabId) {
  try {
    await chrome.storage.session.remove(statsKey(tabId));
  } catch (_) {}
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (_) {}
}

function clearStats(tabId) {
  return withTabLock(tabId, () => clearStatsNow(tabId));
}

function setHqBadge(tabId) {
  try {
    chrome.action.setBadgeText({ tabId, text: 'HQ' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#0090ff' });
  } catch (_) {}
}

async function handleEvent(tabId, event) {
  if (!event || !event.type) return;

  const stats = (await readStats(tabId)) || {
    tabId,
    updatedAt: 0,
    master: null,
    media: null,
    frameworks: null
  };

  stats.updatedAt = Date.now();

  if (event.type === 'master') {
    stats.master = event.payload || null;
    setHqBadge(tabId);
  } else if (event.type === 'media') {
    stats.media = event.payload || null;
  } else if (event.type === 'frameworks') {
    stats.frameworks = event.payload || null;
  } else if (event.type === 'worker') {
    stats.worker = event.payload || null;
  } else if (event.type === 'log') {
    stats.lastLog = event.payload || null;
  }

  await writeStats(tabId, stats);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.__f1hq !== true) return;

  if (message.type === 'event') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) {
      sendResponse({ ok: false });
      return;
    }
    withTabLock(tabId, () => handleEvent(tabId, message.event))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'getConfig') {
    getConfig().then(sendResponse);
    return true;
  }

  if (message.type === 'setConfig') {
    chrome.storage.sync
      .set(message.patch || {})
      .then(getConfig)
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'getStats') {
    const tabId = message.tabId;
    if (tabId == null) {
      sendResponse(null);
      return;
    }
    withTabLock(tabId, () => readStats(tabId))
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearStats(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') clearStats(tabId);
});
