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
let pendingDelete = null;
let toastTimer = null;

/* Helpers */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(value, cents = false) {
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
  if (event.key === "/" && !typing && !drawer.open && !confirmDialog.open) {
    event.preventDefault();
    searchInput.focus();
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

/* Delete */

function askDelete(product) {
  pendingDelete = product;
  $("#confirmText").textContent = `"${product.name}" will be removed from the buy list for all members. This can't be undone.`;
  confirmDialog.showModal();
  $("#confirmCancel").focus();
}

$("#confirmCancel").addEventListener("click", () => confirmDialog.close());

$("#confirmDelete").addEventListener("click", async () => {
  const product = pendingDelete;
  const button = $("#confirmDelete");
  button.disabled = true;
  button.textContent = "Deleting…";

  try {
    await api("DELETE", `/api/admin/products/${encodeURIComponent(product.id)}`);
    products = products.filter((entry) => entry.id !== product.id);
    confirmDialog.close();
    if (drawer.open) drawer.close();
    render();
    showToast(`${product.name} deleted.`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Delete product";
  }
});

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
  await loadProducts();
}

start();
