export function collectListingItems(records, deduplicate = false) {
  const items = [];
  const byListingId = new Map();
  for (const record of records) {
    for (const listing of record?.data?.listings || []) {
      const item = {
        ...listing,
        _keywords: [record.keyword],
        _collectedAt: Number(record.collectedAt) || 0
      };
      if (!deduplicate || !listing.listing_id) {
        items.push(item);
        continue;
      }
      const key = String(listing.listing_id);
      const existing = byListingId.get(key);
      if (!existing) {
        byListingId.set(key, item);
        items.push(item);
        continue;
      }
      const keywords = [...new Set([...existing._keywords, record.keyword])];
      if (item._collectedAt > existing._collectedAt) {
        Object.assign(existing, item, { _keywords: keywords });
      } else {
        existing._keywords = keywords;
      }
    }
  }
  return items;
}
