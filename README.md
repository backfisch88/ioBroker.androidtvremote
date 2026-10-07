# ioBroker.androidtvremote

ioBroker adapter for Android TV / Google TV using Android TV Remote v2, with optional Google Cast media metadata.

## States

Remote v2:
- `info.connection`
- `info.powered`
- `info.currentAppId` - Android package name
- `info.currentApp` - friendly application name
- `info.volume.level`
- `info.volume.maximum`
- `info.volume.muted`

Cast media metadata:
- `info.cast.connection`
- `info.cast.appId`
- `info.cast.appName`
- `info.media.title`
- `info.media.subtitle`
- `info.media.playerState`
- `info.media.contentId`

Controls:
- `control.pairingCode`
- `control.key`
- `control.text`
- `control.appLink`
- `control.power`
- `control.reconnect`
- `control.forgetPairing`

## Development/install workflow

Source directory:

```bash
/home/pi/ioBroker.androidtvremote
```

Install dependencies there as the `iobroker` user, then replace the installed adapter directory with a real copy:

```bash
chown -R iobroker:iobroker /home/pi/ioBroker.androidtvremote
su -s /bin/bash iobroker -c 'cd /home/pi/ioBroker.androidtvremote && npm install'

rm -rf /opt/iobroker/node_modules/iobroker.androidtvremote
cp -a /home/pi/ioBroker.androidtvremote /opt/iobroker/node_modules/iobroker.androidtvremote
chown -R iobroker:iobroker /opt/iobroker/node_modules/iobroker.androidtvremote

cd /opt/iobroker
iobroker upload androidtvremote --allow-root
iobroker restart androidtvremote.0 --allow-root
```

Node.js 22+ is required by `@kud/androidtv-remote`.


## App-Namen (0.2.1)

`info.currentAppId` enthält die originale Android-Paket-ID. `info.currentApp` enthält einen lesbaren Namen für gängige Apps (u.a. Netflix, YouTube, Prime Video, ARD, ZDF, RTL+, MagentaTV, Joyn, Zattoo, waipu.tv, DAZN, Spotify, KiKA, WOW, Disney+ und Apple TV). Unbekannte Paket-IDs werden zusätzlich in `info.currentAppUnknown` geschrieben, damit das Mapping leicht erweitert werden kann.


## Connection handling (0.2.5)
The adapter keeps the Android TV Remote v2 session open. Protocol ping requests are handled by @kud/androidtv-remote. A failed initial connection is retried using the configured reconnect interval; healthy sessions are no longer periodically destroyed and rebuilt.
