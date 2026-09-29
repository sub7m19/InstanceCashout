const DISCORD_CLIENT_ID = "";
const DISCORD_SCOPE = "identify";
const DISCORD_API_BASE = "https://discord.com/api/v10";
const SESSION_KEY = "instanceCashoutDiscordSession";
const TOKEN_KEY = "instanceCashoutDiscordToken";
const STATE_KEY = "instanceCashoutDiscordState";
const ACCOUNT_PREFIX = "instanceCashoutAccount:";

const form = document.querySelector("#quoteForm");
const output = document.querySelector("#messageOutput");
const loginButton = document.querySelector("#discordLogin");
const logoutButton = document.querySelector("#logoutButton");
const authStatus = document.querySelector("#authStatus");
const dashboardName = document.querySelector("#dashboardName");
const profileAvatar = document.querySelector("#profileAvatar");
const profileName = document.querySelector("#profileName");
const profileHandle = document.querySelector("#profileHandle");
const accountDiscordId = document.querySelector("#accountDiscordId");
const accountCreatedAt = document.querySelector("#accountCreatedAt");
const accountLastLogin = document.querySelector("#accountLastLogin");
const quoteHistory = document.querySelector("#quoteHistory");
const clearDraftsButton = document.querySelector("#clearDrafts");

let activeAccount = null;

function setAuthenticated(isAuthenticated) {
  document.body.classList.toggle("auth-locked", !isAuthenticated);
}

function makeState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildDiscordUrl() {
  const state = makeState();
  sessionStorage.setItem(STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: "token",
    client_id: DISCORD_CLIENT_ID,
    scope: DISCORD_SCOPE,
    state,
    redirect_uri: `${window.location.origin}${window.location.pathname}`,
    prompt: "consent",
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

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

function getDiscordAvatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }

  const fallbackIndex = Number(user.discriminator || 0) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${fallbackIndex}.png`;
}

function makeHandle(user) {
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }

  return user.global_name || user.username;
}

function readDiscordCallback() {
  if (!window.location.hash.includes("access_token")) {
    return false;
  }

  const params = new URLSearchParams(window.location.hash.slice(1));
  const returnedState = params.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const accessToken = params.get("access_token");

  if (!returnedState || returnedState !== expectedState || !accessToken) {
    authStatus.textContent = "Discord login could not be verified. Please try again.";
    history.replaceState(null, "", window.location.pathname);
    return false;
  }

  sessionStorage.setItem(SESSION_KEY, "authenticated");
  sessionStorage.setItem(TOKEN_KEY, accessToken);
  sessionStorage.removeItem(STATE_KEY);
  history.replaceState(null, "", window.location.pathname);
  return true;
}

async function fetchDiscordUser(accessToken) {
  const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Discord profile request failed.");
  }

  return response.json();
}

function upsertAccount(user) {
  const now = new Date().toISOString();
  const saved = localStorage.getItem(accountKey(user.id));
  const previous = saved ? JSON.parse(saved) : {};

  const account = {
    id: user.id,
    username: user.username,
    displayName: user.global_name || user.username,
    handle: makeHandle(user),
    avatarUrl: getDiscordAvatarUrl(user),
    createdAt: previous.createdAt || now,
    lastLoginAt: now,
    quoteDrafts: Array.isArray(previous.quoteDrafts) ? previous.quoteDrafts : [],
  };

  localStorage.setItem(accountKey(user.id), JSON.stringify(account));
  activeAccount = account;
  return account;
}

function saveActiveAccount() {
  if (!activeAccount) {
    return;
  }

  localStorage.setItem(accountKey(activeAccount.id), JSON.stringify(activeAccount));
}

function renderQuoteHistory() {
  if (!quoteHistory || !activeAccount) {
    return;
  }

  quoteHistory.innerHTML = "";

  if (!activeAccount.quoteDrafts.length) {
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

function renderDashboard(account) {
  dashboardName.textContent = account.displayName;
  profileAvatar.src = account.avatarUrl;
  profileName.textContent = account.displayName;
  profileHandle.textContent = account.handle;
  accountDiscordId.textContent = account.id;
  accountCreatedAt.textContent = formatDate(account.createdAt);
  accountLastLogin.textContent = formatDate(account.lastLoginAt);
  renderQuoteHistory();
}

async function bootAuthGate() {
  const hasCallback = readDiscordCallback();
  const accessToken = sessionStorage.getItem(TOKEN_KEY);
  const authenticated = hasCallback || sessionStorage.getItem(SESSION_KEY) === "authenticated";

  if (!authenticated || !accessToken) {
    setAuthenticated(false);
    return;
  }

  setAuthenticated(true);

  try {
    const user = await fetchDiscordUser(accessToken);
    const account = upsertAccount(user);
    renderDashboard(account);
  } catch (error) {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    setAuthenticated(false);
    authStatus.textContent = "Your Discord session expired. Please sign in again.";
  }
}

function startDiscordLogin() {
  loginButton.classList.add("is-selected");

  if (!DISCORD_CLIENT_ID) {
    authStatus.textContent =
      "Add your Discord application client ID in script.js, then register this page URL as an OAuth2 redirect URL in the Discord Developer Portal.";
    return;
  }

  window.location.href = buildDiscordUrl();
}

loginButton.addEventListener("click", startDiscordLogin);

logoutButton.addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  activeAccount = null;
  setAuthenticated(false);
  window.scrollTo({ top: 0, behavior: "auto" });
});

clearDraftsButton.addEventListener("click", () => {
  if (!activeAccount) {
    return;
  }

  activeAccount.quoteDrafts = [];
  saveActiveAccount();
  renderQuoteHistory();
});

bootAuthGate();

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const cardType = document.querySelector("#cardType").value;
  const collectionSize = document.querySelector("#collectionSize").value.trim() || "Not sure yet";
  const estimatedValue = document.querySelector("#estimatedValue").value.trim() || "Not sure yet";
  const notes = document.querySelector("#notes").value.trim() || "No extra notes yet";

  if (activeAccount) {
    activeAccount.quoteDrafts.unshift({
      cardType,
      collectionSize,
      estimatedValue,
      notes,
      createdAt: new Date().toISOString(),
    });
    activeAccount.quoteDrafts = activeAccount.quoteDrafts.slice(0, 10);
    saveActiveAccount();
    renderQuoteHistory();
  }

  output.textContent = `Quote request ready:\n\nCard type: ${cardType}\nCollection size: ${collectionSize}\nEstimated value: ${estimatedValue}\nNotes: ${notes}\n\nPlease send photos of the fronts, backs, and any grade labels for the fastest offer.`;
  output.classList.add("visible");
});
