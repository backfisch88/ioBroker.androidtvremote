'use strict';

const utils = require('@iobroker/adapter-core');
const fs = require('node:fs');
const path = require('node:path');
const { Client: CastClient, DefaultMediaReceiver } = require('castv2-client');

class AndroidTvRemoteAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'androidtvremote' });

        this.remote = null;
        this.remoteModule = null;
        this.reconnectTimer = null;
        this.lastRemoteReady = 0;
        this.stopping = false;
        this.connecting = false;
        this.pairingRequested = false;
        this.dataDir = '';
        this.credentialsFile = '';
        this.lastPowered = null;
        this.castClient = null;
        this.castPlayer = null;
        this.castTimer = null;
        this.castConnecting = false;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.stopping = false;
        await this.setStateAsync('info.connection', false, true);
        await this.ensureObjects();
        this.subscribeStates('control.*');

        if (!this.config.host || !String(this.config.host).trim()) {
            this.log.error('Bitte zuerst die IP-Adresse bzw. den Hostnamen des Android-TV-Geräts konfigurieren.');
            return;
        }

        this.dataDir = utils.getAbsoluteInstanceDataDir(this);
        this.credentialsFile = path.join(this.dataDir, 'credentials.json');
        await fs.promises.mkdir(this.dataDir, { recursive: true });

        try {
            this.remoteModule = await import('@kud/androidtv-remote');
        } catch (error) {
            this.log.error(`Android-TV-Remote-Bibliothek konnte nicht geladen werden: ${this.errorText(error)}`);
            return;
        }

        await this.connect();
        this.startCastMonitor();
    }

    async ensureObjects() {
        const defs = {
            'info.connection': {
                name: 'Connected',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            'info.lastRemoteReady': {
                name: 'Last remote connection',
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
                def: 0,
            },
            'info.pairingRequired': {
                name: 'Pairing required',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
            },
            'info.powered': {
                name: 'Powered',
                type: 'boolean',
                role: 'indicator.power',
                read: true,
                write: false,
                def: false,
            },
            'info.currentAppId': {
                name: 'Current app package',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            'info.currentApp': {
                name: 'Current app',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            'info.currentAppUnknown': {
                name: 'Unknown current app package',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            'info.cast.connection': {
                name: 'Cast connected',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            'info.cast.appId': {
                name: 'Cast app ID',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            'info.cast.appName': {
                name: 'Cast app name',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            'info.media.title': {
                name: 'Media title',
                type: 'string',
                role: 'media.title',
                read: true,
                write: false,
                def: '',
            },
            'info.media.subtitle': {
                name: 'Media subtitle',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            'info.media.playerState': {
                name: 'Media player state',
                type: 'string',
                role: 'media.state',
                read: true,
                write: false,
                def: '',
            },
            'info.media.contentId': {
                name: 'Media content ID',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            'info.volume.level': {
                name: 'Volume level',
                type: 'number',
                role: 'level.volume',
                read: true,
                write: false,
                def: 0,
            },
            'info.volume.maximum': {
                name: 'Maximum volume',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            'info.volume.muted': {
                name: 'Muted',
                type: 'boolean',
                role: 'indicator.mute',
                read: true,
                write: false,
                def: false,
            },
            'control.pairingCode': {
                name: 'Pairing code',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                def: '',
            },
            'control.key': {
                name: 'Remote key',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                def: '',
            },
            'control.text': {
                name: 'Send text',
                type: 'string',
                role: 'text',
                read: true,
                write: true,
                def: '',
            },
            'control.appLink': {
                name: 'Open app/deep link',
                type: 'string',
                role: 'text.url',
                read: true,
                write: true,
                def: '',
            },
            'control.power': {
                name: 'Power target / toggle',
                type: 'boolean',
                role: 'switch.power',
                read: true,
                write: true,
                def: false,
            },
            'control.reconnect': {
                name: 'Reconnect',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
                def: false,
            },
            'control.forgetPairing': {
                name: 'Forget pairing',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
                def: false,
            },
        };

        for (const [id, common] of Object.entries(defs)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common,
                native: {},
            });
        }
    }

    async loadCertificate() {
        try {
            const raw = await fs.promises.readFile(this.credentialsFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.key === 'string' && typeof parsed.cert === 'string') {
                return parsed;
            }
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                this.log.warn(`Pairing-Zertifikat konnte nicht gelesen werden: ${this.errorText(error)}`);
            }
        }
        return null;
    }

    async saveCertificate(cert) {
        if (!cert || !cert.key || !cert.cert) {
            return;
        }
        const tmp = `${this.credentialsFile}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(cert, null, 2), {
            mode: 0o600,
        });
        await fs.promises.rename(tmp, this.credentialsFile);
        try {
            await fs.promises.chmod(this.credentialsFile, 0o600);
        } catch {
            // Ignore cleanup errors.
        }
    }

    async deleteCertificate() {
        try {
            await fs.promises.unlink(this.credentialsFile);
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    async connect() {
        if (this.stopping || this.connecting || !this.remoteModule) {
            return;
        }
        this.connecting = true;
        this.clearReconnect();

        try {
            if (this.remote) {
                try {
                    this.remote.stop();
                } catch {
                    // Ignore cleanup errors.
                }
                this.remote = null;
            }

            const cert = await this.loadCertificate();
            const options = {
                pairing_port: Number(this.config.pairingPort) || 6467,
                remote_port: Number(this.config.remotePort) || 6466,
                service_name: String(this.config.deviceName || 'ioBroker'),
                debug: !!this.config.debugProtocol,
            };
            if (cert) {
                options.cert = cert;
            }

            const { createAndroidRemote } = this.remoteModule;
            this.remote = createAndroidRemote(String(this.config.host).trim(), options);
            this.attachRemoteEvents(this.remote);

            this.log.info(`Verbinde mit Android TV ${this.config.host}:${options.remote_port} ...`);
            const started = await this.remote.start();
            if (!started) {
                await this.setStateAsync('info.connection', false, true);
                this.log.info(
                    `Android TV derzeit nicht erreichbar – neuer Versuch in ${Math.max(5, Number(this.config.reconnectSeconds) || 15)} Sekunden.`,
                );
                if (this.remote) {
                    try {
                        this.remote.stop();
                    } catch {
                        // Ignore cleanup errors.
                    }
                    this.remote = null;
                }
                this.scheduleReconnect();
            }
        } catch (error) {
            await this.setStateAsync('info.connection', false, true);
            this.log.warn(`Verbindung fehlgeschlagen: ${this.errorText(error)}`);
            this.scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    attachRemoteEvents(remote) {
        remote.on('secret', async () => {
            this.pairingRequested = true;
            await this.setStateAsync('info.pairingRequired', true, true);
            await this.setStateAsync('info.connection', false, true);
            this.log.info('Pairing erforderlich: Code vom Fernseher in control.pairingCode eintragen.');
        });

        remote.on('ready', async () => {
            this.pairingRequested = false;
            await this.setStateAsync('info.pairingRequired', false, true);
            await this.setStateAsync('info.connection', true, true);
            this.lastRemoteReady = Date.now();
            await this.setStateAsync('info.lastRemoteReady', this.lastRemoteReady, true);
            try {
                await this.saveCertificate(remote.getCertificate());
            } catch (error) {
                this.log.warn(`Pairing-Zertifikat konnte nicht gespeichert werden: ${this.errorText(error)}`);
            }
            this.log.info('Android TV Remote verbunden.');
        });

        remote.on('powered', async powered => {
            this.lastPowered = !!powered;
            await this.setStateAsync('info.powered', !!powered, true);
            await this.setStateAsync('control.power', !!powered, true);
        });

        remote.on('volume', async volume => {
            if (!volume) {
                return;
            }
            await this.setStateAsync('info.volume.level', Number(volume.level) || 0, true);
            await this.setStateAsync('info.volume.maximum', Number(volume.maximum) || 0, true);
            await this.setStateAsync('info.volume.muted', !!volume.muted, true);
        });

        remote.on('current_app', async app => {
            const appId =
                typeof app === 'string'
                    ? app.trim()
                    : String(app?.packageName || app?.package || app?.app || '').trim();

            if (!appId) {
                return;
            }

            const mapped = this.appNameMap()[appId];
            await this.setStateAsync('info.currentAppId', appId, true);
            await this.setStateAsync('info.currentApp', mapped || this.friendlyAppName(appId), true);
            await this.setStateAsync('info.currentAppUnknown', mapped ? '' : appId, true);
        });

        remote.on('unpaired', async () => {
            await this.setStateAsync('info.connection', false, true);
            await this.setStateAsync('info.pairingRequired', true, true);
            this.pairingRequested = true;

            // Gespeicherte Credentials hier NICHT löschen.
            // Ein temporärer Verbindungs-/Authentifizierungsfehler darf nicht
            // dazu führen, dass ein funktionierendes Pairing dauerhaft
            // verloren geht. Credentials werden ausschließlich über
            // control.forgetPairing bewusst gelöscht.
            this.log.warn(
                'Android TV meldet "unpaired". Gespeichertes Pairing bleibt erhalten. ' +
                    'Falls ein neues Pairing wirklich erforderlich ist, control.forgetPairing verwenden.',
            );
        });

        remote.on('error', async error => {
            if (this.stopping) {
                return;
            }
            await this.setStateAsync('info.connection', false, true);
            this.log.warn(`Android-TV-Protokollfehler: ${this.errorText(error)}`);
            this.scheduleReconnect();
        });
    }

    scheduleReconnect() {
        if (this.stopping || this.reconnectTimer || this.pairingRequested) {
            return;
        }
        const seconds = Math.max(5, Number(this.config.reconnectSeconds) || 15);
        this.reconnectTimer = this.setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, seconds * 1000);
    }

    clearReconnect() {
        if (this.reconnectTimer) {
            this.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const prefix = `${this.namespace}.`;
        if (!id.startsWith(prefix)) {
            return;
        }
        const rel = id.slice(prefix.length);

        try {
            switch (rel) {
                case 'control.pairingCode': {
                    const code = String(state.val || '').trim();
                    if (!code) {
                        return;
                    }
                    if (!this.remote || !this.pairingRequested) {
                        this.log.warn('Aktuell wartet der Adapter auf keinen Pairing-Code.');
                    } else {
                        const accepted = this.remote.sendCode(code);
                        if (!accepted) {
                            this.log.warn('Pairing-Code konnte nicht gesendet werden.');
                        }
                    }
                    await this.setStateAsync(rel, '', true);
                    break;
                }

                case 'control.key': {
                    const key = String(state.val || '').trim();
                    if (key) {
                        this.sendKey(key);
                    }
                    await this.setStateAsync(rel, '', true);
                    break;
                }

                case 'control.text': {
                    const text = String(state.val ?? '');
                    if (text && this.requireRemote()) {
                        this.remote.sendText(text);
                    }
                    await this.setStateAsync(rel, '', true);
                    break;
                }

                case 'control.appLink': {
                    const link = String(state.val || '').trim();
                    if (link && this.requireRemote()) {
                        this.remote.sendAppLink(link);
                    }
                    await this.setStateAsync(rel, '', true);
                    break;
                }

                case 'control.power': {
                    const desired = !!state.val;
                    if (this.requireRemote()) {
                        if (this.lastPowered === null || desired !== this.lastPowered) {
                            this.remote.sendPower();
                        }
                    }
                    await this.setStateAsync(rel, desired, true);
                    break;
                }

                case 'control.reconnect': {
                    await this.setStateAsync(rel, false, true);
                    await this.setStateAsync('info.connection', false, true);
                    this.pairingRequested = false;
                    await this.connect();
                    break;
                }

                case 'control.forgetPairing': {
                    await this.setStateAsync(rel, false, true);
                    await this.deleteCertificate();
                    this.pairingRequested = false;
                    if (this.remote) {
                        try {
                            this.remote.stop();
                        } catch {
                            // Ignore cleanup errors.
                        }
                        this.remote = null;
                    }
                    await this.setStateAsync('info.connection', false, true);
                    await this.setStateAsync('info.pairingRequired', false, true);
                    this.log.info('Gespeichertes Pairing wurde gelöscht. Neues Pairing wird gestartet.');
                    await this.connect();
                    break;
                }
            }
        } catch (error) {
            this.log.error(`Befehl ${rel} fehlgeschlagen: ${this.errorText(error)}`);
        }
    }

    appNameMap() {
        return {
            // Launcher / System
            'com.google.android.apps.tv.launcherx': 'Google TV Startbildschirm',
            'com.google.android.tvlauncher': 'Android TV Startbildschirm',
            'com.google.android.apps.tv.launcher': 'Android TV Startbildschirm',
            'com.android.tv.settings': 'Einstellungen',
            'com.android.vending': 'Google Play Store',
            'com.google.android.videos': 'Google TV',

            // Streaming / TV
            'com.netflix.ninja': 'Netflix',
            'com.google.android.youtube.tv': 'YouTube',
            'com.google.android.youtube': 'YouTube',
            'com.amazon.amazonvideo.livingroom': 'Prime Video',
            'de.swr.avp.ard.tv': 'ARD Mediathek',
            'de.swr.avp.ard': 'ARD Mediathek',
            'com.zdf.android.mediathek': 'ZDF',
            'de.zdf.android.mediathek': 'ZDF',
            'de.rtli.tvnow': 'RTL+',
            'de.telekom.magentatv.tv': 'MagentaTV',
            'de.telekom.magentatv.mobile': 'MagentaTV',
            'de.telekom.magentatv.atv': 'MagentaTV (1. Generation)',
            'de.prosiebensat1digital.seventv': 'Joyn',
            'com.zattoo.player': 'Zattoo',
            'de.exaring.waipu': 'waipu.tv',
            'com.dazn': 'DAZN',
            'de.sky.online': 'WOW',
            'com.disney.disneyplus': 'Disney+',
            'com.disneyplus': 'Disney+',
            'com.apple.atve.androidtv.appletv': 'Apple TV',
            'com.apple.atve.sony.appletv': 'Apple TV',

            // Musik
            'com.google.android.youtube.tvmusic': 'YouTube Music',
            'com.google.android.apps.youtube.music': 'YouTube Music',
            'com.spotify.tv.android': 'Spotify',
            'com.spotify.music': 'Spotify',

            // Kinder / Media
            'de.kika.player.androidtv': 'KiKA',
            'com.plexapp.android': 'Plex',
            'org.xbmc.kodi': 'Kodi',
            'org.videolan.vlc': 'VLC',
            'tv.twitch.android.app': 'Twitch',
        };
    }

    friendlyAppName(appId) {
        const id = String(appId || '').trim();
        if (!id) {
            return '';
        }
        const known = this.appNameMap();
        if (known[id]) {
            return known[id];
        }

        // Lesbarer Fallback, Paket-ID bleibt zusätzlich in currentAppUnknown erhalten.
        const parts = id.split('.').filter(Boolean);
        const raw = parts.length ? parts[parts.length - 1] : id;
        return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    startCastMonitor() {
        if (this.config.enableCast === false) {
            return;
        }
        const interval = Math.max(3, Number(this.config.castPollSeconds) || 5);
        const run = async () => {
            if (!this.stopping) {
                await this.pollCast();
            }
        };
        void run();
        this.castTimer = this.setInterval(run, interval * 1000);
    }

    stopCastMonitor() {
        if (this.castTimer) {
            this.clearInterval(this.castTimer);
            this.castTimer = null;
        }
        if (this.castClient) {
            try {
                this.castClient.close();
            } catch {
                // Ignore cleanup errors.
            }
            this.castClient = null;
            this.castPlayer = null;
        }
    }

    async pollCast() {
        if (this.castConnecting || !this.config.host) {
            return;
        }
        this.castConnecting = true;
        try {
            await this.ensureCastConnected();
            const sessions = await this.castGetSessions();
            if (!Array.isArray(sessions) || sessions.length === 0) {
                await this.clearMediaStates();
                return;
            }

            const session = sessions[0];
            await this.setStateAsync('info.cast.appId', String(session.appId || ''), true);
            await this.setStateAsync('info.cast.appName', String(session.displayName || ''), true);

            const status = await this.castJoinAndGetStatus(session);
            if (!status) {
                return;
            }
            const media = status.media || {};
            const metadata = media.metadata || {};
            const title = metadata.title || metadata.seriesTitle || metadata.albumName || '';
            const subtitle = metadata.subtitle || metadata.artist || metadata.studio || '';
            await this.setStateAsync('info.media.title', String(title || ''), true);
            await this.setStateAsync('info.media.subtitle', String(subtitle || ''), true);
            await this.setStateAsync('info.media.playerState', String(status.playerState || ''), true);
            await this.setStateAsync('info.media.contentId', String(media.contentId || ''), true);
        } catch (error) {
            await this.setStateAsync('info.cast.connection', false, true);
            this.castPlayer = null;
            if (this.config.debugProtocol) {
                this.log.debug(`Cast-Abfrage: ${this.errorText(error)}`);
            }
            if (this.castClient) {
                try {
                    this.castClient.close();
                } catch {
                    // Ignore cleanup errors.
                }
                this.castClient = null;
            }
        } finally {
            this.castConnecting = false;
        }
    }

    ensureCastConnected() {
        if (this.castClient) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const client = new CastClient();
            let settled = false;
            const fail = err => {
                if (settled) {
                    return;
                }
                settled = true;
                try {
                    client.close();
                } catch {
                    // Ignore cleanup errors.
                }
                reject(err instanceof Error ? err : new Error(String(err)));
            };
            client.once('error', fail);
            client.connect(String(this.config.host).trim(), () => {
                if (settled) {
                    return;
                }
                settled = true;
                client.removeListener('error', fail);
                client.on('error', () => {
                    void this.setStateAsync('info.cast.connection', false, true);
                    if (this.castClient === client) {
                        this.castClient = null;
                    }
                });
                this.castClient = client;
                void this.setStateAsync('info.cast.connection', true, true);
                resolve();
            });
        });
    }

    castGetSessions() {
        return new Promise((resolve, reject) => {
            this.castClient.getSessions((err, sessions) => (err ? reject(err) : resolve(sessions || [])));
        });
    }

    castJoinAndGetStatus(session) {
        return new Promise((resolve, reject) => {
            this.castClient.join(session, DefaultMediaReceiver, (err, player) => {
                if (err) {
                    return reject(err);
                }
                this.castPlayer = player;
                player.getStatus((statusErr, status) => {
                    if (statusErr) {
                        return reject(statusErr);
                    }
                    resolve(status || null);
                });
            });
        });
    }

    async clearMediaStates() {
        await this.setStateAsync('info.cast.appId', '', true);
        await this.setStateAsync('info.cast.appName', '', true);
        await this.setStateAsync('info.media.title', '', true);
        await this.setStateAsync('info.media.subtitle', '', true);
        await this.setStateAsync('info.media.playerState', '', true);
        await this.setStateAsync('info.media.contentId', '', true);
    }

    sendKey(input) {
        if (!this.requireRemote()) {
            return;
        }
        const { RemoteKeyCode } = this.remoteModule;
        const normalized = input.trim().toUpperCase().replace(/[ -]+/g, '_');
        const aliases = {
            UP: 'KEYCODE_DPAD_UP',
            DOWN: 'KEYCODE_DPAD_DOWN',
            LEFT: 'KEYCODE_DPAD_LEFT',
            RIGHT: 'KEYCODE_DPAD_RIGHT',
            OK: 'KEYCODE_DPAD_CENTER',
            ENTER: 'KEYCODE_DPAD_CENTER',
            CENTER: 'KEYCODE_DPAD_CENTER',
            SELECT: 'KEYCODE_DPAD_CENTER',
            HOME: 'KEYCODE_HOME',
            BACK: 'KEYCODE_BACK',
            MENU: 'KEYCODE_MENU',
            POWER: 'KEYCODE_POWER',
            PLAY_PAUSE: 'KEYCODE_MEDIA_PLAY_PAUSE',
            PLAY: 'KEYCODE_MEDIA_PLAY',
            PAUSE: 'KEYCODE_MEDIA_PAUSE',
            STOP: 'KEYCODE_MEDIA_STOP',
            NEXT: 'KEYCODE_MEDIA_NEXT',
            PREVIOUS: 'KEYCODE_MEDIA_PREVIOUS',
            REWIND: 'KEYCODE_MEDIA_REWIND',
            FAST_FORWARD: 'KEYCODE_MEDIA_FAST_FORWARD',
            VOLUME_UP: 'KEYCODE_VOLUME_UP',
            VOLUP: 'KEYCODE_VOLUME_UP',
            VOLUME_DOWN: 'KEYCODE_VOLUME_DOWN',
            VOLDOWN: 'KEYCODE_VOLUME_DOWN',
            MUTE: 'KEYCODE_VOLUME_MUTE',
        };
        const enumName = normalized.startsWith('KEYCODE_')
            ? normalized
            : aliases[normalized] || `KEYCODE_${normalized}`;
        const code = RemoteKeyCode[enumName];
        if (code === undefined) {
            this.log.warn(`Unbekannte Remote-Taste: ${input} (${enumName})`);
            return;
        }
        this.remote.sendKey(code);
    }

    requireRemote() {
        if (!this.remote) {
            this.log.warn('Android TV ist nicht verbunden.');
            return false;
        }
        return true;
    }

    errorText(error) {
        return error instanceof Error ? error.message : String(error);
    }

    async onUnload(callback) {
        try {
            this.stopping = true;
            this.clearReconnect();
            this.stopCastMonitor();
            await this.setStateAsync('info.connection', false, true);
            if (this.remote) {
                try {
                    this.remote.stop();
                } catch {
                    // Ignore cleanup errors.
                }
                this.remote = null;
            }
        } catch {
            // ignore during shutdown
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new AndroidTvRemoteAdapter(options);
} else {
    new AndroidTvRemoteAdapter();
}
