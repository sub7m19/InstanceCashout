const DISCORD_CLIENT_ID = "";
const DISCORD_SCOPE = "identify";
const SESSION_KEY = "instanceCashoutDiscordSession";
const STATE_KEY = "instanceCashoutDiscordState";

const form = document.querySelector("#quoteForm");
const output = document.querySelector("#messageOutput");
const loginButton = document.querySelector("#discordLogin");
const logoutButton = document.querySelector("#logoutButton");
const authStatus = document.querySelector("#authStatus");

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

function readDiscordCallback() {
  if (!window.location.hash.includes("access_token")) {
    return false;
  }

  const params = new URLSearchParams(window.location.hash.slice(1));
  const returnedState = params.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);

  if (!returnedState || returnedState !== expectedState) {
    authStatus.textContent = "Discord login could not be verified. Please try again.";
    history.replaceState(null, "", window.location.pathname);
    return false;
  }

  sessionStorage.setItem(SESSION_KEY, "authenticated");
  sessionStorage.removeItem(STATE_KEY);
  history.replaceState(null, "", window.location.pathname);
  return true;
}

function bootAuthGate() {
  const authenticated = readDiscordCallback() || sessionStorage.getItem(SESSION_KEY) === "authenticated";
  setAuthenticated(authenticated);
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
  setAuthenticated(false);
  window.scrollTo({ top: 0, behavior: "auto" });
});

bootAuthGate();

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const cardType = document.querySelector("#cardType").value;
  const collectionSize = document.querySelector("#collectionSize").value.trim() || "Not sure yet";
  const estimatedValue = document.querySelector("#estimatedValue").value.trim() || "Not sure yet";
  const notes = document.querySelector("#notes").value.trim() || "No extra notes yet";

  output.textContent = `Quote request ready:\n\nCard type: ${cardType}\nCollection size: ${collectionSize}\nEstimated value: ${estimatedValue}\nNotes: ${notes}\n\nPlease send photos of the fronts, backs, and any grade labels for the fastest offer.`;
  output.classList.add("visible");
});
