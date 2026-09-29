const ATTEMPT_KEY = "republishAttempt";

function statusLabel(status) {
  return {
    captured: "Concept opgeslagen",
    "form-opened": "Plaatsingsformulier geopend",
    "ready-for-review": "Velden hersteld — controleer en plaats via de marketplace",
    published: "Nieuwe advertentie is geplaatst",
    completed: "Oude advertentie is verwijderd",
    failed: "Actie vereist"
  }[status] || status || "Onbekende status";
}

async function render() {
  const { [ATTEMPT_KEY]: attempt } = await chrome.storage.local.get(ATTEMPT_KEY);
  document.querySelector("#empty").hidden = Boolean(attempt);
  document.querySelector("#attempt").hidden = !attempt;
  if (!attempt) return;

  document.querySelector("#title").textContent = attempt.listing?.title || "Naamloze advertentie";
  document.querySelector("#status").textContent = statusLabel(attempt.status);
}

document.querySelector("#open-source").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "republish:open-source" });
});

document.querySelector("#clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "republish:clear" });
  await render();
});

render();
