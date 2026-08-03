import { DEFAULT_KEYWORDS } from "./default-keywords.js";
import {
  getAnalysisResult,
  migrateLegacyResults,
  putAnalysisResult
} from "./data-store.js";

let cancelRequested = false;
let analysisFatalError = null;
let sessionPromise;
let sessionRefreshPromise;
let jobWriteChain = Promise.resolve();
const activeTabIds = new Set();
const activeFetchControllers = new Set();

const DEFAULT_CACHE_MINUTES = 10;
const DEFAULT_PARALLEL_ANALYSIS = false;
const PARALLEL_KEYWORD_LIMIT = 3;
const MAX_CACHE_MINUTES = 43200;
const NETWORK_ATTEMPTS = 3;
const QUEUE_ATTEMPTS = 2;
const RETRY_DELAYS_MS = [1200, 2500];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (value) => chrome.storage.local.set(value);

function cancelledError() {
  const error = new Error("Đã dừng theo yêu cầu.");
  error.code = "CANCELLED";
  error.retryable = false;
  return error;
}

function assertNotCancelled() {
  if (analysisFatalError) throw analysisFatalError;
  if (cancelRequested) throw cancelledError();
}

function abortActiveWork() {
  for (const controller of activeFetchControllers) controller.abort();
  return Promise.allSettled([...activeTabIds].map((tabId) => chrome.tabs.remove(tabId)));
}

function stopForFatalError(error) {
  if (!analysisFatalError) analysisFatalError = error;
  abortActiveWork();
  return analysisFatalError;
}

function normalizeCacheMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CACHE_MINUTES;
  return Math.min(MAX_CACHE_MINUTES, Math.max(0, Math.round(parsed)));
}

async function cancellableFetch(url, options = {}) {
  assertNotCancelled();
  const controller = new AbortController();
  activeFetchControllers.add(controller);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (analysisFatalError) throw analysisFatalError;
    if (cancelRequested || error.name === "AbortError") throw cancelledError();
    throw error;
  } finally {
    activeFetchControllers.delete(controller);
  }
}

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
  const response = await cancellableFetch("https://members.erank.com/ext/ext_start", {
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

async function ensureSessionOnce() {
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

function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = ensureSessionOnce().finally(() => { sessionPromise = undefined; });
  }
  return sessionPromise;
}

function refreshSession(staleConfig) {
  if (!sessionRefreshPromise) {
    sessionRefreshPromise = (async () => {
      const stored = await storageGet("apiConfig");
      if (
        stored.apiConfig?.registered
        && stored.apiConfig.accessToken
        && stored.apiConfig.accessToken !== staleConfig.accessToken
      ) {
        return stored.apiConfig;
      }
      await storageSet({ apiConfig: { ...staleConfig, registered: false } });
      const refreshed = await bootstrap(staleConfig);
      refreshed.registered = true;
      await storageSet({ apiConfig: refreshed });
      return refreshed;
    })().finally(() => { sessionRefreshPromise = undefined; });
  }
  return sessionRefreshPromise;
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
  const request = () => cancellableFetch(`https://members.erank.com${path}`, {
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
    const refreshed = await refreshSession(config);
    const refreshedHeaders = await signRequest("POST", path, refreshed.deviceId, rawBody);
    response = await cancellableFetch(`https://members.erank.com${path}`, {
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
    const error = new Error(authError
      ? "CURL_EXPIRED: Phiên eRank/curl đã hết hạn. Hãy cập nhật curl.txt."
      : `API eRank lỗi ${response.status}: ${detail.slice(0, 180)}`);
    error.code = authError ? "CURL_EXPIRED" : "ERANK_HTTP_ERROR";
    error.status = response.status;
    error.retryable = !authError && (response.status === 408 || response.status === 429 || response.status >= 500);
    throw error;
  }
  const json = await response.json();
  if (!json.success) {
    const error = new Error(json.error?.message || json.error || "eRank trả kết quả không thành công.");
    error.code = "ERANK_RESPONSE_ERROR";
    error.retryable = true;
    throw error;
  }
  return json.data;
}

async function callListingApiWithRetry(keyword, listingIds, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
    try {
      return await callListingApi(keyword, listingIds);
    } catch (error) {
      lastError = error;
      if (error.code === "CANCELLED" || error.code === "CURL_EXPIRED" || attempt === NETWORK_ATTEMPTS || error.retryable === false) throw error;
      await onRetry(attempt + 1, NETWORK_ATTEMPTS, error);
      await sleep(RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS.at(-1));
    }
  }
  throw lastError;
}

async function waitForTab(tabId, timeout = 30000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(updatedListener);
      chrome.tabs.onRemoved.removeListener(removedListener);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Etsy tải trang quá lâu."));
    }, timeout);
    const updatedListener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") {
        cleanup();
        resolve();
      }
    };
    const removedListener = (removedId) => {
      if (removedId === tabId) {
        cleanup();
        reject(analysisFatalError || (cancelRequested
          ? cancelledError()
          : new Error("Tab Etsy đã bị đóng trước khi tải xong.")));
      }
    };
    chrome.tabs.onUpdated.addListener(updatedListener);
    chrome.tabs.onRemoved.addListener(removedListener);
  });
}

async function scrapeKeywordOnce(keyword) {
  assertNotCancelled();
  const tab = await chrome.tabs.create({
    url: `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`,
    active: false
  });
  activeTabIds.add(tab.id);
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
    activeTabIds.delete(tab.id);
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function scrapeKeywordWithRetry(keyword, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
    try {
      return await scrapeKeywordOnce(keyword);
    } catch (error) {
      lastError = error;
      if (analysisFatalError) throw analysisFatalError;
      if (cancelRequested) throw cancelledError();
      if (error.code === "CANCELLED" || attempt === NETWORK_ATTEMPTS) throw error;
      await onRetry(attempt + 1, NETWORK_ATTEMPTS, error);
      await sleep(RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS.at(-1));
    }
  }
  throw lastError;
}

function setJob(patch) {
  const write = jobWriteChain.then(async () => {
    const { jobState = {} } = await storageGet("jobState");
    await storageSet({ jobState: { ...jobState, ...patch, updatedAt: Date.now() } });
  });
  jobWriteChain = write.catch(() => {});
  return write;
}

function isCurlExpired(error) {
  return error.code === "CURL_EXPIRED" || error.message?.startsWith("CURL_EXPIRED");
}

async function processKeywordTask(task, state) {
  assertNotCancelled();
  const { keyword, queueAttempt } = task;
  const existing = await getAnalysisResult(keyword);
  assertNotCancelled();
  if (state.cacheTtlMs > 0 && existing && Date.now() - existing.collectedAt < state.cacheTtlMs) {
    state.settled += 1;
    state.cached += 1;
    delete state.failures[keyword];
    await setJob({
      current: state.settled,
      cached: state.cached,
      failures: Object.values(state.failures),
      message: `Dùng cache dưới ${state.cacheMinutes} phút: “${keyword}”`
    });
    return;
  }
  try {
    await setJob({
      current: state.settled,
      message: `Đang quét Etsy: “${keyword}”${queueAttempt > 1 ? " · lượt queue cuối" : ""}`
    });
    const listingIds = await scrapeKeywordWithRetry(keyword, async (attempt, total, error) => {
      await setJob({
        message: `Tải Etsy lỗi, retry ${attempt}/${total}: “${keyword}” · ${error.message}`
      });
    });
    await setJob({
      current: state.settled,
      message: `Đang lấy dữ liệu SEO cho “${keyword}” (${listingIds.length} listings)…`
    });
    const data = await callListingApiWithRetry(keyword, listingIds, async (attempt, total, error) => {
      await setJob({
        message: `Fetch eRank lỗi, retry ${attempt}/${total}: “${keyword}” · ${error.message}`
      });
    });
    assertNotCancelled();
    await putAnalysisResult({ keyword, listingIds, data, collectedAt: Date.now() });
    chrome.runtime.sendMessage({ type: "RESULT_UPDATED", keyword }).catch(() => {});
    state.settled += 1;
    delete state.failures[keyword];
    await setJob({
      current: state.settled,
      cached: state.cached,
      failures: Object.values(state.failures),
      message: `Đã xong “${keyword}”`
    });
  } catch (error) {
    if (isCurlExpired(error)) throw stopForFatalError(error);
    if (analysisFatalError) throw analysisFatalError;
    if (error.code === "CANCELLED" || cancelRequested) throw cancelledError();
    state.failures[keyword] = {
      keyword,
      message: error.message,
      queueAttempt,
      failedAt: Date.now()
    };
    if (queueAttempt < QUEUE_ATTEMPTS) {
      state.queue.push({ keyword, queueAttempt: queueAttempt + 1 });
      await setJob({
        current: state.settled,
        cached: state.cached,
        failures: Object.values(state.failures),
        message: `Đã đưa “${keyword}” xuống cuối queue để thử lại.`
      });
    } else {
      state.settled += 1;
      await setJob({
        current: state.settled,
        cached: state.cached,
        failures: Object.values(state.failures),
        message: `Bỏ qua “${keyword}” sau ${QUEUE_ATTEMPTS} lượt queue; tiếp tục keyword khác.`
      });
    }
  }
}

async function runAnalysis() {
  const stored = await storageGet([
    "keywords", "results", "jobState", "cacheMinutes", "parallelAnalysis"
  ]);
  if (stored.results) {
    await migrateLegacyResults(stored.results);
    await chrome.storage.local.remove("results");
  }
  const keywords = (stored.keywords?.length ? stored.keywords : DEFAULT_KEYWORDS)
    .map((item) => item.trim()).filter(Boolean);
  if (!keywords.length) throw new Error("Danh sách keyword đang trống.");
  cancelRequested = false;
  analysisFatalError = null;
  const cacheMinutes = normalizeCacheMinutes(stored.cacheMinutes);
  const cacheTtlMs = cacheMinutes * 60 * 1000;
  const parallelAnalysis = typeof stored.parallelAnalysis === "boolean"
    ? stored.parallelAnalysis
    : DEFAULT_PARALLEL_ANALYSIS;
  const concurrency = parallelAnalysis ? PARALLEL_KEYWORD_LIMIT : 1;
  await setJob({
    status: "running",
    current: 0,
    total: keywords.length,
    message: parallelAnalysis
      ? `Đang chuẩn bị queue · tối đa ${concurrency} keyword song song…`
      : "Đang chuẩn bị queue · chạy tuần tự…",
    errorCode: null,
    failures: [],
    cached: 0,
    cacheMinutes,
    parallelAnalysis,
    concurrency
  });
  const queue = keywords.map((keyword) => ({ keyword, queueAttempt: 1 }));
  const state = {
    queue,
    failures: {},
    settled: 0,
    cached: 0,
    cacheMinutes,
    cacheTtlMs
  };
  while (queue.length) {
    assertNotCancelled();
    const batch = queue.splice(0, concurrency);
    const results = await Promise.allSettled(batch.map((task) => processKeywordTask(task, state)));
    if (analysisFatalError) throw analysisFatalError;
    if (cancelRequested) throw cancelledError();
    const unexpected = results.find((result) => result.status === "rejected");
    if (unexpected) throw unexpected.reason;
  }
  const failed = Object.values(state.failures);
  await setJob({
    status: failed.length ? "done_with_errors" : "done",
    current: keywords.length,
    cached: state.cached,
    failures: failed,
    message: failed.length
      ? `Hoàn tất với ${failed.length} keyword lỗi; ${state.cached} keyword dùng cache.`
      : `Hoàn tất ${keywords.length} keyword; ${state.cached} keyword dùng cache.`
  });
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
    abortActiveWork().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});
