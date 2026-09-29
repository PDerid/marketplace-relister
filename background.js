const ATTEMPT_KEY = "republishAttempt";
const PLACEMENT_URL = "https://link.2dehands.be/link/placead/start";

async function getAttempt() {
  const result = await chrome.storage.local.get(ATTEMPT_KEY);
  return result[ATTEMPT_KEY] || null;
}

async function updateAttempt(patch) {
  const current = await getAttempt();
  if (!current) return null;

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [ATTEMPT_KEY]: next });
  return next;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "republish:open-placement": {
        const attempt = await updateAttempt({ status: "form-opened" });
        if (!attempt) throw new Error("Er is geen concept om te openen.");
        const tab = await chrome.tabs.create({ url: attempt.placementUrl || PLACEMENT_URL, active: true });
        sendResponse({ ok: true, tabId: tab.id });
        return;
      }
      case "republish:open-source": {
        const attempt = await getAttempt();
        if (!attempt?.sourceUrl) throw new Error("De oorspronkelijke advertentie ontbreekt.");
        const tab = await chrome.tabs.create({ url: attempt.sourceUrl, active: true });
        sendResponse({ ok: true, tabId: tab.id });
        return;
      }
      case "republish:clear": {
        const attempt = await getAttempt();
        const photoIds = attempt?.photos?.map((photo) => photo.id).filter(Boolean) || [];
        if (photoIds.length) {
          const tabs = await chrome.tabs.query({ url: ["https://*.2dehands.be/*"] });
          await Promise.all(tabs.map((tab) =>
            chrome.tabs.sendMessage(tab.id, { type: "republish:cleanup-photos", photoIds }).catch(() => undefined)
          ));
        }
        await chrome.storage.local.remove(ATTEMPT_KEY);
        sendResponse({ ok: true });
        return;
      }
      case "republish:update": {
        const attempt = await updateAttempt(message.patch || {});
        sendResponse({ ok: Boolean(attempt), attempt });
        return;
      }
      default:
        sendResponse({ ok: false, error: "Onbekende actie." });
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});
