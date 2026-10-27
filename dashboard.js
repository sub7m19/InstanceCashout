const ACTIVE_ACCOUNT_KEY = "instanceCashoutActiveAccount";
const ACCOUNT_PREFIX = "instanceCashoutAccount:";
const CART_KEY = "instanceCashoutCart";
const TABS = ["orders", "sell", "shipments", "payouts", "settings"];
// Same-origin when main.py serves the site; set to the API's URL if the pages are hosted elsewhere.
const API_BASE = "";

const $ = (selector) => document.querySelector(selector);

const dashboardName = $("#dashboardName");
const profileAvatar = $("#profileAvatar");
const profileInitials = $("#profileInitials");
const profileName = $("#profileName");
const profileHandle = $("#profileHandle");
const accountDiscordId = $("#accountDiscordId");
const accountCreatedAt = $("#accountCreatedAt");
const accountLastLogin = $("#accountLastLogin");
const logoutButton = $("#dashboardLogout");
const adminLink = $("#adminLink");
const summaryValue = $("#summaryValue");
const cashoutSteps = document.querySelectorAll("#cashoutSteps .step");
const stepHint = $("#stepHint");
const statOpenOrders = $("#statOpenOrders");
const statToShip = $("#statToShip");
const ordersTabCount = $("#ordersTabCount");
const payoutPending = $("#payoutPending");
const ordersContainer = $("#ordersContainer");
const shipmentsContainer = $("#shipmentsContainer");
const dashboardTabs = document.querySelectorAll(".tab");
const dashboardPanels = document.querySelectorAll(".tab-panel");
const wantedGrid = $("#wantedGrid");
const wantedChips = $("#wantedChips");
const wantedSearch = $("#wantedSearch");
const wantedSort = $("#wantedSort");
const cartBar = $("#cartBar");
const cartCount = $("#cartCount");
const cartTotal = $("#cartTotal");
const orderDialog = $("#orderDialog");
const cartLines = $("#cartLines");
const dialogTotal = $("#dialogTotal");
const submitOrderButton = $("#submitOrder");
const toast = $("#toast");

let activeAccount = null;
let orders = [];
let wantedItems = [];
let categories = [];
let productsState = "loading";
let activeWantedCategory = "all";
let cart = {};
let toastTimer = null;

function productImage(title, accent, secondary) {
  const encodedTitle = escapeHtml(title);

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 250">
      <rect width="420" height="250" fill="#fffaf0"/>
      <rect x="110" y="32" width="200" height="166" rx="10" fill="${accent}" opacity="0.92"/>
      <rect x="126" y="48" width="168" height="134" rx="8" fill="${secondary}" opacity="0.92"/>
      <circle cx="166" cy="94" r="30" fill="#fffaf0" opacity="0.9"/>
      <circle cx="244" cy="132" r="42" fill="#101720" opacity="0.2"/>
      <path d="M145 162c35-58 84-58 129 0" fill="none" stroke="#fffaf0" stroke-width="11" stroke-linecap="round"/>
      <text x="210" y="222" text-anchor="middle" fill="#101720" font-family="Arial, sans-serif" font-size="20" font-weight="900">${encodedTitle}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Products without a photo get generated art in one of these color pairs, picked from the id.
const PLACEHOLDER_COLORS = [
  ["#4bd7a8", "#f2c14e"],
  ["#8d6bff", "#4bd7a8"],
  ["#f06a5b", "#5ea7ff"],
  ["#5ea7ff", "#4bd7a8"],
  ["#f2c14e", "#f06a5b"],
];

function productImageFor(item) {
  if (item.image) {
    return item.image;
  }

  const hash = [...String(item.id)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const [accent, secondary] = PLACEHOLDER_COLORS[hash % PLACEHOLDER_COLORS.length];
  const shortName = String(item.name).replace(/^Pokemon\s+/i, "").split(/\s+/).slice(0, 2).join(" ");
  return productImage(shortName, accent, secondary);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readJson(key, fallback) {
  try {
    const saved = localStorage.getItem(key);
    return saved ? JSON.parse(saved) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    // Storage can be full (large images) or blocked; callers that must persist check the result.
    return false;
  }
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

function formatMoney(value) {
  const cents = !Number.isInteger(Math.round(Number(value) * 100) / 100);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(value);
}

function parseMoney(value) {
  if (!value) {
    return 0;
  }

  const parsed = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function initials(name) {
  const letters = String(name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
  return letters || "IC";
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3200);
}

/* Buy list */

async function loadWantedItems() {
  try {
    const response = await fetch(`${API_BASE}/api/products`);
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    const data = await response.json();
    wantedItems = data.products;
    categories = data.categories;
    productsState = "ready";
  } catch (error) {
    productsState = "error";
  }
}

function itemSpread(item) {
  const retail = Number(item.retailPrice);
  return retail ? Number(item.cashout) - retail : null;
}

function renderWantedChips() {
  const counts = wantedItems.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + 1;
    return result;
  }, {});

  const chips = [["all", "All", wantedItems.length], ...categories.map((name) => [name, name, counts[name] || 0])];

  wantedChips.innerHTML = chips
    .map(
      ([value, label, count]) => `
        <button class="chip" type="button" data-category="${escapeHtml(value)}" aria-pressed="${value === activeWantedCategory}">
          ${escapeHtml(label)}<span>${count}</span>
        </button>`,
    )
    .join("");
}

function renderWantedItems() {
  const search = wantedSearch.value.trim().toLowerCase();
  const sort = wantedSort.value;

  const visibleItems = wantedItems
    .filter((item) => {
      const matchesCategory = activeWantedCategory === "all" || item.category === activeWantedCategory;
      const matchesSearch = !search || `${item.name} ${item.upc} ${item.retailer}`.toLowerCase().includes(search);
      return matchesCategory && matchesSearch;
    })
    .sort((a, b) => {
      if (sort === "name") {
        return a.name.localeCompare(b.name);
      }

      if (sort === "quantity") {
        return Number(b.quantity) - Number(a.quantity);
      }

      if (sort === "spread") {
        return (itemSpread(b) ?? -Infinity) - (itemSpread(a) ?? -Infinity);
      }

      return Number(b.cashout) - Number(a.cashout);
    });

  renderWantedChips();

  if (productsState !== "ready") {
    wantedGrid.innerHTML = productsState === "loading"
      ? `<div class="card empty" style="grid-column: 1 / -1"><p>Loading the buy list…</p></div>`
      : `<div class="card empty" style="grid-column: 1 / -1">
          <h3>Couldn't load the buy list</h3>
          <p>Check your connection and reload the page.</p>
        </div>`;
    return;
  }

  if (!visibleItems.length) {
    wantedGrid.innerHTML = `
      <div class="card empty" style="grid-column: 1 / -1">
        <h3>No items match</h3>
        <p>Try a different search or category.</p>
      </div>`;
    return;
  }

  wantedGrid.innerHTML = visibleItems
    .map((item) => {
      const inCart = cart[item.id] || 0;
      const spread = itemSpread(item);
      const image = `<img src="${escapeHtml(productImageFor(item))}" alt="" loading="lazy">`;

      return `
        <article class="card product${inCart ? " in-cart" : ""}" data-id="${escapeHtml(item.id)}">
          <div class="product-image">
            ${image}
            <span class="product-tag">${escapeHtml(item.category)}</span>
            ${inCart ? `<span class="product-tag in-order">${inCart} in order</span>` : ""}
          </div>
          <div class="product-body">
            <div>
              <h3>${escapeHtml(item.name)}</h3>
              <p class="product-meta">${escapeHtml(item.retailer || "Any retailer")} · UPC ${escapeHtml(item.upc || "pending")}</p>
            </div>
            <div class="price-row">
              <div>
                <small>Cashout per unit</small>
                <span class="cashout">${formatMoney(Number(item.cashout))}</span>
              </div>
              ${spread !== null ? `<span class="spread" title="Retail ${formatMoney(Number(item.retailPrice))}">${spread >= 0 ? "+" : "−"}${formatMoney(Math.abs(spread))} vs retail</span>` : ""}
            </div>
            <p class="product-meta">${Number(item.quantity).toLocaleString()} wanted</p>
            <div class="product-actions">
              <div class="stepper">
                <button type="button" data-step="-1" aria-label="Decrease quantity">−</button>
                <input type="number" inputmode="numeric" min="1" max="${Number(item.quantity)}" value="${inCart || 1}" aria-label="Quantity for ${escapeHtml(item.name)}">
                <button type="button" data-step="1" aria-label="Increase quantity">+</button>
              </div>
              <button class="btn ${inCart ? "btn-secondary" : "btn-primary"}" type="button" data-add>
                ${inCart ? "Update" : "Add to order"}
              </button>
            </div>
          </div>
        </article>`;
    })
    .join("");
}

/* Cart */

function loadCart() {
  const saved = readJson(CART_KEY, {});
  cart = saved && typeof saved === "object" ? saved : {};
  const validIds = new Set(wantedItems.map((item) => item.id));
  Object.keys(cart).forEach((id) => {
    if (!validIds.has(id)) {
      delete cart[id];
    }
  });
}

function cartEntries() {
  return Object.entries(cart)
    .map(([id, quantity]) => ({ item: wantedItems.find((entry) => entry.id === id), quantity }))
    .filter((entry) => entry.item && entry.quantity > 0);
}

function cartSummary() {
  const entries = cartEntries();
  return {
    entries,
    units: entries.reduce((sum, entry) => sum + entry.quantity, 0),
    total: entries.reduce((sum, entry) => sum + entry.quantity * Number(entry.item.cashout), 0),
  };
}

function setCartQuantity(id, quantity) {
  if (quantity > 0) {
    cart[id] = quantity;
  } else {
    delete cart[id];
  }

  writeJson(CART_KEY, cart);
  renderCart();
  renderWantedItems();
}

function renderCart() {
  const { entries, units, total } = cartSummary();

  cartBar.hidden = !entries.length;
  cartCount.textContent = plural(units, "item");
  cartTotal.textContent = formatMoney(total);
  dialogTotal.textContent = formatMoney(total);
  submitOrderButton.disabled = !entries.length;

  if (!entries.length) {
    cartLines.innerHTML = `<div class="empty"><p>Your order is empty.</p></div>`;
    return;
  }

  cartLines.innerHTML = entries
    .map(
      ({ item, quantity }) => `
        <div class="cart-line" data-id="${escapeHtml(item.id)}">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <span>${formatMoney(Number(item.cashout))} each</span>
          </div>
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="Decrease quantity">−</button>
            <input type="number" inputmode="numeric" min="0" max="${Number(item.quantity)}" value="${quantity}" aria-label="Quantity for ${escapeHtml(item.name)}">
            <button type="button" data-step="1" aria-label="Increase quantity">+</button>
          </div>
          <span class="line-total">${formatMoney(quantity * Number(item.cashout))}</span>
          <button class="icon-btn" type="button" data-remove aria-label="Remove ${escapeHtml(item.name)}">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>`,
    )
    .join("");
}

function clampQuantity(value, max) {
  const number = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(number, max || Infinity));
}

async function submitOrder() {
  const { entries } = cartSummary();

  if (!entries.length) {
    return;
  }

  if (!activeAccount) {
    showToast("Log in with Discord to submit an order.");
    return;
  }

  submitOrderButton.disabled = true;
  submitOrderButton.textContent = "Submitting…";
  let order;

  try {
    const response = await fetch(`${API_BASE}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: entries.map(({ item, quantity }) => ({ id: item.id, quantity })) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Couldn't submit your order. Please try again.");
    }
    order = data;
  } catch (error) {
    showToast(error.message === "Failed to fetch" ? "Couldn't reach the server. Check your connection." : error.message);
    return;
  } finally {
    submitOrderButton.disabled = false;
    submitOrderButton.textContent = "Submit order";
  }

  orders.unshift(order);
  cart = {};
  writeJson(CART_KEY, cart);
  orderDialog.close();
  renderCart();
  renderWantedItems();
  renderAccountData();
  activateTab("orders");
  showToast(`${order.id} submitted for ${formatMoney(order.total)}.`);
}

/* Account data */

function accountOrders() {
  return orders;
}

async function loadOrders() {
  try {
    const response = await fetch(`${API_BASE}/api/orders`);
    if (response.ok) {
      orders = (await response.json()).orders;
      renderAccountData();
    }
  } catch (error) {
    // Offline: the dashboard still shows the buy list.
  }
}

function accountDrafts() {
  return Array.isArray(activeAccount?.quoteDrafts) ? activeAccount.quoteDrafts : [];
}

function orderRows() {
  const orders = accountOrders().map((order) => ({
    id: order.id,
    type: "Sell order",
    detail: plural(order.items.reduce((sum, item) => sum + item.quantity, 0), "unit"),
    value: order.total,
    createdAt: order.createdAt,
    status: order.status,
  }));

  const drafts = accountDrafts().map((draft, index) => ({
    id: `QTE-${String(index + 1).padStart(5, "0")}`,
    type: "Quote",
    detail: [draft.cardType, draft.collectionSize].filter(Boolean).join(" · "),
    value: parseMoney(draft.estimatedValue),
    createdAt: draft.createdAt,
    status: "draft",
  }));

  return [...orders, ...drafts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

const STATUS_LABELS = {
  draft: ["In review", "badge-draft"],
  submitted: ["Needs tracking", "badge-submitted"],
  transit: ["In transit", "badge-transit"],
  received: ["Received", "badge-received"],
  paid: ["Paid", "badge-paid"],
  cancelled: ["Cancelled", "badge-cancelled"],
};

function statusBadge(status) {
  const [label, className] = STATUS_LABELS[status] || STATUS_LABELS.draft;
  return `<span class="badge ${className}">${label}</span>`;
}

function emptyState(title, body, action) {
  return `
    <div class="empty">
      <h3>${title}</h3>
      <p>${body}</p>
      ${action}
    </div>`;
}

function renderOrders(rows) {
  if (!rows.length) {
    ordersContainer.innerHTML = emptyState(
      "No orders yet",
      "Pick sealed products from the buy list and submit them in one order. You'll see every order and its status here.",
      `<button class="btn btn-primary" type="button" data-tab-link="sell">Browse the buy list</button>`,
    );
    return;
  }

  ordersContainer.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Order</th><th>Status</th><th>Details</th><th>Created</th><th class="num">Value</th></tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
              <tr>
                <td class="mono">${escapeHtml(row.id)}</td>
                <td class="end">${statusBadge(row.status)}</td>
                <td class="span-all">${escapeHtml(row.type)} · ${escapeHtml(row.detail || "—")}</td>
                <td>${formatDate(row.createdAt)}</td>
                <td class="num"><strong>${formatMoney(row.value)}</strong></td>
              </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

const TRACKING_URLS = {
  UPS: "https://www.ups.com/track?tracknum=",
  USPS: "https://tools.usps.com/go/TrackConfirmAction?tLabels=",
  FedEx: "https://www.fedex.com/fedextrack/?trknbr=",
};

function trackingMarkup(order) {
  const base = TRACKING_URLS[order.carrier];
  const number = escapeHtml(order.tracking);
  const link = base
    ? `<a class="tracking-link mono" href="${base}${encodeURIComponent(order.tracking)}" target="_blank" rel="noopener">${number}</a>`
    : `<span class="mono">${number}</span>`;
  return `${link}<span class="cell-sub">${escapeHtml(order.carrier)}</span>`;
}

function renderShipments() {
  const orders = accountOrders();

  if (!orders.length) {
    shipmentsContainer.innerHTML = emptyState(
      "Nothing to ship",
      "When you submit a sell order, it shows up here so you can add photos and tracking.",
      `<button class="btn btn-secondary" type="button" data-tab-link="sell">Start a sell order</button>`,
    );
    return;
  }

  shipmentsContainer.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>Order</th><th>Status</th><th>Units</th><th>Photos</th><th>Tracking</th></tr>
      </thead>
      <tbody>
        ${orders
          .map((order) => {
            const photos = order.photos ? order.photos.before.length + order.photos.after.length : 0;
            return `
              <tr>
                <td class="mono">${escapeHtml(order.id)}<span class="cell-sub">${formatDate(order.createdAt)}</span></td>
                <td class="end">${statusBadge(order.status)}</td>
                <td data-label="Units">${order.items.reduce((sum, item) => sum + item.quantity, 0)}</td>
                <td data-label="Photos">${
                  photos
                    ? `<button class="link-btn" type="button" data-view-photos="${escapeHtml(order.id)}">View ${photos}</button>`
                    : "—"
                }</td>
                <td class="span-all">${
                  order.tracking
                    ? trackingMarkup(order)
                    : `<button class="btn btn-primary btn-sm" type="button" data-ship="${escapeHtml(order.id)}">Add photos &amp; tracking</button>`
                }</td>
              </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;
}

function renderSummary(rows) {
  const open = (row) => row.status !== "paid" && row.status !== "cancelled";
  const inProgress = rows.filter(open).reduce((sum, row) => sum + row.value, 0);
  const toShip = accountOrders().filter((order) => order.status === "submitted").length;
  const pendingShipment = accountOrders().find((order) => order.status === "submitted");
  const openOrders = rows.filter(open).length;

  summaryValue.textContent = formatMoney(inProgress);
  payoutPending.textContent = formatMoney(inProgress);
  statOpenOrders.textContent = String(openOrders);
  statToShip.textContent = String(toShip);
  ordersTabCount.textContent = String(rows.length);

  // Walk the cashout steps for the newest order so users always know what to do next.
  const latest = accountOrders()[0];
  const stage = { submitted: 2, transit: 3, received: 4, paid: 5 }[latest?.status] || 1;

  cashoutSteps.forEach((step) => {
    const number = Number(step.dataset.step);
    step.classList.toggle("done", number < stage);
    step.classList.toggle("current", number === stage);
  });

  if (pendingShipment) {
    setStepHint(`Next: photograph and pack ${pendingShipment.id}, ship it with your own label, then add the tracking number under Shipments.`);
  } else if (latest?.status === "transit") {
    setStepHint(`${latest.id} is on the way. We'll verify it as soon as it arrives.`);
  } else if (latest?.status === "received") {
    setStepHint(`We received ${latest.id} and are checking it. Your payout comes next.`);
  } else if (accountDrafts().length) {
    setStepHint("Your quote is in review. You can also sell straight from the buy list.");
  } else {
    setStepHint("Start by choosing items from the buy list.");
  }
}

function setStepHint(text) {
  if (stepHint.textContent === text) {
    return;
  }

  stepHint.textContent = text;
  // Restart the fade-in for the new text.
  stepHint.classList.remove("is-new");
  void stepHint.offsetWidth;
  stepHint.classList.add("is-new");
}

function renderAccountData() {
  const rows = orderRows();
  renderSummary(rows);
  renderOrders(rows);
  renderShipments();
}

function renderProfile(account) {
  if (!account) {
    profileInitials.textContent = "IC";
    profileAvatar.hidden = true;
    profileAvatar.removeAttribute("src");
    dashboardName.textContent = "collector";
    profileName.textContent = "Not signed in";
    profileHandle.textContent = "Sign in with Discord to save orders.";
    accountDiscordId.textContent = "Pending";
    accountCreatedAt.textContent = "Pending";
    accountLastLogin.textContent = "Pending";
    return;
  }

  profileInitials.textContent = initials(account.displayName);
  profileAvatar.hidden = !account.avatarUrl;
  if (account.avatarUrl) {
    profileAvatar.src = account.avatarUrl;
  } else {
    profileAvatar.removeAttribute("src");
  }
  dashboardName.textContent = account.displayName;
  profileName.textContent = account.displayName;
  profileHandle.textContent = account.handle;
  accountDiscordId.textContent = account.id;
  accountCreatedAt.textContent = formatDate(account.createdAt);
  accountLastLogin.textContent = formatDate(account.lastLoginAt);
}

function discordAvatarUrl(user) {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
  }

  return `https://cdn.discordapp.com/embed/avatars/${Number(user.discriminator || 0) % 5}.png`;
}

// Orders live in this browser, keyed by Discord id; the profile comes from the server session.
function upsertAccount(user) {
  const previous = readJson(accountKey(user.id), {});
  const now = new Date().toISOString();

  return {
    ...previous,
    id: user.id,
    username: user.username,
    displayName: user.globalName || user.username,
    handle: user.discriminator && user.discriminator !== "0" ? `${user.username}#${user.discriminator}` : user.username,
    avatarUrl: discordAvatarUrl(user),
    createdAt: previous.createdAt || now,
    lastLoginAt: now,
    quoteDrafts: Array.isArray(previous.quoteDrafts) ? previous.quoteDrafts : [],
  };
}

function showAccount(account) {
  activeAccount = account;
  renderProfile(activeAccount);
  renderAccountData();
}

function loadSavedAccount() {
  let accountId = null;

  try {
    accountId = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
  } catch (error) {
    accountId = null;
  }

  return accountId ? readJson(accountKey(accountId), null) : null;
}

async function loadActiveAccount() {
  let response;

  try {
    response = await fetch(`${API_BASE}/api/me`);
  } catch (error) {
    // Offline: show what this browser has saved.
    showAccount(loadSavedAccount());
    return;
  }

  if (response.status === 401) {
    window.location.replace("index.html");
    return;
  }

  if (!response.ok) {
    showAccount(loadSavedAccount());
    return;
  }

  const user = await response.json();
  adminLink.hidden = !user.isAdmin;
  const account = upsertAccount(user);
  writeJson(accountKey(account.id), account);
  try {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, account.id);
  } catch (error) {
    // Blocked storage: the account still shows for this visit.
  }
  showAccount(account);
}

/* Tabs */

function activateTab(tabName, { focus = false, updateHash = true } = {}) {
  const name = TABS.includes(tabName) ? tabName : "orders";

  dashboardTabs.forEach((tab) => {
    const selected = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;

    if (selected && focus) {
      tab.focus();
    }

    if (selected) {
      // On phones the tab bar scrolls sideways; center the chosen tab without scrolling the page.
      const bar = tab.parentElement;
      const offset = tab.getBoundingClientRect().left - bar.getBoundingClientRect().left;
      bar.scrollLeft += offset - (bar.clientWidth - tab.offsetWidth) / 2;
    }
  });

  dashboardPanels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });

  if (updateHash && location.hash !== `#${name}`) {
    history.replaceState(null, "", `#${name}`);
  }
}

dashboardTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    const offset = { ArrowRight: 1, ArrowLeft: -1 }[event.key];

    if (!offset) {
      return;
    }

    event.preventDefault();
    const next = dashboardTabs[(index + offset + dashboardTabs.length) % dashboardTabs.length];
    activateTab(next.dataset.tab, { focus: true });
  });
});

document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-tab-link]");

  if (!link) {
    return;
  }

  event.preventDefault();
  activateTab(link.dataset.tabLink);
  $(".tabs").scrollIntoView({ behavior: "smooth", block: "start" });
});

window.addEventListener("hashchange", () => activateTab(location.hash.slice(1), { updateHash: false }));

/* Sell interactions */

wantedChips.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");

  if (chip) {
    activeWantedCategory = chip.dataset.category;
    renderWantedItems();
  }
});

wantedGrid.addEventListener("click", (event) => {
  const card = event.target.closest(".product");

  if (!card) {
    return;
  }

  const item = wantedItems.find((entry) => entry.id === card.dataset.id);
  const input = card.querySelector(".stepper input");
  const stepButton = event.target.closest("[data-step]");

  if (stepButton) {
    input.value = String(Math.max(1, clampQuantity(Number(input.value) + Number(stepButton.dataset.step), item.quantity)));
    return;
  }

  if (event.target.closest("[data-add]")) {
    const quantity = Math.max(1, clampQuantity(input.value, item.quantity));
    const wasInCart = Boolean(cart[item.id]);
    setCartQuantity(item.id, quantity);
    showToast(wasInCart ? `Updated ${item.name} to ${quantity}.` : `Added ${quantity} × ${item.name}.`);
  }
});

cartLines.addEventListener("click", (event) => {
  const line = event.target.closest(".cart-line");

  if (!line) {
    return;
  }

  const id = line.dataset.id;
  const item = wantedItems.find((entry) => entry.id === id);
  const stepButton = event.target.closest("[data-step]");

  if (stepButton) {
    setCartQuantity(id, clampQuantity((cart[id] || 0) + Number(stepButton.dataset.step), item.quantity));
  } else if (event.target.closest("[data-remove]")) {
    setCartQuantity(id, 0);
  }
});

cartLines.addEventListener("change", (event) => {
  const line = event.target.closest(".cart-line");
  const item = line && wantedItems.find((entry) => entry.id === line.dataset.id);

  if (item) {
    setCartQuantity(item.id, clampQuantity(event.target.value, item.quantity));
  }
});

$("#reviewOrder").addEventListener("click", () => orderDialog.showModal());
document.querySelectorAll(".dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close-dialog]")) {
      dialog.close();
    }
  });
});
submitOrderButton.addEventListener("click", submitOrder);

/* Shipment submission: customer ships with their own label, then uploads photos and tracking. */

const PHOTO_MAX_EDGE = 1280;
const PHOTO_QUALITY = 0.72;
const PHOTO_LIMIT = 8;
let shippingOrderId = null;
let shipPhotos = { before: [], after: [] };

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", PHOTO_QUALITY));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unreadable image"));
    };
    image.src = url;
  });
}

function renderShipPhotos() {
  ["before", "after"].forEach((set) => {
    $(`#${set}Thumbs`).innerHTML = shipPhotos[set]
      .map(
        (src, index) => `
          <div class="thumb">
            <img src="${src}" alt="${set === "before" ? "Before packing" : "After packing"} photo ${index + 1}">
            <button type="button" data-remove-photo="${set}:${index}" aria-label="Remove photo ${index + 1}">
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>`,
      )
      .join("");
  });
}

function setFieldError(errorId, show) {
  const error = $(`#${errorId}`);
  error.hidden = !show;
  error.closest(".photo-field")?.classList.toggle("invalid", show);
}

function openShipDialog(orderId) {
  shippingOrderId = orderId;
  shipPhotos = { before: [], after: [] };
  $("#shipForm").reset();
  $("#shipTracking").removeAttribute("aria-invalid");
  ["trackingError", "beforeError", "afterError"].forEach((id) => setFieldError(id, false));
  $("#shipDialogOrder").textContent = orderId;
  renderShipPhotos();
  $("#shipDialog").showModal();
}

shipmentsContainer.addEventListener("click", (event) => {
  const shipButton = event.target.closest("[data-ship]");
  const viewButton = event.target.closest("[data-view-photos]");

  if (shipButton) {
    openShipDialog(shipButton.dataset.ship);
  } else if (viewButton) {
    openPhotoViewer(viewButton.dataset.viewPhotos);
  }
});

$("#shipForm").addEventListener("change", async (event) => {
  const set = event.target.dataset.photoSet;

  if (!set) {
    return;
  }

  const files = [...event.target.files].slice(0, PHOTO_LIMIT - shipPhotos[set].length);
  event.target.value = "";

  for (const file of files) {
    try {
      shipPhotos[set].push(await compressPhoto(file));
    } catch (error) {
      showToast(`Couldn't read ${file.name}.`);
    }
  }

  setFieldError(`${set}Error`, false);
  renderShipPhotos();
});

$("#shipTracking").addEventListener("input", () => {
  $("#shipTracking").removeAttribute("aria-invalid");
  setFieldError("trackingError", false);
});

$("#shipForm").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-photo]");

  if (button) {
    const [set, index] = button.dataset.removePhoto.split(":");
    shipPhotos[set].splice(Number(index), 1);
    renderShipPhotos();
  }
});

$("#shipForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const tracking = $("#shipTracking").value.replace(/\s+/g, "").toUpperCase();
  const missingTracking = !tracking;
  const missingBefore = !shipPhotos.before.length;
  const missingAfter = !shipPhotos.after.length;

  $("#shipTracking").setAttribute("aria-invalid", String(missingTracking));
  setFieldError("trackingError", missingTracking);
  setFieldError("beforeError", missingBefore);
  setFieldError("afterError", missingAfter);

  if (missingTracking || missingBefore || missingAfter) {
    (missingTracking ? $("#shipTracking") : $(".photo-field.invalid input"))?.focus();
    return;
  }

  const order = accountOrders().find((entry) => entry.id === shippingOrderId);

  if (order) {
    uploadShipment(order, $("#shipCarrier").value, tracking);
  }
});

function setShipUploading(percent) {
  const button = $("#shipSubmit");
  const uploading = percent !== null;
  button.disabled = uploading;
  button.textContent = uploading ? `Uploading… ${percent}%` : "Submit shipment";
  $("#shipProgress").hidden = !uploading;
  $("#shipProgress").value = percent ?? 0;
}

async function uploadShipment(order, carrier, tracking) {
  const form = new FormData();
  form.append("orderId", order.id);
  form.append("carrier", carrier);
  form.append("tracking", tracking);

  for (const set of ["before", "after"]) {
    for (const [index, dataUrl] of shipPhotos[set].entries()) {
      const blob = await (await fetch(dataUrl)).blob();
      form.append(set, blob, `${set}-${index + 1}.jpg`);
    }
  }

  // XHR instead of fetch so we can show upload progress for large photo sets.
  const request = new XMLHttpRequest();
  request.open("POST", `${API_BASE}/api/shipments`);
  request.responseType = "json";
  request.upload.addEventListener("progress", (event) => {
    if (event.lengthComputable) {
      setShipUploading(Math.round((event.loaded / event.total) * 100));
    }
  });
  request.addEventListener("load", () => {
    setShipUploading(null);

    if (request.status === 401) {
      showToast("Log in with Discord again to upload photos.");
      return;
    }

    if (request.status !== 201) {
      showToast(request.response?.error || "Upload failed. Please try again.");
      return;
    }

    orders = orders.map((entry) => (entry.id === order.id ? request.response : entry));
    $("#shipDialog").close();
    renderAccountData();
    showToast(`Photos and tracking submitted for ${order.id}.`);
  });
  request.addEventListener("error", () => {
    setShipUploading(null);
    showToast("Upload failed. Check your connection and try again.");
  });

  setShipUploading(0);
  request.send(form);
}

/* Photo viewer */

let viewerUrls = [];

async function openPhotoViewer(orderId) {
  const order = accountOrders().find((entry) => entry.id === orderId);

  if (!order?.photos) {
    showToast("No photos for this order yet.");
    return;
  }

  viewerUrls.forEach((url) => URL.revokeObjectURL(url));
  viewerUrls = [];
  $("#photoDialogOrder").textContent = `${order.id} · ${order.carrier} ${order.tracking}`;
  $("#photoDialogBody").innerHTML = ["before", "after"]
    .map(
      (set) => `
        <h3 class="photo-heading">${set === "before" ? "Before packing" : "After packing"}</h3>
        <div class="photo-gallery">
          ${order.photos[set].map((name) => `<div class="gallery-item" data-photo="${escapeHtml(name)}"></div>`).join("")}
        </div>`,
    )
    .join("");
  $("#photoDialog").showModal();

  for (const tile of $("#photoDialogBody").querySelectorAll("[data-photo]")) {
    try {
      const response = await fetch(
        `${API_BASE}/api/shipments/${encodeURIComponent(order.id)}/photos/${encodeURIComponent(tile.dataset.photo)}`,
      );
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const url = URL.createObjectURL(await response.blob());
      viewerUrls.push(url);
      tile.innerHTML = `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Shipment photo"></a>`;
    } catch (error) {
      tile.textContent = "Unavailable";
    }
  }
}

wantedSearch.addEventListener("input", renderWantedItems);
wantedSort.addEventListener("change", renderWantedItems);

logoutButton.addEventListener("click", async () => {
  try {
    localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  } catch (error) {
    // Ignore blocked storage; we still sign out.
  }

  try {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST" });
  } catch (error) {
    // Offline: the session cookie expires on its own.
  }

  window.location.href = "index.html";
});

/* Rows that scroll sideways on narrow screens (tabs, chips): fade the side with more to see. */

function updateScrollFade(row) {
  const more = row.scrollWidth - row.clientWidth;
  const atStart = row.scrollLeft <= 2;
  const atEnd = row.scrollLeft >= more - 2;

  if (more <= 2) {
    delete row.dataset.fade;
  } else {
    row.dataset.fade = atStart ? "end" : atEnd ? "start" : "both";
  }
}

document.querySelectorAll(".tabs, .chips").forEach((row) => {
  row.addEventListener("scroll", () => updateScrollFade(row), { passive: true });
  new ResizeObserver(() => updateScrollFade(row)).observe(row);
  // Chips are re-rendered when the buy list changes.
  new MutationObserver(() => updateScrollFade(row)).observe(row, { childList: true });
});

renderWantedItems();
activateTab(location.hash.slice(1), { updateHash: false });
loadActiveAccount()
  .then(loadWantedItems)
  .then(() => {
    // The cart can only be checked against the buy list once it has loaded.
    loadCart();
    renderCart();
    renderWantedItems();
    loadOrders();
  });
