// Discord sign-in runs on the server (/auth/discord); this page never handles a Discord token.
const loginButton = document.querySelector("#discordLogin");
const authStatus = document.querySelector("#authStatus");

const LOGIN_MESSAGES = {
  failed: "Discord login couldn't be completed. Please try again.",
  cancelled: "Discord login was cancelled.",
  unavailable: "Discord login isn't set up yet. Please try again later.",
};

function openDashboard() {
  // replace() so Back from the dashboard doesn't land on this page and bounce forward again.
  window.location.replace("dashboard.html");
}

async function bootAuthGate() {
  const loginResult = new URLSearchParams(window.location.search).get("login");

  if (loginResult) {
    authStatus.textContent = LOGIN_MESSAGES[loginResult] || LOGIN_MESSAGES.failed;
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // Already signed in: this page is only the login, so go straight to the dashboard.
  try {
    const response = await fetch("/api/me");
    if (response.ok) {
      openDashboard();
    }
  } catch (error) {
    // Offline: stay on the login page.
  }
}

loginButton.addEventListener("click", () => {
  loginButton.classList.add("is-selected");
  window.location.href = "/auth/discord";
});

bootAuthGate();
