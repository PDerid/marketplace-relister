(() => {
  const ATTEMPT_KEY = "republishAttempt";
  const DB_NAME = "r2d-republish-photos-v1";
  const DB_STORE = "photos";
  const PANEL_ID = "r2d-republish-panel";
  const BUTTON_ID = "r2d-republish-button";

  function openPhotoDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) {
          request.result.createObjectStore(DB_STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Foto-opslag kon niet worden geopend."));
    });
  }

  async function putPhoto(photo) {
    const db = await openPhotoDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(photo);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Foto kon niet worden opgeslagen."));
    });
  }

  async function getPhoto(id) {
    const db = await openPhotoDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readonly");
      const request = transaction.objectStore(DB_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Foto kon niet worden gelezen."));
    });
  }

  async function deletePhotos(photoIds) {
    if (!photoIds?.length) return;
    const db = await openPhotoDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      const store = transaction.objectStore(DB_STORE);
      photoIds.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Foto-opslag kon niet worden opgeschoond."));
    });
  }

  async function getAttempt() {
    const result = await chrome.storage.local.get(ATTEMPT_KEY);
    return result[ATTEMPT_KEY] || null;
  }

  async function saveAttempt(attempt) {
    await chrome.storage.local.set({ [ATTEMPT_KEY]: attempt });
    return attempt;
  }

  async function patchAttempt(patch) {
    const current = await getAttempt();
    if (!current) return null;
    return saveAttempt({ ...current, ...patch, updatedAt: new Date().toISOString() });
  }

  function text(node) {
    return node?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function ownListingId() {
    const match = location.pathname.match(/^\/seller\/view\/(m\d+)/i);
    return match?.[1] || null;
  }

  function isOwnedListingPage() {
    return Boolean(ownListingId() && findAction("verwijder"));
  }

  function isPlacementPage() {
    return /\/plaats(?:\/|$)/i.test(location.pathname) || /plaats(?:en)?\s+(?:zoekertje|advertentie)/i.test(document.title);
  }

  function isPlacementSuccessPage() {
    return /^\/seller\/view\/m\d+/i.test(location.pathname)
      && new URLSearchParams(location.search).get("previousAction") === "syiSuccess";
  }

  function findAction(label) {
    return [...document.querySelectorAll("button, a")].find((element) => text(element).toLowerCase() === label);
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const result = text(document.querySelector(selector));
      if (result) return result;
    }
    return "";
  }

  function firstElement(selectors) {
    for (const selector of selectors) {
      const result = document.querySelector(selector);
      if (result) return result;
    }
    return null;
  }

  function readJsonLd() {
    const values = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        // A malformed analytics structured-data block is not useful for a listing snapshot.
      }
    }
    return values.flatMap((value) => value?.["@graph"] || [value]);
  }

  function productMetadata() {
    const item = readJsonLd().find((value) => {
      const type = value?.["@type"];
      return type === "Product" || (Array.isArray(type) && type.includes("Product"));
    }) || {};
    const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers || {};
    return {
      title: item.name || "",
      description: item.description || "",
      price: offers.price ? String(offers.price) : ""
    };
  }

  function findLabelValue(labels) {
    const normalized = labels.map((label) => label.toLowerCase());
    const nodes = [...document.querySelectorAll("dt, th, h2, h3, h4, strong, span, div")];
    const labelNode = nodes.find((node) => normalized.includes(text(node).toLowerCase()));
    if (!labelNode) return "";
    const sibling = labelNode.nextElementSibling;
    if (sibling) return text(sibling);
    return text(labelNode.parentElement?.lastElementChild);
  }

  function parsePrice(value) {
    // The placement form uses Belgian decimal notation (for example, "9,00").
    // Store that exact form, rather than a JavaScript-style "9" or "9.00", so
    // React's price validation receives the same value a person would type.
    const match = String(value || "").replace(/\u00a0/g, " ")
      .match(/(?:€\s*)?([\d.,\s]+\d)/);
    if (!match) return "";

    const token = match[1].replace(/\s/g, "");
    let numeric;
    if (token.includes(",")) {
      // In a rendered Belgian amount, dots are thousands separators.
      numeric = token.replace(/\./g, "").replace(",", ".");
    } else {
      const dots = token.split(".");
      // JSON-LD prices can be formatted as 15.00. A single dot followed by
      // one or two digits is therefore a decimal point; 1.234 is thousands.
      numeric = dots.length === 2 && dots[1].length <= 2
        ? token
        : token.replace(/\./g, "");
    }
    const amount = Number(numeric);
    return Number.isFinite(amount) && amount >= 0
      ? amount.toFixed(2).replace(".", ",")
      : "";
  }

  function descriptionText(node) {
    // innerText retains paragraph and <br> breaks that textContent discards.
    return (node?.innerText || node?.textContent || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function findImages() {
    const seen = new Set();
    const imgSources = [...document.querySelectorAll("main img, [role=main] img")].map((image) => ({
      source: image.currentSrc || image.src,
      area: (image.naturalWidth || image.width || 0) * (image.naturalHeight || image.height || 0)
    }));
    // The marketplace renders inactive carousel slides as empty elements. Their only
    // image reference lives in the thumbnail's inline `background-image` style.
    const thumbnailSources = [...document.querySelectorAll('[style*="background-image"]')]
      .map((element) => {
        const match = (element.style.backgroundImage || "").match(/url\(["']?(.*?)["']?\)/i);
        return match?.[1] ? { source: match[1], area: 0 } : null;
      })
      .filter(Boolean);

    return [...imgSources, ...thumbnailSources]
      .map(({ source, area }, index) => {
        if (!source || source.startsWith("data:") || /\.svg(?:\?|$)/i.test(source)) return null;
        const url = originalImageUrl(source);
        const isListingCdn = new URL(url).hostname === "images.2dehands.com";
        // Carousel thumbnails can be smaller than 12,000 px². Keep every image
        // from the first-party listing CDN, but retain the size guard for page chrome.
        if (seen.has(url) || (!isListingCdn && area < 12_000)) return null;
        seen.add(url);
        return {
          id: `${Date.now()}-${index}-${crypto.randomUUID()}`,
          url,
          filename: filenameFromUrl(url, index),
          status: "pending"
        };
      })
      .filter(Boolean);
  }

  function originalImageUrl(source) {
    const url = new URL(source, location.href);
    // The carousel uses `rule=…_85` thumbnail URLs. The same endpoint without
    // `rule` returns the original JPEG, which is what needs to be re-uploaded.
    if (url.hostname === "images.2dehands.com" && /\/images\//.test(url.pathname)) {
      url.searchParams.delete("rule");
    }
    return url.href;
  }

  function filenameFromUrl(url, index) {
    try {
      const name = new URL(url).pathname.split("/").pop() || "foto";
      const safe = name.split("?")[0].replace(/[^a-z0-9._-]/gi, "_");
      return /\.(jpe?g|png|webp|gif)$/i.test(safe) ? safe : `foto-${index + 1}.jpg`;
    } catch {
      return `foto-${index + 1}.jpg`;
    }
  }

  function extractListing() {
    const metadata = productMetadata();
    const title = metadata.title || firstText(["main h1", "[role=main] h1", "h1"]);
    const rawPrice = firstText([
      '[data-testid="listingPrice"]',
      ".ListingHeader-module-price",
      "[data-testid*=price i]",
      "[class*=price i]"
    ]) || metadata.price || findLabelValue(["prijs", "vraagprijs"]);
    const rawMinimumBid = firstText([
      ".Bids-module-subtitle",
      "[data-testid*=minimum-bid i]",
      "[data-testid*=bid i]"
    ]);
    const descriptionNode = firstElement([
      ".Description-module-description",
      "[data-collapse-target=description] [data-collapsable=description]",
      "[data-testid*=description i]",
      "[data-testid*=omschrijving i]",
      "[class*=description i]",
      "[class*=omschrijving i]"
    ]);
    const description = descriptionText(descriptionNode) || metadata.description
      || sectionValue(["omschrijving", "beschrijving", "description"]);
    const category = [...document.querySelectorAll("nav a, [aria-label*=breadcrumb i] a")]
      .map(text)
      .filter(Boolean)
      .join(" | ");

    return {
      title,
      price: parsePrice(rawPrice),
      minimumBid: parsePrice(rawMinimumBid),
      description,
      category,
      attributes: extractAttributes(),
      editUrl: editUrl(),
      images: findImages()
    };
  }

  function editUrl() {
    const edit = document.querySelector('a.editButton[href*="/plaats/"][href$="/edit"], a[href*="/plaats/"][href$="/edit"]');
    return edit ? new URL(edit.getAttribute("href"), location.href).href : "";
  }

  function placementUrlFromListingPage(title) {
    const linkRoute = [...document.querySelectorAll("a[href]")]
      .map((link) => link.href)
      .find((href) => /\/plaats\/\d+\/\d+\?[^\s]*bucketId=\d+/i.test(href));
    const serializedRoute = [...document.scripts]
      .map((script) => script.textContent || "")
      .map((source) => source.match(/\/plaats\/\d+\/\d+\?[^"'\s]*bucketId=\d+[^"'\s]*/i)?.[0] || "")
      .find(Boolean);
    const route = linkRoute || serializedRoute;
    if (!route) return "";
    const url = new URL(route, location.href);
    url.searchParams.set("title", title || "");
    return url.href;
  }

  function formFieldsFromDocument(doc) {
    const nativeFields = [...doc.querySelectorAll("input, textarea, select")]
      .map((control) => {
        const key = control.getAttribute("name") || control.getAttribute("id");
        const type = (control.getAttribute("type") || "").toLowerCase();
      // The marketplace keeps the selected category ID in hidden form fields. Preserve
        // only category-related hidden values; other hidden fields can be CSRF or
        // one-time workflow state and must never be copied into a new listing.
        const isCategoryField = /(categor|rubriek|bucketid)/i.test(key);
        if (!key || ["file", "submit", "button", "reset"].includes(type)) return null;
        if (type === "hidden" && !isCategoryField) return null;
        if (["checkbox", "radio"].includes(type) && !control.checked) return null;
        return {
          key,
          type: control.tagName.toLowerCase() === "select" ? "select" : type || control.tagName.toLowerCase(),
          value: control.value,
          checked: Boolean(control.checked)
        };
      })
      .filter(Boolean);
    const richTextFields = [...doc.querySelectorAll('[contenteditable="true"]')]
      .map((control) => {
        const context = [
          control.getAttribute("name"),
          control.getAttribute("id"),
          control.getAttribute("aria-label"),
          control.getAttribute("data-testid"),
          text(control.parentElement)
        ].filter(Boolean).join(" ");
        const key = control.getAttribute("name") || control.getAttribute("id")
          || (/beschrijving|description|omschrijving/i.test(context) ? "description" : "");
        const value = text(control);
        return key && value ? { key, type: "richtext", value, checked: false } : null;
      })
      .filter(Boolean);
    return [...nativeFields, ...richTextFields];
  }

  function fieldValue(fields, expression) {
    return fields.find((field) => expression.test(field.key))?.value || "";
  }

  function placementUrlFromFields(fields, title) {
    const parentCategory = fieldValue(fields, /(?:parent|l1|level.?1).*categor/i);
    const category = fieldValue(fields, /(?:^|[^a-z])(?:l2|level.?2|categoryid)(?:$|[^a-z])/i);
    const bucket = fieldValue(fields, /bucketid/i);
    if (!parentCategory || !category || !bucket) return "";
    const query = new URLSearchParams({ bucketId: bucket, title: title || "" });
    return `${location.origin}/plaats/${encodeURIComponent(parentCategory)}/${encodeURIComponent(category)}?${query}`;
  }

  function isEditPage() {
    return /^\/plaats\/m\d+\/edit\/?$/i.test(location.pathname);
  }

  async function waitForEditFields() {
    const fieldsNow = () => formFieldsFromDocument(document);
    if (fieldsNow().length >= 3) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      return fieldsNow();
    }
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (fieldsNow().length >= 3) {
          observer.disconnect();
          window.setTimeout(() => resolve(fieldsNow()), 500);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      window.setTimeout(() => {
        observer.disconnect();
        resolve(fieldsNow());
      }, 15_000);
    });
  }

  async function captureLiveEditForm() {
    const attempt = await getAttempt();
    if (!attempt || attempt.status !== "capturing-edit" || attempt.editUrl !== location.href) return;
    const formFields = await waitForEditFields();
    const placementUrl = placementUrlFromFields(formFields, attempt.listing?.title);
    const response = await chrome.runtime.sendMessage({
      type: "republish:edit-captured",
      attemptId: attempt.id,
      formFields,
      placementUrl
    });
    if (!response?.ok) console.warn("[Marketplace Relister]", response?.error || "Bewerkingsformulier kon niet worden verwerkt.");
  }

  function sectionValue(labels) {
    const target = labels.map((label) => label.toLowerCase());
    const heading = [...document.querySelectorAll("h2, h3, h4, [role=heading]")]
      .find((element) => target.includes(text(element).toLowerCase()));
    if (!heading) return "";
    const next = text(heading.nextElementSibling);
    if (next) return next;
    const whole = text(heading.parentElement);
    return whole.replace(new RegExp(`^(${labels.join("|")})\\s*`, "i"), "").trim();
  }

  function extractAttributes() {
    const attributes = {};
    for (const list of document.querySelectorAll(".Attributes-module-list")) {
      const children = [...list.children];
      for (let index = 0; index < children.length - 1; index += 1) {
        const label = children[index];
        const value = children[index + 1];
        if (label.matches("p") && value.matches("span")) {
          const key = text(label);
          const attributeValue = text(value);
          if (key && attributeValue) attributes[key] = attributeValue;
        }
      }
    }
    for (const list of document.querySelectorAll("dl")) {
      const labels = list.querySelectorAll("dt");
      const values = list.querySelectorAll("dd");
      labels.forEach((label, index) => {
        const key = text(label);
        const value = text(values[index]);
        if (key && value) attributes[key] = value;
      });
    }
    return attributes;
  }

  async function cacheImages(images, onProgress) {
    const completed = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      onProgress?.(index, images.length);
      try {
        // Listing images are served by the marketplace CDN with ACAO: *. Browsers reject
        // that response when cookies are included, while the image URL itself is public.
        const sameOrigin = new URL(image.url).origin === location.origin;
        const response = await fetch(image.url, { credentials: sameOrigin ? "include" : "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith("image/")) throw new Error("Geen geldig afbeeldingsbestand");
        await putPhoto({ id: image.id, blob, filename: image.filename, cachedAt: Date.now() });
        completed.push({ ...image, status: "cached", mimeType: blob.type, bytes: blob.size });
      } catch (error) {
        completed.push({ ...image, status: "failed", error: error.message || "Foto kon niet worden opgeslagen" });
      }
    }
    return completed;
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    document.body.append(panel);
    return panel;
  }

  function showPanel({ title, message, detail = "", actions = [] }) {
    const panel = ensurePanel();
    panel.hidden = false;
    panel.replaceChildren();

    const close = document.createElement("button");
    close.type = "button";
    close.className = "r2d-close";
    close.setAttribute("aria-label", "Sluiten");
    close.textContent = "×";
    close.addEventListener("click", () => { panel.hidden = true; });

    const heading = document.createElement("h2");
    heading.textContent = title;
    const body = document.createElement("p");
    body.textContent = message;
    panel.append(close, heading, body);
    if (detail) {
      const muted = document.createElement("p");
      muted.className = "r2d-subtle";
      muted.textContent = detail;
      panel.append(muted);
    }
    if (actions.length) {
      const container = document.createElement("div");
      container.className = "r2d-actions";
      for (const action of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        if (action.kind) button.classList.add(action.kind);
        button.addEventListener("click", action.run);
        container.append(button);
      }
      panel.append(container);
    }
    return panel;
  }

  function buttonAction(label, run, kind = "") {
    return { label, run, kind };
  }

  async function captureAndStart(button) {
    button.disabled = true;
    try {
      const listing = extractListing();
      if (!listing.title) throw new Error("De titel kon niet betrouwbaar worden gelezen.");
      const confirmed = window.confirm(
        `Een nieuw concept maken voor “${listing.title}”?\n\nHet oude zoekertje blijft online totdat je later expliciet verwijdering bevestigt.`
      );
      if (!confirmed) return;

      const previousAttempt = await getAttempt();
      if (previousAttempt?.photos?.length) {
        await deletePhotos(previousAttempt.photos.map((photo) => photo.id));
      }
      const sourceId = ownListingId();
      const attempt = {
        version: 1,
        id: crypto.randomUUID(),
        sourceId,
        sourceUrl: location.href,
        placementUrl: placementUrlFromListingPage(listing.title)
          || (previousAttempt?.sourceId === sourceId ? previousAttempt.placementUrl || "" : ""),
        status: "captured",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        listing: {
          title: listing.title,
          price: listing.price,
          minimumBid: listing.minimumBid,
          description: listing.description,
          category: listing.category,
          attributes: listing.attributes,
          formFields: []
        },
        photos: listing.images
      };
      await saveAttempt(attempt);

      showPanel({
        title: "Foto's bewaren",
        message: listing.images.length ? `Foto 0 van ${listing.images.length} wordt bewaard…` : "Er zijn geen bruikbare foto's gevonden.",
        detail: "Het oorspronkelijke zoekertje blijft ongewijzigd."
      });
      const photos = await cacheImages(listing.images, (position, total) => {
        showPanel({
          title: "Foto's bewaren",
          message: `Foto ${position + 1} van ${total} wordt bewaard…`,
          detail: "Het oorspronkelijke zoekertje blijft ongewijzigd."
        });
      });
      await patchAttempt({ photos });

      const available = photos.filter((photo) => photo.status === "cached").length;
      showPanel({
        title: "Concept is klaar",
        message: `${available} van ${photos.length} foto’s zijn tijdelijk bewaard.`,
        detail: "De normale plaatsingspagina opent nu. Gebruik daar Velden invullen om ook de opgeslagen categorie te herstellen.",
        actions: [buttonAction("Open plaatsingspagina", openPlacement)]
      });
    } catch (error) {
      showPanel({
        title: "Concept niet aangemaakt",
        message: error.message || "Er ging iets mis.",
        detail: "Je oorspronkelijke zoekertje is niet gewijzigd."
      });
    } finally {
      button.disabled = false;
    }
  }

  async function openPlacement() {
    const response = await chrome.runtime.sendMessage({ type: "republish:open-placement" });
    if (!response?.ok) {
      showPanel({ title: "Plaatsingspagina niet geopend", message: response?.error || "Probeer opnieuw.", detail: "Je concept blijft bewaard." });
    }
  }

  function injectRepublishButton() {
    if (!isOwnedListingPage() || document.getElementById(BUTTON_ID)) return;
    const deleteAction = findAction("verwijder");
    if (!deleteAction) return;
    const container = deleteAction.parentElement?.parentElement?.children.length >= 2
      ? deleteAction.parentElement.parentElement
      : deleteAction.parentElement;
    if (!container) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "↻ Opnieuw plaatsen";
    button.setAttribute("aria-label", "Dit zoekertje opnieuw plaatsen");
    button.addEventListener("click", () => captureAndStart(button));
    container.append(button);
  }

  function normalizedFieldName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy.split(/\s+/).map((id) => text(document.getElementById(id))).join(" ")
      : "";
    return [element.name, element.id, element.getAttribute("aria-label"), element.placeholder, labelledText]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function controlFor(terms, selector = "input, textarea, [contenteditable=true]") {
    const loweredTerms = terms.map((term) => term.toLowerCase());
    const controls = [...document.querySelectorAll(selector)].filter((control) => !control.disabled);
    const direct = controls.find((control) => loweredTerms.some((term) => normalizedFieldName(control).includes(term)));
    if (direct) return direct;

    for (const label of document.querySelectorAll("label")) {
      if (!loweredTerms.some((term) => text(label).toLowerCase().includes(term))) continue;
      const target = label.htmlFor && document.getElementById(label.htmlFor);
      if (target?.matches(selector)) return target;
      const nested = label.querySelector(selector);
      if (nested) return nested;
      const next = label.nextElementSibling;
      if (next?.matches(selector)) return next;
      const adjacent = label.parentElement?.querySelector(selector);
      if (adjacent) return adjacent;
    }
    return null;
  }

  function setControlValue(control, value) {
    if (!control || value === undefined || value === null || value === "") return false;
    if (control.isContentEditable) {
      control.textContent = value;
    } else {
      const prototype = control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      setter?.call(control, value);
    }
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function setCheckboxAttributeValues(label, value) {
    const normalizedLabel = label.trim().toLowerCase();
    const groupTitle = [...document.querySelectorAll("legend, strong, h2, h3, h4")]
      .find((element) => text(element).trim().toLowerCase() === normalizedLabel);
    if (!groupTitle) return false;

    const group = groupTitle.parentElement;
    const checkboxes = [...(group?.querySelectorAll('input[type="checkbox"]') || [])];
    if (!checkboxes.length) return false;

    const requestedValues = value.split(/[,;\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    let selected = 0;
    for (const requestedValue of requestedValues) {
      const checkbox = checkboxes.find((input) => {
        const checkboxLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        return input.value.trim().toLowerCase() === requestedValue
          || text(checkboxLabel).trim().toLowerCase() === requestedValue;
      });
      if (!checkbox) continue;
      if (!checkbox.checked) checkbox.click();
      selected += 1;
    }
    return selected > 0;
  }

  async function setAttributeValue(label, value) {
    // A multi-select field has a group heading (such as "Eigenschappen") and
    // individual checkbox labels. Match the saved values to those labels.
    if (setCheckboxAttributeValues(label, value)) return true;

    const control = controlFor([label], "input, select, button, [role=combobox], [role=button]");
    if (!control || !value) return false;
    if (control.matches("button, [role=combobox], [role=button]")) {
      control.click();
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      const option = [...document.querySelectorAll('[role="option"], [role="menuitem"], li, button')]
        .find((element) => element !== control && element.getClientRects().length
          && text(element).trim().toLowerCase() === value.trim().toLowerCase());
      if (!option) return false;
      option.click();
      return true;
    }
    if (control instanceof HTMLSelectElement) {
      const option = [...control.options].find((item) => text(item).toLowerCase() === value.toLowerCase());
      if (!option) return false;
      control.value = option.value;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (control instanceof HTMLInputElement && control.type === "radio") {
      const radios = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`)];
      const matchingRadio = radios.find((radio) => {
        const radioLabel = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
        return radio.value.toLowerCase() === value.toLowerCase() || text(radioLabel).toLowerCase() === value.toLowerCase();
      });
      if (!matchingRadio) return false;
      matchingRadio.click();
      return true;
    }
    return setControlValue(control, value);
  }

  function formControlByKey(key) {
    const escaped = CSS.escape(key);
    const direct = document.querySelector(`[name="${escaped}"], #${escaped}`);
    if (direct) return direct;
    if (/beschrijving|description|omschrijving/i.test(key)) {
      return controlFor(["omschrijving", "beschrijving", "description"], "textarea, [contenteditable=true]");
    }
    return null;
  }

  function restoreEditFormFields(fields) {
    let restored = 0;
    for (const field of fields || []) {
      const control = formControlByKey(field.key);
      if (!control || control.disabled) continue;
      if (field.type === "select" && control instanceof HTMLSelectElement) {
        const option = [...control.options].find((item) => item.value === field.value || text(item) === field.value);
        if (!option) continue;
        control.value = option.value;
        control.dispatchEvent(new Event("change", { bubbles: true }));
        restored += 1;
      } else if (field.type === "radio" && control instanceof HTMLInputElement) {
        const matching = [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(field.key)}"]`)]
          .find((item) => item.value === field.value);
        if (matching) {
          matching.click();
          restored += 1;
        }
      } else if (field.type === "checkbox" && control instanceof HTMLInputElement) {
        if (control.checked !== field.checked) control.click();
        restored += 1;
      } else if (setControlValue(control, field.value)) {
        restored += 1;
      }
    }
    return restored;
  }

  async function fillTextFields(attempt) {
    const listing = attempt.listing || {};
    const title = controlFor(["titel", "title", "onderwerp"]);
    const description = document.querySelector('[data-testid="text-editor-input_nl-BE"][contenteditable="true"]')
      || controlFor(["omschrijving", "beschrijving", "description"], "textarea, [contenteditable=true]")
      || document.querySelector("main [contenteditable=true], [role=main] [contenteditable=true]");
    const price = document.querySelector('input[name="price.value"]')
      || controlFor(["prijs", "price", "vraagprijs"]);
    const minimumBid = document.querySelector('input[name="price.minimumBidPrice"]')
      || controlFor(["bieden vanaf", "minimum bod", "minimumbod", "minimum bid"]);
    const results = {
      title: setControlValue(title, listing.title),
      description: setControlValue(description, listing.description),
      price: setControlValue(price, listing.price),
      minimumBid: setControlValue(minimumBid, listing.minimumBid)
    };
    let restoredAttributes = 0;
    for (const [label, value] of Object.entries(listing.attributes || {})) {
      if (/^(prijs|price|omschrijving|beschrijving|description)$/i.test(label)) continue;
      if (await setAttributeValue(label, value)) restoredAttributes += 1;
    }
    results.attributes = restoredAttributes;
    results.editForm = restoreEditFormFields(listing.formFields);
    return results;
  }

  function categoryControl() {
    const direct = document.querySelector([
      '[role="combobox"]',
      '[data-role*="categor" i]',
      '[data-testid*="categor" i]',
      'input[name*="categor" i]',
      'input[id*="categor" i]',
      'input[placeholder*="categor" i]',
      'input[aria-label*="categor" i]',
      'button[name*="categor" i]',
      'button[aria-label*="categor" i]',
      '[role="button"][aria-label*="categor" i]'
    ].join(", "));
    if (direct) return direct;
    const terms = /\b(categorie|category|rubriek)\b/i;
    return [...document.querySelectorAll('input, button, [role="button"], [role="combobox"], [tabindex]')]
      .find((element) => !element.disabled && element.getClientRects().length && terms.test(
        `${normalizedFieldName(element)} ${text(element)} ${element.getAttribute("title") || ""}`
      )) || null;
  }

  function openCategoryPicker() {
    const control = categoryControl();
    if (!control) return false;
    control.focus({ preventScroll: true });
    control.click();
    return true;
  }

  async function attachPhotos(attempt) {
    const input = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
    if (!input) throw new Error("Kies eerst een categorie zodat de foto-upload beschikbaar is.");

    const cached = attempt.photos?.filter((photo) => photo.status === "cached") || [];
    if (!cached.length) throw new Error("Er zijn geen opgeslagen foto's om toe te voegen.");

    const transfer = new DataTransfer();
    for (const photo of cached) {
      const record = await getPhoto(photo.id);
      if (!record?.blob) continue;
      transfer.items.add(new File([record.blob], photo.filename || record.filename || "foto.jpg", {
        type: record.blob.type || photo.mimeType || "image/jpeg"
      }));
    }
    if (!transfer.files.length) throw new Error("De tijdelijk opgeslagen foto's zijn niet meer beschikbaar.");

    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return transfer.files.length;
  }

  async function restoreForm() {
    const attempt = await getAttempt();
    if (!attempt) return;
    const results = await fillTextFields(attempt);
    // The category component is mounted/re-rendered by the marketplace after the other
    // form values change. Trigger it only after that render has settled.
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
    const categoryOpened = openCategoryPicker();
    await patchAttempt({ status: "ready-for-review" });
    const restored = Object.values(results).filter(Boolean).length;
    showPlacementPanel({
      title: "Velden ingevuld",
      message: `${restored} veld(en) ingevuld. Controleer alle gegevens op de pagina.`,
      detail: categoryOpened
        ? "De categoriekeuze is ook geopend. Kies alleen nog iets als de marketplace de opgeslagen categorie niet al toont."
        : (attempt.listing?.category ? `Oorspronkelijke categorie: ${attempt.listing.category}` : "Controleer of de marketplace de herstelde categorie toont.")
    });
  }

  async function restorePhotos() {
    try {
      const attempt = await getAttempt();
      if (!attempt) return;
      const count = await attachPhotos(attempt);
      showPlacementPanel({ title: "Foto's toegevoegd", message: `${count} foto('s) aan de normale upload toegevoegd.`, detail: "Wacht tot de marketplace elke foto heeft verwerkt voordat je plaatst." });
    } catch (error) {
      showPlacementPanel({ title: "Foto's niet toegevoegd", message: error.message || "Probeer opnieuw.", detail: "Je kunt altijd de originele bestanden handmatig kiezen." });
    }
  }

  function showPlacementPanel(overrides = {}) {
    showPanel({
      title: "Herplaats-concept",
      message: "Vul de originele gegevens en categorie in, voeg de foto's toe, controleer alles en plaats via de normale marketplace-knop.",
      detail: "De extensie klikt nooit op de definitieve plaatsings-, CAPTCHA- of betaalstap.",
      actions: [
        buttonAction("Velden invullen", restoreForm),
        buttonAction("Foto's toevoegen", restorePhotos, "r2d-secondary")
      ],
      ...overrides
    });
  }

  async function showPendingPlacement() {
    const attempt = await getAttempt();
    if (!attempt || ["completed", "published"].includes(attempt.status)) return;
    if (/^\/plaats\/\d+\/\d+\/?$/i.test(location.pathname)) {
      await patchAttempt({ placementUrl: location.href });
    }
    showPlacementPanel({
      detail: attempt.listing?.category
        ? `Oorspronkelijke categorie: ${attempt.listing.category}. Deze wordt samen met de overige velden hersteld.`
        : "De categorie wordt samen met de overige opgeslagen velden hersteld."
    });
  }

  function xsrfToken() {
    const meta = document.querySelector('meta[name="xsrf-token"], meta[name="csrf-token"]')?.getAttribute("content");
    if (meta) return meta;
    const input = document.querySelector('input[name*="xsrf" i], input[name*="csrf" i]')?.value;
    if (input) return input;
    for (const script of document.scripts) {
      const source = script.textContent || "";
      const match = source.match(/(?:xsrfToken|xsrf\.token)\"?\s*[:=]\s*\"([^\"]+)/i);
      if (match?.[1]) return match[1];
    }
    return "";
  }

  async function deleteOriginal() {
    const attempt = await getAttempt();
    if (!attempt?.sourceId || ownListingId() !== attempt.sourceId) return;
    const accepted = window.confirm(
      "De nieuwe advertentie is bevestigd als geplaatst. Wil je het oorspronkelijke zoekertje nu definitief verwijderen? Dit kan niet ongedaan worden gemaakt."
    );
    if (!accepted) return;

    showPanel({
      title: "Verwijderreden",
      message: "Kies de correcte reden die de marketplace bij de verwijdering moet ontvangen.",
      detail: "Het oude zoekertje wordt pas verwijderd wanneer je hieronder bevestigt."
    });
    const panel = ensurePanel();
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Verwijderreden");
    select.innerHTML = '<option value="">Kies een reden</option><option value="NO_DEAL_VIA_MP">Geen overeenkomst via de marketplace</option>';
    const actions = document.createElement("div");
    actions.className = "r2d-actions";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "r2d-danger";
    confirm.textContent = "Verwijder origineel";
    confirm.addEventListener("click", async () => {
      if (!select.value) return;
      confirm.disabled = true;
      try {
        const headers = { "content-type": "application/json", accept: "application/json" };
        const token = xsrfToken();
        if (token) headers["x-xsrf-token"] = token;
        const response = await fetch("/seller/api/delete-ad", {
          method: "DELETE",
          credentials: "same-origin",
          headers,
          body: JSON.stringify({ itemId: attempt.sourceId, reason: select.value })
        });
        if (!response.ok) throw new Error(`De marketplace antwoordde met HTTP ${response.status}.`);
        await patchAttempt({ status: "completed", deletedAt: new Date().toISOString() });
        await deletePhotos(attempt.photos?.map((photo) => photo.id));
        showPanel({ title: "Oorspronkelijk zoekertje verwijderd", message: "De nieuwe advertentie blijft online.", detail: "De tijdelijk opgeslagen foto's zijn opgeruimd." });
      } catch (error) {
        showPanel({
          title: "Automatisch verwijderen is niet gelukt",
          message: error.message || "De marketplace accepteerde de verwijdering niet.",
          detail: "Je nieuwe advertentie blijft online. Gebruik eventueel de gewone knop Verwijder voor het originele zoekertje."
        });
      }
    });
    actions.append(confirm);
    panel.append(select, actions);
  }

  async function handlePlacementSuccess() {
    const attempt = await getAttempt();
    const createdId = ownListingId();
    if (!attempt || !createdId || createdId === attempt.sourceId) return;
    await patchAttempt({ status: "published", publishedId: createdId, publishedUrl: location.href, publishedAt: new Date().toISOString() });
    showPanel({
      title: "Nieuwe advertentie geplaatst",
       message: "De marketplace heeft de plaatsing bevestigd. Je oorspronkelijke zoekertje is nog niet verwijderd.",
      detail: "Open het origineel om de verwijdering afzonderlijk te bevestigen.",
      actions: [buttonAction("Open origineel", async () => {
        const response = await chrome.runtime.sendMessage({ type: "republish:open-source" });
        if (!response?.ok) showPanel({ title: "Origineel niet geopend", message: response?.error || "Probeer opnieuw." });
      })]
    });
  }

  async function showDeletionOffer() {
    const attempt = await getAttempt();
    if (!attempt || attempt.status !== "published" || attempt.sourceId !== ownListingId()) return;
    showPanel({
      title: "Nieuwe advertentie is geplaatst",
      message: "Wil je dit oorspronkelijke zoekertje nu verwijderen?",
      detail: "Dit gebeurt pas na je afzonderlijke bevestiging.",
      actions: [buttonAction("Oude advertentie verwijderen", deleteOriginal, "r2d-danger")]
    });
  }

  function observeListing() {
    injectRepublishButton();
    const observer = new MutationObserver(() => injectRepublishButton());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "republish:cleanup-photos") return;
    deletePhotos(message.photoIds || [])
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });

  async function init() {
    if (isPlacementSuccessPage()) {
      await handlePlacementSuccess();
      return;
    }
    if (ownListingId()) {
      observeListing();
      await showDeletionOffer();
      return;
    }
    if (isPlacementPage()) await showPendingPlacement();
  }

  init().catch((error) => console.warn("[Marketplace Relister]", error));
})();
