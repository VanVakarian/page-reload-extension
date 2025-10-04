const AUTO_RELOAD_KEY = "autoReloadTabs";
const ICON_ACTIVE = "icon128.png";
const ICON_INACTIVE = "icon128-gray.png";

const alarmName = (tabId) => `autoReload-${tabId}`;

// DOM Elements
const hoursInput = document.getElementById("hours");
const minutesInput = document.getElementById("minutes");
const secondsInput = document.getElementById("seconds");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const intervalDisplay = document.getElementById("intervalDisplay");
const remainingDisplay = document.getElementById("remainingDisplay");
const errorMessage = document.getElementById("errorMessage");

let currentTabId = null;
let updateIntervalId = null;
let lastProgressWidth = 0; // Для отслеживания направления изменения

// Утилиты
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

// Конвертация времени в секунды
const getTimeInSeconds = () => {
  const hours = parseInt(hoursInput.value) || 0;
  const minutes = parseInt(minutesInput.value) || 0;
  const seconds = parseInt(secondsInput.value) || 0;
  return hours * 3600 + minutes * 60 + seconds;
};

// Форматирование времени для отображения
const formatTime = (totalSeconds) => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
};

// Обновление UI статуса
const updateStatus = (remainingSeconds, totalSeconds) => {
  if (remainingSeconds === null) {
    intervalDisplay.textContent = "Interval: not set";
    intervalDisplay.classList.remove("active");
    remainingDisplay.textContent = "Enter reload interval";
    remainingDisplay.classList.remove("active");
    remainingDisplay.style.setProperty("--progress-width", "0%");
    lastProgressWidth = 0; // Сбрасываем для следующего запуска
    return;
  }

  const formattedRemaining = formatTime(remainingSeconds);
  const formattedTotal = formatTime(totalSeconds);

  intervalDisplay.textContent = `Interval: ${formattedTotal}`;
  intervalDisplay.classList.add("active");

  remainingDisplay.textContent = `⏱️ Until reload: ${formattedRemaining}`;
  remainingDisplay.classList.add("active");

  // Обновляем фон блока как прогресс-бар
  const progress = (remainingSeconds / totalSeconds) * 100;
  const progressPercent = progress / 100;

  // Определяем направление изменения
  const isIncreasing = progress > lastProgressWidth;
  lastProgressWidth = progress;

  // Если увеличение - убираем transition, если уменьшение - включаем
  if (isIncreasing) {
    remainingDisplay.style.setProperty("--progress-transition", "none");
  } else {
    remainingDisplay.style.setProperty(
      "--progress-transition",
      "width 1s linear, background 1s linear"
    );
  }

  // Интерполяция цвета: зелёный (100%) → жёлтый (50%) → красный (0%)
  let color1, color2;

  if (progressPercent > 0.5) {
    // От зелёного к жёлтому (100% -> 50%)
    const t = (progressPercent - 0.5) * 2; // 0..1
    color1 = interpolateColor([16, 185, 129], [234, 179, 8], 1 - t);
    color2 = interpolateColor([5, 150, 105], [202, 138, 4], 1 - t);
  } else {
    // От жёлтого к красному (50% -> 0%)
    const t = progressPercent * 2; // 0..1
    color1 = interpolateColor([239, 68, 68], [234, 179, 8], t);
    color2 = interpolateColor([220, 38, 38], [202, 138, 4], t);
  }

  remainingDisplay.style.setProperty(
    "--progress-width",
    `${Math.max(0, progress)}%`
  );
  remainingDisplay.style.setProperty(
    "--progress-gradient",
    `linear-gradient(135deg, rgb(${color1[0]}, ${color1[1]}, ${color1[2]}) 0%, rgb(${color2[0]}, ${color2[1]}, ${color2[2]}) 100%)`
  );
};

// Функция интерполяции цвета
const interpolateColor = (color1, color2, factor) => {
  return [
    Math.round(color1[0] + (color2[0] - color1[0]) * factor),
    Math.round(color1[1] + (color2[1] - color1[1]) * factor),
    Math.round(color1[2] + (color2[2] - color1[2]) * factor),
  ];
};

// Блокировка/разблокировка полей ввода
const setInputsDisabled = (disabled) => {
  hoursInput.disabled = disabled;
  minutesInput.disabled = disabled;
  secondsInput.disabled = disabled;
};

// Показ/скрытие ошибки
const showError = (show) => {
  if (show) {
    errorMessage.classList.add("show");
  } else {
    errorMessage.classList.remove("show");
  }
};

// Обновление оставшегося времени в реальном времени
const startStatusUpdates = async () => {
  const updateRemaining = async () => {
    const tabsMap = await getStoredTabs();
    const entry = tabsMap[currentTabId];

    if (!entry) {
      stopStatusUpdates();
      updateStatus(null);
      return;
    }

    const now = Date.now();
    const remainingMs = Math.max(0, entry.nextReloadAt - now);
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    updateStatus(remainingSeconds, entry.intervalSeconds);
  };

  await updateRemaining();
  updateIntervalId = setInterval(updateRemaining, 1000);
};

const stopStatusUpdates = () => {
  if (updateIntervalId) {
    clearInterval(updateIntervalId);
    updateIntervalId = null;
  }
};

// Запуск автообновления
const startAutoReload = async () => {
  const totalSeconds = getTimeInSeconds();

  if (totalSeconds < 1) {
    showError(true);
    return;
  }

  showError(false);

  const activeTab = await queryActiveTab();
  if (!activeTab || !isUrlEligible(activeTab.url)) {
    intervalDisplay.textContent = "Interval: not set";
    remainingDisplay.textContent = "⚠️ Not available for this page";
    return;
  }

  const tabsMap = await getStoredTabs();
  const nextReloadAt = Date.now() + totalSeconds * 1000;

  tabsMap[activeTab.id] = {
    url: activeTab.url,
    intervalSeconds: totalSeconds,
    nextReloadAt,
  };

  await saveStoredTabs(tabsMap);
  setIconForTab(activeTab.id, true);

  // Устанавливаем alarm
  const delayInMinutes = totalSeconds / 60;
  chrome.alarms.create(alarmName(activeTab.id), {
    delayInMinutes,
    periodInMinutes: delayInMinutes,
  });

  // Обновляем UI
  setInputsDisabled(true);
  startBtn.disabled = true;
  stopBtn.disabled = false;

  startStatusUpdates();
};

// Остановка автообновления
const stopAutoReload = async () => {
  const activeTab = await queryActiveTab();
  if (!activeTab) return;

  const tabsMap = await getStoredTabs();
  if (tabsMap[activeTab.id]) {
    delete tabsMap[activeTab.id];
    await saveStoredTabs(tabsMap);
  }

  setIconForTab(activeTab.id, false);
  chrome.alarms.clear(alarmName(activeTab.id));

  // Обновляем UI
  setInputsDisabled(false);
  startBtn.disabled = false;
  stopBtn.disabled = true;

  stopStatusUpdates();
  updateStatus(null);
};

// Загрузка текущего состояния
const loadState = async () => {
  const activeTab = await queryActiveTab();

  if (!activeTab || !isUrlEligible(activeTab.url)) {
    intervalDisplay.textContent = "Interval: not set";
    remainingDisplay.textContent = "⚠️ Not available for this page";
    setInputsDisabled(true);
    startBtn.disabled = true;
    stopBtn.disabled = true;
    return;
  }

  currentTabId = activeTab.id;

  const tabsMap = await getStoredTabs();
  const entry = tabsMap[activeTab.id];
  const isEnabled = Boolean(entry && entry.url === activeTab.url);

  if (isEnabled) {
    // Таймер активен - показываем состояние
    const intervalSeconds = entry.intervalSeconds || 60;
    const hours = Math.floor(intervalSeconds / 3600);
    const minutes = Math.floor((intervalSeconds % 3600) / 60);
    const seconds = intervalSeconds % 60;

    hoursInput.value = hours;
    minutesInput.value = minutes;
    secondsInput.value = seconds;

    setInputsDisabled(true);
    startBtn.disabled = true;
    stopBtn.disabled = false;

    startStatusUpdates();
  } else {
    // Таймер не активен
    setInputsDisabled(false);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStatus(null);
  }

  setIconForTab(activeTab.id, isEnabled);
};

// Валидация ввода - только цифры
const validateInput = (input) => {
  input.value = input.value.replace(/[^0-9]/g, "");
  const value = parseInt(input.value);
  if (value > 999) {
    input.value = "999";
  }
  // Разрешаем пустые поля - они будут считаться как 0
  showError(false);
};

// События
// Обработчики ввода
const handleEnterKey = (event) => {
  if (event.key === "Enter" && !startBtn.disabled) {
    startAutoReload();
  }
};

hoursInput.addEventListener("input", () => validateInput(hoursInput));
minutesInput.addEventListener("input", () => validateInput(minutesInput));
secondsInput.addEventListener("input", () => validateInput(secondsInput));

hoursInput.addEventListener("keydown", handleEnterKey);
minutesInput.addEventListener("keydown", handleEnterKey);
secondsInput.addEventListener("keydown", handleEnterKey);

startBtn.addEventListener("click", startAutoReload);
stopBtn.addEventListener("click", stopAutoReload);

// Инициализация
loadState().then(() => {
  // Показываем popup после загрузки состояния
  document.body.classList.add("loaded");
});

// Очистка при закрытии popup
window.addEventListener("unload", () => {
  stopStatusUpdates();
});
