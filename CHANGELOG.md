# Changelog

## 0.3.0 (2026-10-15)

### Added
- Discover Android TV devices through Bonjour in the adapter configuration, with cached results and a manual refresh button.
- Select a discovered device while keeping the hostname / IP address editable.
- Localized device discovery status in 11 languages.

### Fixed
- Clear playback, Cast and current-app states when Android TV is powered off.
- Restore the previously working Cast session/media polling behavior, avoiding the getSessions timeout regression introduced during media cleanup.
- Use Admin GUI API generation 2 for the device discovery component.

### Notes
- Cast media metadata depends on the receiving application exposing a compatible Cast media session.
- Earlier changes are documented in CHANGELOG_OLD.md.


## 0.2.9 (2026-10-15)

### Fixed
- Prevent Cast polling from permanently stopping when requests do not respond.
- Add request timeouts and automatic Cast connection recovery.
- Improve error logging for failed Cast requests.

