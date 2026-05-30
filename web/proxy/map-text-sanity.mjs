const PLACEHOLDER_GLYPH_RE = /^[0Ooם□▢▯▭◻◼◽◾▪▫]+$/u;
const SINGLE_LETTER_RE = /^\p{L}$/u;
const ZERO_ONLY_RE = /^0+$/u;
const ZERO_PUNCT_ONLY_RE = /^[0Oo.,:;·•-]+$/u;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function textTokens(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isProtectedRole(role) {
  return ["coordinate", "scale", "legend", "title"].includes(String(role || "").toLowerCase());
}

export function classifyMapTextCandidate(entry) {
  const content = String(entry?.content ?? entry?.name ?? "").trim();
  const role = String(entry?.role || entry?.type || "other").toLowerCase();
  if (!content) {
    return { status: "rejected_empty", reason: "empty_text" };
  }

  const compact = compactText(content);
  const tokens = textTokens(content);
  if (!compact) {
    return { status: "rejected_empty", reason: "empty_text" };
  }

  if (!isProtectedRole(role)) {
    if (ZERO_ONLY_RE.test(compact) && compact.length >= 2) {
      return { status: "rejected_symbol", reason: "zero_building_placeholder_sequence" };
    }
    if (ZERO_PUNCT_ONLY_RE.test(compact) && /[0Oo]/u.test(compact) && compact.length >= 3) {
      return { status: "rejected_symbol", reason: "zero_punctuation_building_placeholder_sequence" };
    }
    if (PLACEHOLDER_GLYPH_RE.test(compact) && compact.length >= 2) {
      return { status: "rejected_symbol", reason: "building_placeholder_glyph_sequence" };
    }
    if (SINGLE_LETTER_RE.test(compact) && !["n", "s", "e", "w"].includes(compact.toLowerCase())) {
      return { status: "rejected_symbol", reason: "isolated_single_letter_symbol" };
    }
    if (tokens.length >= 3) {
      const oneCharTokens = tokens.filter((token) => compactText(token).length === 1);
      const placeholderTokens = tokens.filter((token) => PLACEHOLDER_GLYPH_RE.test(compactText(token)));
      if (oneCharTokens.length / tokens.length >= 0.75 && placeholderTokens.length / tokens.length >= 0.6) {
        return { status: "rejected_symbol", reason: "repeated_single_glyph_map_symbols" };
      }
    }
  }

  return { status: "accepted", reason: "" };
}

export function withMapTextSanity(entry) {
  const classification = classifyMapTextCandidate(entry);
  if (classification.status === "accepted") return entry;
  return {
    ...entry,
    candidate_status: classification.status,
    rejection_reason: classification.reason,
  };
}

export function filterRejectedMapText(entries) {
  const accepted = [];
  const rejected = [];
  for (const entry of asArray(entries)) {
    const classified = withMapTextSanity(entry);
    if (classified.candidate_status === "rejected_symbol" || classified.candidate_status === "rejected_empty") {
      rejected.push(classified);
    } else {
      accepted.push(classified);
    }
  }
  return { accepted, rejected };
}
