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

function saveActiveAccount() {
  if (!activeAccount) {
    return;
  }

  localStorage.setItem(accountKey(activeAccount.id), JSON.stringify(activeAccount));
}

function renderQuoteHistory() {
  quoteHistory.innerHTML = "";

  if (!activeAccount || !activeAccount.quoteDrafts.length) {
    const emptyItem = document.createElement("li");
    emptyItem.textContent = "No quote drafts yet.";
    quoteHistory.append(emptyItem);
    return;
  }

  activeAccount.quoteDrafts.slice(0, 5).forEach((draft) => {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const meta = document.createElement("span");

    title.textContent = `${draft.cardType} - ${draft.estimatedValue}`;
    meta.textContent = `${draft.collectionSize} - ${formatDate(draft.createdAt)}`;

    item.append(title, meta);
    quoteHistory.append(item);
  });
}

function renderEmptyDashboard() {
  profileAvatar.removeAttribute("src");
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

logoutButton.addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  window.location.href = "index.html";
});

loadActiveAccount();
