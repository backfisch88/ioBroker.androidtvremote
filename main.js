'use strict';

const utils = require('@iobroker/adapter-core');
const fs = require('node:fs');
const path = require('node:path');
const { Client: CastClient, DefaultMediaReceiver } = require('castv2-client');

// A Cast query that takes longer than this is considered stalled (normal polls take well under a second).
const CAST_STALL_MS = 60000;

/**
 * Convert a configuration value to an integer within the given bounds.
 *
 * @param {unknown} value configured value
 * @param {number} fallback used when the value is missing or not a finite number
 * @param {number} min lower bound
 * @param {number} max upper bound
 */
function clampInt(value, fallback, min, max) {
    const num = Number(value);
    const result = Number.isFinite(num) && num !== 0 ? Math.round(num) : fallback;
    return Math.min(max, Math.max(min, result));
}

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
        this.castTimer = null;
        this.castPlayer = null;
        this.castPlayerSessionId = '';
        this.castConnecting = false;
        this.castPollStarted = 0;
        this.castPollToken = 0;
        this.discoveryRunning = false;
        this.discoveryBonjour = null;
        this.discoveryPromise = null;
        this.discoveryDevices = [];

        this.on('message', this.onMessage.bind(this));
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        this.stopping = false;
        await this.ensureObjects();
        await this.setStateAsync('info.connection', false, true);
        await this.clearPlaybackAndAppStates();
        this.subscribeStates('control.*');
        // Search once at startup without blocking the connection.
        void this.discoverDevices().catch(error => this.log.warn(`Startup discovery failed: ${this.errorText(error)}`));

        if (!this.config.host || !String(this.config.host).trim()) {
            this.log.info('No Android TV device configured yet. Discovery is available.');
            return;
        }

        this.dataDir = utils.getAbsoluteInstanceDataDir(this);
        this.credentialsFile = path.join(this.dataDir, 'credentials.json');
        await fs.promises.mkdir(this.dataDir, { recursive: true });

        try {
            this.remoteModule = await import('@kud/androidtv-remote');
        } catch (error) {
            this.log.error(`Could not load the Android TV Remote library: ${this.errorText(error)}`);
            return;
        }

        await this.connect();
        this.startCastMonitor();
    }

    async ensureObjects() {
        const defs = {
            'control.discover': {
                name: 'Discover Android TV devices',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
            'info.discovery.running': {
                name: 'Discovery running',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
            },
            'info.discovery.devices': {
                name: 'Discovered Android TV devices',
                type: 'string',
                role: 'json',
                read: true,
                write: false,
                def: '[]',
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
                role: 'media.mute',
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
                read: false,
                write: true,
                def: false,
            },
            'control.forgetPairing': {
                name: 'Forget pairing',
                type: 'boolean',
                role: 'button',
                read: false,
                write: true,
                def: false,
            },
        };

        const channels = {
            info: 'Information',
            'info.cast': 'Google Cast',
            'info.media': 'Media',
            'info.volume': 'Volume',
            'info.discovery': 'Device discovery',
            control: 'Control',
        };
        for (const [id, name] of Object.entries(channels)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'channel',
                common: { name },
                native: {},
            });
        }

        for (const [id, common] of Object.entries(defs)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common,
                native: {},
            });
        }

        // Migration: buttons must not be readable (objects created by <= 0.3.0 had read: true).
        for (const [id, common] of Object.entries(defs)) {
            if (common.role === 'button') {
                await this.extendObjectAsync(id, { common: { read: false } });
            }
        }
        // Migration: role of the mute state changed from indicator.mute to media.mute in 0.3.1.
        await this.extendObjectAsync('info.volume.muted', { common: { role: 'media.mute' } });
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
                this.log.warn(`Could not read pairing certificate: ${this.errorText(error)}`);
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
                pairing_port: clampInt(this.config.pairingPort, 6467, 1, 65535),
                remote_port: clampInt(this.config.remotePort, 6466, 1, 65535),
                service_name: String(this.config.deviceName || 'ioBroker'),
                debug: !!this.config.debugProtocol,
            };
            if (cert) {
                options.cert = cert;
            }

            const { createAndroidRemote } = this.remoteModule;
            this.remote = createAndroidRemote(String(this.config.host).trim(), options);
            this.attachRemoteEvents(this.remote);

            this.log.info(`Connecting to Android TV ${this.config.host}:${options.remote_port} ...`);
            const started = await this.remote.start();
            if (!started) {
                await this.setStateAsync('info.connection', false, true);
                this.log.info(`Android TV currently unreachable - retrying in ${this.reconnectSeconds()} seconds.`);
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
            await this.clearPlaybackAndAppStates();
            this.log.warn(`Connection failed: ${this.errorText(error)}`);
            this.scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    attachRemoteEvents(remote) {
        // Wrap handlers so that a failing state write never becomes an unhandled promise rejection.
        const on = (event, handler) =>
            remote.on(event, async (...args) => {
                try {
                    await handler(...args);
                } catch (error) {
                    if (!this.stopping) {
                        this.log.warn(`Remote event "${event}" failed: ${this.errorText(error)}`);
                    }
                }
            });
        on('secret', async () => {
            this.pairingRequested = true;
            await this.setStateAsync('info.pairingRequired', true, true);
            await this.setStateAsync('info.connection', false, true);
            this.log.info('Pairing required: enter the code shown on the TV into control.pairingCode.');
        });

        on('ready', async () => {
            this.lastPowered = null;
            this.pairingRequested = false;
            await this.setStateAsync('info.pairingRequired', false, true);
            await this.setStateAsync('info.connection', true, true);
            this.lastRemoteReady = Date.now();
            await this.setStateAsync('info.lastRemoteReady', this.lastRemoteReady, true);
            try {
                await this.saveCertificate(remote.getCertificate());
            } catch (error) {
                this.log.warn(`Could not save pairing certificate: ${this.errorText(error)}`);
            }
            this.log.info('Android TV Remote connected.');
        });

        on('powered', async powered => {
            this.lastPowered = !!powered;
            await this.setStateAsync('info.powered', !!powered, true);
            await this.setStateAsync('control.power', !!powered, true);
            if (!powered) {
                await this.clearPlaybackAndAppStates();
            }
        });

        on('volume', async volume => {
            if (!volume) {
                return;
            }
            await this.setStateAsync('info.volume.level', Number(volume.level) || 0, true);
            await this.setStateAsync('info.volume.maximum', Number(volume.maximum) || 0, true);
            await this.setStateAsync('info.volume.muted', !!volume.muted, true);
        });

        on('current_app', async app => {
            if (this.lastPowered === false || this.stopping) {
                return;
            }
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

        on('unpaired', async () => {
            await this.setStateAsync('info.connection', false, true);
            await this.clearPlaybackAndAppStates();
            await this.setStateAsync('info.pairingRequired', true, true);
            this.pairingRequested = true;

            // Do NOT delete the stored credentials here.
            // A temporary connection/authentication error must not cause a
            // working pairing to be lost permanently. Credentials are only
            // deleted deliberately via control.forgetPairing.
            this.log.warn(
                'Android TV reported "unpaired". The stored pairing is kept. ' +
                    'If a new pairing is really required, use control.forgetPairing.',
            );
        });

        on('error', async error => {
            if (this.stopping) {
                return;
            }
            await this.setStateAsync('info.connection', false, true);
            await this.clearPlaybackAndAppStates();
            this.log.warn(`Android TV protocol error: ${this.errorText(error)}`);
            this.scheduleReconnect();
        });
    }

    reconnectSeconds() {
        return clampInt(this.config.reconnectSeconds, 15, 5, 3600);
    }

    scheduleReconnect() {
        if (this.stopping || this.reconnectTimer || this.pairingRequested) {
            return;
        }
        const seconds = this.reconnectSeconds();
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
                case 'control.discover': {
                    await this.setStateAsync(rel, false, true);
                    if (state.val === true) {
                        void this.discoverDevices().catch(error => {
                            this.log.warn(`Discovery failed: ${this.errorText(error)}`);
                        });
                    }
                    break;
                }

                case 'control.pairingCode': {
                    const code = String(state.val || '').trim();
                    if (!code) {
                        return;
                    }
                    if (!this.remote || !this.pairingRequested) {
                        this.log.warn('The adapter is currently not waiting for a pairing code.');
                    } else {
                        const accepted = this.remote.sendCode(code);
                        if (!accepted) {
                            this.log.warn('Could not send the pairing code.');
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
                        await this.setStateAsync(rel, desired, true);
                    } else {
                        // Nothing was sent: show the last known power state instead of the requested one.
                        await this.setStateAsync(rel, !!this.lastPowered, true);
                    }
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
                    this.log.info('Stored pairing deleted. Starting a new pairing.');
                    await this.connect();
                    break;
                }
            }
        } catch (error) {
            this.log.error(`Command ${rel} failed: ${this.errorText(error)}`);
        }
    }

    async discoverDevices() {
        if (this.discoveryPromise) {
            return this.discoveryPromise;
        }
        if (this.stopping) {
            return [];
        }
        this.discoveryRunning = true;
        this.discoveryPromise = (async () => {
            let bonjour;
            const devices = new Map();
            try {
                await this.setStateAsync('info.discovery.running', true, true);
                this.log.info('Discovery started ...');
                const { Bonjour } = require('bonjour-service');
                bonjour = new Bonjour();
                this.discoveryBonjour = bonjour;
                const browser = bonjour.find({ type: 'androidtvremote2', protocol: 'tcp' });
                browser.on('up', service => {
                    for (const ip of service.addresses || []) {
                        if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                            continue;
                        }
                        devices.set(ip, {
                            name: service.name || ip,
                            ip,
                            host: service.host || '',
                            port: service.port || 6466,
                        });
                    }
                });
                browser.on('error', error => this.log.warn(`Discovery: ${this.errorText(error)}`));
                await new Promise(resolve => this.setTimeout(resolve, 8000));
                if (this.stopping) {
                    return this.discoveryDevices;
                }
                this.discoveryDevices = [...devices.values()].sort((a, b) => a.name.localeCompare(b.name));
                await this.setStateAsync('info.discovery.devices', JSON.stringify(this.discoveryDevices), true);
                this.log.info(`Discovery finished: ${this.discoveryDevices.length} device(s).`);
                return this.discoveryDevices;
            } finally {
                if (bonjour) {
                    bonjour.destroy();
                }
                if (this.discoveryBonjour === bonjour) {
                    this.discoveryBonjour = null;
                }
                this.discoveryRunning = false;
                if (!this.stopping) {
                    await this.setStateAsync('info.discovery.running', false, true);
                }
            }
        })();
        try {
            return await this.discoveryPromise;
        } finally {
            this.discoveryPromise = null;
        }
    }

    getDiscoveryStatus() {
        return {
            running: this.discoveryRunning,
            devices: this.discoveryDevices.map(device => ({
                value: device.ip,
                label: `${device.name} (${device.ip})`,
            })),
        };
    }

    async onMessage(obj) {
        if (!obj || !obj.callback) {
            return;
        }
        try {
            if (obj.command === 'getDiscoveryStatus') {
                this.sendTo(obj.from, obj.command, this.getDiscoveryStatus(), obj.callback);
            } else if (obj.command === 'startDiscovery') {
                void this.discoverDevices().catch(error => this.log.warn(`Discovery: ${this.errorText(error)}`));
                this.sendTo(obj.from, obj.command, this.getDiscoveryStatus(), obj.callback);
            }
        } catch (error) {
            this.log.warn(`Admin discovery: ${this.errorText(error)}`);
            this.sendTo(obj.from, obj.command, { error: this.errorText(error) }, obj.callback);
        }
    }

    appNameMap() {
        return {
            // Launcher / System
            'com.google.android.apps.tv.launcherx': 'Google TV Home',
            'com.google.android.tvlauncher': 'Android TV Home',
            'com.google.android.apps.tv.launcher': 'Android TV Home',
            'com.android.tv.settings': 'Settings',
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
            'de.telekom.magentatv.atv': 'MagentaTV (1st generation)',
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

        // Readable fallback; the package ID is still kept in currentAppUnknown.
        const parts = id.split('.').filter(Boolean);
        const raw = parts.length ? parts[parts.length - 1] : id;
        return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    startCastMonitor() {
        if (this.config.enableCast === false) {
            return;
        }
        const interval = clampInt(this.config.castPollSeconds, 5, 3, 60);
        const run = async () => {
            if (this.stopping) {
                return;
            }
            // Watchdog: a request that never answers would otherwise block polling until restart.
            if (this.castConnecting && Date.now() - this.castPollStarted > CAST_STALL_MS) {
                this.log.warn('Cast query stalled, resetting the Cast connection.');
                this.resetCastConnection();
                this.castConnecting = false;
                await this.setStateAsync('info.cast.connection', false, true);
            }
            await this.pollCast();
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
        }
        this.dropCastPlayer();
    }

    /**
     * Forget the cached Cast player.
     * Do NOT call player.close() / media.close(): castv2-client sends a STOP request to the media session on close.
     * Dropping the reference is safe, because the player is only ever used together with its Cast client.
     */
    dropCastPlayer() {
        this.castPlayer = null;
        this.castPlayerSessionId = '';
    }

    resetCastConnection() {
        const client = this.castClient;
        this.castClient = null;
        this.dropCastPlayer();

        if (client) {
            try {
                client.close();
            } catch {
                // Ignore cleanup errors.
            }
        }
    }

    async pollCast() {
        if (this.lastPowered === false || this.stopping || this.castConnecting || !this.config.host) {
            return;
        }
        this.castConnecting = true;
        this.castPollStarted = Date.now();
        const token = ++this.castPollToken;
        const stale = () => token !== this.castPollToken || this.lastPowered === false || this.stopping;
        try {
            await this.ensureCastConnected();
            const sessions = await this.castGetSessions();
            if (stale()) {
                return;
            }
            if (!Array.isArray(sessions) || sessions.length === 0) {
                this.dropCastPlayer();
                await this.clearMediaStates();
                return;
            }

            const session = sessions[0];
            await this.setStateAsync('info.cast.appId', String(session.appId || ''), true);
            await this.setStateAsync('info.cast.appName', String(session.displayName || ''), true);

            const status = await this.castJoinAndGetStatus(session);
            if (stale()) {
                return;
            }
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
            if (token !== this.castPollToken) {
                return;
            }
            await this.setStateAsync('info.cast.connection', false, true);
            this.dropCastPlayer();
            if (this.config.debugProtocol) {
                this.log.debug(`Cast query: ${this.errorText(error)}`);
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
            if (token === this.castPollToken) {
                this.castConnecting = false;
            }
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
                if (this.stopping || this.castClient) {
                    // Late connection of an abandoned poll: discard it.
                    try {
                        client.close();
                    } catch {
                        // Ignore cleanup errors.
                    }
                    resolve();
                    return;
                }
                client.on('error', () => {
                    void this.setStateAsync('info.cast.connection', false, true);
                    if (this.castClient === client) {
                        this.castClient = null;
                        this.dropCastPlayer();
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
            const ask = player =>
                player.getStatus((statusErr, status) => (statusErr ? reject(statusErr) : resolve(status || null)));

            // Join each Cast session only once: every join registers new listeners on the Cast connection.
            if (this.castPlayer && session.sessionId && this.castPlayerSessionId === session.sessionId) {
                ask(this.castPlayer);
                return;
            }
            this.castClient.join(session, DefaultMediaReceiver, (err, player) => {
                if (err) {
                    return reject(err);
                }
                this.castPlayer = player;
                this.castPlayerSessionId = session.sessionId || '';
                ask(player);
            });
        });
    }

    async clearPlaybackAndAppStates() {
        this.resetCastConnection();
        await this.setStateAsync('info.cast.connection', false, true);
        await this.clearMediaStates();
        await this.setStateAsync('info.currentApp', '', true);
        await this.setStateAsync('info.currentAppId', '', true);
        await this.setStateAsync('info.currentAppUnknown', '', true);
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
            this.log.warn(`Unknown remote key: ${input} (${enumName})`);
            return;
        }
        this.remote.sendKey(code);
    }

    requireRemote() {
        if (!this.remote) {
            this.log.warn('Android TV is not connected.');
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
            if (this.discoveryBonjour) {
                this.discoveryBonjour.destroy();
                this.discoveryBonjour = null;
            }
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
