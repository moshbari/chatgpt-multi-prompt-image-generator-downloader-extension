// ============================================
// Popup Script — UI Logic & Messaging
// ChatGPT Multi Image Prompt v1.0.0
// Steps: Input → Progress → Done
// ============================================

document.addEventListener("DOMContentLoaded", () => {
  // ---- DOM references ----
  const stepInput = document.getElementById("step-input");
  const stepProgress = document.getElementById("step-progress");
  const stepDone = document.getElementById("step-done");

  const promptsTextarea = document.getElementById("prompts-textarea");
  const promptCount = document.getElementById("prompt-count");
  const separatorSelect = document.getElementById("separator");
  const delayRange = document.getElementById("delay-range");
  const delayValue = document.getElementById("delay-value");
  const downloadFolder = document.getElementById("download-folder");
  const downloadPrefix = document.getElementById("download-prefix");

  const btnStart = document.getElementById("btn-start");
  const btnCancel = document.getElementById("btn-cancel");
  const btnNew = document.getElementById("btn-new");
  const btnRedownload = document.getElementById("btn-redownload");

  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const trackerCurrent = document.getElementById("tracker-current");
  const trackerTotal = document.getElementById("tracker-total");
  const statusLog = document.getElementById("status-log");
  const currentAction = document.getElementById("current-action");

  const doneSummary = document.getElementById("done-summary");
  const downloadStatus = document.getElementById("download-status");
  const resultsSummary = document.getElementById("results-summary");

  const btnDownloadAll = document.getElementById("btn-download-all");
  const quickDlStatus = document.getElementById("quick-dl-status");

  // ---- Step management ----
  function showStep(stepEl) {
    [stepInput, stepProgress, stepDone].forEach((s) =>
      s.classList.remove("active")
    );
    stepEl.classList.add("active");
  }

  // ---- Parse prompts from textarea ----
  function parsePrompts() {
    const text = promptsTextarea.value.trim();
    if (!text) return [];

    const sep = separatorSelect.value;
    let prompts = [];

    switch (sep) {
      case "blank-line":
        prompts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
        break;
      case "triple-dash":
        prompts = text.split(/---+/).map((p) => p.trim()).filter(Boolean);
        break;
      case "numbered":
        prompts = text.split(/\n\s*\d+[\.\)]\s+/).map((p) => p.trim()).filter(Boolean);
        // Also handle if the first item starts with a number
        if (prompts.length === 0) {
          prompts = text.split(/\d+[\.\)]\s+/).map((p) => p.trim()).filter(Boolean);
        }
        break;
      case "double-newline":
        prompts = text.split(/\n/).map((p) => p.trim()).filter(Boolean);
        break;
    }

    return prompts;
  }

  // ---- Update prompt count on input ----
  function updatePromptCount() {
    const prompts = parsePrompts();
    const count = prompts.length;
    promptCount.textContent = `${count} prompt${count !== 1 ? "s" : ""} detected`;
    promptCount.style.color = count > 0 ? "#10a37f" : "#ef4444";
  }

  promptsTextarea.addEventListener("input", updatePromptCount);
  separatorSelect.addEventListener("change", updatePromptCount);

  // ---- Delay slider ----
  delayRange.addEventListener("input", () => {
    delayValue.textContent = delayRange.value + "s";
  });

  // ---- Log helpers ----
  function addLogEntry(text, type = "info") {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${text}`;
    statusLog.appendChild(entry);
    statusLog.scrollTop = statusLog.scrollHeight;
  }

  // ---- Progress update ----
  function updateProgress(percent) {
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `${Math.round(percent)}%`;
  }

  // ---- Save settings to storage ----
  function saveSettings() {
    const folder = downloadFolder.value.trim() || "ChatGPT-Images";
    const prefix = downloadPrefix.value.trim() || "img";
    const delay = parseInt(delayRange.value, 10);
    const separator = separatorSelect.value;
    chrome.runtime.sendMessage({
      action: "saveSettings",
      data: { folder, prefix, delay, separator },
    });
  }

  // ---- Start button ----
  btnStart.addEventListener("click", () => {
    const prompts = parsePrompts();
    if (prompts.length === 0) {
      promptsTextarea.style.borderColor = "#ef4444";
      promptsTextarea.focus();
      return;
    }
    promptsTextarea.style.borderColor = "";

    // Save settings
    saveSettings();

    const delay = parseInt(delayRange.value, 10);

    const config = {
      prompts,
      delay,
      folder: downloadFolder.value.trim() || "ChatGPT-Images",
      prefix: downloadPrefix.value.trim() || "img",
    };

    showStep(stepProgress);
    statusLog.innerHTML = "";
    trackerCurrent.textContent = "0";
    trackerTotal.textContent = prompts.length.toString();
    updateProgress(0);
    currentAction.textContent = "Opening ChatGPT...";
    addLogEntry(`Starting batch: ${prompts.length} prompts, ${delay}s delay`, "info");

    chrome.runtime.sendMessage(
      { action: "startBatch", data: config },
      (response) => {
        if (!response || !response.success) {
          addLogEntry(
            `Failed to start: ${response?.error || "Unknown error"}`,
            "error"
          );
          currentAction.textContent = "Failed to start. Try again.";
        }
      }
    );
  });

  // ---- Cancel button ----
  btnCancel.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "cancelBatch" });
    addLogEntry("Cancelling...", "error");
    setTimeout(() => showStep(stepInput), 1500);
  });

  // ---- New batch button ----
  btnNew.addEventListener("click", () => {
    showStep(stepInput);
    promptsTextarea.value = "";
    promptsTextarea.focus();
    updatePromptCount();
  });

  // ---- Re-download button ----
  btnRedownload.addEventListener("click", async () => {
    btnRedownload.disabled = true;
    btnRedownload.textContent = "Re-downloading...";
    downloadStatus.className = "download-status-done progress";
    downloadStatus.textContent = "Scanning page for images...";

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "startDownloadAll" }, resolve);
      });

      if (!response || !response.success) {
        throw new Error(response?.error || "Failed to download");
      }

      const data = response.data;
      if (data && typeof data.downloaded === "number") {
        downloadStatus.className = "download-status-done success";
        downloadStatus.textContent = `Downloaded ${data.downloaded}/${data.total} images`;
      }
    } catch (err) {
      downloadStatus.className = "download-status-done error";
      downloadStatus.textContent = `Error: ${err.message}`;
    } finally {
      btnRedownload.disabled = false;
      btnRedownload.textContent = "Re-download All Images";
    }
  });

  // ---- Quick Download button ----
  btnDownloadAll.addEventListener("click", async () => {
    btnDownloadAll.disabled = true;
    btnDownloadAll.textContent = "Downloading...";
    quickDlStatus.textContent = "Scanning ChatGPT page for images...";
    quickDlStatus.className = "quick-dl-status progress";

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "quickDownload" }, resolve);
      });

      if (!response || !response.success) {
        throw new Error(response?.error || "Failed to download");
      }

      const data = response.data;
      quickDlStatus.className = "quick-dl-status success";
      quickDlStatus.textContent = `Downloaded ${data.downloaded}/${data.total} images`;
    } catch (err) {
      quickDlStatus.className = "quick-dl-status error";
      quickDlStatus.textContent = err.message;
    } finally {
      btnDownloadAll.disabled = false;
      btnDownloadAll.innerHTML = '<span class="dl-icon">&#11015;</span> Download All ChatGPT Images';
    }
  });

  // ---- Load saved settings ----
  chrome.runtime.sendMessage({ action: "getSettings" }, (response) => {
    if (response && response.success && response.data) {
      if (response.data.prefix) downloadPrefix.value = response.data.prefix;
      if (response.data.folder) downloadFolder.value = response.data.folder;
      if (response.data.delay) {
        delayRange.value = response.data.delay;
        delayValue.textContent = response.data.delay + "s";
      }
      if (response.data.separator) separatorSelect.value = response.data.separator;
    }
  });

  // ---- Listen for messages from background ----
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== "statusUpdate") return;

    const { phase, message: msg, progress, isError, currentPrompt, totalPrompts, results, downloadResult } = message.data;

    // Update tracker
    if (typeof currentPrompt === "number") {
      trackerCurrent.textContent = currentPrompt.toString();
    }
    if (typeof totalPrompts === "number") {
      trackerTotal.textContent = totalPrompts.toString();
    }

    // Generating phase
    if (phase === "generating" || phase === "cooldown") {
      if (!stepProgress.classList.contains("active")) {
        showStep(stepProgress);
        statusLog.innerHTML = "";
      }
      if (typeof progress === "number") updateProgress(progress);
      if (msg) {
        currentAction.textContent = msg;
        const logType = phase === "cooldown" ? "cooldown" : isError ? "error" : "info";
        // Only log non-cooldown-countdown messages (avoid spamming)
        if (phase !== "cooldown" || msg.includes("done") || msg.includes("Done")) {
          addLogEntry(msg, logType);
        } else {
          // Update the last cooldown entry instead of adding new ones
          const lastEntry = statusLog.querySelector(".log-entry.cooldown:last-child");
          if (lastEntry) {
            const time = new Date().toLocaleTimeString();
            lastEntry.textContent = `[${time}] ${msg}`;
          } else {
            addLogEntry(msg, "cooldown");
          }
        }
      }
      return;
    }

    // Auto-downloading phase
    if (phase === "auto-downloading") {
      if (!stepProgress.classList.contains("active")) {
        showStep(stepProgress);
      }
      if (typeof progress === "number") updateProgress(progress);
      if (msg) {
        currentAction.textContent = msg;
        addLogEntry(msg, isError ? "error" : "info");
      }
      return;
    }

    // Done
    if (phase === "done") {
      updateProgress(100);
      if (msg) {
        currentAction.textContent = msg;
        addLogEntry(msg, "success");
      }
      setTimeout(() => {
        showStep(stepDone);

        // Download result
        if (downloadResult) {
          const dr = downloadResult;
          downloadStatus.className = "download-status-done success";
          downloadStatus.textContent = `Downloaded ${dr.downloaded}/${dr.total} images to Downloads/${dr.folderPath || "ChatGPT-Images"}/`;
        } else if (msg) {
          downloadStatus.className = "download-status-done success";
          downloadStatus.textContent = msg;
        }

        // Results summary
        if (results && Array.isArray(results)) {
          renderResults(results);
          const successCount = results.filter((r) => r.success).length;
          doneSummary.textContent = `${successCount}/${results.length} images generated successfully.`;
        }
      }, 1500);
      return;
    }

    // Downloading progress
    if (phase === "downloading" || phase === "download-complete") {
      if (downloadStatus) {
        downloadStatus.textContent = msg || "";
        if (phase === "download-complete") {
          downloadStatus.className = "download-status-done success";
        } else if (isError) {
          downloadStatus.className = "download-status-done error";
        } else {
          downloadStatus.className = "download-status-done progress";
        }
      }
      return;
    }

    // Cancelled
    if (phase === "cancelled") {
      setTimeout(() => showStep(stepInput), 1500);
      return;
    }

    // Error fallback
    if (isError && msg) {
      currentAction.textContent = msg;
      addLogEntry(msg, "error");
    }
  });

  // ---- Render results ----
  function renderResults(results) {
    resultsSummary.innerHTML = "";
    results.forEach((r, i) => {
      const item = document.createElement("div");
      item.className = "result-item";
      const promptPreview = r.promptPreview || `Prompt ${i + 1}`;
      item.innerHTML = `
        <span class="result-num">#${i + 1}</span>
        <span class="result-text">${escapeHtml(promptPreview)}</span>
        <span class="result-status ${r.success ? "ok" : "fail"}">${r.success ? "OK" : "FAIL"}</span>
      `;
      resultsSummary.appendChild(item);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- On popup open, check existing state ----
  chrome.runtime.sendMessage({ action: "getState" }, (response) => {
    if (response && response.success && response.data) {
      const { isRunning, currentPhase, results, totalPrompts } = response.data;
      if (isRunning) {
        showStep(stepProgress);
        if (totalPrompts) trackerTotal.textContent = totalPrompts.toString();
        currentAction.textContent = "In progress...";
      } else if (currentPhase === "done" && results) {
        showStep(stepDone);
        renderResults(results);
        const successCount = results.filter((r) => r.success).length;
        doneSummary.textContent = `${successCount}/${results.length} images generated successfully.`;
        downloadStatus.className = "download-status-done success";
        downloadStatus.textContent = "Images downloaded. Use re-download if needed.";
      }
    }
  });

  // Initial prompt count
  updatePromptCount();
});
