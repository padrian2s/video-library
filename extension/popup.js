const serverUrlInput = document.getElementById("serverUrl");
const apiKeyInput = document.getElementById("apiKey");
const currentUrlDiv = document.getElementById("currentUrl");
const sendBtn = document.getElementById("sendBtn");
const statusDiv = document.getElementById("status");
const saveSettingsLink = document.getElementById("saveSettings");

let tabUrl = "";
let tabTitle = "";
let tabThumbnail = "";
let tabId = null;

// Load saved settings
chrome.storage.local.get(["serverUrl", "apiKey"], (data) => {
  serverUrlInput.value = data.serverUrl || "http://localhost:3000";
  apiKeyInput.value = data.apiKey || "";
});

// Get current tab info and extract og:image thumbnail
chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  if (tabs[0]) {
    tabUrl = tabs[0].url;
    tabTitle = tabs[0].title || "";
    tabId = tabs[0].id;
    currentUrlDiv.textContent = tabUrl;

    // Try to extract og:image from the page for non-YouTube URLs
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: () => {
          const meta = document.querySelector(
            'meta[property="og:image"], meta[name="og:image"]'
          );
          return meta ? meta.getAttribute("content") : null;
        },
      });
      if (results && results[0] && results[0].result) {
        tabThumbnail = results[0].result;
      }
    } catch {}
  }
});

// Save settings
saveSettingsLink.addEventListener("click", () => {
  chrome.storage.local.set({
    serverUrl: serverUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
  });
  statusDiv.textContent = "Settings saved";
  statusDiv.className = "status ok";
});

// Send URL
sendBtn.addEventListener("click", async () => {
  const server = serverUrlInput.value.trim().replace(/\/+$/, "");
  const key = apiKeyInput.value.trim();

  if (!server) return showStatus("Enter server URL", true);
  if (!key) return showStatus("Enter API key", true);
  if (!tabUrl) return showStatus("No URL to send", true);

  sendBtn.disabled = true;
  sendBtn.textContent = "Sending...";

  try {
    const res = await fetch(`${server}/api/urls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({ url: tabUrl, title: tabTitle, thumbnail: tabThumbnail || undefined }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 409) {
      showStatus("Already saved", false);
      chrome.storage.local.set({ serverUrl: server, apiKey: key });
      return;
    }

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    // Auto-save settings on successful send
    chrome.storage.local.set({
      serverUrl: server,
      apiKey: key,
    });

    showStatus("Saved!", false);
  } catch (e) {
    showStatus(e.message, true);
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Save URL";
  }
});

function showStatus(msg, isError) {
  statusDiv.textContent = msg;
  statusDiv.className = `status ${isError ? "err" : "ok"}`;
}
