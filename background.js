const AUTO_RELOAD_KEY = "autoReloadTabs";
const ORPHANED_TIMERS_KEY = "orphanedTimers"; // Таймеры без активной вкладки
const ICON_ACTIVE = "icon128.png";
const ICON_INACTIVE = "icon128-gray.png";
const MIN_ALARM_INTERVAL = 30; // Минимальный интервал для chrome.alarms (секунды)

const alarmName = (tabId) => `autoReload-${tabId}`;

let trackedTabsCache = {};
let countdownIntervalId = null;
let timeoutIds = {}; // Хранилище timeout IDs для интервалов < 30 секунд

/**
 * Получить ключ таймера (URL или домен)
 */
const getTimerKey = (url, applyToDomain) => {
  if (applyToDomain) {
    return getDomainFromUrl(url) || url;
  }
  return url;
};

/**
 * Извлечь домен из URL
 */
const getDomainFromUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return null;
  }
};

/**
 * Проверяет, соответствует ли URL настройке (точный URL или домен)
 */
const urlMatches = (currentUrl, savedUrl, applyToDomain) => {
  if (currentUrl === savedUrl) {
    return true;
  }

  if (applyToDomain) {
    const currentDomain = getDomainFromUrl(currentUrl);
    const savedDomain = getDomainFromUrl(savedUrl);
    return currentDomain && savedDomain && currentDomain === savedDomain;
  }

  return false;
};

/**
 * Генерирует случайное число с нормальным распределением (bell curve)
 * Использует Box-Muller transform
 * @param {number} mean - Среднее значение (μ)
 * @param {number} stdDev - Стандартное отклонение (σ)
 * @returns {number} Случайное число
 */
const generateNormalRandom = (mean, stdDev) => {
  const u1 = Math.random();
  const u2 = Math.random();
  const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return z0 * stdDev + mean;
};

/**
 * Вычисляет следующий интервал с учетом настроек случайности
 * @param {object} entry - Запись о вкладке
 * @returns {number} Интервал в секундах
 */
const calculateNextInterval = (entry) => {
  const baseInterval = entry.intervalSeconds || 60;

  // Если случайность отключена, возвращаем базовый интервал
  if (!entry.randomness || !entry.randomness.enabled) {
    return baseInterval;
  }

  const variationPercent = entry.randomness.variationPercent || 0;
  const variation = baseInterval * (variationPercent / 100);

  let randomInterval;

  if (entry.randomness.useNormalDistribution) {
    // Нормальное распределение (bell curve)
    // σ = variation / 2, чтобы ~95% значений попадали в диапазон ±variation
    const sigma = variation / 2;
    randomInterval = generateNormalRandom(baseInterval, sigma);
  } else {
    // Равномерное распределение
    const minInterval = baseInterval - variation;
    const maxInterval = baseInterval + variation;
    randomInterval = minInterval + Math.random() * (maxInterval - minInterval);
  }

  // Ограничиваем диапазон (минимум 1 секунда, максимум 200% от базового)
  return Math.max(1, Math.min(baseInterval * 2, Math.round(randomInterval)));
};

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

const clearTimeout = (tabId) => {
  if (timeoutIds[tabId]) {
    globalThis.clearTimeout(timeoutIds[tabId]);
    delete timeoutIds[tabId];
  }
};

const clearReload = async (tabId) => {
  await clearAlarm(tabId);
  clearTimeout(tabId);
};

/**
 * Универсальная функция планирования перезагрузки
 * Использует chrome.alarms для >= 30s, setTimeout для < 30s
 */
const scheduleReload = async (tabId, intervalSeconds = 60) => {
  const numericId = Number(tabId);
  if (Number.isNaN(numericId)) {
    return;
  }

  // Очищаем предыдущие таймеры
  await clearReload(numericId);

  if (intervalSeconds >= MIN_ALARM_INTERVAL) {
    // Используем chrome.alarms для длинных интервалов
    const delayInMinutes = intervalSeconds / 60;
    chrome.alarms.create(alarmName(numericId), {
      delayInMinutes,
    });
  } else {
    // Используем setTimeout для коротких интервалов (< 30 секунд)
    const delayMs = intervalSeconds * 1000;
    const timeoutId = globalThis.setTimeout(async () => {
      await handleReload(numericId);
    }, delayMs);
    timeoutIds[numericId] = timeoutId;
  }
};

/**
 * Обработчик перезагрузки (общий для alarms и setTimeout)
 */
const handleReload = async (tabId) => {
  const entry = trackedTabsCache[tabId];
  if (!entry) {
    await clearReload(tabId);
    return;
  }

  const tab = await getTab(tabId);

  // Если вкладка закрыта - удаляем таймер
  if (!tab) {
    await disableTabReload(tabId);
    return;
  }

  // Проверяем, соответствует ли текущий URL
  const shouldReload = urlMatches(tab.url, entry.url, entry.applyToDomain);

  // Вычисляем следующий интервал с учетом случайности
  const nextInterval = calculateNextInterval(entry);
  entry.nextReloadAt = Date.now() + nextInterval * 1000;
  entry.currentActualInterval = nextInterval;

  await setStoredTabs(trackedTabsCache);
  refreshBadgeText();

  // Перезагружаем страницу ТОЛЬКО если URL соответствует
  if (shouldReload) {
    chrome.tabs.reload(tabId);
  }

  // Создаем НОВЫЙ таймер в ЛЮБОМ случае (таймер работает в фоне)
  await scheduleReload(tabId, nextInterval);
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

const formatBadgeText = (totalSeconds) => {
  // Если >= 60 минут, показываем часы
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    return `${hours}h`;
  }

  // Если >= 60 секунд, показываем минуты
  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}m`;
  }

  // Иначе показываем секунды (включая 0)
  return `${totalSeconds}s`;
};

const refreshBadgeText = async () => {
  if (!Object.keys(trackedTabsCache).length) {
    return;
  }

  const now = Date.now();

  for (const [tabId, entry] of Object.entries(trackedTabsCache)) {
    const tab = await getTab(Number(tabId));

    // Показываем badge только если вкладка существует и URL соответствует
    if (!tab || !urlMatches(tab.url, entry.url, entry.applyToDomain)) {
      updateBadgeText(tabId, "");
      setIconForTab(tabId, false);
      continue;
    }

    const intervalSeconds = entry.intervalSeconds || 60;
    const intervalMs = intervalSeconds * 1000;
    const nextReloadAt = entry.nextReloadAt || now + intervalMs;
    const remainingMs = Math.max(0, nextReloadAt - now);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const text = formatBadgeText(remainingSec);

    updateBadgeText(tabId, text);
    setIconForTab(tabId, true);
  }
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

  await clearReload(tabId);
  updateBadgeText(tabId, "");
  setIconForTab(tabId, false);
};

const ensureEntryDefaults = (entry) => {
  const normalized = { ...entry };
  normalized.intervalSeconds = normalized.intervalSeconds || 60;

  const now = Date.now();

  // Вычисляем следующий интервал с учетом случайности
  const nextInterval = calculateNextInterval(normalized);
  const targetMs = nextInterval * 1000;

  if (!normalized.nextReloadAt || normalized.nextReloadAt <= now) {
    normalized.nextReloadAt = now + targetMs;
    normalized.currentActualInterval = nextInterval; // Сохраняем реальный интервал
  } else {
    // Если nextReloadAt уже установлен, вычисляем currentActualInterval из него
    if (!normalized.currentActualInterval) {
      const remainingMs = normalized.nextReloadAt - now;
      normalized.currentActualInterval = Math.ceil(remainingMs / 1000);
    }
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

  // Настраиваем поведение side panel: клик на иконку открывает/закрывает панель
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
      if (
        !tab ||
        !urlMatches(tab.url, tabsMap[tabId].url, tabsMap[tabId].applyToDomain)
      ) {
        delete tabsMap[tabId];
        changed = true;
        await clearReload(numericId);
        setIconForTab(numericId, false);
        updateBadgeText(numericId, "");
        return;
      }

      const normalized = ensureEntryDefaults(tabsMap[tabId]);
      if (
        normalized.intervalSeconds !== tabsMap[tabId].intervalSeconds ||
        normalized.nextReloadAt !== tabsMap[tabId].nextReloadAt
      ) {
        changed = true;
      }

      tabsMap[tabId] = normalized;
      setIconForTab(numericId, true);

      // Используем уже вычисленный интервал из normalized
      const restoredInterval =
        normalized.currentActualInterval || normalized.intervalSeconds || 60;
      await scheduleReload(numericId, restoredInterval);
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
  const entry = trackedTabsCache[tabId];

  if (!entry) {
    return;
  }

  // Сохраняем таймер как "осиротевший" перед удалением
  const timerKey = getTimerKey(entry.url, entry.applyToDomain);

  // Загружаем текущие осиротевшие таймеры
  const orphanedTimers = await new Promise((resolve) => {
    chrome.storage.local.get([ORPHANED_TIMERS_KEY], (result) => {
      resolve(result[ORPHANED_TIMERS_KEY] || {});
    });
  });

  // Сохраняем таймер по ключу
  orphanedTimers[timerKey] = {
    ...entry,
    savedAt: Date.now(), // Когда был сохранен
  };

  await new Promise((resolve) => {
    chrome.storage.local.set(
      { [ORPHANED_TIMERS_KEY]: orphanedTimers },
      resolve
    );
  });

  // Удаляем из активных
  await disableTabReload(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const entry = trackedTabsCache[tabId];

  // При завершении загрузки проверяем, нет ли осиротевшего таймера
  if (!entry && changeInfo.status === "complete" && tab.url) {
    // Загружаем осиротевшие таймеры
    const orphanedTimers = await new Promise((resolve) => {
      chrome.storage.local.get([ORPHANED_TIMERS_KEY], (result) => {
        resolve(result[ORPHANED_TIMERS_KEY] || {});
      });
    });

    // Ищем подходящий таймер
    for (const [key, timer] of Object.entries(orphanedTimers)) {
      if (urlMatches(tab.url, timer.url, timer.applyToDomain)) {
        // Нашли! Восстанавливаем таймер
        const now = Date.now();
        const remainingMs = Math.max(0, timer.nextReloadAt - now);

        if (remainingMs > 0) {
          // Таймер еще не истек - восстанавливаем
          const remainingSec = Math.ceil(remainingMs / 1000);

          // Обновляем URL для applyToDomain режима
          if (timer.applyToDomain && tab.url !== timer.url) {
            timer.url = tab.url;
          }

          trackedTabsCache[tabId] = timer;
          await setStoredTabs(trackedTabsCache);
          await scheduleReload(tabId, remainingSec);
          setIconForTab(tabId, true);
          await refreshBadgeText();

          // Уведомляем side panel о восстановлении таймера
          chrome.runtime
            .sendMessage({
              type: "timerRestored",
              tabId: tabId,
            })
            .catch(() => {
              // Игнорируем ошибку если side panel не открыт
            });
        } else {
          // Таймер уже истек - запускаем заново
          const nextInterval = calculateNextInterval(timer);
          timer.nextReloadAt = now + nextInterval * 1000;
          timer.currentActualInterval = nextInterval;

          if (timer.applyToDomain && tab.url !== timer.url) {
            timer.url = tab.url;
          }

          trackedTabsCache[tabId] = timer;
          await setStoredTabs(trackedTabsCache);
          await scheduleReload(tabId, nextInterval);
          setIconForTab(tabId, true);
          await refreshBadgeText();

          // Уведомляем side panel о восстановлении таймера
          chrome.runtime
            .sendMessage({
              type: "timerRestored",
              tabId: tabId,
            })
            .catch(() => {
              // Игнорируем ошибку если side panel не открыт
            });
        }

        // Удаляем из осиротевших
        delete orphanedTimers[key];
        await new Promise((resolve) => {
          if (Object.keys(orphanedTimers).length === 0) {
            chrome.storage.local.remove(ORPHANED_TIMERS_KEY, resolve);
          } else {
            chrome.storage.local.set(
              { [ORPHANED_TIMERS_KEY]: orphanedTimers },
              resolve
            );
          }
        });

        return; // Нашли и восстановили
      }
    }
  }

  if (!entry) {
    return;
  }

  // Если URL изменился
  if (changeInfo.url) {
    const matches = urlMatches(changeInfo.url, entry.url, entry.applyToDomain);

    if (!matches) {
      // URL не соответствует
      if (entry.applyToDomain) {
        // Для domain mode - полностью отключаем (другой домен)
        await disableTabReload(tabId);
        return;
      } else {
        // Для URL mode - просто скрываем визуальные индикаторы
        // Таймер продолжает работать в фоне
        updateBadgeText(tabId, "");
        setIconForTab(tabId, false);
        return;
      }
    }

    // URL соответствует - обновляем entry.url для applyToDomain режима
    if (entry.applyToDomain && changeInfo.url !== entry.url) {
      entry.url = changeInfo.url;
      trackedTabsCache[tabId] = entry;
      await setStoredTabs(trackedTabsCache);
    }
  }

  // При любом изменении статуса обновляем визуальные индикаторы
  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    await refreshBadgeText();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await getTab(tabId);

  if (!tab) {
    return;
  }

  const entry = trackedTabsCache[tabId];
  if (!entry) {
    return;
  }

  // Обновляем визуальные индикаторы на основе текущего URL
  await refreshBadgeText();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("autoReload-")) {
    return;
  }

  const tabId = Number(alarm.name.replace("autoReload-", ""));
  if (Number.isNaN(tabId)) {
    return;
  }

  await handleReload(tabId);
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

    if (!entry.intervalSeconds) {
      entry.intervalSeconds = 60;
      needsPersist = true;
    }

    if (!entry.nextReloadAt || entry.nextReloadAt <= now) {
      entry.nextReloadAt = now + entry.intervalSeconds * 1000;
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

  addedTabIds.forEach(async (tabId) => {
    const entry = trackedTabsCache[tabId];
    if (!entry) {
      return;
    }

    // Вычисляем интервал с учетом случайности для первого запуска
    const firstInterval = calculateNextInterval(entry);
    await scheduleReload(tabId, firstInterval);
    setIconForTab(tabId, true);
  });

  const removedTabIds = oldValue
    ? Object.keys(oldValue).filter((tabId) => !trackedTabsCache[tabId])
    : [];

  removedTabIds.forEach(async (tabId) => {
    await clearReload(Number(tabId));
    updateBadgeText(tabId, "");
    setIconForTab(tabId, false);
  });

  updateCountdownLoopState();
  refreshBadgeText();
});

// Обработчик сообщений от popup.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "scheduleReload") {
    scheduleReload(message.tabId, message.intervalSeconds);
    sendResponse({ success: true });
  } else if (message.type === "clearReload") {
    clearReload(message.tabId);
    sendResponse({ success: true });
  }
  return true;
});
