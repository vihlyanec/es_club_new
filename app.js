const config = {
  // URLы твоих вебхуков
  personalOfferUrl: "https://example.com/api/personal-offer",
  paymentUrl: "https://vihlyanec-n8n.ru/webhook/es_club/payment",
  promoCheckUrl: "https://vihlyanec-n8n.ru/webhook/es_club/promocode",
};

/**
 * Получаем tg_id и email из query-параметров Telegram Web App.
 * Пример: https://.../index.html?tg_id=123&email=test%40mail.com
 */
function getUserContext() {
  const params = new URLSearchParams(window.location.search);
  const tgId = params.get("tg_id") || null;
  const email = params.get("email") || null;

  return { tgId, email };
}

const state = {
  user: getUserContext(),
  tariff: null, // { id, months }
  amount: null,
  currency: "RUB",
  personalOffer: null,
  promoLoading: false,
  promoResult: null, // { status: true|false, discount_percent: number }
};

// DOM
const screenTariffs = document.getElementById("screen-tariffs");
const screenPayment = document.getElementById("screen-payment");
const backToTariffs = document.getElementById("back-to-tariffs");
const promoInput = document.getElementById("promo-input");
const promoMessage = document.getElementById("promo-message");
const promoThrobber = document.getElementById("promo-throbber");
const promoSubmitBtn = document.getElementById("promo-submit");
const payButton = document.getElementById("pay-button");
const summaryTariffTitle = document.getElementById("summary-tariff-title");
const summaryTariffMonths = document.getElementById("summary-tariff-months");
const summaryAmountWrap = document.getElementById("summary-amount-wrap");
const summaryAmountOld = document.getElementById("summary-amount-old");
const summaryAmount = document.getElementById("summary-amount");
const summaryAmountCaption = document.getElementById("summary-amount-caption");

// Утилиты
function setScreen(name) {
  if (name === "tariffs") {
    screenTariffs.classList.add("screen--active");
    screenPayment.classList.remove("screen--active");
  } else if (name === "payment") {
    screenPayment.classList.add("screen--active");
    screenTariffs.classList.remove("screen--active");
  }
}

function formatMonthsLabel(months) {
  if (months === 1) return "1 месяц";
  if (months === 3) return "3 месяца";
  return `${months} мес.`;
}

function formatAmount(amount, currency) {
  if (typeof amount !== "number") return "—";
  const formatter = new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: currency || "RUB",
    maximumFractionDigits: 0,
  });
  return formatter.format(amount);
}

async function callWebhook(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`webhook error: ${res.status}`);
  }

  return res.json();
}

// Логика тарифов
function getTariffMeta(tariffId) {
  if (tariffId === "guest") {
    return {
      title: "GUEST",
      basePrice: {
        1: 8490,
        3: 22890,
      },
    };
  }

  if (tariffId === "regular") {
    return {
      title: "REGULAR",
      basePrice: {
        1: 12490,
        3: 33690,
      },
    };
  }

  return {
    title: "LOCAL",
    basePrice: {
      1: 25490,
      3: 68790,
    },
  };
}

/** Базовая сумма до применения промокода (персональный оффер или цена из тарифа). */
function getBaseAmount() {
  if (!state.tariff) return null;
  const { id, months } = state.tariff;
  const meta = getTariffMeta(id);
  if (state.personalOffer && typeof state.personalOffer.amount === "number") {
    return state.personalOffer.amount;
  }
  return meta.basePrice[months] ?? meta.basePrice[1];
}

function getTariffReferenceAmount(tariffId, months) {
  if (months !== 3) return null;
  const meta = getTariffMeta(tariffId);
  const monthlyAmount = meta.basePrice[1];
  if (typeof monthlyAmount !== "number") return null;
  return monthlyAmount * 3;
}

function updatePaymentSummary() {
  if (!state.tariff) return;

  const { id, months } = state.tariff;
  const meta = getTariffMeta(id);

  summaryTariffTitle.textContent = meta.title;
  summaryTariffMonths.textContent = formatMonthsLabel(months);

  const baseAmount = getBaseAmount();
  let displayAmount = baseAmount;
  let showOldPrice = false;
  let oldAmount = null;
  const tariffReferenceAmount = getTariffReferenceAmount(id, months);

  if (state.promoResult && state.promoResult.status === true && state.promoResult.discount_percent != null) {
    const percent = state.promoResult.discount_percent;
    const newAmount = Math.round(baseAmount * (1 - percent / 100));
    state.amount = newAmount;
    displayAmount = newAmount;
    oldAmount = tariffReferenceAmount ?? baseAmount;
    showOldPrice = oldAmount > displayAmount;
  } else if (!state.promoResult || state.promoResult.status !== true) {
    state.amount = baseAmount;
    oldAmount = tariffReferenceAmount;
    showOldPrice = typeof oldAmount === "number" && oldAmount > displayAmount;
  }

  summaryAmountOld.hidden = !showOldPrice;
  if (showOldPrice && oldAmount != null) {
    summaryAmountOld.textContent = formatAmount(oldAmount, state.currency);
  }
  if (summaryAmountCaption) {
    summaryAmountCaption.hidden = !showOldPrice;
  }
  summaryAmount.textContent = formatAmount(displayAmount, state.currency);
}

// Обработка выбора тарифа
async function handleTariffSelect(tariffId, months) {
  state.tariff = { id: tariffId, months };
  state.personalOffer = null;
  state.amount = null;
  state.promoResult = null;
  state.promoLoading = false;
  promoInput.value = "";
  promoMessage.hidden = true;
  promoMessage.textContent = "";
  promoMessage.className = "promo-message";
  if (promoThrobber) promoThrobber.hidden = true;

  // 1. Проверяем персональные предложения
  try {
    const payload = {
      tg_id: state.user.tgId,
      email: state.user.email,
      tariff_id: tariffId,
      months,
    };

    const data = await callWebhook(config.personalOfferUrl, payload);

    // Ожидаемый формат ответа можешь подстроить под свой бекенд.
    // Ниже пример:
    //
    // {
    //   "has_offer": true,
    //   "amount": 5900,
    //   "currency": "RUB",
    //   "message": "у тебя персональная скидка 15%"
    // }

    if (data && data.has_offer) {
      state.personalOffer = data;
      state.amount = typeof data.amount === "number" ? data.amount : null;
      state.currency = data.currency || "RUB";

      setScreen("payment");
      updatePaymentSummary();

      if (data.message) {
        promoMessage.hidden = false;
        promoMessage.textContent = data.message;
        promoMessage.classList.add("promo-message--success");
      }
    } else {
      // персональных офферов нет – просто переходим на экран подтверждения
      setScreen("payment");
      updatePaymentSummary();
    }
  } catch (error) {
    console.error(error);
    // В случае ошибки всё равно покажем экран оплаты с базовой ценой
    setScreen("payment");
    updatePaymentSummary();
  }
}

async function handlePay() {
  if (!state.tariff) return;

  const { id, months } = state.tariff;
  const meta = getTariffMeta(id);

  let amount = state.amount;
  if (typeof amount !== "number") {
    amount = meta.basePrice[months] ?? meta.basePrice[1];
  }

  const promoCode = promoInput.value.trim() || null;

  payButton.disabled = true;
  payButton.textContent = "переходим к оплате...";

  const payload = {
    tg_id: state.user.tgId,
    email: state.user.email,
    tariff_id: id,
    months,
    amount,
    currency: state.currency,
    promo_code: promoCode,
    // Явно передаём статус промокода и размер скидки
    promo_applied:
      !!state.promoResult && state.promoResult.status === true,
    promo_status:
      state.promoResult && state.promoResult.status === true
        ? "applied"
        : state.promoResult && state.promoResult.status === false
        ? "rejected"
        : "not_checked",
    promo_discount_percent:
      state.promoResult && typeof state.promoResult.discount_percent === "number"
        ? state.promoResult.discount_percent
        : 0,
    meta: {
      source: "telegram_web_app",
      user_agent: navigator.userAgent,
    },
  };

  const url = config.paymentUrl;
  const body = JSON.stringify(payload);

  // 1) Отправка БЕЗ preflight: используем text/plain (это "simple request")
  // n8n получит body строкой, но это ок — дальше JSON.parse() при необходимости.
  let sent = false;

  try {
    if (navigator.sendBeacon) {
      sent = navigator.sendBeacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }));
    }
  } catch (e) {}

  // Фоллбек: fetch без чтения ответа, keepalive + no-cors, чтобы браузер не блокировал
  if (!sent) {
    try {
      fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch (e) {}
  }

  // 2) Очень короткая пауза, чтобы WebView успел поставить запрос в сеть
  await new Promise((r) => setTimeout(r, 150));

  // 3) Закрываем Mini App
  const tg = window.Telegram?.WebApp;
  if (tg?.close) {
    try { tg.close(); } catch (e) {}
    setTimeout(() => { try { tg.close(); } catch (e) {} }, 200);
    return;
  }

  try { window.close(); } catch (e) {}
}

async function checkPromoCode(code) {
  if (!code || !state.tariff) return;

  state.promoLoading = true;
  promoThrobber.hidden = false;
  if (promoSubmitBtn) promoSubmitBtn.disabled = true;
  promoMessage.hidden = true;
  promoMessage.textContent = "";
  promoMessage.className = "promo-message";

  try {
    const payload = {
      tg_id: state.user.tgId,
      email: state.user.email,
      tariff_id: state.tariff.id,
      months: state.tariff.months,
      promo_code: code,
    };

    // Отправляем тело как JSON, чтобы бэкенд сразу получал объект.
    // Важно: на вебхуке должны быть корректно настроены CORS/OPTIONS.
    const res = await fetch(config.promoCheckUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      // если не удалось распарсить JSON, оставим data = null
      console.error("promo json parse error", e);
    }

    // Ожидаемый ответ бэкенда: { status: true|false, discount_percent: number, message?: string }
    const status =
      data && (data.status === true || data.status === "true");
    const discount =
      data && typeof data.discount_percent === "number"
        ? data.discount_percent
        : 0;

    if (res.ok && status && discount > 0) {
      state.promoResult = {
        status: true,
        discount_percent: discount,
      };
      promoMessage.hidden = false;
      promoMessage.textContent = `скидка ${state.promoResult.discount_percent}% применена`;
      promoMessage.classList.add("promo-message--success");
    } else {
      // Любой ответ сервера (включая 4xx) трактуем как "промокод не применён",
      // но если пришло понятное сообщение, покажем его.
      state.promoResult = null;
      promoMessage.hidden = false;
      promoMessage.textContent =
        data && typeof data.message === "string" && data.message.trim()
          ? data.message.trim()
          : "промокод недействителен или истёк";
      promoMessage.classList.add("promo-message--error");
    }
  } catch (error) {
    console.error("promo request error", error);
    // Только при реальной сетевой ошибке/краше показываем общее сообщение "попробуй позже".
    state.promoResult = null;
    promoMessage.hidden = false;
    promoMessage.textContent = "не удалось проверить промокод. попробуй позже.";
    promoMessage.classList.remove("promo-message--success");
    promoMessage.classList.add("promo-message--error");
  } finally {
    state.promoLoading = false;
    promoThrobber.hidden = true;
    if (promoSubmitBtn) promoSubmitBtn.disabled = false;
  }

  updatePaymentSummary();
}

function onPromoInput() {
  const code = promoInput.value.trim();

  if (!code) {
    state.promoResult = null;
    promoMessage.hidden = true;
    promoMessage.textContent = "";
    promoMessage.className = "promo-message";
    updatePaymentSummary();
    return;
  }
}

// Навешиваем обработчики
function initEvents() {
  document.querySelectorAll(".js-select-tariff").forEach((btn) => {
    btn.addEventListener("click", () => {
      const months = Number(btn.dataset.months || "1");
      const card = btn.closest(".tariff-card");
      const tariffId = card?.dataset.tariffId || "guest";
      handleTariffSelect(tariffId, months);
    });
  });

  backToTariffs.addEventListener("click", () => {
    setScreen("tariffs");
  });

  payButton.addEventListener("click", () => {
    handlePay();
  });

  promoInput.addEventListener("input", onPromoInput);

  if (promoSubmitBtn) {
    promoSubmitBtn.addEventListener("click", () => {
      const code = promoInput.value.trim();
      if (!code || state.promoLoading) return;
      checkPromoCode(code);
    });
  }
}

// Старт
initEvents();
