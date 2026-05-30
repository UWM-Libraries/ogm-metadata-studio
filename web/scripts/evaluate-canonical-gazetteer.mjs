#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalConcordanceLayer,
  clearCanonicalConcordanceCache,
} from "../proxy/canonical-concordance.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE = path.resolve(__dirname, "../../examples/eval/seattle-canonical-gazetteer-gold.json");

function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_FIXTURE,
    indexPath: "",
    json: false,
  };
  for (const arg of argv) {
    if (arg === "--json") options.json = true;
    else if (arg.startsWith("--fixture=")) options.fixture = path.resolve(arg.slice("--fixture=".length));
    else if (arg.startsWith("--index=")) options.indexPath = path.resolve(arg.slice("--index=".length));
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
  console.log(`Evaluate canonical gazetteer matching against a gold fixture.

Usage:
  npm run eval:canonical-gazetteer -- [options]

Options:
  --fixture=PATH       Gold fixture path. Defaults to examples/eval/seattle-canonical-gazetteer-gold.json.
  --index=PATH         Existing canonical_places.ndjson path. If omitted, fixture.canonicalPlaces is used.
  --json               Print the full evaluation result as JSON.
`);
}

function writeFixtureIndex(tempDir, fixture) {
  const indexPath = path.join(tempDir, "canonical_places.ndjson");
  writeFileSync(indexPath, [
    JSON.stringify({ type: "metadata", label: fixture.name || "fixture-canonical", recordCount: fixture.canonicalPlaces?.length || 0 }),
    ...(fixture.canonicalPlaces || []).map((record) => JSON.stringify(record)),
    "",
  ].join("\n"), "utf8");
  return indexPath;
}

function findPlacename(placenames, expected) {
  if (expected.placenameId) {
    const byId = placenames.find((place) => place.id === expected.placenameId);
    if (byId) return byId;
  }
  return placenames.find((place) => place.name === expected.name);
}

function evaluateCase(testCase) {
  const result = buildCanonicalConcordanceLayer({
    placenames: testCase.placenames || [],
    textGroups: testCase.textGroups || [],
    textSegments: testCase.textSegments || [],
    resource: testCase.resource || {},
    mapExtent: testCase.mapExtent || {},
    boundary: testCase.boundary || null,
  });
  const assertions = (testCase.expected || []).map((expected) => {
    const place = findPlacename(result.placenames, expected);
    const actual = place?.ogmPlaceId || "";
    const candidates = place?.geocoding?.canonicalCandidates || [];
    const candidateIds = candidates.map((candidate) => candidate.ogmPlaceId).filter(Boolean);
    return {
      placenameId: expected.placenameId,
      name: expected.name || place?.name,
      expected: expected.ogmPlaceId,
      actual,
      passed: actual === expected.ogmPlaceId,
      foundInTop5: candidateIds.slice(0, 5).includes(expected.ogmPlaceId),
      ambiguous: String(place?.extensions?.canonicalGazetteer?.status || "").toLowerCase() === "ambiguous",
      candidates: candidates.map((candidate) => ({
        ogmPlaceId: candidate.ogmPlaceId,
        score: candidate.score,
        matchType: candidate.matchType,
      })),
    };
  });
  return {
    id: testCase.id,
    description: testCase.description,
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    extension: result.extension,
  };
}

export function evaluateCanonicalGazetteerFixture(fixture, { indexPath = "" } = {}) {
  const previous = {
    enabled: process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER,
    path: process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH,
    label: process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL,
  };
  const tempDir = mkdtempSync(path.join(tmpdir(), "canonical-gazetteer-eval-"));
  try {
    process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER = "1";
    process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH = indexPath || writeFixtureIndex(tempDir, fixture);
    process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL = fixture.name || "canonical-gazetteer-eval";
    clearCanonicalConcordanceCache();
    const cases = (fixture.cases || []).map(evaluateCase);
    const assertionCount = cases.reduce((sum, item) => sum + item.assertions.length, 0);
    const passedAssertions = cases.reduce((sum, item) => sum + item.assertions.filter((assertion) => assertion.passed).length, 0);
    const top5Assertions = cases.reduce((sum, item) => sum + item.assertions.filter((assertion) => assertion.foundInTop5).length, 0);
    const ambiguousAssertions = cases.reduce((sum, item) => sum + item.assertions.filter((assertion) => assertion.ambiguous).length, 0);
    const expectedIds = new Set((fixture.cases || []).flatMap((testCase) => (testCase.expected || []).map((item) => item.ogmPlaceId).filter(Boolean)));
    const actualIds = new Set(cases.flatMap((testCase) => testCase.assertions.map((item) => item.actual).filter(Boolean)));
    return {
      name: fixture.name,
      cases,
      metrics: {
        cases: cases.length,
        passedCases: cases.filter((item) => item.passed).length,
        assertions: assertionCount,
        passedAssertions,
        top5Assertions,
        ambiguousAssertions,
        precisionAt1: assertionCount > 0 ? passedAssertions / assertionCount : 0,
        recallAt5: assertionCount > 0 ? top5Assertions / assertionCount : 0,
        ambiguityRate: assertionCount > 0 ? ambiguousAssertions / assertionCount : 0,
        newMatches: Array.from(actualIds).filter((id) => !expectedIds.has(id)).sort(),
        lostMatches: Array.from(expectedIds).filter((id) => !actualIds.has(id)).sort(),
      },
      passed: cases.every((item) => item.passed),
    };
  } finally {
    if (previous.enabled === undefined) delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER;
    else process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER = previous.enabled;
    if (previous.path === undefined) delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH;
    else process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_PATH = previous.path;
    if (previous.label === undefined) delete process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL;
    else process.env.ENRICHMENT_PROXY_CANONICAL_GAZETTEER_LABEL = previous.label;
    clearCanonicalConcordanceCache();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function printHuman(result) {
  console.log(`${result.name || "Canonical gazetteer"}: ${result.metrics.passedAssertions}/${result.metrics.assertions} assertions passed`);
  console.log(`precision@1=${result.metrics.precisionAt1.toFixed(3)}`);
  console.log(`recall@5=${result.metrics.recallAt5.toFixed(3)} ambiguityRate=${result.metrics.ambiguityRate.toFixed(3)}`);
  for (const testCase of result.cases) {
    const label = testCase.passed ? "PASS" : "FAIL";
    console.log(`${label} ${testCase.id}`);
    for (const assertion of testCase.assertions) {
      if (!assertion.passed) console.log(`  expected ${assertion.expected}, got ${assertion.actual || "(none)"}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixture = JSON.parse(readFileSync(options.fixture, "utf8"));
  const result = evaluateCanonicalGazetteerFixture(fixture, { indexPath: options.indexPath });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (!result.passed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
