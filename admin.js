// Admin dashboard: manage the buy list members see on their dashboard.
const $ = (selector) => document.querySelector(selector);

const productRows = $("#productRows");
const tableMessage = $("#tableMessage");
const searchInput = $("#searchInput");
const statusFilter = $("#statusFilter");
const categoryFilter = $("#categoryFilter");
const sortSelect = $("#sortSelect");
const drawer = $("#productDrawer");
const form = $("#productForm");
const confirmDialog = $("#confirmDialog");
const toast = $("#toast");

const fields = {
  name: $("#fieldName"),
  category: $("#fieldCategory"),
  retailer: $("#fieldRetailer"),
  upc: $("#fieldUpc"),
  cashout: $("#fieldCashout"),
  retailPrice: $("#fieldRetail"),
  quantity: $("#fieldQuantity"),
  active: $("#fieldActive"),
  imageFile: $("#fieldImageFile"),
  imageUrl: $("#fieldImageUrl"),
};

let products = [];
let categories = [];
let loadState = "loading";
let filters = { search: "", status: "all", category: "all", sort: "recent" };

// Drawer state
let editing = null; // product being edited, or null for a new one
let pendingFile = null; // image chosen but not uploaded yet
let pendingFileUrl = "";
let imageRemoved = false;
let savedSnapshot = "";
let confirmHandler = null;
let toastTimer = null;

/* Helpers */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(value, cents = !Number.isInteger(Math.round(Number(value) * 100) / 100)) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(value);
}

function formatAmount(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(2);
}

function spreadOf(product) {
  return product.retailPrice ? Number(product.cashout) - Number(product.retailPrice) : null;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), isError ? 5000 : 2800);
}

async function api(method, url, body) {
  const options = { method, headers: { "X-Requested-With": "fetch" } };

  if (body instanceof FormData) {
    options.body = body;
  } else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (response.status === 401) {
    window.location.replace("index.html");
    throw new Error("Signed out.");
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Something went wrong. Try again.");
  }

  return response.status === 204 ? null : response.json();
}

// Same generated art the member dashboard shows for products without a photo.
const PLACEHOLDER_COLORS = [
  ["#4bd7a8", "#f2c14e"],
  ["#8d6bff", "#4bd7a8"],
  ["#f06a5b", "#5ea7ff"],
  ["#5ea7ff", "#4bd7a8"],
  ["#f2c14e", "#f06a5b"],
];

function placeholderImage(product) {
  const hash = [...String(product.id || "new")].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const [accent, secondary] = PLACEHOLDER_COLORS[hash % PLACEHOLDER_COLORS.length];
  const title = escapeHtml(String(product.name || "New product").replace(/^Pokemon\s+/i, "").split(/\s+/).slice(0, 2).join(" "));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 250">
      <rect width="420" height="250" fill="#fffaf0"/>
      <rect x="110" y="32" width="200" height="166" rx="10" fill="${accent}" opacity="0.92"/>
      <rect x="126" y="48" width="168" height="134" rx="8" fill="${secondary}" opacity="0.92"/>
      <circle cx="166" cy="94" r="30" fill="#fffaf0" opacity="0.9"/>
      <circle cx="244" cy="132" r="42" fill="#101720" opacity="0.2"/>
      <path d="M145 162c35-58 84-58 129 0" fill="none" stroke="#fffaf0" stroke-width="11" stroke-linecap="round"/>
      <text x="210" y="222" text-anchor="middle" fill="#101720" font-family="Arial, sans-serif" font-size="20" font-weight="900">${title}</text>
    </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function imageFor(product) {
  return product.image || placeholderImage(product);
}

/* Rendering */

function visibleProducts() {
  const search = filters.search.trim().toLowerCase();

  return products
    .filter((product) => {
      if (filters.status === "live" && !product.active) return false;
      if (filters.status === "hidden" && product.active) return false;
      if (filters.category !== "all" && product.category !== filters.category) return false;
      return !search || `${product.name} ${product.upc} ${product.retailer}`.toLowerCase().includes(search);
    })
    .sort((a, b) => {
      switch (filters.sort) {
        case "cashout":
          return b.cashout - a.cashout;
        case "spread":
          return (spreadOf(b) ?? -Infinity) - (spreadOf(a) ?? -Infinity);
        case "quantity":
          return b.quantity - a.quantity;
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return String(b.updatedAt).localeCompare(String(a.updatedAt));
      }
    });
}

function renderKpis() {
  const live = products.filter((product) => product.active);
  $("#kpiLive").textContent = live.length;
  $("#kpiHidden").textContent = products.length - live.length;
  $("#kpiUnits").textContent = live.reduce((sum, product) => sum + product.quantity, 0).toLocaleString();
  $("#kpiTop").textContent = live.length ? formatMoney(Math.max(...live.map((product) => product.cashout))) : "–";
  $("#countAll").textContent = products.length;
  $("#countLive").textContent = live.length;
  $("#countHidden").textContent = products.length - live.length;
}

function spreadCell(product) {
  const spread = spreadOf(product);
  if (spread === null) {
    return `<span class="money-cell">—</span>`;
  }
  return `<span class="${spread >= 0 ? "spread-pos" : "spread-neg"}">${spread >= 0 ? "+" : "−"}${formatMoney(Math.abs(spread))}</span>`;
}

function rowHtml(product, index) {
  const meta = [product.retailer, product.upc && `UPC ${product.upc}`].filter(Boolean).join(" · ") || "No retailer or UPC";

  return `
    <tr data-id="${escapeHtml(product.id)}" class="${product.active ? "" : "is-hidden"}" style="--row: ${index}">
      <td class="product-td">
        <div class="product-cell">
          <img class="thumb" src="${escapeHtml(imageFor(product))}" alt="" loading="lazy">
          <div>
            <strong>${escapeHtml(product.name)}</strong>
            <small>${escapeHtml(meta)}</small>
          </div>
        </div>
      </td>
      <td class="cat-cell"><span class="cat-badge">${escapeHtml(product.category)}</span></td>
      <td class="num retail-cell money-cell">${product.retailPrice ? formatMoney(product.retailPrice, true) : "—"}</td>
      <td class="num cashout-td" data-label="Cashout">
        <span class="inline-edit money cashout">
          <input type="number" inputmode="decimal" min="0" step="0.01" value="${formatAmount(product.cashout)}"
            data-inline="cashout" aria-label="Cashout for ${escapeHtml(product.name)}">
        </span>
      </td>
      <td class="num spread-cell">${spreadCell(product)}</td>
      <td class="num wanted-td" data-label="Wanted">
        <span class="inline-edit">
          <input type="number" inputmode="numeric" min="0" step="1" value="${product.quantity}"
            data-inline="quantity" aria-label="Units wanted for ${escapeHtml(product.name)}">
        </span>
      </td>
      <td class="live-td">
        <label class="switch">
          <input type="checkbox" role="switch" data-toggle-live ${product.active ? "checked" : ""}
            aria-label="Show ${escapeHtml(product.name)} to members">
          <span class="switch-track" aria-hidden="true"></span>
          <span class="switch-text">${product.active ? "Live" : "Hidden"}</span>
        </label>
      </td>
      <td class="actions-td">
        <div class="row-actions">
          <button class="icon-btn" type="button" data-edit aria-label="Edit ${escapeHtml(product.name)}">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="icon-btn danger" type="button" data-delete aria-label="Delete ${escapeHtml(product.name)}">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
}

function renderTable() {
  if (loadState === "loading") {
    productRows.innerHTML = Array.from({ length: 4 }, () => `
      <tr class="skeleton-row">
        <td colspan="8"><span class="skeleton" style="width: ${40 + Math.round(Math.random() * 40)}%"></span></td>
      </tr>`).join("");
    tableMessage.innerHTML = "";
    return;
  }

  if (loadState === "error") {
    productRows.innerHTML = "";
    tableMessage.innerHTML = `
      <div class="empty">
        <h3>Couldn't load products</h3>
        <p>Check your connection and try again.</p>
        <button class="btn btn-secondary" type="button" id="retryLoad">Try again</button>
      </div>`;
    return;
  }

  const rows = visibleProducts();
  productRows.innerHTML = rows.map(rowHtml).join("");

  if (rows.length) {
    tableMessage.innerHTML = "";
  } else if (products.length) {
    tableMessage.innerHTML = `
      <div class="empty">
        <h3>No products match</h3>
        <p>Try a different search, status or category.</p>
        <button class="btn btn-secondary" type="button" id="clearFilters">Clear filters</button>
      </div>`;
  } else {
    tableMessage.innerHTML = `
      <div class="empty">
        <h3>Your buy list is empty</h3>
        <p>Add the first product members can sell to you.</p>
        <button class="btn btn-primary" type="button" data-new-product>New product</button>
      </div>`;
  }
}

function render() {
  renderKpis();
  renderTable();
}

/* Loading */

async function loadProducts() {
  loadState = "loading";
  renderTable();

  try {
    const data = await api("GET", "/api/admin/products");
    products = data.products;
    categories = data.categories;
    loadState = "ready";
    fillCategoryOptions();
  } catch (error) {
    loadState = "error";
  }

  render();
}

function fillCategoryOptions() {
  const options = categories.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  categoryFilter.innerHTML = `<option value="all">All categories</option>${options}`;
  categoryFilter.value = filters.category;
  fields.category.innerHTML = options;
}

function replaceProduct(updated) {
  products = products.map((product) => (product.id === updated.id ? updated : product));
}

/* Edit in place: cashout and quantity */

async function saveInline(input) {
  const row = input.closest("tr");
  const product = products.find((entry) => entry.id === row.dataset.id);
  const key = input.dataset.inline;
  const value = key === "quantity" ? Math.floor(Number(input.value)) : Math.round(Number(input.value) * 100) / 100;
  const wrapper = input.closest(".inline-edit");

  if (input.value === "" || !Number.isFinite(value) || value < 0) {
    input.setAttribute("aria-invalid", "true");
    showToast(key === "quantity" ? "Units wanted must be 0 or more." : "Cashout must be 0 or more.", true);
    input.value = key === "quantity" ? product[key] : formatAmount(product[key]);
    setTimeout(() => input.removeAttribute("aria-invalid"), 1500);
    return;
  }

  if (value === product[key]) {
    input.value = key === "quantity" ? value : formatAmount(value);
    return;
  }

  wrapper.classList.remove("is-saved");
  wrapper.classList.add("is-saving");

  try {
    const updated = await api("PATCH", `/api/admin/products/${encodeURIComponent(product.id)}`, { [key]: value });
    replaceProduct(updated);
    renderKpis();
    // Update just this row's spread so focus isn't lost while tabbing through the table.
    row.querySelector(".spread-cell").innerHTML = spreadCell(updated);
    input.value = key === "quantity" ? updated[key] : formatAmount(updated[key]);
    wrapper.classList.remove("is-saving");
    wrapper.classList.add("is-saved");
    setTimeout(() => wrapper.classList.remove("is-saved"), 1600);
  } catch (error) {
    wrapper.classList.remove("is-saving");
    input.value = key === "quantity" ? product[key] : formatAmount(product[key]);
    showToast(error.message, true);
  }
}

productRows.addEventListener("change", (event) => {
  if (event.target.matches("[data-inline]")) {
    saveInline(event.target);
  } else if (event.target.matches("[data-toggle-live]")) {
    toggleLive(event.target);
  }
});

productRows.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.matches("[data-inline]")) {
    event.preventDefault();
    event.target.blur();
  }

  if (event.key === "Escape" && event.target.matches("[data-inline]")) {
    const product = products.find((entry) => entry.id === event.target.closest("tr").dataset.id);
    const key = event.target.dataset.inline;
    event.target.value = key === "quantity" ? product[key] : formatAmount(product[key]);
    event.target.blur();
  }
});

async function toggleLive(input) {
  const row = input.closest("tr");
  const product = products.find((entry) => entry.id === row.dataset.id);
  const active = input.checked;
  input.disabled = true;

  try {
    const updated = await api("PATCH", `/api/admin/products/${encodeURIComponent(product.id)}`, { active });
    replaceProduct(updated);
    renderKpis();
    row.classList.toggle("is-hidden", !active);
    row.querySelector(".switch-text").textContent = active ? "Live" : "Hidden";
    showToast(active ? `${updated.name} is live for members.` : `${updated.name} is hidden from members.`);

    // If the row no longer matches the status filter, let it go.
    if (filters.status !== "all") {
      renderTable();
    }
  } catch (error) {
    input.checked = !active;
    showToast(error.message, true);
  } finally {
    input.disabled = false;
  }
}

productRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-id]");
  if (!row) return;
  const product = products.find((entry) => entry.id === row.dataset.id);

  if (event.target.closest("[data-edit]")) {
    openDrawer(product);
  } else if (event.target.closest("[data-delete]")) {
    askDelete(product);
  }
});

tableMessage.addEventListener("click", (event) => {
  if (event.target.closest("#retryLoad")) {
    loadProducts();
  } else if (event.target.closest("#clearFilters")) {
    filters = { ...filters, search: "", status: "all", category: "all" };
    searchInput.value = "";
    categoryFilter.value = "all";
    setStatusFilter("all");
    renderTable();
  } else if (event.target.closest("[data-new-product]")) {
    openDrawer(null);
  }
});

/* Filters */

function setStatusFilter(status) {
  filters.status = status;
  statusFilter.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.status === status));
  });
}

searchInput.addEventListener("input", () => {
  filters.search = searchInput.value;
  renderTable();
});

statusFilter.addEventListener("click", (event) => {
  const button = event.target.closest("[data-status]");
  if (button) {
    setStatusFilter(button.dataset.status);
    renderTable();
  }
});

categoryFilter.addEventListener("change", () => {
  filters.category = categoryFilter.value;
  renderTable();
});

sortSelect.addEventListener("change", () => {
  filters.sort = sortSelect.value;
  renderTable();
});

// "/" jumps to search, like most admin tools.
document.addEventListener("keydown", (event) => {
  const typing = event.target.closest("input, select, textarea");
  if (event.key === "/" && !typing && !drawer.open && !orderDrawer.open && !confirmDialog.open) {
    event.preventDefault();
    (currentView === "orders" ? orderSearch : searchInput).focus();
  }
});

/* Drawer: add / edit */

function formSnapshot() {
  return JSON.stringify([
    fields.name.value, fields.category.value, fields.retailer.value, fields.upc.value,
    fields.cashout.value, fields.retailPrice.value, fields.quantity.value, fields.active.checked,
    fields.imageUrl.value, Boolean(pendingFile), imageRemoved,
  ]);
}

function isDirty() {
  return formSnapshot() !== savedSnapshot;
}

function setPendingFile(file) {
  if (pendingFileUrl) {
    URL.revokeObjectURL(pendingFileUrl);
  }
  pendingFile = file;
  pendingFileUrl = file ? URL.createObjectURL(file) : "";
}

function openDrawer(product) {
  editing = product;
  setPendingFile(null);
  imageRemoved = false;
  form.reset();
  clearErrors();

  $("#drawerEyebrow").textContent = product ? "Edit product" : "New product";
  $("#drawerTitle").textContent = product ? product.name : "Add to the buy list";
  $("#saveButton").textContent = product ? "Save changes" : "Add product";
  $("#deleteFromDrawer").hidden = !product;

  fields.name.value = product?.name ?? "";
  fields.category.value = product?.category ?? categories[0];
  fields.retailer.value = product?.retailer ?? "";
  fields.upc.value = product?.upc ?? "";
  fields.cashout.value = product ? formatAmount(product.cashout) : "";
  fields.retailPrice.value = product?.retailPrice ? formatAmount(product.retailPrice) : "";
  fields.quantity.value = product?.quantity ?? 1;
  fields.active.checked = product?.active ?? true;
  fields.imageUrl.value = product?.image?.startsWith("https://") ? product.image : "";

  showDiscardBar(false);
  savedSnapshot = formSnapshot();
  updateDrawer();
  drawer.showModal();
  fields.name.focus();
}

function currentImage() {
  if (pendingFileUrl) return pendingFileUrl;
  if (fields.imageUrl.value.trim()) return fields.imageUrl.value.trim();
  if (imageRemoved) return "";
  return editing?.image?.startsWith("/product-images/") ? editing.image : "";
}

function draftProduct() {
  return {
    id: editing?.id || "new",
    name: fields.name.value.trim(),
    category: fields.category.value,
    retailer: fields.retailer.value.trim(),
    upc: fields.upc.value.trim(),
    cashout: Number(fields.cashout.value) || 0,
    retailPrice: Number(fields.retailPrice.value) || null,
    quantity: Math.max(0, Math.floor(Number(fields.quantity.value) || 0)),
    active: fields.active.checked,
    image: currentImage() || null,
  };
}

function updateDrawer() {
  const draft = draftProduct();
  const image = currentImage();

  // Image drop zone
  $("#imagePreview").hidden = !image;
  if (image) $("#imagePreview").src = image;
  $("#dropzoneText").hidden = Boolean(image);
  $("#imageActions").hidden = !image;
  $("#liveText").textContent = draft.active ? "Live" : "Hidden";

  // Spread vs retail
  const spread = spreadOf(draft);
  $("#spreadNote").innerHTML = spread === null || !fields.cashout.value
    ? "Add a retail price to see the spread members get."
    : `Members make <strong class="${spread >= 0 ? "spread-pos" : "spread-neg"}">${spread >= 0 ? "+" : "−"}${formatMoney(Math.abs(spread), true)}</strong> per unit vs. retail.`;

  // Member preview: the same card markup as the member dashboard
  const meta = `${escapeHtml(draft.retailer || "Any retailer")} · UPC ${escapeHtml(draft.upc || "pending")}`;
  $("#memberPreview").innerHTML = `
    <article class="card product">
      <div class="product-image">
        <img src="${escapeHtml(image || placeholderImage(draft))}" alt="">
        <span class="product-tag">${escapeHtml(draft.category)}</span>
      </div>
      <div class="product-body">
        <div>
          <h3>${escapeHtml(draft.name || "Product name")}</h3>
          <p class="product-meta">${meta}</p>
        </div>
        <div class="price-row">
          <div>
            <small>Cashout per unit</small>
            <span class="cashout">${formatMoney(draft.cashout)}</span>
          </div>
          ${spread !== null ? `<span class="spread">${spread >= 0 ? "+" : "−"}${formatMoney(Math.abs(spread))} vs retail</span>` : ""}
        </div>
        <p class="product-meta">${draft.quantity.toLocaleString()} wanted</p>
        <div class="product-actions">
          <button class="btn btn-primary" type="button" tabindex="-1">Add to order</button>
        </div>
      </div>
    </article>`;
  $(".drawer-preview").classList.toggle("preview-hidden", !draft.active);
  $("#previewNote").textContent = draft.active ? "This is how members see it." : "Hidden: members won't see this product.";
}

form.addEventListener("input", (event) => {
  if (event.target === fields.imageUrl && fields.imageUrl.value.trim()) {
    setPendingFile(null);
    fields.imageFile.value = "";
  }
  if (event.target.getAttribute("aria-invalid")) {
    event.target.removeAttribute("aria-invalid");
  }
  updateDrawer();
});

// Validate a field when leaving it, not only on save.
form.addEventListener("focusout", (event) => {
  if ([fields.name, fields.cashout, fields.quantity, fields.imageUrl].includes(event.target) && event.target.value !== "") {
    validate(event.target);
  }
});

function clearErrors() {
  form.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
  form.querySelectorAll(".field-error").forEach((error) => {
    error.hidden = true;
    error.textContent = "";
  });
}

function setError(input, errorId, message) {
  const error = $(errorId);
  input.toggleAttribute("aria-invalid", Boolean(message));
  if (message) input.setAttribute("aria-invalid", "true");
  error.textContent = message;
  error.hidden = !message;
  return !message;
}

function validate(only) {
  const checks = [
    [fields.name, "#errorName", () => (fields.name.value.trim() ? "" : "Enter a product name.")],
    [fields.cashout, "#errorCashout", () => {
      const cashout = Number(fields.cashout.value);
      const retail = fields.retailPrice.value;
      if (fields.cashout.value === "" || !(cashout >= 0)) return "Enter the cashout per unit (0 or more).";
      if (retail !== "" && !(Number(retail) >= 0)) return "Retail price must be 0 or more.";
      return "";
    }],
    [fields.quantity, "#errorQuantity", () => {
      const quantity = Number(fields.quantity.value);
      return fields.quantity.value !== "" && Number.isInteger(quantity) && quantity >= 0 ? "" : "Enter a whole number of units (0 or more).";
    }],
    [fields.imageUrl, "#errorImage", () => {
      const url = fields.imageUrl.value.trim();
      return !url || /^https:\/\/\S+$/i.test(url) ? "" : "Image links must start with https://";
    }],
  ];

  let firstInvalid = null;
  for (const [input, errorId, check] of checks) {
    if (only && input !== only) continue;
    if (!setError(input, errorId, check()) && !firstInvalid) {
      firstInvalid = input;
    }
  }
  return firstInvalid;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const invalid = validate();
  if (invalid) {
    invalid.focus();
    return;
  }

  const draft = draftProduct();
  const body = {
    name: draft.name,
    category: draft.category,
    retailer: draft.retailer,
    upc: draft.upc,
    cashout: Number(fields.cashout.value),
    retailPrice: fields.retailPrice.value === "" ? null : Number(fields.retailPrice.value),
    quantity: draft.quantity,
    active: draft.active,
  };

  // An image link replaces the image; "Remove" clears it. An uploaded file is sent after saving.
  if (fields.imageUrl.value.trim()) {
    body.image = fields.imageUrl.value.trim();
  } else if (imageRemoved && !pendingFile) {
    body.image = null;
  }

  const saveButton = $("#saveButton");
  const label = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";

  try {
    let saved = editing
      ? await api("PATCH", `/api/admin/products/${encodeURIComponent(editing.id)}`, body)
      : await api("POST", "/api/admin/products", body);

    if (pendingFile) {
      const upload = new FormData();
      upload.append("image", pendingFile);
      saved = await api("POST", `/api/admin/products/${encodeURIComponent(saved.id)}/image`, upload);
    }

    if (editing) {
      replaceProduct(saved);
    } else {
      products.unshift(saved);
    }

    savedSnapshot = formSnapshot();
    drawer.close();
    render();
    showToast(editing ? "Changes saved." : `${saved.name} added to the buy list.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = label;
  }
});

/* Image: pick, drop, replace, remove */

function acceptImage(file) {
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    setError(fields.imageUrl, "#errorImage", "Images must be JPEG, PNG or WebP.");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setError(fields.imageUrl, "#errorImage", "Images must be under 5 MB.");
    return;
  }
  setError(fields.imageUrl, "#errorImage", "");
  setPendingFile(file);
  fields.imageUrl.value = "";
  imageRemoved = false;
  updateDrawer();
}

fields.imageFile.addEventListener("change", () => acceptImage(fields.imageFile.files?.[0]));

const dropzone = $("#dropzone");
["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-over");
  }),
);
["dragleave", "drop"].forEach((type) =>
  dropzone.addEventListener(type, () => dropzone.classList.remove("is-over")),
);
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  acceptImage(event.dataTransfer.files?.[0]);
});

$("#removeImage").addEventListener("click", () => {
  setPendingFile(null);
  fields.imageFile.value = "";
  fields.imageUrl.value = "";
  imageRemoved = true;
  updateDrawer();
});

/* Closing with unsaved changes */

function showDiscardBar(show) {
  $("#discardBar").hidden = !show;
  $("#drawerActions").hidden = show;
  $("#deleteFromDrawer").hidden = show || !editing;
}

function requestClose() {
  if (isDirty()) {
    showDiscardBar(true);
    $("#keepEditing").focus();
  } else {
    drawer.close();
  }
}

drawer.addEventListener("cancel", (event) => {
  // Esc: don't lose edits by accident.
  event.preventDefault();
  requestClose();
});

drawer.addEventListener("click", (event) => {
  if (event.target.closest("[data-drawer-close]")) {
    requestClose();
  } else if (event.target === drawer) {
    // Click on the backdrop
    requestClose();
  }
});

$("#keepEditing").addEventListener("click", () => {
  showDiscardBar(false);
  fields.name.focus();
});

$("#discardChanges").addEventListener("click", () => drawer.close());

drawer.addEventListener("close", () => setPendingFile(null));

$("#deleteFromDrawer").addEventListener("click", () => askDelete(editing));

/* Confirmation */

function askConfirm({ title, text, action, run }) {
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmAction").textContent = action;
  confirmHandler = run;
  confirmDialog.showModal();
  $("#confirmCancel").focus();
}

$("#confirmCancel").addEventListener("click", () => confirmDialog.close());

$("#confirmAction").addEventListener("click", async () => {
  const button = $("#confirmAction");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Working…";

  try {
    await confirmHandler();
    confirmDialog.close();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

function askDelete(product) {
  askConfirm({
    title: "Delete this product?",
    text: `"${product.name}" will be removed from the buy list for all members. This can't be undone.`,
    action: "Delete product",
    run: async () => {
      await api("DELETE", `/api/admin/products/${encodeURIComponent(product.id)}`);
      products = products.filter((entry) => entry.id !== product.id);
      if (drawer.open) drawer.close();
      render();
      showToast(`${product.name} deleted.`);
    },
  });
}

/* New product, log out, start */

document.addEventListener("click", (event) => {
  if (event.target.closest("#newProductButton")) {
    openDrawer(null);
  }
});

$("#logoutButton").addEventListener("click", async () => {
  try {
    await fetch("/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "index.html";
  }
});

async function start() {
  let user;

  try {
    const response = await fetch("/api/me");
    if (response.status === 401) {
      window.location.replace("index.html");
      return;
    }
    user = await response.json();
  } catch (error) {
    $("#adminApp").hidden = false;
    loadState = "error";
    renderTable();
    return;
  }

  if (!user.isAdmin) {
    $("#deniedUserId").textContent = `Your Discord ID: ${user.id}`;
    $("#deniedState").hidden = false;
    return;
  }

  $("#adminApp").hidden = false;
  showView(location.hash === "#orders" ? "orders" : "products");
  await Promise.all([loadProducts(), loadOrders()]);
}

/* Views: Products | Orders */

const orderRows = $("#orderRows");
const ordersMessage = $("#ordersMessage");
const orderSearch = $("#orderSearch");
const orderStatusChips = $("#orderStatusChips");
const orderDrawer = $("#orderDrawer");

let currentView = "products";
let orders = [];
let ordersState = "loading";
let orderFilter = { search: "", status: "open" };
let openOrderId = null;

function showView(view) {
  currentView = view;
  document.querySelectorAll(".admin-tabs [data-view]").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  });
  $("#view-products").hidden = view !== "products";
  $("#view-orders").hidden = view !== "orders";
  history.replaceState(null, "", view === "orders" ? "#orders" : location.pathname);
}

$(".admin-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-view]");
  if (tab) showView(tab.dataset.view);
});

/* Orders */

const ORDER_STATUS = {
  submitted: { label: "Needs tracking", badge: "badge-submitted" },
  transit: { label: "In transit", badge: "badge-transit" },
  received: { label: "Received", badge: "badge-received" },
  paid: { label: "Paid", badge: "badge-paid" },
  cancelled: { label: "Cancelled", badge: "badge-cancelled" },
};

// How each status change reads in an order's history.
const HISTORY_LABELS = {
  submitted: "Order submitted",
  transit: "Tracking added",
  received: "Marked received",
  paid: "Marked paid",
  cancelled: "Cancelled",
};

const ORDER_FILTERS = [
  ["open", "Open"],
  ["all", "All"],
  ["submitted", "Needs tracking"],
  ["transit", "In transit"],
  ["received", "Received"],
  ["paid", "Paid"],
  ["cancelled", "Cancelled"],
];

const TRACKING_URLS = {
  UPS: "https://www.ups.com/track?tracknum=",
  USPS: "https://tools.usps.com/go/TrackConfirmAction?tLabels=",
  FedEx: "https://www.fedex.com/fedextrack/?trknbr=",
};

const isOpen = (order) => order.status !== "paid" && order.status !== "cancelled";
const units = (order) => order.items.reduce((sum, item) => sum + item.quantity, 0);

function statusBadge(status) {
  const info = ORDER_STATUS[status] || ORDER_STATUS.submitted;
  return `<span class="badge ${info.badge}">${info.label}</span>`;
}

function formatDate(value, withTime = true) {
  return value
    ? new Intl.DateTimeFormat(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(new Date(value))
    : "—";
}

function sellerName(seller) {
  return seller.globalName || seller.username || seller.id;
}

function avatarUrl(seller) {
  if (seller.avatar) {
    return `https://cdn.discordapp.com/avatars/${seller.id}/${seller.avatar}.png?size=64`;
  }
  let index = 0;
  try {
    index = Number((BigInt(seller.id) >> 22n) % 6n);
  } catch (error) {
    // Not a Discord id (local testing)
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function trackingLink(order) {
  if (!order.tracking) {
    return `<span class="muted">Waiting for member</span>`;
  }
  const base = TRACKING_URLS[order.carrier];
  const number = escapeHtml(order.tracking);
  const link = base
    ? `<a class="tracking-link mono" href="${base}${encodeURIComponent(order.tracking)}" target="_blank" rel="noopener">${number}</a>`
    : `<span class="mono">${number}</span>`;
  return `${link}<small>${escapeHtml(order.carrier)}</small>`;
}

function visibleOrders() {
  const search = orderFilter.search.trim().toLowerCase();
  return orders.filter((order) => {
    if (orderFilter.status === "open" && !isOpen(order)) return false;
    if (!["open", "all"].includes(orderFilter.status) && order.status !== orderFilter.status) return false;
    if (!search) return true;
    const haystack = [
      order.id, order.tracking, order.seller.id, order.seller.username, order.seller.globalName,
      ...order.items.map((item) => item.name),
    ].join(" ").toLowerCase();
    return haystack.includes(search);
  });
}

function renderOrderKpis() {
  for (const status of ["submitted", "transit", "received", "paid"]) {
    const matching = orders.filter((order) => order.status === status);
    const key = status[0].toUpperCase() + status.slice(1);
    $(`#kpi${key}`).textContent = matching.length;
    $(`#kpi${key}Value`).textContent = matching.length ? formatMoney(matching.reduce((sum, order) => sum + order.total, 0)) : "";
  }
  const open = orders.filter(isOpen).length;
  $("#openOrdersCount").textContent = open;
  $("#openOrdersCount").hidden = !open;

  const counts = (key) => {
    if (key === "all") return orders.length;
    if (key === "open") return open;
    return orders.filter((order) => order.status === key).length;
  };
  orderStatusChips.innerHTML = ORDER_FILTERS.map(([key, label]) => `
    <button class="chip" type="button" data-status="${key}" aria-pressed="${orderFilter.status === key}">
      ${label}<span>${counts(key)}</span>
    </button>`).join("");
}

function orderRowHtml(order, index) {
  const first = order.items[0];
  const more = order.items.length > 1 ? ` + ${order.items.length - 1} more` : "";

  return `
    <tr data-order="${escapeHtml(order.id)}" style="--row: ${index}" tabindex="0" aria-label="Open ${escapeHtml(order.id)}">
      <td class="order-id-td"><strong class="mono">${escapeHtml(order.id)}</strong><small>${formatDate(order.createdAt)}</small></td>
      <td class="member-td">
        <div class="member-cell">
          <img class="avatar" src="${escapeHtml(avatarUrl(order.seller))}" alt="" loading="lazy">
          <div><strong>${escapeHtml(sellerName(order.seller))}</strong><small>@${escapeHtml(order.seller.username || order.seller.id)}</small></div>
        </div>
      </td>
      <td class="items-td"><span class="items-name">${escapeHtml(first?.name || "")}${escapeHtml(more)}</span><small>${units(order)} units</small></td>
      <td class="num total-td"><strong>${formatMoney(order.total)}</strong></td>
      <td class="tracking-td">${trackingLink(order)}</td>
      <td class="status-td">${statusBadge(order.status)}</td>
      <td class="open-td">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </td>
    </tr>`;
}

function renderOrders() {
  renderOrderKpis();

  if (ordersState !== "ready") {
    orderRows.innerHTML = "";
    ordersMessage.innerHTML = ordersState === "loading"
      ? `<div class="empty"><p>Loading orders…</p></div>`
      : `<div class="empty"><h3>Couldn't load orders</h3><p>Check your connection and try again.</p>
          <button class="btn btn-secondary" type="button" id="retryOrders">Try again</button></div>`;
    return;
  }

  const rows = visibleOrders();
  orderRows.innerHTML = rows.map(orderRowHtml).join("");

  if (rows.length) {
    ordersMessage.innerHTML = "";
  } else if (orders.length) {
    ordersMessage.innerHTML = `<div class="empty"><h3>No orders here</h3><p>Nothing matches this search or status.</p>
      <button class="btn btn-secondary" type="button" id="showAllOrders">Show all orders</button></div>`;
  } else {
    ordersMessage.innerHTML = `<div class="empty"><h3>No orders yet</h3><p>When members submit sell orders, they show up here.</p></div>`;
  }
}

async function loadOrders() {
  try {
    orders = (await api("GET", "/api/admin/orders")).orders;
    ordersState = "ready";
  } catch (error) {
    ordersState = "error";
  }
  renderOrders();

  if (openOrderId && orderDrawer.open) {
    renderOrderDrawer();
  }
}

orderSearch.addEventListener("input", () => {
  orderFilter.search = orderSearch.value;
  renderOrders();
});

orderStatusChips.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-status]");
  if (chip) {
    orderFilter.status = chip.dataset.status;
    renderOrders();
  }
});

document.querySelectorAll("[data-order-filter]").forEach((card) =>
  card.addEventListener("click", () => {
    orderFilter.status = card.dataset.orderFilter;
    renderOrders();
  }),
);

ordersMessage.addEventListener("click", (event) => {
  if (event.target.closest("#retryOrders")) {
    ordersState = "loading";
    renderOrders();
    loadOrders();
  } else if (event.target.closest("#showAllOrders")) {
    orderFilter = { search: "", status: "all" };
    orderSearch.value = "";
    renderOrders();
  }
});

$("#refreshOrders").addEventListener("click", async () => {
  await loadOrders();
  showToast("Orders refreshed.");
});

orderRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-order]");
  // Let the tracking link open the carrier's page without opening the drawer.
  if (row && !event.target.closest("a")) openOrder(row.dataset.order);
});

orderRows.addEventListener("keydown", (event) => {
  const row = event.target.closest("tr[data-order]");
  if (row && (event.key === "Enter" || event.key === " ") && event.target === row) {
    event.preventDefault();
    openOrder(row.dataset.order);
  }
});

/* Order drawer */

// The next step for each status, and what "Reopen" goes back to after a cancel.
const NEXT_STEP = {
  submitted: { status: "received", label: "Mark received" },
  transit: { status: "received", label: "Mark received" },
  received: { status: "paid", label: "Mark paid" },
};

function openOrder(orderId) {
  openOrderId = orderId;
  renderOrderDrawer();
  orderDrawer.showModal();
}

function renderOrderDrawer() {
  const order = orders.find((entry) => entry.id === openOrderId);
  if (!order) return;

  $("#orderDrawerTitle").innerHTML = `${escapeHtml(order.id)} ${statusBadge(order.status)}`;

  const photos = order.photos || { before: [], after: [] };
  const photoTiles = (set) => photos[set].map((name) => {
    const url = `/api/admin/orders/${encodeURIComponent(order.id)}/photos/${encodeURIComponent(name)}`;
    return `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${set === "before" ? "Before" : "After"} packing photo" loading="lazy"></a>`;
  }).join("");

  const history = (order.history || []).slice().reverse().map((entry) => `
    <li>
      <strong>${HISTORY_LABELS[entry.status] || entry.status}</strong>
      <span>${formatDate(entry.at)}</span>
      <small>by ${escapeHtml(entry.by || "—")}</small>
    </li>`).join("");

  $("#orderBody").innerHTML = `
    <div class="order-main">
      <section class="order-section">
        <h3 class="label">Sending it</h3>
        <div class="member-card">
          <img class="avatar avatar-lg" src="${escapeHtml(avatarUrl(order.seller))}" alt="">
          <div>
            <strong>${escapeHtml(sellerName(order.seller))}</strong>
            <small>@${escapeHtml(order.seller.username || order.seller.id)}</small>
            <button class="copy-id mono" type="button" data-copy="${escapeHtml(order.seller.id)}" title="Copy Discord ID">
              ID ${escapeHtml(order.seller.id)}
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
            </button>
          </div>
        </div>
      </section>

      <section class="order-section">
        <h3 class="label">Items</h3>
        <ul class="order-items">
          ${order.items.map((item) => `
            <li>
              <span><strong>${escapeHtml(item.name)}</strong><small>${item.quantity} × ${formatMoney(item.cashout)}</small></span>
              <span class="mono">${formatMoney(item.quantity * item.cashout)}</span>
            </li>`).join("")}
        </ul>
        <p class="order-total">Total cashout <strong>${formatMoney(order.total)}</strong></p>
      </section>

      <section class="order-section">
        <h3 class="label">Shipping</h3>
        ${order.tracking
          ? `<dl class="ship-facts">
              <div><dt>Carrier</dt><dd>${escapeHtml(order.carrier)}</dd></div>
              <div><dt>Tracking</dt><dd>${trackingLink(order)}</dd></div>
              <div><dt>Shipped</dt><dd>${formatDate(order.shippedAt)}</dd></div>
            </dl>
            <p class="photo-set-label">Before packing</p>
            <div class="order-photos">${photoTiles("before") || `<span class="muted">No photos</span>`}</div>
            <p class="photo-set-label">After packing</p>
            <div class="order-photos">${photoTiles("after") || `<span class="muted">No photos</span>`}</div>`
          : `<p class="muted">The member hasn't added tracking and photos yet.</p>`}
      </section>
    </div>

    <aside class="order-section order-timeline">
      <h3 class="label">History</h3>
      <ol class="timeline">${history}</ol>
    </aside>`;

  const next = NEXT_STEP[order.status];
  const actions = [];
  if (isOpen(order)) {
    actions.push(`<button class="btn btn-danger-ghost" type="button" data-order-status="cancelled">Cancel order</button>`);
  }
  if (order.status === "cancelled") {
    actions.push(`<button class="btn btn-secondary" type="button" data-order-reopen>Reopen</button>`);
  }
  actions.push(`<span class="spacer"></span>`);
  if (order.status === "submitted") {
    actions.push(`<span class="muted foot-note">Waiting for tracking from the member</span>`);
  }
  if (next) {
    actions.push(`<button class="btn btn-primary" type="button" data-order-status="${next.status}">${next.label}</button>`);
  }
  $("#orderActions").innerHTML = actions.join("");
}

async function setOrderStatus(order, status) {
  const updated = await api("PATCH", `/api/admin/orders/${encodeURIComponent(order.id)}`, { status });
  orders = orders.map((entry) => (entry.id === updated.id ? updated : entry));
  renderOrders();
  renderOrderDrawer();
  showToast(`${updated.id}: ${ORDER_STATUS[status].label.toLowerCase()}.`);
}

$("#orderActions").addEventListener("click", async (event) => {
  const order = orders.find((entry) => entry.id === openOrderId);
  const button = event.target.closest("[data-order-status], [data-order-reopen]");
  if (!order || !button) return;

  if (button.dataset.orderStatus === "cancelled") {
    askConfirm({
      title: `Cancel ${order.id}?`,
      text: `${sellerName(order.seller)}'s order for ${formatMoney(order.total)} will be marked cancelled. You can reopen it later.`,
      action: "Cancel order",
      run: () => setOrderStatus(order, "cancelled"),
    });
    return;
  }

  // Reopen goes back to the last status before the cancel.
  const status = button.dataset.orderStatus
    || [...(order.history || [])].reverse().find((entry) => entry.status !== "cancelled")?.status
    || "submitted";

  button.disabled = true;
  try {
    await setOrderStatus(order, status);
  } catch (error) {
    showToast(error.message, true);
    button.disabled = false;
  }
});

$("#orderBody").addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy]");
  if (!copy) return;
  try {
    await navigator.clipboard.writeText(copy.dataset.copy);
    showToast("Discord ID copied.");
  } catch (error) {
    showToast("Couldn't copy. Select the ID and copy it instead.", true);
  }
});

orderDrawer.addEventListener("click", (event) => {
  if (event.target.closest("[data-order-close]") || event.target === orderDrawer) {
    orderDrawer.close();
  }
});

orderDrawer.addEventListener("close", () => {
  openOrderId = null;
});

start();
