![Logo](admin/androidtvremote.png)

# ioBroker.androidtvremote

[![NPM version](https://img.shields.io/npm/v/iobroker.androidtvremote.svg)](https://www.npmjs.com/package/iobroker.androidtvremote)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Unofficial Android TV / Google TV remote control adapter for ioBroker using the Android TV Remote v2 protocol.

Supported devices: [Android TV / Google TV](https://www.android.com/tv/).

The adapter maintains a persistent connection to an Android TV or Google TV device and provides remote control, power state, volume information, currently active application and optional Google Cast media metadata.

## Features

- Android TV Remote v2 protocol
- No ADB or wireless debugging required
- Secure pairing with Android TV / Google TV
- Pairing certificate stored locally after initial pairing
- Persistent Remote v2 connection
- Automatic reconnect after connection loss
- Power state
- Volume and mute state
- Currently active Android application
- Friendly names for many common streaming apps
- Unknown application package detection
- Remote key commands
- Text input
- App/deep-link launching
- Power control
- Manual reconnect
- Pairing reset
- Optional Google Cast session and media metadata
- Automatic device discovery (Bonjour/mDNS) in the adapter configuration

## Requirements

- ioBroker
- Node.js 22 or newer
- Android TV or Google TV device supporting the Android TV Remote v2 protocol
- ioBroker host and Android TV / Google TV device must be reachable over the network

Default Android TV Remote v2 ports:

| Function | Port |
|----------|------|
| Remote | 6466 |
| Pairing | 6467 |

## Installation

Install the adapter in ioBroker and create an instance.

Select a discovered device in the adapter configuration or enter its IP address or hostname manually.

The network is searched once when the adapter starts and again when you press "Search" in the configuration. The IP address / hostname field stays editable after selecting a device.

## Pairing

On the first connection, the Android TV / Google TV device displays a pairing code.

Enter this code into:

    androidtvremote.0.control.pairingCode

After successful pairing, the certificate is stored locally by the adapter and normally no further pairing is required.

To remove the stored pairing information and pair again, trigger:

    androidtvremote.0.control.forgetPairing

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| IP address / hostname | Android TV / Google TV device | |
| Pairing name | Name shown on the TV during pairing | ioBroker |
| Pairing port | Android TV Remote v2 pairing port | 6467 |
| Remote port | Android TV Remote v2 remote-control port | 6466 |
| Reconnect interval | Delay before reconnecting after a failed connection | 15 s |
| Protocol debug | Enable additional protocol logging | disabled |
| Cast media information | Enable optional Google Cast monitoring | enabled |
| Cast polling interval | Interval for checking Cast media information | 5 s |

## Datapoints

### Information

    info.connection
    info.pairingRequired
    info.powered
    info.currentAppId
    info.currentApp
    info.currentAppUnknown
    info.lastRemoteReady
    info.volume.level
    info.volume.maximum
    info.volume.muted
    info.discovery.running
    info.discovery.devices

`info.currentAppId` contains the original Android package name.

`info.currentApp` provides a human-readable application name for many common applications, including Netflix, YouTube, Prime Video, ARD, ZDF, RTL+, MagentaTV, Joyn, Zattoo, waipu.tv, DAZN, Spotify, KiKA, WOW, Disney+ and Apple TV.

Unknown package names are additionally written to `info.currentAppUnknown` so that the application mapping can easily be extended.

### Controls

    control.pairingCode
    control.key
    control.text
    control.appLink
    control.power
    control.reconnect
    control.forgetPairing
    control.discover

| State | Usage |
|-------|-------|
| `control.pairingCode` | Pairing code shown on the TV |
| `control.key` | Key name, e.g. `HOME`, `BACK`, `OK`, `UP`, `DOWN`, `LEFT`, `RIGHT`, `PLAY_PAUSE`, `VOLUME_UP`, `MUTE`, or any Android `KEYCODE_...` name |
| `control.text` | Text to type into the focused input field |
| `control.appLink` | App link or URL to open on the TV |
| `control.power` | `true` / `false` to switch the TV on or off (sent only if the state differs) |
| `control.reconnect` | Button: reconnect now |
| `control.forgetPairing` | Button: delete the stored pairing and pair again |
| `control.discover` | Button: search the network for devices |

Commands are acknowledged after they were handled. Without a connection, `control.power` shows the last known power state.

### Google Cast

When Cast monitoring is enabled:

    info.cast.connection
    info.cast.appId
    info.cast.appName
    info.media.title
    info.media.subtitle
    info.media.playerState
    info.media.contentId

## Media metadata

Android TV Remote v2 itself provides information about the currently active Android application, but does not expose complete media metadata for every native Android TV application.

The optional Cast integration can provide title, subtitle and playback state when an active Google Cast receiver session exposes this information.

Media, Cast and application states are cleared when the TV is switched off.

Therefore, media metadata may not be available for applications that are running natively on the Android TV device.

## Connection handling

The adapter keeps the Android TV Remote v2 connection open instead of periodically disconnecting and rebuilding it.

Protocol ping requests are handled by the underlying Remote v2 library.

If the initial connection fails or an established connection is lost, the adapter retries the connection using the configured reconnect interval.

`info.connection` (instance indicator) stays green as long as a pairing exists or a connection was established. A switched-off TV does not turn it yellow; the adapter keeps checking the TV and reconnects automatically as soon as it is reachable again. `info.powered` shows the power state. The instance is only yellow if there never was a connection (not paired yet).

A single "unpaired" report from the device (the TV also sends it when it switches off) only triggers a reconnect. After 5 reports in a row the adapter stops reconnecting and sets `info.pairingRequired`. The stored pairing is always kept. Trigger `control.reconnect` to try again, or `control.forgetPairing` to pair anew.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.3.2 (2026-11-28)

- Fixed: instance turned yellow when the TV was switched off and sometimes did not reconnect when it came back
- Changed: `info.connection` stays true while a pairing exists, TV off is no longer a connection error
- Changed: a single "unpaired" report only triggers a reconnect

### 0.3.1 (2026-11-12)

- Fixed: missing `bonjour-service` dependency
- Fixed: Cast polling can no longer stall, Cast player is reused per session
- Fixed: buttons are not readable anymore, `control.power` without connection
- Fixed: security advisories in dependencies
- Changed: log messages, app names and `media.mute` role are now standard/English
- Added: channel objects, `info.connection` instance object, debug option in config

### 0.3.0 (2026-10-15)

- Added cached Bonjour device discovery and manual device search in the adapter configuration.
- Added device selection with a separately editable IP address / hostname field.
- Added translated discovery status in 11 languages and Admin GUI API 2 compatibility.
- Clear media, Cast and current-app states on power-off; restore the tested Cast media polling implementation.

### 0.2.9 (2026-10-15)

- Fixed Cast polling becoming permanently stuck when requests do not respond
- Added timeouts and automatic recovery of stalled Cast connections
- Improved Cast error logging
- No changes to Android TV Remote v2 pairing or remote-control functionality

### 0.2.8 (2026-10-09)

- Updated GitHub Actions checks and Dependabot automerge configuration
- Maintenance release without changes to adapter runtime behavior

### 0.2.7 (2026-10-09)

- Added automated GitHub Actions release workflow
- Prepared npm publishing through Trusted Publishing
- Updated release documentation and changelog
- No changes to adapter runtime behavior

[Older changelog entries](CHANGELOG_OLD.md)

## License

MIT License

Copyright (c) 2026 Henrik Schönhofen <henrik.schoenhofen@icloud.com>

See [LICENSE](LICENSE) for the full license text.
