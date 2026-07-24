import { DEFAULT_KEYWORDS } from "./default-keywords.js";
import { migrateLegacyResults, putAnalysisResult } from "./data-store.js";

let cancelRequested = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (value) => chrome.storage.local.set(value);

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getOrCreateSigningKey() {
  const stored = await storageGet("signingKey");
  if (stored.signingKey?.publicKey && stored.signingKey?.privateKey) return stored.signingKey;
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const signingKey = {
    publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey)
  };
  await storageSet({ signingKey });
  return signingKey;
}

async function signRequest(method, path, deviceId, rawBody) {
  const signingKey = await getOrCreateSigningKey();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const canonical = [method.toUpperCase(), path, deviceId, timestamp, await sha256Hex(rawBody)].join("\n");
  const privateKey = await crypto.subtle.importKey(
    "jwk", signingKey.privateKey, { name: "Ed25519" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(canonical));
  return {
    "X-Device-Id": deviceId,
    "X-Timestamp": timestamp,
    "X-Signature": bytesToBase64(new Uint8Array(signature))
  };
}

function randomDeviceId() {
  return crypto.randomUUID();
}

async function bootstrap(config) {
  const signingKey = await getOrCreateSigningKey();
  const deviceId = config.deviceId || randomDeviceId();
  const response = await fetch("https://members.erank.com/ext/ext_start", {
    method: "GET",
    credentials: "include",
    headers: {
      "X-Device-Id": deviceId,
      "X-Ext-Signing-Public-Key": signingKey.publicKey,
      "X-Ext-Signing-Key-Type": "ed25519"
    }
  });
  if (!response.ok || response.headers.get("content-type")?.includes("text/html")) {
    throw new Error(`Không tạo được phiên eRank (${response.status}). Hãy đăng nhập members.erank.com.`);
  }
  const payload = await response.json();
  const accessToken = payload?.access_token || payload?.data?.access_token;
  if (!accessToken) throw new Error("eRank không trả access token.");
  const nextConfig = { ...config, deviceId, accessToken };
  await storageSet({ apiConfig: nextConfig });
  return nextConfig;
}

async function ensureSession() {
  const stored = await storageGet("apiConfig");
  let config = stored.apiConfig || {};
  // A curl import supplies a usable bearer token, but its device signature belongs
  // to another key. Bootstrap registers this extension's own signing key.
  if (!config.registered) {
    config = await bootstrap(config);
    config.registered = true;
    await storageSet({ apiConfig: config });
  }
  return config;
}

async function callListingApi(keyword, listingIds) {
  const config = await ensureSession();
  const path = "/ext";
  const requestBody = {
    endpoint: "ext/listing-ids",
    payload: { keyword, listing_ids: listingIds },
    method: "POST"
  };
  const rawBody = JSON.stringify(requestBody);
  const signedHeaders = await signRequest("POST", path, config.deviceId, rawBody);
  const request = () => fetch(`https://members.erank.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.accessToken}`,
      ...signedHeaders
    },
    body: rawBody
  });
  let response = await request();
  if (response.status === 401 || response.status === 403) {
    await storageSet({ apiConfig: { ...config, registered: false } });
    const refreshed = await bootstrap(config);
    refreshed.registered = true;
    await storageSet({ apiConfig: refreshed });
    const refreshedHeaders = await signRequest("POST", path, refreshed.deviceId, rawBody);
    response = await fetch(`https://members.erank.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshed.accessToken}`,
        ...refreshedHeaders
      },
      body: rawBody
    });
  }
  if (!response.ok) {
    const detail = await response.text();
    const authError = response.status === 401 || response.status === 403;
    throw new Error(authError
      ? "CURL_EXPIRED: Phiên eRank/curl đã hết hạn. Hãy cập nhật curl.txt."
      : `API eRank lỗi ${response.status}: ${detail.slice(0, 180)}`);
  }
  const json = await response.json();
  if (!json.success) throw new Error(json.error?.message || json.error || "eRank trả kết quả không thành công.");
  return json.data;
}

async function waitForTab(tabId, timeout = 30000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Etsy tải trang quá lâu."));
    }, timeout);
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scrapeKeyword(keyword) {
  const tab = await chrome.tabs.create({
    url: `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`,
    active: false
  });
  try {
    await waitForTab(tab.id);
    await sleep(700);
    let result;
    try {
      result = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_LISTINGS" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["scraper.js"] });
      result = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_LISTINGS" });
    }
    if (!result?.ok) throw new Error(result?.error || "Không quét được trang Etsy.");
    if (!result.listingIds.length) {
      throw new Error("Không tìm thấy listing ID. Etsy có thể đang yêu cầu captcha hoặc đăng nhập.");
    }
    return result.listingIds;
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function setJob(patch) {
  const { jobState = {} } = await storageGet("jobState");
  await storageSet({ jobState: { ...jobState, ...patch, updatedAt: Date.now() } });
}

async function runAnalysis() {
  const stored = await storageGet(["keywords", "results", "jobState"]);
  if (stored.results) {
    await migrateLegacyResults(stored.results);
    await chrome.storage.local.remove("results");
  }
  const keywords = (stored.keywords?.length ? stored.keywords : DEFAULT_KEYWORDS)
    .map((item) => item.trim()).filter(Boolean);
  if (!keywords.length) throw new Error("Danh sách keyword đang trống.");
  cancelRequested = false;
  const resumeIndex = stored.jobState?.errorCode === "CURL_EXPIRED"
    ? Math.max(0, Math.min(stored.jobState.current || 0, keywords.length - 1))
    : 0;
  await setJob({
    status: "running",
    current: resumeIndex,
    total: keywords.length,
    message: resumeIndex ? `Tiếp tục từ keyword ${resumeIndex + 1}…` : "Đang chuẩn bị…",
    errorCode: null
  });
  for (let index = resumeIndex; index < keywords.length; index += 1) {
    if (cancelRequested) throw new Error("Đã dừng theo yêu cầu.");
    const keyword = keywords[index];
    await setJob({ current: index, message: `Đang quét Etsy: “${keyword}”` });
    const listingIds = await scrapeKeyword(keyword);
    await setJob({ current: index, message: `Đang lấy dữ liệu SEO (${listingIds.length} listings)…` });
    const data = await callListingApi(keyword, listingIds);
    await putAnalysisResult({ keyword, listingIds, data, collectedAt: Date.now() });
    chrome.runtime.sendMessage({ type: "RESULT_UPDATED", keyword }).catch(() => {});
    await setJob({ current: index + 1, message: `Đã xong “${keyword}”` });
  }
  await setJob({ status: "done", current: keywords.length, message: `Hoàn tất ${keywords.length} keyword.` });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "START_ANALYSIS") {
    storageGet("jobState").then(({ jobState }) => {
      if (jobState?.status === "running") return sendResponse({ ok: false, error: "Tác vụ đang chạy." });
      runAnalysis().catch(async (error) => {
        const stopped = error.message === "Đã dừng theo yêu cầu.";
        await setJob({
          status: stopped ? "idle" : "error",
          message: error.message,
          errorCode: error.message.startsWith("CURL_EXPIRED") ? "CURL_EXPIRED" : null
        });
      });
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message?.type === "STOP_ANALYSIS") {
    cancelRequested = true;
    sendResponse({ ok: true });
  }
  if (message?.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});
