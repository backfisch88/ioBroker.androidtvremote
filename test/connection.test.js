'use strict';

/* global describe, it */

const assert = require('node:assert');
const EventEmitter = require('node:events');
const Module = require('node:module');
const path = require('node:path');

/** Minimal stand-in for the ioBroker adapter base class. */
class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.config = {};
        this.namespace = 'androidtvremote.0';
        this.states = {};
        this.logs = { info: [], warn: [], error: [], debug: [] };
        this.log = Object.fromEntries(Object.keys(this.logs).map(level => [level, msg => this.logs[level].push(msg)]));
    }
    async setStateAsync(id, val) {
        this.states[id] = val;
    }
    async extendObjectAsync() {}
    setTimeout(fn, ms) {
        return setTimeout(fn, ms);
    }
    clearTimeout(timer) {
        clearTimeout(timer);
    }
}

class FakeRemote extends EventEmitter {
    constructor(startResult) {
        super();
        this.startResult = startResult;
        this.stopped = false;
    }
    async start() {
        return this.startResult;
    }
    stop() {
        this.stopped = true;
    }
    getCertificate() {
        return { key: 'k', cert: 'c' };
    }
}

function loadAdapter(startResults) {
    const mainPath = path.join(__dirname, '..', 'main.js');
    const original = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => '/tmp' };
        }
        return original.call(this, request, ...rest);
    };
    let adapter;
    try {
        delete require.cache[require.resolve(mainPath)];
        adapter = require(mainPath)({});
    } finally {
        Module._load = original;
    }
    adapter.config = { host: '192.0.2.1' };
    adapter.remotes = [];
    adapter.remoteModule = {
        createAndroidRemote: () => {
            const remote = new FakeRemote(startResults.length ? startResults.shift() : true);
            adapter.remotes.push(remote);
            return remote;
        },
    };
    adapter.saveCertificate = async () => {};
    return adapter;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('connection state', () => {
    it('stays green when the TV is unreachable after a pairing exists', async () => {
        const adapter = loadAdapter([false, false]);
        await adapter.setConnected(true);
        await adapter.connect();
        await adapter.connect();
        assert.strictEqual(adapter.states['info.connection'], true);
        assert.ok(adapter.reconnectTimer, 'a reconnect must still be scheduled');
        assert.strictEqual(adapter.logs.info.filter(line => line.includes('unreachable')).length, 1);
        adapter.clearReconnect();
    });

    it('stays yellow when there never was a connection', async () => {
        const adapter = loadAdapter([false]);
        await adapter.setConnected(false);
        await adapter.connect();
        assert.strictEqual(adapter.states['info.connection'], false);
        adapter.clearReconnect();
    });

    it('turns green on ready and cancels a pending reconnect', async () => {
        const adapter = loadAdapter([true]);
        await adapter.setConnected(false);
        adapter.scheduleReconnect();
        await adapter.connect();
        adapter.remotes[0].emit('ready');
        await tick();
        assert.strictEqual(adapter.states['info.connection'], true);
        assert.strictEqual(adapter.reconnectTimer, null);
    });

    it('ignores events of a replaced remote', async () => {
        const adapter = loadAdapter([true, true]);
        await adapter.connect();
        adapter.remotes[0].emit('ready');
        await tick();
        await adapter.connect();
        assert.strictEqual(adapter.remotes[0].stopped, true);
        adapter.remotes[0].emit('error', new Error('old'));
        adapter.remotes[0].emit('powered', true);
        await tick();
        assert.strictEqual(adapter.states['info.connection'], true);
        assert.strictEqual(adapter.states['info.powered'], undefined);
        assert.strictEqual(adapter.logs.warn.length, 0);
    });

    it('reconnects after "unpaired" and only gives up after repeated reports', async () => {
        const adapter = loadAdapter([true]);
        await adapter.connect();
        adapter.remotes[0].emit('ready');
        await tick();
        for (let i = 1; i < 5; i++) {
            adapter.remotes[0].emit('unpaired');
            await tick();
            assert.strictEqual(adapter.states['info.connection'], true, `report ${i}`);
            assert.ok(adapter.reconnectTimer, `reconnect scheduled after report ${i}`);
            adapter.clearReconnect();
        }
        adapter.remotes[0].emit('unpaired');
        await tick();
        assert.strictEqual(adapter.states['info.connection'], false);
        assert.strictEqual(adapter.states['info.pairingRequired'], true);
        assert.strictEqual(adapter.pairingRequested, true);
        assert.ok(adapter.logs.warn.some(line => line.includes('unpaired')));
    });

    it('a successful ready resets the "unpaired" counter', async () => {
        const adapter = loadAdapter([true]);
        await adapter.connect();
        adapter.remotes[0].emit('unpaired');
        adapter.remotes[0].emit('unpaired');
        await tick();
        assert.strictEqual(adapter.unpairedCount, 2);
        adapter.remotes[0].emit('ready');
        await tick();
        assert.strictEqual(adapter.unpairedCount, 0);
    });
});

describe('link check', () => {
    it('detects a switched-off TV and reconnects once it is reachable again', async () => {
        const adapter = loadAdapter([true]);
        await adapter.connect();
        adapter.remotes[0].emit('ready');
        await tick();
        adapter.lastPowered = true;

        let reachable = false;
        adapter.probePort = async () => reachable;
        let connects = 0;
        adapter.connect = async () => {
            connects++;
        };

        await adapter.checkLink();
        assert.strictEqual(adapter.needsFreshConnect, false, 'one failed probe is not enough');
        await adapter.checkLink();
        assert.strictEqual(adapter.needsFreshConnect, true);
        assert.strictEqual(adapter.lastPowered, false);
        assert.strictEqual(adapter.states['info.powered'], false);
        assert.strictEqual(adapter.states['info.connection'], true, 'must stay green');
        assert.strictEqual(connects, 0);

        reachable = true;
        await adapter.checkLink();
        assert.strictEqual(connects, 1);
    });

    it('does not reconnect while the connection is fine', async () => {
        const adapter = loadAdapter([true]);
        await adapter.connect();
        adapter.probePort = async () => true;
        let connects = 0;
        adapter.connect = async () => {
            connects++;
        };
        await adapter.checkLink();
        assert.strictEqual(connects, 0);
    });

    it('probePort reports false for a closed port', async () => {
        const adapter = loadAdapter([]);
        assert.strictEqual(await adapter.probePort('127.0.0.1', 1, 1000), false);
    });
});
