const ACTIVE_ACCOUNT_KEY = "instanceCashoutActiveAccount";
const ACCOUNT_PREFIX = "instanceCashoutAccount:";
const SESSION_KEY = "instanceCashoutDiscordSession";
const TOKEN_KEY = "instanceCashoutDiscordToken";

const dashboardName = document.querySelector("#dashboardName");
const profileAvatar = document.querySelector("#profileAvatar");
const profileName = document.querySelector("#profileName");
const profileHandle = document.querySelector("#profileHandle");
const accountDiscordId = document.querySelector("#accountDiscordId");
const accountCreatedAt = document.querySelector("#accountCreatedAt");
const accountLastLogin = document.querySelector("#accountLastLogin");
const quoteHistory = document.querySelector("#quoteHistory");
const clearDraftsButton = document.querySelector("#clearDrafts");
const logoutButton = document.querySelector("#dashboardLogout");
const emptyState = document.querySelector("#dashboardEmpty");
const dashboardEstimate = document.querySelector("#dashboardEstimate");
const dashboardEstimateSmall = document.querySelector("#dashboardEstimateSmall");
const dashboardDraftCount = document.querySelector("#dashboardDraftCount");
const dashboardProgress = document.querySelector("#dashboardProgress");
const pendingQuoteCount = document.querySelector("#pendingQuoteCount");
const payoutEstimate = document.querySelector("#payoutEstimate");
const dashboardTabs = document.querySelectorAll(".dashboard-tab");
const dashboardPanels = document.querySelectorAll(".dashboard-tab-panel");
const dashboardTabLinks = document.querySelectorAll("[data-tab-link]");

let activeAccount = null;

function accountKey(discordId) {
  return `${ACCOUNT_PREFIX}${discordId}`;
}

function formatDate(value) {
  if (!value) {
    return "Pending";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMoney(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function parseMoney(value) {
  if (!value) {
    return 0;
  }

  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function draftId(index) {
  return `DRF-${String(index + 1).padStart(5, "0")}`;
}

function saveActiveAccount() {
  if (!activeAccount) {
    return;
  }

  localStorage.setItem(accountKey(activeAccount.id), JSON.stringify(activeAccount));
}

function renderDashboardMetrics() {
  const drafts = activeAccount?.quoteDrafts ?? [];
  const estimate = drafts.reduce((sum, draft) => sum + parseMoney(draft.estimatedValue), 0);
  const draftCount = drafts.length;
  const progress = Math.min(100, Math.round((estimate / 500) * 100));

  dashboardEstimate.textContent = formatMoney(estimate);
  dashboardEstimateSmall.textContent = formatMoney(estimate);
  payoutEstimate.textContent = formatMoney(estimate);
  pendingQuoteCount.textContent = String(draftCount);

  if (dashboardDraftCount) {
    dashboardDraftCount.textContent = draftCount
      ? `${draftCount} saved ${draftCount === 1 ? "draft" : "drafts"} ready for review`
      : "";
  }

  if (dashboardProgress) {
    dashboardProgress.style.width = `${progress}%`;
  }
}

function activateTab(tabName) {
  dashboardTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  dashboardPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });
}

function renderQuoteHistory() {
  quoteHistory.innerHTML = "";
  renderDashboardMetrics();
  const drafts = activeAccount?.quoteDrafts ?? [];

  if (!drafts.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");

    cell.colSpan = 6;
    cell.textContent = "No quote drafts yet.";
    row.append(cell);
    quoteHistory.append(row);
    return;
  }

  drafts.slice(0, 6).forEach((draft, index) => {
    const row = document.createElement("tr");
    const id = document.createElement("td");
    const value = document.createElement("td");
    const type = document.createElement("td");
    const size = document.createElement("td");
    const created = document.createElement("td");
    const status = document.createElement("td");
    const badge = document.createElement("span");

    id.textContent = draftId(index);
    value.textContent = draft.estimatedValue;
    type.textContent = draft.cardType;
    size.textContent = draft.collectionSize;
    created.textContent = formatDate(draft.createdAt);
    badge.className = "status-badge";
    badge.textContent = "Draft";
    status.append(badge);

    row.append(id, value, type, size, created, status);
    quoteHistory.append(row);
  });
}

function renderEmptyDashboard() {
  profileAvatar.removeAttribute("src");
  dashboardName.textContent = "collector";
  profileName.textContent = "Discord account";
  profileHandle.textContent = "Not loaded yet";
  accountDiscordId.textContent = "Pending";
  accountCreatedAt.textContent = "Pending";
  accountLastLogin.textContent = "Pending";
  emptyState.classList.add("visible");
  renderQuoteHistory();
}

function renderDashboard(account) {
  emptyState.classList.remove("visible");
  dashboardName.textContent = account.displayName;
  profileAvatar.src = account.avatarUrl;
  profileName.textContent = account.displayName;
  profileHandle.textContent = account.handle;
  accountDiscordId.textContent = account.id;
  accountCreatedAt.textContent = formatDate(account.createdAt);
  accountLastLogin.textContent = formatDate(account.lastLoginAt);
  renderQuoteHistory();
}

function loadActiveAccount() {
  const accountId = localStorage.getItem(ACTIVE_ACCOUNT_KEY);

  if (!accountId) {
    renderEmptyDashboard();
    return;
  }

  const saved = localStorage.getItem(accountKey(accountId));

  if (!saved) {
    renderEmptyDashboard();
    return;
  }

  activeAccount = JSON.parse(saved);
  renderDashboard(activeAccount);
}

clearDraftsButton.addEventListener("click", () => {
  if (!activeAccount) {
    return;
  }

  activeAccount.quoteDrafts = [];
  saveActiveAccount();
  renderQuoteHistory();
});

dashboardTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    activateTab(tab.dataset.tab);
  });
});

dashboardTabLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    activateTab(link.dataset.tabLink);
  });
});

logoutButton.addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  window.location.href = "index.html";
});

loadActiveAccount();
