// ============================================
// Background Service Worker
// Orchestrates: Open ChatGPT → Send Prompts One by One → Auto-Download
// ChatGPT Multi Image Prompt v1.0.0
// ============================================

"use strict";

// ---- Default settings ----
const DEFAULT_SETTINGS = {
  folder: "ChatGPT-Images",
  prefix: "img",
  delay: 90,
  separator: "blank-line",
};

// ---- Filename override map ----
// chrome.downloads.download() ignores the filename param for blob/estuary URLs,
// so we intercept during Chrome's filename determination phase and force our name.
const pendingFilenames = new Map();

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const desiredFilename = pendingFilenames.get(downloadItem.id);
  if (desiredFilename) {
    pendingFilenames.delete(downloadItem.id);
    console.log(`[MultiImg] onDeterminingFilename: overriding "${downloadItem.filename}" → "${desiredFilename}"`);
    suggest({ filename: desiredFilename, conflictAction: "uniquify" });
    return true;
  }
});

// ---- State ----
let state = {
  isRunning: false,
  cancelled: false,
  chatgptTabId: null,
  currentPhase: null,
  results: null,
  totalPrompts: 0,
};

// ---- Utility: send message to a tab with retry ----
async function sendToTab(tabId, message, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (err) {
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content-chatgpt.js"],
          });
          await new Promise((r) => setTimeout(r, 1000));
        } catch (_) {}
      } else {
        throw err;
      }
    }
  }
}

// ---- Open a new tab and wait for it to load ----
async function openNewTab(url) {
  const tab = await chrome.tabs.create({ url, active: true });

  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === tab.id && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });

  await new Promise((r) => setTimeout(r, 4000));
  return tab.id;
}

// ---- Ensure a ChatGPT tab is open ----
async function ensureChatGPTTab(forceNew = false) {
  if (!forceNew && state.chatgptTabId) {
    try {
      const tab = await chrome.tabs.get(state.chatgptTabId);
      if (tab && tab.url && tab.url.includes("chatgpt.com")) {
        await chrome.tabs.update(state.chatgptTabId, { active: true });
        return state.chatgptTabId;
      }
    } catch (_) {}
  }

  if (!forceNew) {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (tabs.length > 0) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      return tabs[0].id;
    }
  }

  return await openNewTab("https://chatgpt.com/");
}

// ---- Broadcast status to popup ----
function broadcastStatus(data) {
  chrome.runtime.sendMessage({
    action: "statusUpdate",
    data,
  }).catch(() => {});
}

// ---- Get settings from storage ----
async function getSettings() {
  try {
    const result = await chrome.storage.local.get("multiImgSettings");
    return result.multiImgSettings || DEFAULT_SETTINGS;
  } catch (_) {
    return DEFAULT_SETTINGS;
  }
}

// ============================================================
// Auto-download images after generation completes
// ============================================================
async function phaseAutoDownload() {
  state.currentPhase = "auto-downloading";

  const settings = await getSettings();
  const folderPath = settings.folder || "ChatGPT-Images";

  broadcastStatus({
    phase: "auto-downloading",
    message: "All images generated! Auto-downloading...",
    progress: 92,
  });

  await new Promise((r) => setTimeout(r, 3000));

  if (!state.chatgptTabId) {
    console.error("[MultiImg] No ChatGPT tab for auto-download");
    return { downloaded: 0, total: 0, results: [] };
  }

  broadcastStatus({
    phase: "auto-downloading",
    message: `Saving to Downloads/${folderPath}/...`,
    progress: 95,
  });

  try {
    const result = await sendToTab(state.chatgptTabId, {
      action: "downloadAllImages",
      data: { folderPath, prefix: settings.prefix },
    });

    if (result && result.success && result.data) {
      return { ...result.data, folderPath };
    } else {
      console.warn("[MultiImg] Auto-download response:", result);
      return { downloaded: 0, total: 0, results: [], error: result?.error };
    }
  } catch (err) {
    console.error("[MultiImg] Auto-download failed:", err);
    return { downloaded: 0, total: 0, results: [], error: err.message };
  }
}

// ============================================================
// Main Pipeline
// ============================================================
async function runPipeline(config) {
  state.isRunning = true;
  state.cancelled = false;
  state.currentPhase = "generating";
  state.totalPrompts = config.prompts.length;
  state.results = null;

  try {
    // Open ChatGPT
    broadcastStatus({
      phase: "generating",
      message: "Opening ChatGPT...",
      progress: 2,
      currentPrompt: 0,
      totalPrompts: config.prompts.length,
    });

    state.chatgptTabId = await ensureChatGPTTab(true);

    await new Promise((r) => setTimeout(r, 3000));

    if (state.cancelled) throw new Error("Cancelled by user");

    // Send prompts to content script
    broadcastStatus({
      phase: "generating",
      message: "Starting batch image generation...",
      progress: 5,
      currentPrompt: 0,
      totalPrompts: config.prompts.length,
    });

    const response = await sendToTab(state.chatgptTabId, {
      action: "batchGenerate",
      data: {
        prompts: config.prompts,
        delay: config.delay,
      },
    });

    if (!response || !response.success) {
      throw new Error(
        `Batch generation failed: ${response?.error || "Unknown error"}`
      );
    }

    state.results = response.data;

    if (state.cancelled) throw new Error("Cancelled by user");

    // Auto-download all images
    const downloadResult = await phaseAutoDownload();

    if (state.cancelled) throw new Error("Cancelled by user");

    // Done!
    state.currentPhase = "done";
    const successCount = state.results
      ? state.results.filter((r) => r.success).length
      : 0;

    let dlMsg;
    if (downloadResult.downloaded > 0) {
      dlMsg = `All done! ${downloadResult.downloaded} images downloaded to Downloads/${downloadResult.folderPath || "ChatGPT-Images"}/`;
    } else {
      dlMsg = `All done! ${successCount} images generated. Use re-download to save them.`;
    }

    broadcastStatus({
      phase: "done",
      message: dlMsg,
      progress: 100,
      results: state.results,
      downloadResult,
    });
  } catch (err) {
    if (err.message === "Cancelled by user") {
      broadcastStatus({
        phase: "cancelled",
        message: "Cancelled by user.",
        progress: 0,
      });
    } else {
      broadcastStatus({
        phase: state.currentPhase || "error",
        message: `Error: ${err.message}`,
        progress: 0,
        isError: true,
      });
    }
  } finally {
    state.isRunning = false;
  }
}

// ============================================================
// Image Download Handler
// ============================================================
async function handleImageDownload(imageUrl, slideNumber, mimeType, promptText) {
  let settings = DEFAULT_SETTINGS;
  try {
    const result = await chrome.storage.local.get("multiImgSettings");
    if (result.multiImgSettings) settings = result.multiImgSettings;
  } catch (_) {}

  console.log("[MultiImg] handleImageDownload called:", {
    urlType: imageUrl.startsWith("blob:") ? "blob" : "direct",
    slideNumber,
    mimeType,
    settings,
  });

  const now = new Date();
  // Get timezone abbreviation (e.g., "GST", "EST", "PST")
  const tzAbbr = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}_${tzAbbr}`;
  // Use first 5 words of prompt text as filename base, fallback to prefix
  let nameBase = settings.prefix || "img";
  if (promptText && promptText.trim()) {
    const words = promptText.trim().split(/\s+/).slice(0, 5);
    // Sanitize: keep only letters, numbers, spaces → replace spaces with underscores
    nameBase = words
      .join(" ")
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase();
    if (!nameBase) nameBase = settings.prefix || "img";
  }
  const slideStr = slideNumber ? `_${slideNumber}` : "";

  // Detect file extension — prefer explicit mimeType from content script
  let ext = "png";
  if (mimeType) {
    if (mimeType.includes("jpeg") || mimeType.includes("jpg")) ext = "jpg";
    else if (mimeType.includes("webp")) ext = "webp";
    else if (mimeType.includes("png")) ext = "png";
  } else {
    if (imageUrl.includes(".jpg") || imageUrl.includes("image/jpeg")) ext = "jpg";
    else if (imageUrl.includes(".webp") || imageUrl.includes("image/webp")) ext = "webp";
  }

  const filename = `${nameBase}${slideStr}_${timestamp}.${ext}`;
  const folder = settings.folder || "ChatGPT-Images";
  const fullPath = `${folder}/${filename}`;

  console.log(`[MultiImg] Downloading to: ${fullPath} (url type: ${imageUrl.startsWith("blob:") ? "blob" : "direct"})`);

  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url: imageUrl,
        filename: fullPath,
        conflictAction: "uniquify",
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[MultiImg] Download start failed:",
            chrome.runtime.lastError.message
          );
          resolve({
            success: false,
            error: chrome.runtime.lastError.message,
          });
          return;
        }

        // Store desired filename so onDeterminingFilename can override
        pendingFilenames.set(downloadId, fullPath);
        console.log(`[MultiImg] Download started: id=${downloadId}, desired=${fullPath}`);

        const onChange = (delta) => {
          if (delta.id !== downloadId) return;

          if (delta.state?.current === "complete") {
            chrome.downloads.onChanged.removeListener(onChange);
            // Log the ACTUAL final path Chrome used
            chrome.downloads.search({ id: downloadId }, (items) => {
              if (items && items.length > 0) {
                console.log(`[MultiImg] Download COMPLETE — actual path: ${items[0].filename}`);
              }
            });
            resolve({ success: true, filename });
          }

          if (delta.state?.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChange);
            console.warn(`[MultiImg] Download interrupted: id=${downloadId}, error:`, delta.error);
            resolve({ success: false, error: delta.error?.current || "interrupted" });
          }
        };

        chrome.downloads.onChanged.addListener(onChange);

        setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChange);
          resolve({ success: false, error: "timeout" });
        }, 60000);
      }
    );
  });
}

// ============================================================
// Message handling
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case "startBatch":
      if (state.isRunning) {
        sendResponse({ success: false, error: "Already running" });
        return;
      }
      runPipeline(message.data);
      sendResponse({ success: true });
      break;

    case "cancelBatch":
      state.cancelled = true;
      state.isRunning = false;
      broadcastStatus({
        phase: "cancelled",
        message: "Cancelled by user.",
        progress: 0,
      });
      sendResponse({ success: true });
      break;

    case "getState":
      sendResponse({
        success: true,
        data: {
          isRunning: state.isRunning,
          currentPhase: state.currentPhase,
          results: state.results,
          totalPrompts: state.totalPrompts,
        },
      });
      break;

    case "downloadImageUrl":
      handleImageDownload(message.url, message.slideNumber, message.mimeType, message.promptText)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;

    case "startDownloadAll":
      {
        if (state.chatgptTabId) {
          (async () => {
            const settings = await getSettings();
            sendToTab(state.chatgptTabId, {
              action: "downloadAllImages",
              data: settings,
            })
              .then((result) => sendResponse(result))
              .catch((err) =>
                sendResponse({ success: false, error: err.message })
              );
          })();
        } else {
          sendResponse({
            success: false,
            error: "ChatGPT tab not found",
          });
        }
      }
      return true;

    case "quickDownload":
      {
        (async () => {
          try {
            let tabId = state.chatgptTabId;

            if (!tabId) {
              const tabs = await chrome.tabs.query({
                url: "https://chatgpt.com/*",
              });
              if (tabs.length > 0) {
                const activeTab = tabs.find((t) => t.active) || tabs[0];
                tabId = activeTab.id;
              }
            }

            if (!tabId) {
              sendResponse({
                success: false,
                error: "No ChatGPT tab found. Open chatgpt.com first.",
              });
              return;
            }

            // Ensure content script is injected
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ["content-chatgpt.js"],
              });
            } catch (_) {}
            await new Promise((r) => setTimeout(r, 500));

            const settings = await getSettings();
            const result = await sendToTab(tabId, {
              action: "downloadAllImages",
              data: settings,
            });
            sendResponse(result);
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();
      }
      return true;

    case "saveSettings":
      chrome.storage.local.set({ multiImgSettings: message.data });
      sendResponse({ success: true });
      break;

    case "getSettings":
      chrome.storage.local.get("multiImgSettings", (result) => {
        sendResponse({
          success: true,
          data: result.multiImgSettings || DEFAULT_SETTINGS,
        });
      });
      return true;

    case "statusUpdate":
      // Relay from content script to popup
      chrome.runtime.sendMessage(message).catch(() => {});
      break;

    default:
      break;
  }

  return true;
});

console.log("[MultiImg] Background service worker loaded (v1.0.0)");
