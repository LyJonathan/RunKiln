# Changelog

## [Unreleased]

### Added

- `SettingsList` section titles: an item with `section: true` is drawn flush left (theme `section`, else `hint`) with a blank row above, is skipped by the cursor, wheel and clicks, and is left out of search results.
- `HitMap` and `ClickableRows`: map rendered cells to values and handle hover, press, click, right click and wheel for clickable lists. Mouse `move` and `leave` events reach components, results can carry a `pointer` shape (sent as OSC 22 where enabled), and `TuiAltScreen` takes a mouse mode (`on`, `wheel`, `off`) and a full-repaint option.
- `TuiAltScreen` option `stickyPromptHeader(prompt, width)`: while scrolled up, the last user prompt above the view (a zone started with `USER_PROMPT_ZONE_START`) is pinned at the top; a click on it scrolls there. `scrollToEndIndicator` now receives the number of messages that arrived below since scrolling up.
- Reduced motion: `setReducedMotion()` / `isReducedMotion()`; loaders show a static `●` instead of animating when it is on.
- `Markdown` theme `maxProseWidth`: prose wraps at that width; code blocks and tables keep the full width.

### Changed

- UI strings use a plain " - " instead of middle dots and em dashes.
- Removed leftover upstream naming: user-facing text, comments, identifiers, temp-file and log names now say RunKiln. Legacy `PI_*` environment variables are still read as a fallback for their `RUNKILN_*` replacements.
- Dropped the upstream changelog history, which described features and docs RunKiln does not ship. See NOTICE.md for provenance.

## [0.1.0]

- First RunKiln release.
