/**
 * Общие утилиты для расширения Page Auto Reloader
 */

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
      chrome.storage.local.remove(TIMERS_KEY, resolve);
      return;
    }
    chrome.storage.local.set({ [TIMERS_KEY]: timers }, resolve);
  });
};

/**
 * Добавить новый таймер
 * @param {object} timer - Объект таймера
 * @returns {Promise<void>}
 */
export const addTimer = async (timer) => {
  const timers = await getTimers();
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
