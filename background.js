const AUTO_RELOAD_KEY = "autoReloadTabs";
const ICON_ACTIVE = "icon128.png";
const ICON_INACTIVE = "icon128-gray.png";
const MINUTE_MS = 60000;

const alarmName = (tabId) => `autoReload-${tabId}`;

let trackedTabsCache = {};
let countdownIntervalId = null;

const getStoredTabs = () =>
  new Promise((resolve) => {
    chrome.storage.local.get([AUTO_RELOAD_KEY], (result) => {
      trackedTabsCache = result[AUTO_RELOAD_KEY] || {};
      resolve(trackedTabsCache);
    });
  });

const setStoredTabs = (tabsMap) =>
  new Promise((resolve) => {
    const entries = { ...tabsMap };
    trackedTabsCache = entries;

    if (Object.keys(entries).length === 0) {
      chrome.storage.local.remove(AUTO_RELOAD_KEY, () => {
        updateCountdownLoopState();
        resolve();
      });
      return;
    }

    chrome.storage.local.set({ [AUTO_RELOAD_KEY]: entries }, () => {
      updateCountdownLoopState();
      resolve();
    });
  });

const setIconForTab = (tabId, enabled) => {
  const numericId = Number(tabId);
  if (Number.isNaN(numericId)) {
    return;
  }

  chrome.action.setIcon(
    { tabId: numericId, path: enabled ? ICON_ACTIVE : ICON_INACTIVE },
    () => {
      if (chrome.runtime.lastError) {
        return;
      }
    }
  );
};

const updateBadgeText = (tabId, text) => {
  const numericId = Number(tabId);
  if (Number.isNaN(numericId)) {
    return;
  }

  chrome.action.setBadgeText({ tabId: numericId, text }, () => {
    if (chrome.runtime.lastError) {
      return;
    }
  });
};

const clearAlarm = (tabId) =>
  new Promise((resolve) => {
    chrome.alarms.clear(alarmName(tabId), () => resolve());
  });

const scheduleAlarm = (tabId, intervalMinutes = 1) => {
  const numericId = Number(tabId);
  if (Number.isNaN(numericId)) {
    return;
  }

  chrome.alarms.create(alarmName(numericId), {
    delayInMinutes: intervalMinutes,
    periodInMinutes: intervalMinutes,
  });
};

const getTab = (tabId) =>
  new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab);
    });
  });

const refreshBadgeText = () => {
  if (!Object.keys(trackedTabsCache).length) {
    return;
  }

  const now = Date.now();

  Object.entries(trackedTabsCache).forEach(([tabId, entry]) => {
    const intervalMinutes = entry.intervalMinutes || 1;
    const intervalMs = intervalMinutes * MINUTE_MS;
    const nextReloadAt = entry.nextReloadAt || now + intervalMs;
    const remainingMs = Math.max(0, nextReloadAt - now);
    const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));
    const text = remainingSec > 0 ? String(remainingSec) : "0";

    updateBadgeText(tabId, text);
  });
};

function updateCountdownLoopState() {
  const hasTabs = Object.keys(trackedTabsCache).length > 0;

  if (!hasTabs) {
    if (countdownIntervalId !== null) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
    return;
  }

  if (countdownIntervalId === null) {
    refreshBadgeText();
    countdownIntervalId = setInterval(refreshBadgeText, 1000);
  }
}

const disableTabReload = async (tabId) => {
  if (trackedTabsCache[tabId]) {
    delete trackedTabsCache[tabId];
    await setStoredTabs(trackedTabsCache);
  }

  await clearAlarm(tabId);
  updateBadgeText(tabId, "");
  setIconForTab(tabId, false);
};

const ensureEntryDefaults = (entry) => {
  const normalized = { ...entry };
  normalized.intervalMinutes = normalized.intervalMinutes || 1;

  const now = Date.now();
  const targetMs = normalized.intervalMinutes * MINUTE_MS;

  if (!normalized.nextReloadAt || normalized.nextReloadAt <= now) {
    normalized.nextReloadAt = now + targetMs;
  }

  return normalized;
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setIcon({ path: ICON_INACTIVE });
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const tabsMap = await getStoredTabs();
  let changed = false;

  await Promise.all(
    Object.keys(tabsMap).map(async (tabId) => {
      const numericId = Number(tabId);
      if (Number.isNaN(numericId)) {
        delete tabsMap[tabId];
        changed = true;
        return;
      }

      const tab = await getTab(numericId);
      if (!tab || tab.url !== tabsMap[tabId].url) {
        delete tabsMap[tabId];
        changed = true;
        await clearAlarm(numericId);
        setIconForTab(numericId, false);
        updateBadgeText(numericId, "");
        return;
      }

      const normalized = ensureEntryDefaults(tabsMap[tabId]);
      if (
        normalized.intervalMinutes !== tabsMap[tabId].intervalMinutes ||
        normalized.nextReloadAt !== tabsMap[tabId].nextReloadAt
      ) {
        changed = true;
      }

      tabsMap[tabId] = normalized;
      setIconForTab(numericId, true);
      scheduleAlarm(numericId, tabsMap[tabId].intervalMinutes || 1);
    })
  );

  if (changed) {
    await setStoredTabs(tabsMap);
  } else {
    trackedTabsCache = tabsMap;
    updateCountdownLoopState();
  }

  refreshBadgeText();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!trackedTabsCache[tabId]) {
    return;
  }

  await disableTabReload(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const entry = trackedTabsCache[tabId];

  if (!entry) {
    return;
  }

  if (changeInfo.url && changeInfo.url !== entry.url) {
    await disableTabReload(tabId);
    return;
  }

  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    setIconForTab(tabId, true);
    refreshBadgeText();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await getTab(tabId);

  if (!tab) {
    await disableTabReload(tabId);
    return;
  }

  const entry = trackedTabsCache[tabId];
  const isActive = Boolean(entry && entry.url === tab.url);
  setIconForTab(tabId, isActive);

  if (!isActive) {
    updateBadgeText(tabId, "");
    return;
  }

  refreshBadgeText();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("autoReload-")) {
    return;
  }

  const tabId = Number(alarm.name.replace("autoReload-", ""));
  if (Number.isNaN(tabId)) {
    return;
  }

  const entry = trackedTabsCache[tabId];
  if (!entry) {
    await clearAlarm(tabId);
    return;
  }

  const tab = await getTab(tabId);
  if (!tab || tab.url !== entry.url) {
    await disableTabReload(tabId);
    return;
  }

  entry.nextReloadAt = Date.now() + (entry.intervalMinutes || 1) * MINUTE_MS;
  await setStoredTabs(trackedTabsCache);
  refreshBadgeText();
  chrome.tabs.reload(tabId);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[AUTO_RELOAD_KEY]) {
    return;
  }

  const { oldValue } = changes[AUTO_RELOAD_KEY];
  trackedTabsCache = changes[AUTO_RELOAD_KEY].newValue || {};

  let needsPersist = false;
  const now = Date.now();

  Object.keys(trackedTabsCache).forEach((tabId) => {
    const entry = trackedTabsCache[tabId];

    if (!entry) {
      return;
    }

    if (!entry.intervalMinutes) {
      entry.intervalMinutes = 1;
      needsPersist = true;
    }

    if (!entry.nextReloadAt || entry.nextReloadAt <= now) {
      entry.nextReloadAt = now + entry.intervalMinutes * MINUTE_MS;
      needsPersist = true;
    }
  });

  if (needsPersist) {
    setStoredTabs(trackedTabsCache);
  }

  const addedTabIds = Object.keys(trackedTabsCache).filter((tabId) => {
    if (!oldValue) {
      return true;
    }
    return !oldValue[tabId];
  });

  addedTabIds.forEach((tabId) => {
    const entry = trackedTabsCache[tabId];
    if (!entry) {
      return;
    }

    scheduleAlarm(tabId, entry.intervalMinutes || 1);
    setIconForTab(tabId, true);
  });

  const removedTabIds = oldValue
    ? Object.keys(oldValue).filter((tabId) => !trackedTabsCache[tabId])
    : [];

  removedTabIds.forEach((tabId) => {
    clearAlarm(Number(tabId));
    updateBadgeText(tabId, "");
    setIconForTab(tabId, false);
  });

  updateCountdownLoopState();
  refreshBadgeText();
});
