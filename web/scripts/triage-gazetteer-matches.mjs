#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function providerKey(match) {
  const provider = String(match?.provider || match?.authority || "unknown").toLowerCase();
  if (provider === "wof") return "whosonfirst";
  if (provider === "osm") return "openstreetmap";
  if (provider === "gn") return "geonames";
  return provider;
}

function candidateSpread(candidates = []) {
  const scores = candidates.map((candidate) => Number(candidate.score ?? candidate.confidence)).filter(Number.isFinite);
  if (scores.length < 2) return 1;
  scores.sort((a, b) => b - a);
  return scores[0] - scores[1];
}

function reviewReasons(place) {
  const reasons = [];
  const canonical = place?.extensions?.canonicalGazetteer;
  const canonicalCandidates = asArray(place?.geocoding?.canonicalCandidates || canonical?.candidates);
  const sourceCandidates = asArray(place?.geocoding?.candidates);
  const providers = new Set(asArray(place?.gazetteerMatches).map(providerKey));

  if (!place?.ogmPlaceId) reasons.push("missing canonical OGM match");
  if (String(canonical?.status || "").toLowerCase() === "ambiguous") reasons.push("canonical match is ambiguous");
  if (String(place?.geocoding?.matchType || "").includes("ambiguous")) reasons.push("source match is ambiguous");
  if (candidateSpread(canonicalCandidates) < 0.04 && canonicalCandidates.length > 1) reasons.push("top canonical candidates are close");
  if (candidateSpread(sourceCandidates) < 0.04 && sourceCandidates.length > 1) reasons.push("top source candidates are close");
  if (providers.has("whosonfirst") && providers.has("openstreetmap") && providers.has("geonames") && providers.has("ogm")) {
    const authorityIds = new Set(asArray(place.gazetteerMatches).map((match) => `${providerKey(match)}:${match.authorityId}`));
    if (authorityIds.size >= 4 && String(canonical?.matchType || "").includes("fuzzy")) reasons.push("many-source fuzzy canonical match");
  }
  if (canonical?.projectedCoordinates && Number(canonical.projectedPositionScore || 0) < 0.35) {
    reasons.push("projected label position is far from selected canonical place");
  }
  return reasons;
}

function reviewNote(place, reasons) {
  const canonical = place?.extensions?.canonicalGazetteer || {};
  const topCanonical = asArray(place?.geocoding?.canonicalCandidates || canonical.candidates).slice(0, 3);
  const topSource = asArray(place?.geocoding?.candidates).slice(0, 3);
  return {
    placenameId: place.id,
    name: place.name,
    ogmPlaceId: place.ogmPlaceId,
    authority: place.authority,
    authorityId: place.authorityId,
    reasons,
    recommendation: reasons.some((reason) => reason.includes("missing")) ? "review_required"
      : reasons.some((reason) => reason.includes("ambiguous") || reason.includes("close")) ? "compare_candidates"
        : "spot_check",
    evidence: {
      sourceTextIds: place.sourceTextIds,
      sourceTextIndices: place.sourceTextIndices,
      approxBbox: place.approxBbox,
      projectedCoordinates: canonical.projectedCoordinates || place.extensions?.projectedCoordinates?.coordinates,
      matchProviders: asArray(place.gazetteerMatches).map((match) => ({
        provider: providerKey(match),
        authorityId: match.authorityId,
        status: match.status,
        matchType: match.matchType,
        confidence: match.confidence,
      })),
      topCanonical,
      topSource,
    },
  };
}

export function triageGazetteerMatches(aiEnrichments) {
  const notes = [];
  for (const place of asArray(aiEnrichments?.derivedPlacenames)) {
    const reasons = reviewReasons(place);
    if (reasons.length > 0) notes.push(reviewNote(place, reasons));
  }
  const byRecommendation = {};
  for (const note of notes) byRecommendation[note.recommendation] = (byRecommendation[note.recommendation] || 0) + 1;
  return {
    summary: {
      placenames: asArray(aiEnrichments?.derivedPlacenames).length,
      reviewNotes: notes.length,
      byRecommendation,
    },
    notes,
  };
}

function parseArgs(argv) {
  const options = { input: "", output: "" };
  for (const arg of argv) {
    if (arg.startsWith("--input=")) options.input = path.resolve(arg.slice("--input=".length));
    else if (arg.startsWith("--output=")) options.output = path.resolve(arg.slice("--output=".length));
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.input) throw new Error("--input is required");
  return options;
}

function printHelp() {
  console.log(`Generate review triage notes for enriched gazetteer matches.

Usage:
  npm run triage:gazetteer -- --input=PATH [--output=PATH]
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.input)) throw new Error(`Input not found: ${options.input}`);
  const report = triageGazetteerMatches(JSON.parse(readFileSync(options.input, "utf8")));
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, text, "utf8");
  else process.stdout.write(text);
  console.error(`Generated ${report.summary.reviewNotes} review note(s) for ${report.summary.placenames} placename(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
