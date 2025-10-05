/**
 * Общие утилиты для расширения Page Auto Reloader
 */

// ============================================================
// SYNC STORAGE - Throttle механизм
// ============================================================

let syncThrottleTimer = null;
let hasPendingSync = false;
const SYNC_THROTTLE_INTERVAL = 60000; // 60 секунд

/**
 * Запустить throttle для синхронизации
 */
const throttledSyncToCloud = () => {
  hasPendingSync = true;

  // Если таймер уже запущен - ничего не делаем
  if (syncThrottleTimer !== null) {
    return;
  }

  // Запускаем новый таймер
  syncThrottleTimer = setTimeout(async () => {
    syncThrottleTimer = null;
    hasPendingSync = false;
    await performSync();
  }, SYNC_THROTTLE_INTERVAL);
};

/**
 * Выполнить синхронизацию (Read-Merge-Write)
 */
const performSync = async () => {
  try {
    // 1. Читаем SYNC (что уже там есть)
    const syncData = await new Promise((resolve) => {
      chrome.storage.sync.get(["timers"], (result) => {
        if (chrome.runtime.lastError) {
          console.error("SYNC read error:", chrome.runtime.lastError);
          resolve({ timers: {} });
        } else {
          resolve(result);
        }
      });
    });
    const syncTimers = syncData.timers || {};

    // 2. Читаем LOCAL (что у нас)
    const localTimers = await getTimers();

    // 3. Мерджим: добавляем/обновляем из LOCAL
    for (const [id, localTimer] of Object.entries(localTimers)) {
      const syncTimer = syncTimers[id];
      const localUpdatedAt = localTimer.updatedAt || localTimer.createdAt;

      // Если в SYNC нет, или LOCAL новее - обновляем
      if (
        !syncTimer ||
        localUpdatedAt >= (syncTimer.updatedAt || syncTimer.createdAt)
      ) {
        syncTimers[id] = {
          id: localTimer.id,
          rule: localTimer.rule,
          settings: localTimer.settings,
          createdAt: localTimer.createdAt,
          updatedAt: localUpdatedAt,
          // БЕЗ tabId и state!
        };
      }
    }

    // 4. Удаляем из SYNC то, чего нет в LOCAL (было удалено)
    for (const id of Object.keys(syncTimers)) {
      if (!localTimers[id]) {
        delete syncTimers[id];
      }
    }

    // 5. Пишем объединённую версию в SYNC
    await new Promise((resolve, reject) => {
      chrome.storage.sync.set({ timers: syncTimers }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });

    console.log("✓ Synced to cloud:", Object.keys(syncTimers).length, "timers");
  } catch (error) {
    console.error("✗ Sync failed:", error);
    // Если SYNC недоступен - продолжаем работу на LOCAL
  }
};

/**
 * Принудительная синхронизация (при закрытии браузера)
 */
export const forceSyncToCloud = async () => {
  if (syncThrottleTimer) {
    clearTimeout(syncThrottleTimer);
    syncThrottleTimer = null;
  }
  if (hasPendingSync) {
    await performSync();
    hasPendingSync = false;
  }
};

/**
 * Мердж LOCAL с SYNC при старте браузера
 */
export const mergeWithSync = async () => {
  try {
    // 1. Читаем SYNC
    const syncData = await new Promise((resolve) => {
      chrome.storage.sync.get(["timers"], (result) => {
        if (chrome.runtime.lastError) {
          console.log("Sync недоступен, работаем только с LOCAL");
          resolve({ timers: {} });
        } else {
          resolve(result);
        }
      });
    });
    const syncTimers = syncData.timers || {};

    if (Object.keys(syncTimers).length === 0) {
      return false; // Нечего мерджить
    }

    // 2. Читаем LOCAL
    const localTimers = await getTimers();
    let hasChanges = false;

    // 3. Мерджим: добавляем из SYNC то, чего нет или что новее
    for (const [id, syncTimer] of Object.entries(syncTimers)) {
      const localTimer = localTimers[id];

      if (!localTimer) {
        // Новый таймер из другого устройства
        localTimers[id] = {
          ...syncTimer,
          tabId: null, // Будет назначен при открытии вкладки
          state: {
            nextReloadAt:
              Date.now() + syncTimer.settings.intervalSeconds * 1000,
            currentActualInterval: syncTimer.settings.intervalSeconds,
          },
        };
        hasChanges = true;
        console.log("✓ Restored from sync:", syncTimer.rule.value);
      } else {
        // Таймер существует - проверяем timestamp
        const localUpdatedAt = localTimer.updatedAt || localTimer.createdAt;
        const syncUpdatedAt = syncTimer.updatedAt || syncTimer.createdAt;

        if (syncUpdatedAt > localUpdatedAt) {
          // SYNC новее - обновляем настройки
          localTimers[id].rule = syncTimer.rule;
          localTimers[id].settings = syncTimer.settings;
          localTimers[id].updatedAt = syncUpdatedAt;
          hasChanges = true;
          console.log("✓ Updated from sync:", syncTimer.rule.value);
        }
      }
    }

    // 4. Сохраняем обновлённый LOCAL (БЕЗ throttle - это старт)
    if (hasChanges) {
      await new Promise((resolve) => {
        chrome.storage.local.set({ [TIMERS_KEY]: localTimers }, resolve);
      });
      return true;
    }

    return false;
  } catch (error) {
    console.error("Merge failed:", error);
    return false;
  }
};

// ============================================================
// УТИЛИТЫ
// ============================================================

/**
 * Извлечь домен из URL
 * @param {string} url - URL для обработки
 * @returns {string|null} - Домен или null
 */
export const getDomainFromUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return null;
  }
};

/**
 * Форматирование времени для отображения
 * @param {number} totalSeconds - Общее количество секунд
 * @returns {string} - Отформатированная строка времени
 */
export const formatTime = (totalSeconds) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
};

/**
 * Генерация UUID v4
 * @returns {string} - UUID строка
 */
export const generateUUID = () => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * Определяет единственный активный таймер для заданного URL, разрешая конфликты.
 * Приоритет: доменное правило > URL-правило.
 * @param {object} allTimers - Объект всех таймеров из storage
 * @param {string} currentUrl - Текущий URL страницы
 * @returns {object|null} - Объект активного таймера или null
 */
export const findActiveTimerForUrl = (allTimers, currentUrl) => {
  const matchingTimers = [];
  const currentDomain = getDomainFromUrl(currentUrl);

  for (const timerId in allTimers) {
    const timer = allTimers[timerId];

    if (timer.rule.type === "url" && timer.rule.value === currentUrl) {
      matchingTimers.push(timer);
    } else if (
      timer.rule.type === "domain" &&
      timer.rule.value === currentDomain
    ) {
      matchingTimers.push(timer);
    }
  }

  if (matchingTimers.length === 0) return null;
  if (matchingTimers.length === 1) return matchingTimers[0];

  // Разрешение конфликта
  // 1. Доменный таймер всегда имеет приоритет
  const domainTimer = matchingTimers.find((t) => t.rule.type === "domain");
  if (domainTimer) return domainTimer;

  // 2. Если доменного нет, но есть несколько URL-правил,
  // берем самый новый (по createdAt)
  return matchingTimers.sort((a, b) => b.createdAt - a.createdAt)[0];
};

/**
 * Storage утилиты для работы с таймерами
 */

const TIMERS_KEY = "timers";

/**
 * Получить все таймеры из storage
 * @returns {Promise<object>} - Объект с таймерами
 */
export const getTimers = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get([TIMERS_KEY], (result) => {
      resolve(result[TIMERS_KEY] || {});
    });
  });
};

/**
 * Сохранить все таймеры в storage
 * @param {object} timers - Объект с таймерами
 * @returns {Promise<void>}
 */
export const setTimers = (timers) => {
  return new Promise((resolve) => {
    if (Object.keys(timers).length === 0) {
      chrome.storage.local.remove(TIMERS_KEY, () => {
        throttledSyncToCloud(); // Запускаем throttle
        resolve();
      });
      return;
    }
    chrome.storage.local.set({ [TIMERS_KEY]: timers }, () => {
      throttledSyncToCloud(); // Запускаем throttle
      resolve();
    });
  });
};

/**
 * Добавить новый таймер
 * @param {object} timer - Объект таймера
 * @returns {Promise<void>}
 */
export const addTimer = async (timer) => {
  const timers = await getTimers();
  timer.updatedAt = Date.now(); // Добавляем timestamp
  timers[timer.id] = timer;
  await setTimers(timers);
};

/**
 * Удалить таймер по ID
 * @param {string} timerId - ID таймера
 * @returns {Promise<void>}
 */
export const removeTimer = async (timerId) => {
  const timers = await getTimers();
  delete timers[timerId];
  await setTimers(timers);
};

/**
 * Обновить таймер
 * @param {string} timerId - ID таймера
 * @param {object} updates - Объект с обновлениями
 * @returns {Promise<void>}
 */
export const updateTimer = async (timerId, updates) => {
  const timers = await getTimers();
  if (timers[timerId]) {
    // Для обновления state НЕ меняем updatedAt (state не синхронизируется)
    const isStateOnlyUpdate =
      Object.keys(updates).length === 1 && updates.state;

    if (!isStateOnlyUpdate) {
      updates.updatedAt = Date.now(); // Только для настроек
    }

    timers[timerId] = { ...timers[timerId], ...updates };
    await setTimers(timers);
  }
};

/**
 * Миграция данных из старого формата в новый
 * @returns {Promise<boolean>} - true если миграция выполнена
 */
export const migrateOldData = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["autoReloadTabs", "orphanedTimers"],
      async (result) => {
        const oldAutoReload = result.autoReloadTabs || {};
        const oldOrphaned = result.orphanedTimers || {};

        // Если нет старых данных, миграция не нужна
        if (
          Object.keys(oldAutoReload).length === 0 &&
          Object.keys(oldOrphaned).length === 0
        ) {
          resolve(false);
          return;
        }

        const newTimers = {};

        // Мигрируем активные таймеры
        for (const [tabId, entry] of Object.entries(oldAutoReload)) {
          const timerId = generateUUID();
          const ruleType = entry.applyToDomain ? "domain" : "url";
          const ruleValue = entry.applyToDomain
            ? getDomainFromUrl(entry.url)
            : entry.url;

          newTimers[timerId] = {
            id: timerId,
            tabId: parseInt(tabId),
            createdAt: Date.now(),
            rule: {
              type: ruleType,
              value: ruleValue,
            },
            settings: {
              intervalSeconds: entry.intervalSeconds || 60,
              randomness: entry.randomness || {
                enabled: false,
                variationPercent: 0,
                useNormalDistribution: false,
              },
            },
            state: {
              nextReloadAt:
                entry.nextReloadAt ||
                Date.now() + (entry.intervalSeconds || 60) * 1000,
              currentActualInterval:
                entry.currentActualInterval || entry.intervalSeconds || 60,
            },
          };
        }

        // Мигрируем осиротевшие таймеры (без tabId, просто сохраняем правила)
        for (const [key, entry] of Object.entries(oldOrphaned)) {
          const timerId = generateUUID();
          const isUrl = key.startsWith("http");
          const ruleType = isUrl ? "url" : "domain";

          newTimers[timerId] = {
            id: timerId,
            tabId: null, // Нет активной вкладки
            createdAt: entry.savedAt || Date.now(),
            rule: {
              type: ruleType,
              value: key,
            },
            settings: {
              intervalSeconds: entry.intervalSeconds || 60,
              randomness: entry.randomness || {
                enabled: false,
                variationPercent: 0,
                useNormalDistribution: false,
              },
            },
            state: {
              nextReloadAt:
                entry.nextReloadAt ||
                Date.now() + (entry.intervalSeconds || 60) * 1000,
              currentActualInterval:
                entry.currentActualInterval || entry.intervalSeconds || 60,
            },
          };
        }

        // Сохраняем новые таймеры
        await setTimers(newTimers);

        // Удаляем старые ключи
        chrome.storage.local.remove(
          ["autoReloadTabs", "orphanedTimers"],
          () => {
            resolve(true);
          }
        );
      }
    );
  });
};
