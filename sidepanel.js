const AUTO_RELOAD_KEY = "autoReloadTabs";
const URL_SETTINGS_KEY = "urlSettings"; // Последние настройки для каждого URL
const ICON_ACTIVE = "icon128.png";
const ICON_INACTIVE = "icon128-gray.png";

const alarmName = (tabId) => `autoReload-${tabId}`;

// DOM Elements
const hoursInput = document.getElementById("hours");
const minutesInput = document.getElementById("minutes");
const secondsInput = document.getElementById("seconds");
const timeSlider = document.getElementById("timeSlider");
const sliderValueDisplay = document.getElementById("sliderValueDisplay");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const intervalDisplay = document.getElementById("intervalDisplay");
const remainingDisplay = document.getElementById("remainingDisplay");
const errorMessage = document.getElementById("errorMessage");
const randomnessCheckbox = document.getElementById("randomnessCheckbox");
const randomnessControls = document.getElementById("randomnessControls");
const variationSlider = document.getElementById("variationSlider");
const variationValue = document.getElementById("variationValue");
const uniformRange = document.getElementById("uniformRange");
const uniformRangeText = document.getElementById("uniformRangeText");
const normalDistCheckbox = document.getElementById("normalDistCheckbox");
const normalDistInfo = document.getElementById("normalDistInfo");
const range68 = document.getElementById("range68");
const range95 = document.getElementById("range95");
const applyToDomainCheckbox = document.getElementById("applyToDomainCheckbox");
const domainHint = document.getElementById("domainHint");

// Константы для экспоненциальной функции
const EXP_K = 0.1; // Коэффициент экспоненты
const EXP_SCALE = 3.9227; // Масштабирующий коэффициент

// Экспоненциальная функция для преобразования позиции ползунка в секунды
// Формула: seconds = (e^(k*position) - 1) * scale + 1
// Диапазон: position 0-100 → seconds 1-86400 (~24 часа)
const positionToSeconds = (position) => {
  return Math.round((Math.exp(EXP_K * position) - 1) * EXP_SCALE + 1);
};

// Обратная функция: из секунд в позицию ползунка
// Формула: position = ln((seconds - 1) / scale + 1) / k
const secondsToPosition = (seconds) => {
  return Math.log((seconds - 1) / EXP_SCALE + 1) / EXP_K;
};

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

// Получить настройки для конкретного URL или домена
const getUrlSettings = async (url, checkDomain = true) => {
  return new Promise((resolve) => {
    chrome.storage.local.get([URL_SETTINGS_KEY], (result) => {
      const allSettings = result[URL_SETTINGS_KEY] || {};

      // Сначала проверяем точный URL
      if (allSettings[url]) {
        resolve(allSettings[url]);
        return;
      }

      // Если не найдено и разрешена проверка домена, проверяем домен
      if (checkDomain) {
        const domain = getDomainFromUrl(url);
        if (domain && allSettings[domain]) {
          resolve(allSettings[domain]);
          return;
        }
      }

      resolve(null);
    });
  });
};

// Сохранить настройки для конкретного URL или домена
const saveUrlSettings = async (url, settings) => {
  return new Promise((resolve) => {
    chrome.storage.local.get([URL_SETTINGS_KEY], (result) => {
      const allSettings = result[URL_SETTINGS_KEY] || {};
      const key = getSettingsKey(url, settings.applyToDomain);
      allSettings[key] = settings;
      chrome.storage.local.set({ [URL_SETTINGS_KEY]: allSettings }, resolve);
    });
  });
};

// Собрать текущие настройки из UI
const getCurrentSettings = () => {
  const totalSeconds = getTimeInSeconds();
  return {
    intervalSeconds: totalSeconds,
    applyToDomain: applyToDomainCheckbox.checked,
    randomness: {
      enabled: randomnessCheckbox.checked,
      variationPercent: randomnessCheckbox.checked
        ? parseInt(variationSlider.value)
        : 15,
      useNormalDistribution:
        randomnessCheckbox.checked && normalDistCheckbox.checked,
    },
  };
};

// Сохранить текущие настройки для текущего URL
const saveCurrentUrlSettings = async () => {
  const activeTab = await queryActiveTab();
  if (!activeTab || !isUrlEligible(activeTab.url)) return;

  const settings = getCurrentSettings();
  await saveUrlSettings(activeTab.url, settings);
};

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

// Извлечь домен из URL
const getDomainFromUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return null;
  }
};

// Получить ключ для сохранения настроек (URL или домен)
const getSettingsKey = (url, useDomain = false) => {
  if (useDomain) {
    return getDomainFromUrl(url) || url;
  }
  return url;
};

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

// Форматирование для отображения на ползунке (более компактное)
const formatSliderValue = (totalSeconds) => {
  if (totalSeconds < 60) {
    return `${totalSeconds} sec`;
  } else if (totalSeconds < 3600) {
    const minutes = Math.round(totalSeconds / 60);
    return `${minutes} min`;
  } else {
    const hours = (totalSeconds / 3600).toFixed(1);
    // Убираем .0 если число целое
    return `${hours.replace(".0", "")} hours`;
  }
};

// Обновление отображения значения ползунка
const updateSliderDisplay = (position) => {
  const seconds = positionToSeconds(position);
  sliderValueDisplay.textContent = formatSliderValue(seconds);
};

// Применение значения из ползунка к полям ввода
const applySliderValueToInputs = (position) => {
  const totalSeconds = positionToSeconds(position);

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  hoursInput.value = hours || "";
  minutesInput.value = minutes || "";
  secondsInput.value = seconds || "";

  showError(false);
};

// Синхронизация ползунка с полями ввода
const syncSliderWithInputs = () => {
  const totalSeconds = getTimeInSeconds();
  if (totalSeconds > 0) {
    const position = secondsToPosition(totalSeconds);
    timeSlider.value = Math.min(100, Math.max(0, position));
    // Показываем реальное значение, даже если ползунок упёрся в максимум
    sliderValueDisplay.textContent = formatSliderValue(totalSeconds);
  }
};

// Обновление UI статуса
const updateStatus = (remainingSeconds, totalSeconds) => {
  if (remainingSeconds === null) {
    intervalDisplay.textContent = "Interval is not set";
    intervalDisplay.classList.remove("active");
    document.querySelector(".reload-status").textContent =
      "Enter reload interval";
    remainingDisplay.classList.remove("active");
    remainingDisplay.style.setProperty("--progress-width", "0%");
    lastProgressWidth = 0; // Сбрасываем для следующего запуска
    return;
  }

  const formattedRemaining = formatTime(remainingSeconds);
  const formattedTotal = formatTime(totalSeconds);

  intervalDisplay.textContent = `Interval is set to ${formattedTotal}`;
  intervalDisplay.classList.add("active");

  document.querySelector(
    ".reload-status"
  ).textContent = `⏱️ Until reload: ${formattedRemaining}`;
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
  timeSlider.disabled = disabled;
  applyToDomainCheckbox.disabled = disabled;
  randomnessCheckbox.disabled = disabled;
  variationSlider.disabled = disabled;
  normalDistCheckbox.disabled = disabled;
};

// Показ/скрытие ошибки
const showError = (show) => {
  if (show) {
    errorMessage.classList.add("show");
  } else {
    errorMessage.classList.remove("show");
  }
};

// Обновление отображения диапазонов случайности
const updateRandomnessRanges = () => {
  const totalSeconds = getTimeInSeconds();
  const variationPercent = parseInt(variationSlider.value);

  if (totalSeconds < 1) {
    uniformRangeText.textContent = "—";
    range68.textContent = "—";
    range95.textContent = "—";
    return;
  }

  const variation = totalSeconds * (variationPercent / 100);
  const minSeconds = Math.max(1, Math.round(totalSeconds - variation));
  const maxSeconds = Math.round(totalSeconds + variation);

  // Uniform range
  uniformRangeText.textContent = `${formatTime(minSeconds)} - ${formatTime(
    maxSeconds
  )}`;

  // Normal distribution ranges (σ = variation / 2, so ±2σ ≈ ±variation)
  const sigma = variation / 2;

  // 68% range (±1σ)
  const min68 = Math.max(1, Math.round(totalSeconds - sigma));
  const max68 = Math.round(totalSeconds + sigma);
  range68.textContent = `${formatTime(min68)} - ${formatTime(max68)}`;

  // 95% range (±2σ)
  const min95 = Math.max(1, Math.round(totalSeconds - 2 * sigma));
  const max95 = Math.round(totalSeconds + 2 * sigma);
  range95.textContent = `${formatTime(min95)} - ${formatTime(max95)}`;
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

    // Используем реальный интервал для прогресс-бара
    const actualInterval =
      entry.currentActualInterval || entry.intervalSeconds || 60;
    updateStatus(remainingSeconds, actualInterval);
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
    intervalDisplay.textContent = "Interval is not set";
    document.querySelector(".reload-status").textContent =
      "⚠️ Not available for this page";
    return;
  }

  const tabsMap = await getStoredTabs();

  const randomnessConfig = {
    enabled: randomnessCheckbox.checked,
    variationPercent: randomnessCheckbox.checked
      ? parseInt(variationSlider.value)
      : 0,
    useNormalDistribution:
      randomnessCheckbox.checked && normalDistCheckbox.checked,
  };

  // Вычисляем первый интервал с учетом случайности
  let firstInterval = totalSeconds;
  if (randomnessConfig.enabled) {
    const variation = totalSeconds * (randomnessConfig.variationPercent / 100);

    if (randomnessConfig.useNormalDistribution) {
      // Нормальное распределение
      const sigma = variation / 2;
      const u1 = Math.random();
      const u2 = Math.random();
      const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      firstInterval = z0 * sigma + totalSeconds;
    } else {
      // Равномерное распределение
      const minInterval = totalSeconds - variation;
      const maxInterval = totalSeconds + variation;
      firstInterval = minInterval + Math.random() * (maxInterval - minInterval);
    }

    // Ограничиваем диапазон
    firstInterval = Math.max(
      1,
      Math.min(totalSeconds * 2, Math.round(firstInterval))
    );
  }

  const nextReloadAt = Date.now() + firstInterval * 1000;

  tabsMap[activeTab.id] = {
    url: activeTab.url,
    intervalSeconds: totalSeconds,
    nextReloadAt,
    randomness: randomnessConfig,
    applyToDomain: applyToDomainCheckbox.checked,
    currentActualInterval: firstInterval, // Реальный интервал для текущего цикла
  };

  await saveStoredTabs(tabsMap);
  setIconForTab(activeTab.id, true);

  // Отправляем сообщение в background.js для создания таймера
  // Background.js сам решит использовать alarm или setTimeout
  chrome.runtime.sendMessage({
    type: "scheduleReload",
    tabId: activeTab.id,
    intervalSeconds: firstInterval,
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

  // Отправляем сообщение в background.js для очистки таймеров
  chrome.runtime.sendMessage({
    type: "clearReload",
    tabId: activeTab.id,
  });

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
    intervalDisplay.textContent = "Interval is not set";
    document.querySelector(".reload-status").textContent =
      "⚠️ Not available for this page";
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

    // Синхронизируем ползунок
    const position = secondsToPosition(intervalSeconds);
    timeSlider.value = Math.min(100, Math.max(0, position));
    updateSliderDisplay(parseFloat(timeSlider.value));

    // Загружаем настройки случайности
    if (entry.randomness && entry.randomness.enabled) {
      randomnessCheckbox.checked = true;
      randomnessControls.classList.remove("hidden");
      variationSlider.value = entry.randomness.variationPercent || 15;
      variationValue.textContent = `±${variationSlider.value}%`;

      if (entry.randomness.useNormalDistribution) {
        normalDistCheckbox.checked = true;
        normalDistInfo.classList.remove("hidden");
        uniformRange.style.display = "none";
      } else {
        normalDistCheckbox.checked = false;
        normalDistInfo.classList.add("hidden");
        uniformRange.style.display = "block";
      }

      updateRandomnessRanges();
    } else {
      randomnessCheckbox.checked = false;
      randomnessControls.classList.add("hidden");
    }

    // Загружаем настройку домена
    applyToDomainCheckbox.checked = entry.applyToDomain || false;
    updateDomainHint();

    setInputsDisabled(true);
    startBtn.disabled = true;
    stopBtn.disabled = false;

    startStatusUpdates();
  } else {
    // Таймер не активен - загружаем последние настройки для этого URL
    const savedSettings = await getUrlSettings(activeTab.url);

    if (savedSettings && savedSettings.intervalSeconds) {
      // Восстанавливаем сохраненные настройки
      const intervalSeconds = savedSettings.intervalSeconds;
      const hours = Math.floor(intervalSeconds / 3600);
      const minutes = Math.floor((intervalSeconds % 3600) / 60);
      const seconds = intervalSeconds % 60;

      hoursInput.value = hours || "";
      minutesInput.value = minutes || "";
      secondsInput.value = seconds || "";

      // Синхронизируем ползунок
      const position = secondsToPosition(intervalSeconds);
      timeSlider.value = Math.min(100, Math.max(0, position));
      updateSliderDisplay(parseFloat(timeSlider.value));

      // Восстанавливаем настройки случайности
      if (savedSettings.randomness && savedSettings.randomness.enabled) {
        randomnessCheckbox.checked = true;
        randomnessControls.classList.remove("hidden");
        variationSlider.value = savedSettings.randomness.variationPercent || 15;
        variationValue.textContent = `±${variationSlider.value}%`;

        if (savedSettings.randomness.useNormalDistribution) {
          normalDistCheckbox.checked = true;
          normalDistInfo.classList.remove("hidden");
          uniformRange.style.display = "none";
        } else {
          normalDistCheckbox.checked = false;
          normalDistInfo.classList.add("hidden");
          uniformRange.style.display = "block";
        }

        updateRandomnessRanges();
      } else {
        randomnessCheckbox.checked = false;
        randomnessControls.classList.add("hidden");
        normalDistCheckbox.checked = false;
        normalDistInfo.classList.add("hidden");
        uniformRange.style.display = "block";
      }

      // Восстанавливаем настройку домена
      applyToDomainCheckbox.checked = savedSettings.applyToDomain || false;
    } else {
      // Нет сохраненных настроек - устанавливаем значения по умолчанию
      // По умолчанию: 5 минут
      const defaultSeconds = 300; // 5 минут
      const hours = Math.floor(defaultSeconds / 3600);
      const minutes = Math.floor((defaultSeconds % 3600) / 60);
      const seconds = defaultSeconds % 60;

      hoursInput.value = hours || "";
      minutesInput.value = minutes || "";
      secondsInput.value = seconds || "";

      // Синхронизируем ползунок с дефолтным значением
      const position = secondsToPosition(defaultSeconds);
      timeSlider.value = Math.min(100, Math.max(0, position));
      updateSliderDisplay(parseFloat(timeSlider.value));

      randomnessCheckbox.checked = false;
      randomnessControls.classList.add("hidden");
      normalDistCheckbox.checked = false;
      normalDistInfo.classList.add("hidden");
      uniformRange.style.display = "block";
      applyToDomainCheckbox.checked = false;
    }

    updateDomainHint();
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
  syncSliderWithInputs();
  updateRandomnessRanges();

  // Сохраняем настройки при изменении
  saveCurrentUrlSettings();
};

// События
// Обработчики ввода
const handleEnterKey = (event) => {
  if (event.key === "Enter" && !startBtn.disabled) {
    startAutoReload();
  }
};

// Обработчик ползунка
timeSlider.addEventListener("input", () => {
  const position = parseFloat(timeSlider.value);
  updateSliderDisplay(position);
  applySliderValueToInputs(position);
  updateRandomnessRanges();
  saveCurrentUrlSettings();
});

// Обновление подсказки домена
const updateDomainHint = async () => {
  const activeTab = await queryActiveTab();
  if (activeTab && isUrlEligible(activeTab.url)) {
    const domain = getDomainFromUrl(activeTab.url);
    if (applyToDomainCheckbox.checked && domain) {
      domainHint.textContent = `Will reload all pages on ${domain}`;
    } else {
      domainHint.textContent = "";
    }
  }
};

// Обработчик чекбокса применения к домену
applyToDomainCheckbox.addEventListener("change", () => {
  updateDomainHint();
  saveCurrentUrlSettings();
});

// Обработчик чекбокса случайности
randomnessCheckbox.addEventListener("change", () => {
  if (randomnessCheckbox.checked) {
    randomnessControls.classList.remove("hidden");
    updateRandomnessRanges();
  } else {
    randomnessControls.classList.add("hidden");
    normalDistCheckbox.checked = false;
    normalDistInfo.classList.add("hidden");
    uniformRange.style.display = "block";
  }
  saveCurrentUrlSettings();
});

// Обработчик слайдера вариации
variationSlider.addEventListener("input", () => {
  const value = variationSlider.value;
  variationValue.textContent = `±${value}%`;
  updateRandomnessRanges();
  saveCurrentUrlSettings();
});

// Обработчик чекбокса нормального распределения
normalDistCheckbox.addEventListener("change", () => {
  if (normalDistCheckbox.checked) {
    normalDistInfo.classList.remove("hidden");
    uniformRange.style.display = "none";
  } else {
    normalDistInfo.classList.add("hidden");
    uniformRange.style.display = "block";
  }
  saveCurrentUrlSettings();
});

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

// Отслеживание переключения вкладок
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // Останавливаем обновления для предыдущей вкладки
  stopStatusUpdates();

  // Загружаем состояние для новой активной вкладки
  await loadState();
});

// Отслеживание обновления вкладок (например, изменение URL)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Проверяем, это текущая активная вкладка и изменился URL или статус
  const activeTab = await queryActiveTab();
  if (
    activeTab &&
    activeTab.id === tabId &&
    (changeInfo.url || changeInfo.status === "complete")
  ) {
    // Перезагружаем состояние для текущей вкладки
    stopStatusUpdates();
    await loadState();
  }
});

// Очистка при закрытии popup
window.addEventListener("unload", () => {
  stopStatusUpdates();
});

// Слушаем сообщения от background.js о восстановлении таймера
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "timerRestored") {
    // Таймер был восстановлен - перезагружаем состояние
    queryActiveTab().then((activeTab) => {
      if (activeTab && activeTab.id === message.tabId) {
        stopStatusUpdates();
        loadState();
      }
    });
  }
});
