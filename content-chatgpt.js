// ============================================
// Content Script: ChatGPT Automation
// Injected into https://chatgpt.com/*
// ChatGPT Multi Image Prompt v1.0.0
// ============================================

(function () {
  "use strict";

  // Prevent double-injection
  if (window.__multiImagePromptInjected) return;
  window.__multiImagePromptInjected = true;

  console.log("[MultiImg] ChatGPT content script loaded");

  // ---- Selectors (from live DOM inspection March 2026) ----
  const SELECTORS = {
    // ChatGPT uses a ProseMirror contenteditable div
    inputField: "#prompt-textarea",
    // Send button (only visible when text is entered)
    sendButton: 'button[data-testid="send-button"]',
    // Stop button (visible while generating)
    stopButton: 'button[aria-label="Stop generating"]',
    stopButtonAlt: 'button[data-testid="stop-button"]',
    stopButtonAlt2: 'button[aria-label="Stop streaming"]',
    // Image container for generated images
    imageContainer: '[data-testid="image-paragen-multigen"]',
    // Conversation turns
    conversationTurn: '[data-testid^="conversation-turn-"]',
    // New chat button
    newChatButton: 'a[data-testid="create-new-chat-button"]',
    newChatButtonAlt: 'a[href="/"]',
    // Preference feedback buttons (appear after image generation)
    skipButton: "button",
    // "Creating image" text indicator during generation
    creatingImageText: ".text-token-text-secondary",
  };

  // ---- Utility: wait for element ----
  function waitForElement(selector, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for: ${selector}`));
      }, timeout);
    });
  }

  // ---- Utility: sleep ----
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- Find the input field ----
  async function getInputField() {
    const el = document.querySelector(SELECTORS.inputField);
    if (el) return el;
    return await waitForElement(SELECTORS.inputField, 15000);
  }

  // ---- Find the send button ----
  async function getSendButton(timeout = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const btn = document.querySelector(SELECTORS.sendButton);
      if (btn) return btn;
      await sleep(300);
    }
    throw new Error("Could not find ChatGPT send button");
  }

  // ---- Type text into ProseMirror editor ----
  async function typeIntoInput(text) {
    const input = await getInputField();
    input.focus();
    await sleep(300);

    // Clear existing content
    input.innerHTML = "";
    await sleep(100);

    // Create a paragraph with the text
    const p = document.createElement("p");
    p.textContent = text;
    input.appendChild(p);

    // Trigger events for ProseMirror to recognize the change
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

    await sleep(500);

    console.log("[MultiImg] Typed into ChatGPT:", text.substring(0, 60) + "...");
    await sleep(300);
  }

  // ---- Click send ----
  async function clickSend() {
    await sleep(500);
    const btn = await getSendButton();
    btn.click();
    console.log("[MultiImg] ChatGPT send button clicked");
    await sleep(1000);
  }

  // ---- Wait for ChatGPT to finish generating an image ----
  async function waitForImageGeneration(turnCountBeforeSend, timeout = 180000) {
    const startTime = Date.now();
    console.log("[MultiImg] Waiting for ChatGPT image generation...");
    console.log("[MultiImg] Turn count before send:", turnCountBeforeSend);

    // Wait for generation to start
    await sleep(3000);

    let sawGenerationActivity = false;

    while (Date.now() - startTime < timeout) {
      // Check for stop button (means still generating)
      const stopBtn =
        document.querySelector(SELECTORS.stopButton) ||
        document.querySelector(SELECTORS.stopButtonAlt) ||
        document.querySelector(SELECTORS.stopButtonAlt2);

      if (stopBtn) {
        sawGenerationActivity = true;
        console.log("[MultiImg] ChatGPT still generating (stop button visible)...");
        await sleep(3000);
        continue;
      }

      // Check if "Creating image" text is present
      const creatingText = Array.from(
        document.querySelectorAll(
          ".text-token-text-secondary, [data-message-author-role='assistant'] span"
        )
      ).find(
        (el) =>
          el.textContent.trim() === "Creating image" &&
          el.offsetParent !== null
      );

      if (creatingText) {
        sawGenerationActivity = true;
        console.log("[MultiImg] ChatGPT still creating image...");
        await sleep(3000);
        continue;
      }

      // No stop button and no "Creating image" text
      await sleep(2000);

      const currentTurnCount = document.querySelectorAll(
        SELECTORS.conversationTurn
      ).length;

      // Strategy 1: Check for preference buttons
      const prefButtons = Array.from(
        document.querySelectorAll("button")
      ).filter(
        (b) =>
          b.textContent.includes("Image 1 is better") ||
          b.textContent.includes("Image 2 is better") ||
          b.textContent.trim() === "Skip"
      );
      if (prefButtons.length > 0) {
        console.log("[MultiImg] Preference buttons detected — generation done!");
        return true;
      }

      // Strategy 2: New conversation turns appeared
      if (currentTurnCount > turnCountBeforeSend) {
        const turns = document.querySelectorAll(SELECTORS.conversationTurn);
        const lastTurn = turns[turns.length - 1];
        const turnText = lastTurn
          ? lastTurn.textContent.toLowerCase()
          : "";

        const imageCreated =
          turnText.includes("image created") ||
          turnText.includes("images created") ||
          turnText.includes("here's") ||
          turnText.includes("here is") ||
          turnText.includes("i've created") ||
          turnText.includes("i've generated") ||
          turnText.includes("generated the image") ||
          turnText.includes("created the image");

        const hasEstuaryImg = lastTurn
          ? lastTurn.querySelector('img[src*="/backend-api/estuary/"]')
          : false;

        if (imageCreated || hasEstuaryImg) {
          const recheckStop =
            document.querySelector(SELECTORS.stopButton) ||
            document.querySelector(SELECTORS.stopButtonAlt);
          if (!recheckStop) {
            console.log("[MultiImg] Image generation complete (new turn with image content)!");
            return true;
          }
        }

        // New turn + input ready + no stop button = done
        const inputReady = document.querySelector(SELECTORS.inputField);
        if (inputReady && !document.querySelector(SELECTORS.stopButton)) {
          console.log("[MultiImg] New turn + input ready — generation done!");
          return true;
        }
      }

      // Strategy 3: Fallback — saw generation activity that ended
      if (sawGenerationActivity) {
        const inputReady = document.querySelector(SELECTORS.inputField);
        if (inputReady) {
          console.log("[MultiImg] Fallback: generation activity ended + input ready — done!");
          return true;
        }
      }

      // Strategy 4: Time-based fallback
      if (Date.now() - startTime > 15000) {
        const inputReady = document.querySelector(SELECTORS.inputField);
        if (inputReady) {
          console.log("[MultiImg] Time-based fallback: 15s+ idle with input ready — done!");
          return true;
        }
      }

      await sleep(2000);
    }

    throw new Error("Timeout waiting for ChatGPT image generation (3 minutes)");
  }

  // ---- Click "Skip" on the preference prompt ----
  async function clickSkipPreference() {
    await sleep(1000);
    const skipBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent.trim() === "Skip"
    );
    if (skipBtn) {
      skipBtn.click();
      console.log("[MultiImg] Clicked Skip on preference prompt");
      await sleep(500);
    } else {
      console.log("[MultiImg] No Skip button found — continuing anyway");
    }
  }

  // ---- Process a single image prompt ----
  async function processImagePrompt(prompt, promptNumber, totalPrompts) {
    chrome.runtime.sendMessage({
      action: "statusUpdate",
      data: {
        phase: "generating",
        message: `Prompt ${promptNumber}/${totalPrompts}: Typing prompt...`,
        currentPrompt: promptNumber,
        totalPrompts,
      },
    });

    await typeIntoInput(prompt);

    // Record turn count BEFORE sending
    const turnCountBeforeSend = document.querySelectorAll(
      SELECTORS.conversationTurn
    ).length;

    chrome.runtime.sendMessage({
      action: "statusUpdate",
      data: {
        phase: "generating",
        message: `Prompt ${promptNumber}/${totalPrompts}: Sending to ChatGPT...`,
        currentPrompt: promptNumber,
        totalPrompts,
      },
    });

    await clickSend();

    chrome.runtime.sendMessage({
      action: "statusUpdate",
      data: {
        phase: "generating",
        message: `Prompt ${promptNumber}/${totalPrompts}: Waiting for image generation...`,
        currentPrompt: promptNumber,
        totalPrompts,
      },
    });

    await waitForImageGeneration(turnCountBeforeSend, 180000);

    // Skip the preference prompt
    await clickSkipPreference();

    chrome.runtime.sendMessage({
      action: "statusUpdate",
      data: {
        phase: "generating",
        message: `Prompt ${promptNumber}/${totalPrompts}: Image generated!`,
        currentPrompt: promptNumber,
        totalPrompts,
      },
    });

    return { promptNumber, success: true, promptPreview: prompt.substring(0, 60) };
  }

  // ---- Cooldown with countdown ----
  async function cooldownBetweenPrompts(currentPrompt, totalPrompts, cooldownSeconds) {
    for (let remaining = cooldownSeconds; remaining > 0; remaining--) {
      chrome.runtime.sendMessage({
        action: "statusUpdate",
        data: {
          phase: "cooldown",
          message: `Prompt ${currentPrompt}/${totalPrompts} done. Cooldown: ${remaining}s before next prompt...`,
          currentPrompt,
          totalPrompts,
        },
      });
      await sleep(1000);
    }
  }

  // ---- Process all image prompts sequentially ----
  async function handleBatchGenerate({ prompts, delay }) {
    const results = [];
    const cooldownSeconds = delay || 90;

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const promptNumber = i + 1;

      // Calculate progress: each prompt gets an equal slice of 5%-90%
      const progressBase = 5;
      const progressRange = 85;
      const progressPerPrompt = progressRange / prompts.length;
      const progress = Math.round(progressBase + (i * progressPerPrompt));

      chrome.runtime.sendMessage({
        action: "statusUpdate",
        data: {
          phase: "generating",
          message: `Starting prompt ${promptNumber}/${prompts.length}...`,
          progress,
          currentPrompt: promptNumber,
          totalPrompts: prompts.length,
        },
      });

      try {
        const result = await processImagePrompt(
          prompt,
          promptNumber,
          prompts.length
        );
        results.push(result);
      } catch (err) {
        chrome.runtime.sendMessage({
          action: "statusUpdate",
          data: {
            phase: "generating",
            message: `Prompt ${promptNumber}: Error - ${err.message}`,
            isError: true,
            currentPrompt: promptNumber,
            totalPrompts: prompts.length,
          },
        });
        results.push({
          promptNumber,
          success: false,
          error: err.message,
          promptPreview: prompt.substring(0, 60),
        });
      }

      // Rate-limit cooldown between prompts (skip after last)
      if (i < prompts.length - 1) {
        await cooldownBetweenPrompts(promptNumber, prompts.length, cooldownSeconds);
      }
    }

    // ---- Post-generation verification ----
    // Wait for all generated images to fully render in the DOM before
    // handing off to the download phase. The last image often needs
    // extra time because it was just generated and may still be loading
    // or transitioning from a blurry preview to the final sharp version.
    const expectedCount = results.filter((r) => r.success).length;
    if (expectedCount > 0) {
      console.log("[MultiImg] Verifying images in DOM (expecting up to", expectedCount, ")...");
      chrome.runtime.sendMessage({
        action: "statusUpdate",
        data: {
          phase: "generating",
          message: "All prompts sent! Waiting for images to finish rendering...",
          progress: 90,
          currentPrompt: prompts.length,
          totalPrompts: prompts.length,
        },
      });

      // Give the last image extra time to load before we even start checking
      await sleep(5000);

      const verifyStart = Date.now();
      const verifyTimeout = 60000; // 60s (increased from 30s)
      let lastCount = 0;
      let stableCount = 0;
      // Require more stable checks when images are missing vs when all found
      const STABLE_THRESHOLD_MISSING = 6; // 6 checks × 3s = 18s of no change
      const STABLE_THRESHOLD_COMPLETE = 2; // 2 checks × 3s = 6s

      while (Date.now() - verifyStart < verifyTimeout) {
        const currentImages = findGeneratedImages();
        if (currentImages.length >= expectedCount) {
          console.log("[MultiImg] All", currentImages.length, "images confirmed in DOM!");
          break;
        }

        if (currentImages.length === lastCount) {
          stableCount++;
          // Only give up early if we've waited long enough AND have at least some images
          const threshold = currentImages.length < expectedCount
            ? STABLE_THRESHOLD_MISSING
            : STABLE_THRESHOLD_COMPLETE;
          if (stableCount >= threshold && currentImages.length > 0) {
            console.log("[MultiImg] Image count stable at", currentImages.length, "/", expectedCount, "after", stableCount, "checks — proceeding");
            break;
          }
        } else {
          stableCount = 0;
          lastCount = currentImages.length;
        }

        console.log("[MultiImg] Found", currentImages.length, "/", expectedCount, "images — waiting...");
        await sleep(3000);
      }

      // Final extra wait to let the last image fully render its sharp version
      await sleep(3000);
    }

    return results;
  }

  // ============================================================
  // IMAGE DOWNLOAD FUNCTIONALITY
  // ============================================================

  // ---- Check if an image element is a blurry preview ----
  function isBlurryPreview(img) {
    let el = img;
    for (let i = 0; i < 5 && el; i++) {
      const style = window.getComputedStyle(el);
      const filter = style.filter || style.webkitFilter || "";
      if (filter.includes("blur")) return true;
      if (i > 0 && parseFloat(style.opacity) < 0.5) return true;
      if (style.visibility === "hidden" || style.display === "none") return true;
      if (i === 0) {
        const rect = img.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 100) return true;
      }
      if (style.transform && style.transform.includes("scale(0")) return true;
      el = el.parentElement;
    }

    if (!img.complete || img.naturalWidth === 0) return true;

    return false;
  }

  // ---- Find all generated images on the page ----
  function findGeneratedImages() {
    const seen = new Set();
    const candidates = [];

    for (const img of document.querySelectorAll("img")) {
      if (!img.src || seen.has(img.src)) continue;
      if (!img.src.includes("/backend-api/estuary/")) continue;

      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 500 || h < 500) continue;

      if (img.parentElement?.className?.includes("rounded-full")) continue;
      if (isBlurryPreview(img)) continue;

      seen.add(img.src);

      const turn = img.closest('[data-testid^="conversation-turn-"]');
      const turnId = turn ? turn.getAttribute("data-testid") : "unknown";

      candidates.push({ img, w, h, turnId, src: img.src });
    }

    // Fallback: image-paragen-multigen containers
    if (candidates.length === 0) {
      const containers = document.querySelectorAll(SELECTORS.imageContainer);
      for (const container of containers) {
        const imgs = container.querySelectorAll("img");
        for (const img of imgs) {
          if (!img.src || seen.has(img.src)) continue;
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (w < 500 || h < 500) continue;
          if (isBlurryPreview(img)) continue;

          seen.add(img.src);
          const turn = img.closest('[data-testid^="conversation-turn-"]');
          const turnId = turn ? turn.getAttribute("data-testid") : "unknown";
          candidates.push({ img, w, h, turnId, src: img.src });
        }
      }
    }

    // Group by conversation turn — keep best image per turn
    const turnMap = new Map();
    for (let idx = 0; idx < candidates.length; idx++) {
      const c = candidates[idx];
      c.domIndex = idx;
      const existing = turnMap.get(c.turnId);
      if (!existing) {
        turnMap.set(c.turnId, c);
      } else {
        const existingArea = existing.w * existing.h;
        const newArea = c.w * c.h;
        if (
          newArea > existingArea ||
          (newArea === existingArea && idx > existing.domIndex)
        ) {
          turnMap.set(c.turnId, c);
        }
      }
    }

    const found = Array.from(turnMap.values()).map((c) => c.img);
    console.log(
      "[MultiImg] Found",
      found.length,
      "generated images on ChatGPT page",
      "(filtered from",
      candidates.length,
      "candidates across",
      turnMap.size,
      "turns)"
    );
    return found;
  }

  // ---- Find the scroll container ----
  function findScrollContainer() {
    const main = document.querySelector("main");
    if (main) {
      const scrollable =
        main.querySelector('[class*="overflow-y"]') ||
        main.querySelector('[class*="scroll"]');
      if (
        scrollable &&
        scrollable.scrollHeight > scrollable.clientHeight + 50
      ) {
        return scrollable;
      }
    }

    let best = null;
    let bestH = 0;
    for (const div of document.querySelectorAll("div")) {
      const s = div.scrollHeight - div.clientHeight;
      if (s < 50) continue;
      const r = div.getBoundingClientRect();
      if (r.width < 300 || r.height < 200) continue;
      if (s > bestH) {
        best = div;
        bestH = s;
      }
    }
    return best || document.documentElement;
  }

  // ---- Download a single image via background.js ----
  // Strategy: fetch the image as a Blob (using cookies from the content
  // script context), then create an Object URL. Blob URLs have NO server
  // headers (no Content-Disposition), so chrome.downloads.download() will
  // properly respect our custom filename and folder path.
  async function downloadSingleImage(imgUrl, slideNumber, promptText) {
    let blobUrl = null;
    let mimeType = "image/png";

    try {
      const response = await fetch(imgUrl, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      mimeType = blob.type || "image/png";
      blobUrl = URL.createObjectURL(blob);
      console.log("[MultiImg] Created blob URL for image", slideNumber, "| type:", mimeType, "| size:", blob.size);
    } catch (err) {
      console.error("[MultiImg] Blob conversion failed, falling back to direct URL:", err);
      blobUrl = imgUrl;
    }

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "downloadImageUrl", url: blobUrl, slideNumber, mimeType, promptText },
        (response) => {
          // Revoke the blob URL after giving the download enough time to start
          if (blobUrl && blobUrl.startsWith("blob:")) {
            setTimeout(() => {
              URL.revokeObjectURL(blobUrl);
              console.log("[MultiImg] Revoked blob URL for image", slideNumber);
            }, 30000);
          }

          if (chrome.runtime.lastError) {
            console.error(
              "[MultiImg] Download message error:",
              chrome.runtime.lastError.message
            );
            resolve({
              success: false,
              error: chrome.runtime.lastError.message,
            });
            return;
          }
          if (response?.success) {
            console.log("[MultiImg] Downloaded:", response.filename);
            resolve({ success: true, filename: response.filename });
          } else {
            console.warn("[MultiImg] Download failed:", response?.error);
            resolve({
              success: false,
              error: response?.error || "Unknown error",
            });
          }
        }
      );
    });
  }

  // ---- Main: Scroll through page, find all images, download them ----
  async function handleDownloadAllImages({ folderPath, prefix }) {
    console.log("[MultiImg] Starting ChatGPT image download scan...");

    chrome.runtime.sendMessage({
      action: "statusUpdate",
      data: {
        phase: "downloading",
        message: "Scanning ChatGPT page for images...",
      },
    });

    const scroller = findScrollContainer();
    const viewHeight = scroller.clientHeight || window.innerHeight;
    const step = Math.floor(viewHeight * 0.6);

    scroller.scrollTop = 0;
    await sleep(500);

    const candidateMap = new Map();
    let scrollPos = 0;
    let stuckCount = 0;
    let lastScrollHeight = scroller.scrollHeight;

    let scanPass = 0;
    function collectCandidates() {
      scanPass++;
      for (const img of document.querySelectorAll("img")) {
        if (!img.src || !img.src.includes("/backend-api/estuary/")) continue;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (w < 500 || h < 500) continue;
        if (img.parentElement?.className?.includes("rounded-full")) continue;
        if (isBlurryPreview(img)) continue;

        const turn = img.closest('[data-testid^="conversation-turn-"]');
        const turnId = turn
          ? turn.getAttribute("data-testid")
          : `unknown-${img.src.slice(-20)}`;

        const existing = candidateMap.get(turnId);
        const area = w * h;
        if (
          !existing ||
          area > existing.area ||
          (area === existing.area &&
            existing.src !== img.src &&
            scanPass > existing.scanPass)
        ) {
          // Extract prompt text from the user turn preceding this image turn
          let promptText = "";
          if (turn) {
            const prevTurn = turn.previousElementSibling;
            if (prevTurn && prevTurn.getAttribute("data-testid")?.startsWith("conversation-turn-")) {
              const userMsg = prevTurn.querySelector('[data-message-author-role="user"]');
              promptText = userMsg ? userMsg.textContent.trim() : prevTurn.textContent.trim();
            }
          }
          candidateMap.set(turnId, { src: img.src, w, h, area, scanPass, promptText });
        }
      }
    }

    // Initial scan at top
    collectCandidates();

    // Scroll and collect
    while (true) {
      scrollPos += step;
      scroller.scrollTop = scrollPos;
      await sleep(1000);

      const sizeBefore = candidateMap.size;
      collectCandidates();

      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      if (scroller.scrollTop >= maxScroll - 10) {
        collectCandidates();
        break;
      }

      if (
        scroller.scrollHeight === lastScrollHeight &&
        candidateMap.size === sizeBefore
      ) {
        stuckCount++;
        if (stuckCount > 5) break;
      } else {
        stuckCount = 0;
        lastScrollHeight = scroller.scrollHeight;
      }
    }

    // Second pass: scroll back to bottom and wait for any late-loading images
    // This catches the last generated image which may still be transitioning
    // from blurry preview to sharp final render
    console.log("[MultiImg] First pass found", candidateMap.size, "candidates. Running second pass...");
    const firstPassCount = candidateMap.size;

    scroller.scrollTop = scroller.scrollHeight;
    await sleep(3000); // Give time for last images to fully render

    // Re-scan the entire visible area near the bottom (where the last image is)
    collectCandidates();
    await sleep(2000);
    collectCandidates(); // One more pass after extra wait

    if (candidateMap.size > firstPassCount) {
      console.log("[MultiImg] Second pass found", candidateMap.size - firstPassCount, "additional image(s)!");
    }

    // Deduplicate URLs and carry prompt text from candidateMap
    const urlSet = new Set();
    const imageEntries = [];
    for (const c of candidateMap.values()) {
      if (!urlSet.has(c.src)) {
        urlSet.add(c.src);
        imageEntries.push({ src: c.src, promptText: c.promptText || "" });
      }
    }
    const imageUrls = imageEntries.map((e) => e.src);
    console.log(
      "[MultiImg] Total unique images found:",
      imageUrls.length,
      "(from",
      candidateMap.size,
      "turns)"
    );

    if (imageUrls.length === 0) {
      chrome.runtime.sendMessage({
        action: "statusUpdate",
        data: {
          phase: "downloading",
          message: "No images found on ChatGPT page!",
          isError: true,
        },
      });
      return { downloaded: 0, total: 0, results: [] };
    }

    chrome.runtime.sendMessage({
      action: "statusUpdate",
      data: {
        phase: "downloading",
        message: `Found ${imageUrls.length} images. Downloading...`,
      },
    });

    // Download each image sequentially
    const results = [];
    for (let i = 0; i < imageUrls.length; i++) {
      chrome.runtime.sendMessage({
        action: "statusUpdate",
        data: {
          phase: "downloading",
          message: `Downloading image ${i + 1}/${imageUrls.length}...`,
          progress: Math.round(((i + 1) / imageUrls.length) * 100),
        },
      });

      const result = await downloadSingleImage(imageUrls[i], i + 1, imageEntries[i].promptText);
      results.push(result);
      await sleep(500);
    }

    const successCount = results.filter((r) => r.success).length;

    chrome.runtime.sendMessage({
      action: "statusUpdate",
      data: {
        phase: "download-complete",
        message: `Downloaded ${successCount}/${imageUrls.length} images!`,
      },
    });

    return { downloaded: successCount, total: imageUrls.length, results };
  }

  // ---- Handle messages from background script ----
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "batchGenerate") {
      handleBatchGenerate(message.data)
        .then((result) => sendResponse({ success: true, data: result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (message.action === "ping") {
      sendResponse({ success: true, status: "ready" });
      return true;
    }

    if (message.action === "getImageUrls") {
      const images = findGeneratedImages();
      const urls = images.map((img) => img.src);
      sendResponse({ success: true, data: urls });
      return true;
    }

    if (message.action === "downloadAllImages") {
      handleDownloadAllImages(message.data || {})
        .then((result) => sendResponse({ success: true, data: result }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
  });
})();
