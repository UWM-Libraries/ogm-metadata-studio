# OpenGeoMetadata Studio Design System

This document is the source of truth for the OpenGeoMetadata Studio interface. The app should feel like a working metadata studio built from the same visual language as the OpenGeoMetadata API site: precise, archival, geometric, and a little playful.

## Design Goals

- Make every page feel like part of one application, not a collection of embedded tools.
- Use OpenGeoMetadata brand cues deliberately: logo geometry, black line work, yellow/blue/red accents, grid structure, and confident type.
- Keep the primary background white. Yellow is an accent, not an ambient page tint.
- Let the single global grid background show through the app frame instead of adding grid-on-grid surfaces.
- Favor operational clarity over marketing composition. This is a metadata workspace.

## Brand Assets

The official app logo treatment is a stacked mark:

- Official OpenGeoMetadata map legend logo on top.
- Yellow square behind it, slightly offset.
- Black square behind the yellow square, slightly offset again.
- Hard black borders, square geometry, no soft card treatment.

Current logo assets live in `web/public/opengeometadata-map-legend-logo-*.svg`.

Do not invent faux official logo compositions for background art. If logo geometry appears as decoration, use the official mark or official mark-derived assets.

## Core Palette

Use these colors as the working palette:

- Ink: `#111111`
- Text: `#141414`
- Muted text: `#5a5547`
- White: `#ffffff`
- Cool neutral well: `#f5f5f5`
- OGM yellow: `#f6d94d`
- OGM blue: `#2f62b8`
- OGM red: `#cf3f32`

Yellow, blue, and red should be accents: logo layers, active states, rules, chips, small fills, map marks, and footer details. They should not wash the full page.

## Background System

The page background is a white fixed grid.

- Base: white.
- Grid lines: subtle black at low opacity.
- Global background art sits behind all page content.
- The main workspace frame is translucent white so the one true grid bleeds through.
- Do not add another grid texture to the main content panels.

The gray triangle and accent squares can be playful, but they should stay quiet enough that metadata remains the focus.

## Layout

The app layout is:

1. Sticky branded header.
2. Single global grid/background layer.
3. Main workspace frame.
4. Page/tool content.
5. OGM API-inspired footer.

Use full-width app sections and framed tools. Do not nest cards inside cards. Cards are for repeated resource items, tables, modals, and focused tool surfaces.

## Typography

Use Work Sans throughout the app.

- Headers should be heavy and confident.
- Labels should be compact, uppercase when useful, and highly scannable.
- Body copy should remain readable and work-focused.
- Do not use negative letter spacing.
- Do not scale font size with viewport width except for true page hero/title moments.

## Component Language

Shared OGM component classes should carry the visual system:

- `ogm-workspace-frame`
- `ogm-page-card`
- `ogm-table-card`
- `ogm-admin-toolbar`
- `ogm-result-card`
- `ogm-panel-card`
- `ogm-map-facet`
- `ogm-field`
- `ogm-select`
- `ogm-primary-button`
- `ogm-secondary-button`
- `ogm-danger-button`
- `ogm-tag`
- `ogm-access-badge`

Common traits:

- 2px black borders in light mode.
- 4px radius or less.
- Small hard shadows, usually black at low opacity.
- White or translucent-white surfaces.
- Yellow rules or inset accents where emphasis is needed.
- Dark mode switches borders and key accents to OGM yellow.

Avoid Tailwind default gray-card UI on new screens. If a page needs a table, form, toolbar, tab strip, empty state, or action button, use the OGM classes first.

## Search Results

Results should feel like catalog records in the OGM system.

- No red/blue/yellow stripe on the left edge.
- Resource index uses a small yellow square.
- Thumbnail and static map are framed with black borders.
- Metadata tags use cool neutral wells.
- Resource title is OGM blue and becomes ink with a yellow underline on hover.
- Result card surfaces are white/translucent white so the page grid remains unified.

## Maps

Use the shared OpenFreeMap Bright style for MapLibre maps and static result maps.

Shared config:

- `OPENFREEMAP_BRIGHT_STYLE`
- `STATIC_MAP_CACHE_VERSION`
- `staticMapCacheKey`

When map rendering changes, bump the static map cache version so cached images regenerate.

Hex/H3 map visualizations should render as real map overlays, not empty controls. If a page has geometry, the user should see the geometry.

## Resource Pages

Resource detail, edit, related distributions, sidebar, similar resources, and admin views must share the same OGM design language as search.

- Resource pages sit inside the same workspace frame.
- Detail panels use `ogm-page-card` or `ogm-table-card`.
- Edit tabs use `ogm-tab-strip` and `ogm-tab-button`.
- Form fields use `ogm-field`, `ogm-select`, and `TagInput`'s OGM styling.
- Code/citation boxes use the cool neutral well, not cream.

Do not let the edit experience fall back to generic SaaS gray panels.

## Admin And Utility Pages

Admin resources, distributions, import/export, and enrichments should all use the same app shell.

Preferred canonical routes:

- `/admin/resources`
- `/admin/distributions`
- `/admin/import`
- `/admin/enrichments`
- `/admin/resources/new`
- `/resources/:id`
- `/resources/:id/edit`
- `/resources/:id/admin`

Avoid exposing `?view=...` as the primary user-facing navigation pattern.

## Footer

The footer should echo the OGM API footer:

- Black grid background.
- White title text.
- Yellow underline/rule.
- Blue vertical panel.
- Project, route, and note sections.
- Links and route code pills that feel integrated with the grid.

The footer is part of the app's identity, not a generic legal strip.

## Interaction Rules

- Buttons use icons when an icon is the familiar convention.
- Text buttons are for clear commands or navigation labels.
- Controls should be stable in size; hover states must not shift layouts.
- Interactive states should be obvious but not noisy.
- Keep content scannable for repeated metadata work.

## Dark Mode

Dark mode is black-first:

- Base: `#111111`
- Grid lines: subtle white.
- Borders and key active states: OGM yellow.
- Cards: near-black translucent surfaces.
- Text: white with muted white for secondary copy.

Do not make dark mode a separate design system. It is the same OGM geometry with inverted surfaces.

## Design Review Checklist

Before finalizing UI changes, check:

- Does the app still use white as the primary background?
- Is there only one visible grid system behind the content?
- Are yellow, blue, and red accents used sparingly?
- Does the official logo treatment appear in the header?
- Are result cards free of the old left color stripe?
- Do admin/resource/edit pages use the same OGM component language?
- Do maps use the shared Bright style?
- Do footer and header feel like the same product?
- Does text fit at mobile and desktop widths?
- Do typecheck, build, focused tests, and a browser route sweep still pass?
