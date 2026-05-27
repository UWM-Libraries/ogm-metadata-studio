#!/usr/bin/env python3
"""Build a compact Who's On First concordance index for the enrichment proxy.

The script reads WOF SQLite downloads and/or checked-out WOF GeoJSON repos,
then writes NDJSON records that the local Node proxy can load without a live
gazetteer API.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any, Iterable


def normalize_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def table_columns(conn: sqlite3.Connection, table: str) -> dict[str, str]:
    try:
        rows = conn.execute(f"PRAGMA table_info({quote_ident(table)})").fetchall()
    except sqlite3.Error:
        return {}
    return {str(row["name"]).lower(): str(row["name"]) for row in rows}


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1",
        (table,),
    ).fetchone()
    return row is not None


def pick_col(columns: dict[str, str], *names: str) -> str | None:
    for name in names:
        if name.lower() in columns:
            return columns[name.lower()]
    return None


def row_get(row: sqlite3.Row | dict[str, Any], columns: dict[str, str], *names: str) -> Any:
    column = pick_col(columns, *names)
    if not column:
        return None
    return row[column]


def parse_jsonish(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    text = str(value).strip()
    if not text:
        return None
    if text[0] in "[{":
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return None
    return None


def parse_list(value: Any) -> list[Any]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    parsed = parse_jsonish(value)
    if isinstance(parsed, list):
        return parsed
    text = str(value).strip()
    if not text:
        return []
    if "," in text:
        return [item.strip() for item in text.split(",") if item.strip()]
    return [text]


def parse_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number else None


def parse_boolish(value: Any) -> bool | None:
    if value is True or value is False:
        return value
    if value in (1, "1"):
        return True
    if value in (0, "0"):
        return False
    text = str(value or "").strip().lower()
    if text == "true":
        return True
    if text == "false":
        return False
    return None


def parse_bbox(value: Any) -> list[float] | None:
    if isinstance(value, str) and "," in value:
        parts = [item.strip() for item in value.split(",")]
    else:
        parsed = parse_jsonish(value)
        parts = parsed if isinstance(parsed, list) else value
    if not isinstance(parts, list) or len(parts) < 4:
        return None
    numbers = [parse_number(item) for item in parts[:4]]
    if any(item is None for item in numbers):
        return None
    west, south, east, north = numbers
    if west > east or south > north:
        return None
    return [west, south, east, north]


def bbox_intersects(a: list[float] | None, b: list[float] | None) -> bool:
    if not a or not b:
        return False
    return a[2] >= b[0] and a[0] <= b[2] and a[3] >= b[1] and a[1] <= b[3]


def compact_id(value: Any) -> str | None:
    if value is None or value == "":
        return None
    text = str(value).strip()
    return text if text else None


def add_name(names: list[dict[str, str]], value: Any, source: str) -> None:
    text = str(value or "").strip()
    if not text:
        return
    normalized = normalize_text(text)
    if not normalized:
        return
    key = (normalized, source)
    existing = {(item["normalized"], item["source"]) for item in names}
    if key in existing:
        return
    names.append({"value": text, "normalized": normalized, "source": source})


def values_from_property(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        parsed = parse_jsonish(value)
        if isinstance(parsed, list):
            return parsed
    return [value]


def region_code_from_props(props: dict[str, Any], repo: str | None) -> str | None:
    iso_code = str(props.get("iso:code") or props.get("qs:a2") or "").upper()
    match = re.match(r"^[A-Z]{2}-([A-Z0-9]{2,3})$", iso_code)
    if match:
        return match.group(1)
    repo_text = str(repo or props.get("wof:repo") or "").lower()
    match = re.search(r"(?:^|-)us-([a-z]{2})(?:$|-)", repo_text)
    if match:
        return match.group(1).upper()
    return None


def hierarchy_ids(hierarchy: Any) -> list[str]:
    ids: list[str] = []
    for item in hierarchy if isinstance(hierarchy, list) else [hierarchy]:
        if not isinstance(item, dict):
            continue
        for key, value in item.items():
            if key.endswith("_id") or key in {"id", "wof:id"}:
                for candidate in parse_list(value):
                    text = compact_id(candidate)
                    if text and text not in ids:
                        ids.append(text)
    return ids


def feature_from_geojson_table(conn: sqlite3.Connection, wof_id: str) -> dict[str, Any] | None:
    if not table_exists(conn, "geojson"):
        return None
    columns = table_columns(conn, "geojson")
    id_col = pick_col(columns, "id", "wof_id", "wof:id")
    json_col = pick_col(columns, "body", "geojson", "json", "feature")
    if not id_col or not json_col:
        return None
    try:
        row = conn.execute(
            f"SELECT * FROM geojson WHERE {quote_ident(id_col)} = ? LIMIT 1",
            (wof_id,),
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    parsed = parse_jsonish(row[json_col])
    return parsed if isinstance(parsed, dict) else None


def related_rows(conn: sqlite3.Connection, table: str, wof_id: str) -> tuple[list[sqlite3.Row], dict[str, str]]:
    if not table_exists(conn, table):
        return [], {}
    columns = table_columns(conn, table)
    id_col = pick_col(columns, "id", "wof_id", "wof:id")
    if not id_col:
        return [], columns
    try:
        rows = conn.execute(
            f"SELECT * FROM {quote_ident(table)} WHERE {quote_ident(id_col)} = ?",
            (wof_id,),
        ).fetchall()
    except sqlite3.Error:
        return [], columns
    return rows, columns


def names_from_feature(props: dict[str, Any], names: list[dict[str, str]]) -> None:
    add_name(names, props.get("wof:name"), "wof:name")
    for key, value in props.items():
        if not (key.startswith("name:") or key.startswith("fullname:")):
            continue
        for item in values_from_property(value):
            add_name(names, item, key)


def names_from_table(conn: sqlite3.Connection, wof_id: str, names: list[dict[str, str]]) -> None:
    rows, columns = related_rows(conn, "names", wof_id)
    name_col = pick_col(columns, "name", "value", "label")
    if not name_col:
        return
    for row in rows:
        source = row_get(row, columns, "source", "key", "name_key", "tag", "name_type", "type")
        if not source:
            source_parts = [
                row_get(row, columns, "language", "lang"),
                row_get(row, columns, "extlang"),
                row_get(row, columns, "script"),
                row_get(row, columns, "region"),
                row_get(row, columns, "variant"),
                row_get(row, columns, "extension"),
                row_get(row, columns, "privateuse"),
            ]
            source = "names:" + "_".join(str(item) for item in source_parts if item)
        add_name(names, row[name_col], str(source or "names"))


def concordances_from_table(conn: sqlite3.Connection, wof_id: str) -> dict[str, Any]:
    rows, columns = related_rows(conn, "concordances", wof_id)
    concordances: dict[str, Any] = {}
    key_col = pick_col(columns, "key", "source", "namespace", "prefix", "concordance_key")
    value_col = pick_col(columns, "value", "other_id", "concordance_value", "identifier")
    ignored = {"id", "wof_id", "wof:id", "placetype", "country"}
    for row in rows:
        if key_col and value_col and row[key_col] not in (None, "") and row[value_col] not in (None, ""):
            concordances[str(row[key_col])] = row[value_col]
            continue
        for lower_name, column in columns.items():
            if lower_name in ignored or row[column] in (None, ""):
                continue
            concordances[column] = row[column]
    return concordances


def ancestors_from_table(conn: sqlite3.Connection, wof_id: str) -> tuple[list[str], list[str], list[dict[str, Any]]]:
    rows, columns = related_rows(conn, "ancestors", wof_id)
    ancestor_ids: list[str] = []
    ancestor_names: list[str] = []
    hierarchy: list[dict[str, Any]] = []
    ancestor_id_col = pick_col(columns, "ancestor_id", "ancestor", "ancestor_wof_id")
    placetype_col = pick_col(columns, "ancestor_placetype", "placetype")
    name_col = pick_col(columns, "ancestor_name", "name")
    for row in rows:
        ancestor_id = compact_id(row[ancestor_id_col]) if ancestor_id_col else None
        if ancestor_id and ancestor_id not in ancestor_ids:
            ancestor_ids.append(ancestor_id)
        name = str(row[name_col]).strip() if name_col and row[name_col] not in (None, "") else ""
        if name and name not in ancestor_names:
            ancestor_names.append(name)
        if ancestor_id and placetype_col and row[placetype_col]:
            hierarchy.append({f"{row[placetype_col]}_id": ancestor_id})
    return ancestor_ids, ancestor_names, hierarchy


def record_from_row(conn: sqlite3.Connection, row: sqlite3.Row, spr_columns: dict[str, str]) -> dict[str, Any] | None:
    wof_id = compact_id(row_get(row, spr_columns, "id", "wof_id", "wof:id"))
    if not wof_id:
        return None
    feature = feature_from_geojson_table(conn, wof_id) or {}
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}

    names: list[dict[str, str]] = []
    name = row_get(row, spr_columns, "name") or props.get("wof:name")
    add_name(names, name, "wof:name")
    names_from_feature(props, names)
    names_from_table(conn, wof_id, names)

    min_lon = parse_number(row_get(row, spr_columns, "min_lon", "minlongitude"))
    min_lat = parse_number(row_get(row, spr_columns, "min_lat", "minlatitude"))
    max_lon = parse_number(row_get(row, spr_columns, "max_lon", "maxlongitude"))
    max_lat = parse_number(row_get(row, spr_columns, "max_lat", "maxlatitude"))
    bbox = [min_lon, min_lat, max_lon, max_lat] if None not in (min_lon, min_lat, max_lon, max_lat) else None
    bbox = parse_bbox(bbox) or parse_bbox(feature.get("bbox")) or parse_bbox(props.get("geom:bbox"))

    lon = parse_number(row_get(row, spr_columns, "lon", "longitude"))
    lat = parse_number(row_get(row, spr_columns, "lat", "latitude"))
    lon = lon if lon is not None else parse_number(props.get("geom:longitude") or props.get("lbl:longitude"))
    lat = lat if lat is not None else parse_number(props.get("geom:latitude") or props.get("lbl:latitude"))
    centroid = {"lon": lon, "lat": lat} if lon is not None and lat is not None else None

    concordances = {}
    props_concordances = props.get("wof:concordances")
    if isinstance(props_concordances, dict):
        concordances.update({str(key): value for key, value in props_concordances.items()})
    concordances.update(concordances_from_table(conn, wof_id))

    table_ancestor_ids, table_ancestor_names, table_hierarchy = ancestors_from_table(conn, wof_id)
    hierarchy = props.get("wof:hierarchy")
    if not hierarchy:
        hierarchy = table_hierarchy
    ancestor_ids = [
        *hierarchy_ids(hierarchy),
        *[compact_id(item) for item in parse_list(props.get("wof:belongsto")) if compact_id(item)],
        *table_ancestor_ids,
    ]
    deduped_ancestor_ids = []
    for ancestor_id in ancestor_ids:
        if ancestor_id and ancestor_id != wof_id and ancestor_id not in deduped_ancestor_ids:
            deduped_ancestor_ids.append(ancestor_id)

    repo = row_get(row, spr_columns, "repo") or props.get("wof:repo")
    placetype = row_get(row, spr_columns, "placetype") or props.get("wof:placetype")
    country = row_get(row, spr_columns, "country") or props.get("wof:country") or props.get("iso:country")
    region = region_code_from_props(props, str(repo or ""))
    is_current = parse_boolish(row_get(row, spr_columns, "is_current", "iscurrent"))
    if is_current is None:
        is_current = parse_boolish(props.get("mz:is_current"))

    return {
        "wofId": wof_id,
        "name": str(name or names[0]["value"] if names else "").strip(),
        "normalizedNames": names,
        "placetype": str(placetype or "").strip().lower() or None,
        "country": str(country or "").strip().upper() or None,
        "region": region,
        "bbox": bbox,
        "centroid": centroid,
        "hierarchy": hierarchy,
        "ancestorIds": deduped_ancestor_ids,
        "ancestorNames": table_ancestor_names,
        "concordances": concordances or None,
        "repo": repo,
        "isCurrent": is_current,
        "isDeprecated": parse_boolish(row_get(row, spr_columns, "is_deprecated", "isdeprecated") or props.get("edtf:deprecated")),
        "isSuperseded": parse_boolish(row_get(row, spr_columns, "is_superseded", "issuperseded") or props.get("wof:superseded")),
        "supersededBy": parse_list(row_get(row, spr_columns, "superseded_by", "supersededby") or props.get("wof:superseded_by")),
        "path": row_get(row, spr_columns, "path") or props.get("wof:path"),
        "uri": row_get(row, spr_columns, "uri") or props.get("wof:uri"),
    }


def record_from_feature(feature: dict[str, Any], source_path: Path | None = None) -> dict[str, Any] | None:
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    wof_id = compact_id(props.get("wof:id") or feature.get("id"))
    if not wof_id:
        return None

    names: list[dict[str, str]] = []
    name = props.get("wof:name")
    add_name(names, name, "wof:name")
    names_from_feature(props, names)

    bbox = parse_bbox(feature.get("bbox")) or parse_bbox(props.get("geom:bbox"))
    lon = parse_number(props.get("geom:longitude") or props.get("lbl:longitude"))
    lat = parse_number(props.get("geom:latitude") or props.get("lbl:latitude"))
    centroid = {"lon": lon, "lat": lat} if lon is not None and lat is not None else None

    concordances = {}
    props_concordances = props.get("wof:concordances")
    if isinstance(props_concordances, dict):
        concordances.update({str(key): value for key, value in props_concordances.items()})

    hierarchy = props.get("wof:hierarchy")
    ancestor_ids = [
        *hierarchy_ids(hierarchy),
        *[compact_id(item) for item in parse_list(props.get("wof:belongsto")) if compact_id(item)],
    ]
    deduped_ancestor_ids = []
    for ancestor_id in ancestor_ids:
        if ancestor_id and ancestor_id != wof_id and ancestor_id not in deduped_ancestor_ids:
            deduped_ancestor_ids.append(ancestor_id)

    repo = props.get("wof:repo")
    placetype = props.get("wof:placetype")
    country = props.get("wof:country") or props.get("iso:country")
    region = region_code_from_props(props, str(repo or ""))
    is_current = parse_boolish(props.get("mz:is_current"))

    path = props.get("wof:path")
    if not path and source_path:
        path = str(source_path)

    return {
        "wofId": wof_id,
        "name": str(name or names[0]["value"] if names else "").strip(),
        "normalizedNames": names,
        "placetype": str(placetype or "").strip().lower() or None,
        "country": str(country or "").strip().upper() or None,
        "region": region,
        "bbox": bbox,
        "centroid": centroid,
        "hierarchy": hierarchy,
        "ancestorIds": deduped_ancestor_ids,
        "ancestorNames": [],
        "concordances": concordances or None,
        "repo": repo,
        "isCurrent": is_current,
        "isDeprecated": parse_boolish(props.get("edtf:deprecated")),
        "isSuperseded": parse_boolish(props.get("wof:superseded")),
        "supersededBy": parse_list(props.get("wof:superseded_by")),
        "path": path,
        "uri": props.get("wof:uri"),
    }


def compact_record(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if value not in (None, "", [], {})}


def apply_filters(record: dict[str, Any], args: argparse.Namespace) -> bool:
    country = str(record.get("country") or "").upper()
    if args.country and country != args.country.upper() and not (args.include_blank_country and not country):
        return False
    if args.placetypes and str(record.get("placetype") or "").lower() not in args.placetypes:
        return False
    if args.repo_contains:
        repo = str(record.get("repo") or "").lower()
        if not any(item.lower() in repo for item in args.repo_contains):
            return False
    if args.current_only and record.get("isCurrent") is False:
        return False
    if args.bbox:
        bbox = record.get("bbox")
        if not bbox and record.get("centroid"):
            lon = record["centroid"]["lon"]
            lat = record["centroid"]["lat"]
            bbox = [lon, lat, lon, lat]
        if not bbox_intersects(bbox, args.bbox):
            return False
    return True


def sql_spr_rows(conn: sqlite3.Connection, args: argparse.Namespace) -> tuple[list[sqlite3.Row], dict[str, str]]:
    if not table_exists(conn, "spr"):
        raise RuntimeError("WOF SQLite database does not contain an spr table")
    columns = table_columns(conn, "spr")
    clauses: list[str] = []
    params: list[Any] = []
    country_col = pick_col(columns, "country")
    placetype_col = pick_col(columns, "placetype")
    min_lon_col = pick_col(columns, "min_lon", "minlongitude")
    max_lon_col = pick_col(columns, "max_lon", "maxlongitude")
    min_lat_col = pick_col(columns, "min_lat", "minlatitude")
    max_lat_col = pick_col(columns, "max_lat", "maxlatitude")

    if args.country and country_col:
        if args.include_blank_country:
            clauses.append(f"(upper({quote_ident(country_col)}) = ? OR {quote_ident(country_col)} IS NULL OR {quote_ident(country_col)} = '')")
        else:
            clauses.append(f"upper({quote_ident(country_col)}) = ?")
        params.append(args.country.upper())
    if args.placetypes and placetype_col:
        placeholders = ",".join("?" for _ in args.placetypes)
        clauses.append(f"lower({quote_ident(placetype_col)}) IN ({placeholders})")
        params.extend(sorted(args.placetypes))
    if args.bbox and all([min_lon_col, max_lon_col, min_lat_col, max_lat_col]):
        west, south, east, north = args.bbox
        clauses.append(
            f"{quote_ident(max_lon_col)} >= ? AND {quote_ident(min_lon_col)} <= ? "
            f"AND {quote_ident(max_lat_col)} >= ? AND {quote_ident(min_lat_col)} <= ?"
        )
        params.extend([west, east, south, north])
    sql = "SELECT * FROM spr"
    if clauses:
        sql += " WHERE " + " AND ".join(clauses)
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    return conn.execute(sql, params).fetchall(), columns


def geojson_data_root(root: Path) -> Path:
    if root.is_file():
        return root
    data_dir = root / "data"
    if data_dir.exists():
        return data_dir
    return root


def iter_geojson_paths(root: Path) -> Iterable[Path]:
    data_root = geojson_data_root(root)
    if data_root.is_file():
        if data_root.suffix == ".geojson":
            yield data_root
        return
    yield from sorted(data_root.rglob("*.geojson"))


def load_geojson_record(path: Path) -> dict[str, Any] | None:
    with path.open("r", encoding="utf-8") as stream:
        parsed = json.load(stream)
    if not isinstance(parsed, dict):
        return None
    return record_from_feature(parsed, path)


def merge_records(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    merged = {**existing, **{key: value for key, value in incoming.items() if value not in (None, "", [], {})}}
    names = existing.get("normalizedNames", []) + incoming.get("normalizedNames", [])
    deduped_names: list[dict[str, str]] = []
    for item in names:
        key = (item.get("normalized"), item.get("source"))
        if key not in {(name.get("normalized"), name.get("source")) for name in deduped_names}:
            deduped_names.append(item)
    merged["normalizedNames"] = deduped_names
    merged["ancestorIds"] = list(dict.fromkeys(existing.get("ancestorIds", []) + incoming.get("ancestorIds", [])))
    merged["ancestorNames"] = list(dict.fromkeys(existing.get("ancestorNames", []) + incoming.get("ancestorNames", [])))
    concordances = {}
    concordances.update(existing.get("concordances") or {})
    concordances.update(incoming.get("concordances") or {})
    if concordances:
        merged["concordances"] = concordances
    return merged


def attach_hierarchy_labels(records: dict[str, dict[str, Any]]) -> None:
    id_to_name = {wof_id: record.get("name") for wof_id, record in records.items() if record.get("name")}
    id_to_region = {
        wof_id: record.get("region")
        for wof_id, record in records.items()
        if record.get("placetype") == "region" and record.get("region")
    }
    for record in records.values():
        labels = list(record.get("ancestorNames") or [])
        for ancestor_id in record.get("ancestorIds") or []:
            name = id_to_name.get(str(ancestor_id))
            if name and name not in labels:
                labels.append(name)
            if not record.get("region") and id_to_region.get(str(ancestor_id)):
                record["region"] = id_to_region[str(ancestor_id)]
        if labels:
            record["hierarchyLabels"] = labels


def parse_bbox_arg(value: str | None) -> list[float] | None:
    if not value:
        return None
    bbox = parse_bbox(value)
    if not bbox:
        raise argparse.ArgumentTypeError("bbox must be west,south,east,north")
    return bbox


def parse_csv_set(values: list[str] | None) -> set[str]:
    items: set[str] = set()
    for value in values or []:
        for item in value.split(","):
            text = item.strip().lower()
            if text:
                items.add(text)
    return items


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sqlite", nargs="*", type=Path, help="WOF SQLite download(s) to index")
    parser.add_argument("-o", "--output", required=True, type=Path, help="Output NDJSON path")
    parser.add_argument("--geojson-root", action="append", type=Path, help="WOF GeoJSON repo root, data directory, or single .geojson file")
    parser.add_argument("--label", help="Human-readable index label stored in the NDJSON metadata line")
    parser.add_argument("--country", help="Optional ISO country filter, such as US")
    parser.add_argument("--include-blank-country", action="store_true", help="Keep bbox-matching records whose source has no country code, useful for marine or cross-border WOF repos")
    parser.add_argument("--bbox", type=parse_bbox_arg, help="Optional west,south,east,north bbox filter")
    parser.add_argument("--placetype", action="append", dest="placetype_values", help="Placetype or comma-separated placetype list")
    parser.add_argument("--repo-contains", action="append", help="Keep only records whose repo contains this text")
    parser.add_argument("--current-only", action="store_true", help="Exclude records flagged as non-current")
    parser.add_argument("--limit", type=int, help="Development-only row limit per SQLite input")
    parser.add_argument("--geojson-limit", type=int, help="Development-only file limit per GeoJSON root")
    return parser


def main(argv: list[str]) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if not args.sqlite and not args.geojson_root:
        parser.error("Provide at least one SQLite input or --geojson-root")
    args.placetypes = parse_csv_set(args.placetype_values)
    records: dict[str, dict[str, Any]] = {}
    input_summaries = []

    for sqlite_path in args.sqlite:
        if not sqlite_path.exists():
            parser.error(f"SQLite input not found: {sqlite_path}")
        conn = sqlite3.connect(sqlite_path)
        conn.row_factory = sqlite3.Row
        try:
            rows, spr_columns = sql_spr_rows(conn, args)
            kept = 0
            for row in rows:
                record = record_from_row(conn, row, spr_columns)
                if not record or not apply_filters(record, args):
                    continue
                compacted = compact_record(record)
                wof_id = str(compacted["wofId"])
                records[wof_id] = merge_records(records[wof_id], compacted) if wof_id in records else compacted
                kept += 1
            input_summaries.append({"path": str(sqlite_path), "sprRowsRead": len(rows), "recordsKept": kept})
        finally:
            conn.close()

    for root in args.geojson_root or []:
        if not root.exists():
            parser.error(f"GeoJSON root not found: {root}")
        files_read = 0
        kept = 0
        errors = 0
        for path in iter_geojson_paths(root):
            if args.geojson_limit and files_read >= args.geojson_limit:
                break
            files_read += 1
            try:
                record = load_geojson_record(path)
            except (OSError, json.JSONDecodeError) as error:
                errors += 1
                print(f"Skipping unreadable GeoJSON {path}: {error}", file=sys.stderr)
                continue
            if not record or not apply_filters(record, args):
                continue
            compacted = compact_record(record)
            wof_id = str(compacted["wofId"])
            records[wof_id] = merge_records(records[wof_id], compacted) if wof_id in records else compacted
            kept += 1
        input_summaries.append({
            "type": "geojson_root",
            "path": str(root),
            "filesRead": files_read,
            "recordsKept": kept,
            "errors": errors,
        })

    attach_hierarchy_labels(records)
    output_records = [compact_record(record) for record in records.values()]
    output_records.sort(key=lambda item: (str(item.get("country", "")), str(item.get("placetype", "")), str(item.get("name", "")), str(item.get("wofId", ""))))

    args.output.parent.mkdir(parents=True, exist_ok=True)
    metadata = {
        "type": "metadata",
        "label": args.label or args.output.stem,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "recordCount": len(output_records),
        "inputs": input_summaries,
        "filters": {
            "country": args.country,
            "includeBlankCountry": args.include_blank_country,
            "bbox": args.bbox,
            "placetypes": sorted(args.placetypes),
            "repoContains": args.repo_contains,
            "currentOnly": args.current_only,
        },
    }
    with args.output.open("w", encoding="utf-8") as stream:
        stream.write(json.dumps(metadata, ensure_ascii=False, sort_keys=True) + "\n")
        for record in output_records:
            stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

    print(f"Wrote {len(output_records)} WOF record(s) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
