function collectListingIds() {
  const ids = new Set();
  document.querySelectorAll('a[href*="/listing/"]').forEach((link) => {
    const match = link.href.match(/\/listing\/(\d+)/);
    if (match) ids.add(Number(match[1]));
  });
  document.querySelectorAll("[data-listing-id]").forEach((node) => {
    const id = Number(node.getAttribute("data-listing-id"));
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  });
  return [...ids];
}

async function scrapeWithScrolling() {
  let previous = 0;
  let unchanged = 0;
  for (let step = 0; step < 12 && unchanged < 3; step += 1) {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 650));
    const count = collectListingIds().length;
    unchanged = count === previous ? unchanged + 1 : 0;
    previous = count;
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  return collectListingIds();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SCRAPE_LISTINGS") return;
  scrapeWithScrolling()
    .then((listingIds) => sendResponse({
      ok: true,
      listingIds,
      title: document.title,
      url: location.href
    }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
