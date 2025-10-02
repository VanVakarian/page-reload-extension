const AUTO_RELOAD_KEY = "autoReloadTabs";
const ICON_ACTIVE = "icon128.png";
const ICON_INACTIVE = "icon128-gray.png";

const alarmName = (tabId) => `autoReload-${tabId}`;

const updateBadgeText = (tabId, text) => {
  chrome.action.setBadgeText({ tabId, text }, () => {
    if (chrome.runtime.lastError) {
      return;
    }
  });
};

const queryActiveTab = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError || !tabs.length) {
        resolve(null);
        return;
      }
      resolve(tabs[0]);
    });
  });

const getStoredTabs = () =>
  new Promise((resolve) => {
    chrome.storage.local.get([AUTO_RELOAD_KEY], (result) => {
      resolve(result[AUTO_RELOAD_KEY] || {});
    });
  });

const saveStoredTabs = (tabsMap) =>
  new Promise((resolve) => {
    if (Object.keys(tabsMap).length === 0) {
      chrome.storage.local.remove(AUTO_RELOAD_KEY, resolve);
      return;
    }
    chrome.storage.local.set({ [AUTO_RELOAD_KEY]: tabsMap }, resolve);
  });

const setIconForTab = (tabId, enabled) => {
  chrome.action.setIcon(
    { tabId, path: enabled ? ICON_ACTIVE : ICON_INACTIVE },
    () => {
      if (chrome.runtime.lastError) {
        return;
      }
    }
  );
};

const isUrlEligible = (url) => Boolean(url && /^https?:/i.test(url));

const loadState = async () => {
  const checkbox = document.getElementById("extensionToggle");
  const activeTab = await queryActiveTab();

  if (!activeTab || !isUrlEligible(activeTab.url)) {
    checkbox.checked = false;
    checkbox.disabled = true;
    checkbox.title = "Автообновление недоступно для этой страницы";
    return;
  }

  const tabsMap = await getStoredTabs();
  const entry = tabsMap[activeTab.id];
  const isEnabled = Boolean(entry && entry.url === activeTab.url);

  checkbox.checked = isEnabled;
  checkbox.disabled = false;
  checkbox.title = "";
  setIconForTab(activeTab.id, isEnabled);
};

const updateAutoReload = async (shouldEnable) => {
  const activeTab = await queryActiveTab();
  if (!activeTab || !isUrlEligible(activeTab.url)) {
    return false;
  }

  const tabsMap = await getStoredTabs();

  if (shouldEnable) {
    const nextReloadAt = Date.now() + 60000;
    tabsMap[activeTab.id] = {
      url: activeTab.url,
      intervalMinutes: 1,
      nextReloadAt,
    };

    await saveStoredTabs(tabsMap);
    setIconForTab(activeTab.id, true);
    updateBadgeText(activeTab.id, "60");
    chrome.alarms.create(alarmName(activeTab.id), {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
    return true;
  }

  if (tabsMap[activeTab.id]) {
    delete tabsMap[activeTab.id];
    await saveStoredTabs(tabsMap);
  }

  setIconForTab(activeTab.id, false);
  updateBadgeText(activeTab.id, "");
  chrome.alarms.clear(alarmName(activeTab.id));
  return true;
};

document
  .getElementById("extensionToggle")
  .addEventListener("change", async (event) => {
    await updateAutoReload(event.target.checked);
    await loadState();
  });

loadState();
