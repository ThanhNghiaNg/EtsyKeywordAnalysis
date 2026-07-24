const DB_NAME = "etsy-seo-analyst";
const DB_VERSION = 1;
const RESULT_STORE = "keyword-results";
const MAX_POPULAR_TAGS = 250;

function numeric(value) {
  const parsed = Number(String(value ?? 0).replace(/[,$%]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function metric(source) {
  return { value: numeric(source?.value ?? source) };
}

function compactTrend(trend) {
  if (!trend || typeof trend !== "object") return {};
  return Object.fromEntries(Object.entries(trend).map(([month, point]) => [
    month,
    numeric(point?.value ?? point)
  ]));
}

function compactListing(listing) {
  return {
    listing_id: numeric(listing.listing_id),
    title: String(listing.title || ""),
    listing_image: String(listing.listing_image || ""),
    views: numeric(listing.views),
    favorers: numeric(listing.favorers),
    shop_name: String(listing.shop_name || ""),
    tags: Array.isArray(listing.tags) ? listing.tags.map(String).slice(0, 13) : [],
    est_sales: metric(listing.est_sales),
    est_revenue: metric(listing.est_revenue),
    est_conversion_rate: metric(listing.est_conversion_rate),
    listing_price: metric(listing.listing_price),
    orig_listing_price: metric(listing.orig_listing_price),
    is_converted: Boolean(listing.is_converted)
  };
}

function compactPopularTag(tag) {
  return {
    keyword: String(tag.keyword || ""),
    occurences: numeric(tag.occurences),
    competition: metric(tag.competition),
    avg_searches: metric(tag.avg_searches),
    avg_clicks: metric(tag.avg_clicks),
    ctr: metric(tag.ctr),
    search_trend: compactTrend(tag.search_trend)
  };
}

function tagPriority(tag, sourceKeyword) {
  const exactBoost = tag.keyword?.toLowerCase() === sourceKeyword.toLowerCase() ? 1e12 : 0;
  return exactBoost
    + numeric(tag.occurences) * 1e7
    + numeric(tag.avg_searches?.value) * 100
    + numeric(tag.avg_clicks?.value);
}

export function compactAnalysisRecord(record) {
  const keyword = String(record.keyword || record.data?.keyword || "");
  const popularTags = (record.data?.popular_tags || [])
    .filter((tag) => tag?.keyword)
    .sort((a, b) => tagPriority(b, keyword) - tagPriority(a, keyword))
    .slice(0, MAX_POPULAR_TAGS)
    .map(compactPopularTag);
  return {
    keyword,
    listingIds: [...new Set((record.listingIds || []).map(numeric).filter(Boolean))],
    collectedAt: numeric(record.collectedAt) || Date.now(),
    data: {
      keyword,
      listings: (record.data?.listings || []).map(compactListing),
      popular_tags: popularTags
    }
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RESULT_STORE)) {
        database.createObjectStore(RESULT_STORE, { keyPath: "keyword" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB đang bị khóa bởi một tab extension khác."));
  });
}

async function withStore(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(RESULT_STORE, mode);
      const store = transaction.objectStore(RESULT_STORE);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Giao dịch IndexedDB bị hủy."));
      const request = operation(store);
      if (request) {
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => reject(request.error);
      }
    });
  } finally {
    database.close();
  }
}

export async function putAnalysisResult(record) {
  const compact = compactAnalysisRecord(record);
  await withStore("readwrite", (store) => store.put(compact));
  return compact;
}

export async function getAllAnalysisResults() {
  return (await withStore("readonly", (store) => store.getAll())) || [];
}

export async function clearAnalysisResults() {
  await withStore("readwrite", (store) => store.clear());
}

export async function migrateLegacyResults(legacyResults) {
  if (!legacyResults || typeof legacyResults !== "object") return 0;
  const records = Object.values(legacyResults).filter((record) => record?.keyword);
  for (const record of records) await putAnalysisResult(record);
  return records.length;
}
