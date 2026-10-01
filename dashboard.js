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
const WANTED_ITEMS_KEY = "instanceCashoutWantedItems";
const wantedGrid = document.querySelector("#wantedGrid");
const wantedForm = document.querySelector("#wantedForm");
const openWantedFormButton = document.querySelector("#openWantedForm");
const cancelWantedFormButton = document.querySelector("#cancelWantedForm");
const wantedImage = document.querySelector("#wantedImage");
const wantedImagePreview = document.querySelector("#wantedImagePreview");
const wantedSearch = document.querySelector("#wantedSearch");
const wantedSort = document.querySelector("#wantedSort");
const wantedCategoryButtons = document.querySelectorAll(".sell-chip");
const wantedAllCount = document.querySelector("#wantedAllCount");

let activeAccount = null;
let wantedItems = [];
let wantedImageData = "";
let activeWantedCategory = "all";

function productImage(title, accent, secondary) {
  const encodedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

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

const defaultWantedItems = [
  {
    id: "want-151-mini-tin",
    name: "Pokemon 151 Mini Tin Collection 10 Pack",
    category: "Pokemon",
    upc: "151151151515",
    retailer: "Sam's Club",
    buyPrice: "$74.98",
    cashout: 490,
    quantity: 965,
    image: productImage("151 Mini Tin", "#4bd7a8", "#f2c14e"),
  },
  {
    id: "want-prismatic-etb",
    name: "Prismatic Evolutions Elite Trainer Box",
    category: "Sealed",
    upc: "196214105195",
    retailer: "Pokemon Center",
    buyPrice: "$54.99",
    cashout: 320,
    quantity: 2047,
    image: productImage("Prismatic ETB", "#8d6bff", "#4bd7a8"),
  },
  {
    id: "want-destined-rivals",
    name: "Pokemon Destined Rivals Booster Box",
    category: "Pokemon",
    upc: "196214111189",
    retailer: "Target",
    buyPrice: "$119.99",
    cashout: 330,
    quantity: 940,
    image: productImage("Destined Rivals", "#f06a5b", "#5ea7ff"),
  },
  {
    id: "want-blooming-waters",
    name: "Pokemon 151 Blooming Waters Premium Collection",
    category: "Sealed",
    upc: "196214119017",
    retailer: "Best Buy",
    buyPrice: "$59.99",
    cashout: 300,
    quantity: 4070,
    image: productImage("Blooming Waters", "#5ea7ff", "#4bd7a8"),
  },
];

function hydrateDefaultWantedImages() {
  const defaultImageById = defaultWantedItems.reduce((result, item) => {
    result[item.id] = item.image;
    return result;
  }, {});

  let changed = false;
  wantedItems = wantedItems.map((item) => {
    if (!item.image && defaultImageById[item.id]) {
      changed = true;
      return { ...item, image: defaultImageById[item.id] };
    }

    return item;
  });

  if (changed) {
    saveWantedItems();
  }
}

function seedMissingDefaultWantedItems() {
  const existingIds = new Set(wantedItems.map((item) => item.id));
  const missingItems = defaultWantedItems.filter((item) => !existingIds.has(item.id));

  if (missingItems.length) {
    wantedItems = [...wantedItems, ...missingItems];
    saveWantedItems();
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
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function wantedItemKey(item) {
  return item.name.toLowerCase();
}

function loadWantedItems() {
  const saved = localStorage.getItem(WANTED_ITEMS_KEY);

  if (!saved) {
    wantedItems = defaultWantedItems;
    localStorage.setItem(WANTED_ITEMS_KEY, JSON.stringify(wantedItems));
    return;
  }

  try {
    wantedItems = JSON.parse(saved);
  } catch (error) {
    wantedItems = defaultWantedItems;
  }

  if (!Array.isArray(wantedItems)) {
    wantedItems = defaultWantedItems;
  }

  seedMissingDefaultWantedItems();
  hydrateDefaultWantedImages();
}

function saveWantedItems() {
  localStorage.setItem(WANTED_ITEMS_KEY, JSON.stringify(wantedItems));
}

function wantedImageMarkup(item) {
  if (item.image) {
    return `<img src="${item.image}" alt="">`;
  }

  return `<span>${item.category}</span>`;
}

function renderWantedCounts() {
  if (!wantedAllCount) {
    return;
  }

  const counts = wantedItems.reduce((result, item) => {
    result[item.category] = (result[item.category] || 0) + 1;
    return result;
  }, {});

  wantedAllCount.textContent = String(wantedItems.length);
  wantedCategoryButtons.forEach((button) => {
    const category = button.dataset.category;
    const count = category === "all" ? wantedItems.length : counts[category] || 0;
    const countNode = button.querySelector("span");

    if (countNode) {
      countNode.textContent = String(count);
    }
  });
}

function renderWantedItems() {
  if (!wantedGrid || !wantedSearch || !wantedSort) {
    return;
  }

  const search = wantedSearch.value.trim().toLowerCase();
  const sort = wantedSort.value;

  let visibleItems = wantedItems.filter((item) => {
    const matchesCategory = activeWantedCategory === "all" || item.category === activeWantedCategory;
    const matchesSearch = !search || `${item.name} ${item.upc} ${item.retailer}`.toLowerCase().includes(search);
    return matchesCategory && matchesSearch;
  });

  visibleItems = visibleItems.sort((a, b) => {
    if (sort === "name") {
      return wantedItemKey(a).localeCompare(wantedItemKey(b));
    }

    if (sort === "quantity") {
      return Number(b.quantity) - Number(a.quantity);
    }

    return Number(b.cashout) - Number(a.cashout);
  });

  renderWantedCounts();
  wantedGrid.innerHTML = "";

  if (!visibleItems.length) {
    const empty = document.createElement("p");
    empty.className = "wanted-empty";
    empty.textContent = "No wanted items match this view.";
    wantedGrid.append(empty);
    return;
  }

  visibleItems.forEach((item) => {
    const card = document.createElement("article");
    card.className = "wanted-card";
    card.innerHTML = `
      <div class="wanted-card-image">${wantedImageMarkup(item)}</div>
      <div class="wanted-card-body">
        <h3>${item.name}</h3>
        <dl>
          <div><dt>UPC</dt><dd>${item.upc || "Pending"}</dd></div>
          <div><dt>Retailer</dt><dd>${item.retailer || "Any"}</dd></div>
          <div><dt>Buy price</dt><dd>${item.buyPrice || "Open"}</dd></div>
          <div><dt>Cashout</dt><dd class="cashout">$${Number(item.cashout).toLocaleString()}</dd></div>
          <div><dt>Quantity</dt><dd>0/${Number(item.quantity).toLocaleString()}</dd></div>
        </dl>
        <div class="wanted-card-actions">
          <label>
            <span>Quantity</span>
            <input type="number" min="1" value="1" aria-label="Quantity for ${item.name}">
          </label>
          <button type="button">Sell</button>
        </div>
      </div>
    `;
    wantedGrid.append(card);
  });
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
  emptyState.classList.remove("visible");
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

clearDraftsButton?.addEventListener("click", () => {
  if (!activeAccount) {
    return;
  }

  activeAccount.quoteDrafts = [];
  saveActiveAccount();
  renderQuoteHistory();
});

openWantedFormButton?.addEventListener("click", () => {
  wantedForm.hidden = false;
  openWantedFormButton.hidden = true;
});

cancelWantedFormButton?.addEventListener("click", () => {
  wantedForm.reset();
  wantedImageData = "";
  wantedImagePreview.removeAttribute("src");
  wantedForm.hidden = true;
  openWantedFormButton.hidden = false;
});

wantedImage?.addEventListener("change", () => {
  const file = wantedImage.files?.[0];

  if (!file) {
    wantedImageData = "";
    wantedImagePreview.removeAttribute("src");
    return;
  }

  const reader = new FileReader();
  reader.addEventListener("load", () => {
    wantedImageData = String(reader.result);
    wantedImagePreview.src = wantedImageData;
  });
  reader.readAsDataURL(file);
});

wantedForm?.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(wantedForm);
  const item = {
    id: `want-${Date.now()}`,
    name: String(formData.get("wantedName")).trim(),
    category: String(formData.get("wantedCategory")),
    upc: String(formData.get("wantedUpc")).trim(),
    retailer: String(formData.get("wantedRetailer")).trim(),
    buyPrice: String(formData.get("wantedBuyPrice")).trim(),
    cashout: Number(formData.get("wantedCashout")) || 0,
    quantity: Number(formData.get("wantedQuantity")) || 1,
    image: wantedImageData,
  };

  wantedItems.unshift(item);
  saveWantedItems();
  renderWantedItems();
  wantedForm.reset();
  wantedImageData = "";
  wantedImagePreview.removeAttribute("src");
  wantedForm.hidden = true;
  openWantedFormButton.hidden = false;
});

wantedCategoryButtons.forEach((button) => {
  button.addEventListener("click", () => {
    activeWantedCategory = button.dataset.category;
    wantedCategoryButtons.forEach((categoryButton) => {
      categoryButton.classList.toggle("active", categoryButton === button);
    });
    renderWantedItems();
  });
});

wantedSearch?.addEventListener("input", renderWantedItems);
wantedSort?.addEventListener("change", renderWantedItems);

logoutButton.addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  window.location.href = "index.html";
});

loadWantedItems();
renderWantedItems();
loadActiveAccount();
