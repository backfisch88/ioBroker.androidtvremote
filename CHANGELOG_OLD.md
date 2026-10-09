# Older changes

### 0.2.6 (2026-10-08)

- Improved pairing credential persistence
- Pairing certificates are no longer automatically deleted on `unpaired` events
- Pairing information can still be removed manually using `control.forgetPairing`


### 0.2.5 (2026-10-07)

- Improved Remote v2 connection handling
- Persistent Remote v2 session instead of periodically forcing reconnects
- Failed initial connections are detected and retried automatically
- Protocol ping handling is left to the Android TV Remote v2 library
- Improved reconnect behavior after temporary network/device unavailability
- Android TV / Google TV power, volume and current-app states
- Friendly application-name mapping
- Optional Google Cast media metadata
- Remote keys, text input, app links and power control
- Secure pairing with locally stored certificate
