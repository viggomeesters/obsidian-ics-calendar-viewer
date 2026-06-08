# Changelog

## 0.1.4

- Added manual release workflow dispatch fallback for GitHub artifact attestations.

## 0.1.3

- Reissued the review-fix release after adding the GitHub Actions release workflow.

## 0.1.2

- Added the repository MIT license file.
- Removed redundant component literal types from the ICS parser.
- Replaced `display: contents` in the detail field layout for older Obsidian compatibility.
- Added a GitHub Actions release workflow with build provenance attestations for release assets.

## 0.1.1

- Persisted viewer mode, grouping, and filters in Obsidian view state for restored event/source tabs.

## 0.1.0

- Initial read-only `.ics` file viewer.
- Added local `VCALENDAR`, `VEVENT`, `VTODO`, and `VTIMEZONE` parsing.
- Added event list, detail pane, search/date filters, recurrence and timezone warnings, and raw source view.
- Added fixture-backed smoke and security checks.
