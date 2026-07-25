export function cycleSortRules(rules, key, type = "string") {
  const current = rules.find((rule) => rule.key === key);
  if (!current) return [...rules, { key, type, direction: "asc" }];
  if (current.direction === "asc") {
    return rules.map((rule) => rule.key === key ? { ...rule, direction: "desc" } : rule);
  }
  return rules.filter((rule) => rule.key !== key);
}

function compareValues(left, right, type) {
  if (type === "number") {
    const a = Number(left);
    const b = Number(right);
    const safeA = Number.isFinite(a) ? a : 0;
    const safeB = Number.isFinite(b) ? b : 0;
    return safeA - safeB;
  }
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    sensitivity: "base",
    numeric: true
  });
}

export function sortRows(rows, rules, accessors = {}) {
  if (!rules.length) return rows;
  return rows
    .map((row, originalIndex) => ({ row, originalIndex }))
    .sort((left, right) => {
      for (const rule of rules) {
        const read = accessors[rule.key] || ((row) => row?.[rule.key]);
        const compared = compareValues(read(left.row), read(right.row), rule.type);
        if (compared) return rule.direction === "asc" ? compared : -compared;
      }
      return left.originalIndex - right.originalIndex;
    })
    .map(({ row }) => row);
}
