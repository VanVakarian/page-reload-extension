import {
  findActiveTimerForUrl,
  forceSyncToCloud,
  getTimers,
  mergeWithSync,
  migrateOldData,
  updateTimer,
} from "./shared/utils.js";

const ICON_ACTIVE = "icon128.png";
const ICON_INACTIVE = "icon128-gray.png";
const MIN_ALARM_INTERVAL = 30; // Минимальный интервал для chrome.alarms (секунды)

const alarmName = (timerId) => `autoReload-${timerId}`;

let timersCache = {};
let countdownIntervalId = null;
let timeoutIds = {}; // Хранилище timeout IDs для интервалов < 30 секунд

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
 */
const calculateNextInterval = (settings) => {
  const baseInterval = settings.intervalSeconds || 60;

  // Если случайность отключена, возвращаем базовый интервал
  if (!settings.randomness || !settings.randomness.enabled) {
    return baseInterval;
  }

  const variationPercent = settings.randomness.variationPercent || 0;
  const variation = baseInterval * (variationPercent / 100);

  let randomInterval;

  if (settings.randomness.useNormalDistribution) {
    // Нормальное распределение (bell curve)
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

const clearAlarm = (timerId) =>
  new Promise((resolve) => {
    chrome.alarms.clear(alarmName(timerId), () => resolve());
  });

const clearTimeout = (timerId) => {
  if (timeoutIds[timerId]) {
    globalThis.clearTimeout(timeoutIds[timerId]);
    delete timeoutIds[timerId];
  }
};

const clearReload = async (timerId) => {
  await clearAlarm(timerId);
  clearTimeout(timerId);
};

/**
 * Универсальная функция планирования перезагрузки
 * Использует chrome.alarms для >= 30s, setTimeout для < 30s
 */
const scheduleReload = async (timerId, intervalSeconds = 60) => {
  // Очищаем предыдущие таймеры
  await clearReload(timerId);

  if (intervalSeconds >= MIN_ALARM_INTERVAL) {
    // Используем chrome.alarms для длинных интервалов
    const delayInMinutes = intervalSeconds / 60;
    chrome.alarms.create(alarmName(timerId), {
      delayInMinutes,
    });
  } else {
    // Используем setTimeout для коротких интервалов (< 30 секунд)
    const delayMs = intervalSeconds * 1000;
    const timeoutId = globalThis.setTimeout(async () => {
      await handleReload(timerId);
    }, delayMs);
    timeoutIds[timerId] = timeoutId;
  }
};

/**
 * Обработчик перезагрузки (общий для alarms и setTimeout)
 */
const handleReload = async (timerId) => {
  const allTimers = await getTimers();
  const timer = allTimers[timerId];

  if (!timer) {
    await clearReload(timerId);
    return;
  }

  // Если нет tabId, таймер не может выполнять перезагрузку
  if (!timer.tabId) {
    await clearReload(timerId);
    return;
  }

  const tab = await getTab(timer.tabId);

  // Если вкладка закрыта - только очищаем alarm, но НЕ удаляем таймер
  if (!tab) {
    await clearReload(timerId);
    return;
  }

  // КЛЮЧЕВАЯ ПРОВЕРКА: проверяем, является ли этот таймер "главным" для текущего URL
  const activeTimer = findActiveTimerForUrl(allTimers, tab.url);

  if (!activeTimer || activeTimer.id !== timerId) {
    // Этот таймер устарел (есть более приоритетный) - не перезагружаем
    await clearReload(timerId);
    return;
  }

  // Вычисляем следующий интервал с учетом случайности
  const nextInterval = calculateNextInterval(timer.settings);
  timer.state.nextReloadAt = Date.now() + nextInterval * 1000;
  timer.state.currentActualInterval = nextInterval;

  // Обновляем таймер в storage
  await updateTimer(timerId, { state: timer.state });

  // Обновляем кэш
  timersCache = await getTimers();
  refreshBadgeText();

  // Перезагружаем страницу
  chrome.tabs.reload(timer.tabId);

  // Создаем НОВЫЙ таймер
  await scheduleReload(timerId, nextInterval);
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
  if (Object.keys(timersCache).length === 0) {
    return;
  }

  // 1. Собираем все уникальные tabId из всех таймеров
  const tabIds = new Set();
  for (const timer of Object.values(timersCache)) {
    if (timer.tabId) {
      tabIds.add(timer.tabId);
    }
  }

  const now = Date.now();

  // 2. Для каждой вкладки устанавливаем badge ОДИН РАЗ
  for (const tabId of tabIds) {
    const tab = await getTab(tabId);

    if (!tab) {
      updateBadgeText(tabId, "");
      setIconForTab(tabId, false);
      continue;
    }

    // Находим активный таймер для URL этой вкладки
    const activeTimer = findActiveTimerForUrl(timersCache, tab.url);

    if (!activeTimer || activeTimer.tabId !== tabId) {
      // Нет активного таймера для этой вкладки
      updateBadgeText(tabId, "");
      setIconForTab(tabId, false);
      continue;
    }

    // Вычисляем оставшееся время для активного таймера
    const intervalSeconds = activeTimer.settings.intervalSeconds || 60;
    const intervalMs = intervalSeconds * 1000;
    const nextReloadAt = activeTimer.state?.nextReloadAt || now + intervalMs;
    const remainingMs = Math.max(0, nextReloadAt - now);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const text = formatBadgeText(remainingSec);

    updateBadgeText(tabId, text);
    setIconForTab(tabId, true);
  }
};

function updateCountdownLoopState() {
  const hasTimers = Object.keys(timersCache).length > 0;

  if (!hasTimers) {
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

chrome.runtime.onInstalled.addListener(async () => {
  chrome.action.setIcon({ path: ICON_INACTIVE });
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }

  // Настраиваем поведение side panel
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Выполняем миграцию данных при первой установке/обновлении
  const migrated = await migrateOldData();
  if (migrated) {
    console.log("Данные успешно мигрированы в новый формат");
  }

  // Мердж с SYNC (на случай установки на новом устройстве)
  const merged = await mergeWithSync();
  if (merged) {
    console.log("Таймеры восстановлены из sync");
  }

  // Перезагружаем кэш
  timersCache = await getTimers();
});

chrome.runtime.onStartup.addListener(async () => {
  // Сначала мерджим с SYNC (подтягиваем изменения с других устройств)
  await mergeWithSync();

  // Потом читаем LOCAL (основное хранилище с учётом мерджа)
  timersCache = await getTimers();

  for (const [timerId, timer] of Object.entries(timersCache)) {
    // Если нет tabId, пропускаем
    if (!timer.tabId) continue;

    const tab = await getTab(timer.tabId);

    if (!tab) {
      // Вкладка не существует - ничего не делаем, таймер остается в storage
      continue;
    }

    // Проверяем, является ли этот таймер активным для URL вкладки
    const activeTimer = findActiveTimerForUrl(timersCache, tab.url);

    if (!activeTimer || activeTimer.id !== timerId) {
      // Этот таймер не активен для данной вкладки
      continue;
    }

    // Вычисляем оставшееся время
    const now = Date.now();
    const nextReloadAt = timer.state?.nextReloadAt || now;
    const remainingMs = Math.max(0, nextReloadAt - now);
    const remainingSec = Math.ceil(remainingMs / 1000);

    if (remainingSec > 0) {
      // Перепланируем alarm с оставшимся временем
      await scheduleReload(timerId, remainingSec);
      setIconForTab(timer.tabId, true);
    } else {
      // Время истекло - запускаем немедленно
      await handleReload(timerId);
    }
  }

  updateCountdownLoopState();
  refreshBadgeText();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Находим все таймеры с этим tabId
  const allTimers = await getTimers();

  for (const [timerId, timer] of Object.entries(allTimers)) {
    if (timer.tabId === tabId) {
      // Отменяем физический alarm/timeout
      await clearReload(timerId);
      // НЕ удаляем таймер из storage
    }
  }

  timersCache = await getTimers();
  updateCountdownLoopState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Обновляем badge только при завершении загрузки
  if (changeInfo.status === "complete" && tab.url) {
    const allTimers = await getTimers();
    const activeTimer = findActiveTimerForUrl(allTimers, tab.url);

    if (activeTimer && activeTimer.tabId === tabId) {
      setIconForTab(tabId, true);
    } else {
      setIconForTab(tabId, false);
      updateBadgeText(tabId, "");
    }

    await refreshBadgeText();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await getTab(tabId);
  if (!tab) return;

  // Обновляем визуальные индикаторы
  await refreshBadgeText();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("autoReload-")) {
    return;
  }

  const timerId = alarm.name.replace("autoReload-", "");
  await handleReload(timerId);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.timers) {
    return;
  }

  timersCache = changes.timers.newValue || {};
  updateCountdownLoopState();
  refreshBadgeText();
});

// Обработчик сообщений от sidepanel.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "scheduleReload") {
    scheduleReload(message.timerId, message.intervalSeconds).then(() => {
      sendResponse({ success: true });
    });
  } else if (message.type === "clearReload") {
    clearReload(message.timerId).then(() => {
      sendResponse({ success: true });
    });
  } else if (message.type === "resumeExpiredTimer") {
    // Возобновляем истекший таймер
    handleReload(message.timerId).then(() => {
      sendResponse({ success: true });
    });
  }
  return true; // Асинхронный ответ
});

// Принудительная синхронизация при закрытии браузера
chrome.runtime.onSuspend.addListener(async () => {
  console.log("Browser closing, forcing sync...");
  await forceSyncToCloud();
});
