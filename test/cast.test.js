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
        this.intervals = [];
        this.logs = { info: [], warn: [], error: [], debug: [] };
        this.log = Object.fromEntries(Object.keys(this.logs).map(level => [level, msg => this.logs[level].push(msg)]));
    }
    async setStateAsync(id, val) {
        this.states[id] = val;
    }
    async extendObjectAsync() {}
    setInterval(fn) {
        this.intervals.push(fn);
        return fn;
    }
    clearInterval() {}
    setTimeout(fn, ms) {
        return setTimeout(fn, ms);
    }
    clearTimeout(timer) {
        clearTimeout(timer);
    }
}

const castClients = [];
class FakeCastClient extends EventEmitter {
    constructor() {
        super();
        this.index = castClients.length;
        this.closed = false;
        castClients.push(this);
    }
    connect(host, cb) {
        setImmediate(cb);
    }
    getSessions(cb) {
        if (this.index === 0) {
            this.pendingCallback = cb; // the first client never answers (stalled TV)
            return;
        }
        cb(null, []);
    }
    close() {
        this.closed = true;
    }
}

function loadAdapter(config) {
    const mainPath = path.join(__dirname, '..', 'main.js');
    const original = Module._load;
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => '/tmp' };
        }
        if (request === 'castv2-client') {
            return {
                Client: FakeCastClient,
                DefaultMediaReceiver: original.call(this, request, ...rest).DefaultMediaReceiver,
            };
        }
        return original.call(this, request, ...rest);
    };
    try {
        delete require.cache[require.resolve(mainPath)];
        const adapter = require(mainPath)({});
        adapter.config = config;
        return adapter;
    } finally {
        Module._load = original;
    }
}

describe('configuration bounds', () => {
    const seconds = value => loadAdapter({ reconnectSeconds: value }).reconnectSeconds();

    it('falls back to the default for missing or invalid values', () => {
        for (const value of [undefined, 0, '', 'abc', NaN]) {
            assert.strictEqual(seconds(value), 15);
        }
    });

    it('clamps values to the allowed range', () => {
        assert.strictEqual(seconds(1), 5);
        assert.strictEqual(seconds(30), 30);
        assert.strictEqual(seconds(99999999999), 3600);
    });
});

describe('control.power without connection', () => {
    it('does not acknowledge the requested value when nothing was sent', async () => {
        const adapter = loadAdapter({});
        adapter.lastPowered = false;
        await adapter.onStateChange('androidtvremote.0.control.power', { val: true, ack: false });
        assert.strictEqual(adapter.states['control.power'], false);
        assert.ok(adapter.logs.warn.some(line => line.includes('not connected')));
    });
});

describe('Cast stall watchdog', () => {
    it('recovers from a Cast request that never answers', async () => {
        castClients.length = 0;
        const adapter = loadAdapter({ host: '192.0.2.1', enableCast: true, castPollSeconds: 5 });
        adapter.startCastMonitor();
        const run = adapter.intervals[0];
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(adapter.castConnecting, true, 'first poll should be hanging');

        // A poll that is not yet stalled must not be interrupted.
        await run();
        assert.strictEqual(castClients.length, 1);

        // Simulate a stall longer than the watchdog limit.
        adapter.castPollStarted = Date.now() - 61000;
        await run();
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.strictEqual(castClients.length, 2, 'a new Cast connection should have been created');
        assert.strictEqual(castClients[0].closed, true, 'the stalled client should have been closed');
        assert.strictEqual(adapter.castConnecting, false, 'polling should be unlocked again');
        assert.ok(adapter.logs.warn.some(line => line.includes('stalled')));

        // A very late answer of the abandoned request must not break the new state.
        castClients[0].pendingCallback(null, []);
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.strictEqual(adapter.castConnecting, false);
        adapter.stopCastMonitor();
    });
});

describe('Cast player reuse', () => {
    /** Fake Cast connection that answers GET_STATUS like a TV would. */
    class FakeBus extends EventEmitter {
        constructor() {
            super();
            this.sent = [];
        }
        createChannel(sourceId, destinationId, namespace, encoding) {
            const Channel = require('castv2/lib/channel');
            return new Channel(this, sourceId, destinationId, namespace, encoding);
        }
        send(sourceId, destinationId, namespace, data) {
            const message = JSON.parse(data);
            this.sent.push(message.type);
            if (message.type === 'GET_STATUS') {
                setImmediate(() =>
                    this.emit(
                        'message',
                        destinationId,
                        sourceId,
                        namespace,
                        JSON.stringify({
                            type: 'MEDIA_STATUS',
                            requestId: message.requestId,
                            status: [
                                { playerState: 'PLAYING', media: { contentId: 'id1', metadata: { title: 'Song' } } },
                            ],
                        }),
                    ),
                );
            }
        }
    }

    it('joins a session only once, keeps listeners constant and never sends STOP', async () => {
        const adapter = loadAdapter({ host: '192.0.2.1' });
        const bus = new FakeBus();
        let joins = 0;
        const session = { sessionId: 'abc', transportId: 'transport-1', appId: 'CC1AD845', displayName: 'Default' };
        adapter.castClient = Object.assign(bus, {
            getSessions: cb => cb(null, [session]),
            join: (sess, App, cb) => {
                joins++;
                cb(null, new App(bus, sess));
            },
        });

        await adapter.pollCast();
        const listenersAfterFirstPoll = bus.listenerCount('message');
        for (let i = 0; i < 5; i++) {
            await adapter.pollCast();
        }

        assert.strictEqual(joins, 1, 'player should be reused for the same session');
        assert.strictEqual(bus.listenerCount('message'), listenersAfterFirstPoll, 'listeners must not grow');
        assert.ok(!bus.sent.includes('STOP'), 'playback must never be stopped');
        assert.strictEqual(adapter.states['info.media.title'], 'Song');
        assert.strictEqual(adapter.states['info.media.playerState'], 'PLAYING');

        // A different session needs a new join.
        session.sessionId = 'def';
        await adapter.pollCast();
        assert.strictEqual(joins, 2);
        assert.ok(!bus.sent.includes('STOP'));
    });
});
