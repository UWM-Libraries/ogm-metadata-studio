#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX = path.resolve(__dirname, "../.cache/gazetteers/canonical/seattle/canonical_places.ndjson");

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function bboxArea(box) {
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, Number(box[2]) - Number(box[0])) * Math.max(0, Number(box[3]) - Number(box[1]));
}

function bboxDiagonalDegrees(box) {
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.hypot(Number(box[2]) - Number(box[0]), Number(box[3]) - Number(box[1]));
}

function sourceAuthorities(place) {
  return new Set(asArray(place.sources).map((source) => String(source?.authority || "").toLowerCase()).filter(Boolean));
}

function sourceIdsByAuthority(place) {
  const byAuthority = {};
  for (const source of asArray(place.sources)) {
    const authority = String(source?.authority || "").toLowerCase();
    const authorityId = String(source?.authorityId || "").trim();
    if (!authority || !authorityId) continue;
    if (!byAuthority[authority]) byAuthority[authority] = [];
    byAuthority[authority].push(authorityId);
  }
  return byAuthority;
}

function lowMergeScore(place) {
  const score = Number(place?.review?.minMergeScore);
  return Number.isFinite(score) ? score : undefined;
}

function issue(severity, code, message, details = {}) {
  return { severity, code, message, details };
}

export function auditCanonicalPlace(place, options = {}) {
  const issues = [];
  const byAuthority = sourceIdsByAuthority(place);
  const authorityCount = sourceAuthorities(place).size;
  const sourceCount = asArray(place.sources).length;
  const diagonal = bboxDiagonalDegrees(place.bboxUnion || place.bbox);
  const area = bboxArea(place.bboxUnion || place.bbox);
  const minMergeScore = lowMergeScore(place);

  if (byAuthority.whosonfirst?.length > 1) {
    issues.push(issue(
      "warning",
      "multiple_wof_ids",
      "Canonical cluster contains multiple Who's On First ids.",
      { whosonfirst: byAuthority.whosonfirst },
    ));
  }
  if (byAuthority.geonames?.length > 1) {
    issues.push(issue(
      "warning",
      "multiple_geonames_ids",
      "Canonical cluster contains multiple GeoNames ids.",
      { geonames: byAuthority.geonames },
    ));
  }
  const gnisIds = asArray(place.concordances?.gnis);
  if (gnisIds.length > 1) {
    issues.push(issue(
      "warning",
      "multiple_gnis_ids",
      "Canonical cluster contains multiple GNIS feature ids.",
      { gnis: gnisIds },
    ));
  }
  const wikidataIds = asArray(place.concordances?.wikidata);
  if (wikidataIds.length > 1) {
    issues.push(issue(
      "warning",
      "multiple_wikidata_ids",
      "Canonical cluster contains multiple Wikidata ids.",
      { wikidata: wikidataIds },
    ));
  }
  if (authorityCount >= 3 && sourceCount >= 6 && minMergeScore !== undefined && minMergeScore < 0.9) {
    issues.push(issue(
      "review",
      "weak_large_cluster",
      "Large multi-authority cluster has a low minimum merge score.",
      { authorityCount, sourceCount, minMergeScore },
    ));
  }
  if (diagonal > Number(options.maxBboxDiagonalDegrees || 1.2)) {
    issues.push(issue(
      "warning",
      "large_bbox_spread",
      "Canonical cluster bbox spread is large for a local gazetteer.",
      { diagonalDegrees: Math.round(diagonal * 1000) / 1000, areaDegrees: Math.round(area * 1000000) / 1000000 },
    ));
  }
  if (String(place.ogmPlaceId || "").startsWith("ogm:place:whosonfirst:") && byAuthority.whosonfirst?.length > 1) {
    const anchor = String(place.ogmPlaceId).split(":").at(-1);
    if (!byAuthority.whosonfirst.includes(anchor)) {
      issues.push(issue(
        "error",
        "anchor_not_in_cluster",
        "Canonical WOF anchor id is not present in cluster sources.",
        { anchor, whosonfirst: byAuthority.whosonfirst },
      ));
    } else if (byAuthority.whosonfirst[0] !== anchor) {
      issues.push(issue(
        "review",
        "anchor_not_first_source",
        "Canonical WOF anchor is not the first WOF source id; verify representative selection.",
        { anchor, whosonfirst: byAuthority.whosonfirst },
      ));
    }
  }
  return issues;
}

export function auditCanonicalGazetteer(records, options = {}) {
  const issues = [];
  for (const place of records) {
    const placeIssues = auditCanonicalPlace(place, options);
    for (const item of placeIssues) {
      issues.push({
        ogmPlaceId: place.ogmPlaceId,
        name: place.name,
        ...item,
      });
    }
  }
  const severityCounts = {};
  const codeCounts = {};
  for (const item of issues) {
    severityCounts[item.severity] = (severityCounts[item.severity] || 0) + 1;
    codeCounts[item.code] = (codeCounts[item.code] || 0) + 1;
  }
  return {
    summary: {
      records: records.length,
      issues: issues.length,
      severityCounts,
      codeCounts,
    },
    issues,
  };
}

function readCanonicalPlaces(indexPath) {
  const records = [];
  for (const line of readFileSync(indexPath, "utf8").split(/\n+/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (parsed?.type === "metadata") continue;
    records.push(parsed);
  }
  return records;
}

function parseArgs(argv) {
  const options = {
    index: DEFAULT_INDEX,
    output: "",
    failOn: "",
  };
  for (const arg of argv) {
    if (arg.startsWith("--index=")) options.index = path.resolve(arg.slice("--index=".length));
    else if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg.startsWith("--fail-on=")) options.failOn = arg.slice("--fail-on=".length);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Audit canonical gazetteer clusters for suspicious merges.

Usage:
  npm run audit:canonical-gazetteer -- [options]

Options:
  --index=PATH          canonical_places.ndjson path.
  --output=PATH         Write full JSON report.
  --fail-on=SEVERITY    Exit non-zero if issues at this severity or higher exist: review, warning, error.
`);
}

function shouldFail(report, failOn) {
  const rank = { review: 1, warning: 2, error: 3 };
  const minRank = rank[failOn];
  if (!minRank) return false;
  return report.issues.some((item) => rank[item.severity] >= minRank);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.index)) throw new Error(`Canonical gazetteer index not found: ${options.index}`);
  const report = auditCanonicalGazetteer(readCanonicalPlaces(options.index));
  if (options.output) writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Audited ${report.summary.records} canonical places: ${report.summary.issues} issue(s)`);
  console.log(JSON.stringify(report.summary.severityCounts));
  for (const item of report.issues.slice(0, 20)) {
    console.log(`${item.severity.toUpperCase()} ${item.code} ${item.ogmPlaceId} ${item.name}`);
  }
  if (shouldFail(report, options.failOn)) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
