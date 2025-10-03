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
  if (hours > 0) parts.push(`${hours}ч`);
  if (minutes > 0) parts.push(`${minutes}м`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}с`);

  return parts.join(" ");
};

// Обновление UI статуса
const updateStatus = (remainingSeconds, totalSeconds) => {
  if (remainingSeconds === null) {
    intervalDisplay.textContent = "Интервал: не задан";
    intervalDisplay.classList.remove("active");
    remainingDisplay.textContent = "Введите интервал обновления";
    remainingDisplay.classList.remove("active", "pulse");
    return;
  }

  const formattedRemaining = formatTime(remainingSeconds);
  const formattedTotal = formatTime(totalSeconds);

  intervalDisplay.textContent = `Интервал: ${formattedTotal}`;
  intervalDisplay.classList.add("active");

  remainingDisplay.textContent = `⏱️ До обновления: ${formattedRemaining}`;
  remainingDisplay.classList.add("active", "pulse");
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
    intervalDisplay.textContent = "Интервал: не задан";
    remainingDisplay.textContent = "⚠️ Недоступно для этой страницы";
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
    intervalDisplay.textContent = "Интервал: не задан";
    remainingDisplay.textContent = "⚠️ Недоступно для этой страницы";
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
  if (input.value === "") {
    input.value = "0";
  }
  showError(false);
};

// События
hoursInput.addEventListener("input", () => validateInput(hoursInput));
minutesInput.addEventListener("input", () => validateInput(minutesInput));
secondsInput.addEventListener("input", () => validateInput(secondsInput));

startBtn.addEventListener("click", startAutoReload);
stopBtn.addEventListener("click", stopAutoReload);

// Инициализация
loadState();

// Очистка при закрытии popup
window.addEventListener("unload", () => {
  stopStatusUpdates();
});
