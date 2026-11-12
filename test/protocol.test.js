'use strict';

/* global describe, it */

const assert = require('node:assert');
const path = require('node:path');
const protobuf = require('protobufjs');

// Guards the dependency overrides (protobufjs / node-forge): the Cast and Remote v2 protocols must still encode and decode.

/**
 * Find the first message type in a protobuf namespace.
 *
 * @param {object} namespace protobuf root or namespace
 */
function firstType(namespace) {
    for (const nested of namespace.nestedArray || []) {
        if (nested instanceof protobuf.Type) {
            return nested;
        }
        const found = firstType(nested);
        if (found) {
            return found;
        }
    }
    return null;
}

describe('protocol libraries', () => {
    it('castv2 encodes and decodes a CastMessage', async () => {
        const proto = require('castv2/lib/proto');
        // castv2 loads its proto file asynchronously
        for (let i = 0; i < 50; i++) {
            try {
                const data = {
                    protocolVersion: 0,
                    sourceId: 'sender-0',
                    destinationId: 'receiver-0',
                    namespace: 'urn:x-cast:com.google.cast.tp.connection',
                    payloadType: 0,
                    payloadUtf8: '{"type":"CONNECT"}',
                };
                const decoded = proto.CastMessage.parse(proto.CastMessage.serialize(data));
                assert.strictEqual(decoded.sourceId, 'sender-0');
                assert.strictEqual(decoded.payloadUtf8, '{"type":"CONNECT"}');
                return;
            } catch (error) {
                if (!String(error.message).includes('not loaded yet')) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        assert.fail('castv2 proto was not loaded');
    });

    it('Android TV Remote v2 proto files load and round-trip a message', () => {
        const dir = path.join(__dirname, '..', 'node_modules', '@kud', 'androidtv-remote', 'dist');
        for (const file of ['pairingmessage.proto', 'remotemessage.proto']) {
            const root = protobuf.loadSync(path.join(dir, file));
            const type = firstType(root);
            assert.ok(type, `${file}: no message type found`);
            const message = type.create({});
            const decoded = type.decode(type.encode(message).finish());
            assert.ok(decoded, `${file}: round trip failed`);
        }
    });

    it('node-forge can create a pairing certificate', () => {
        const forge = require('node-forge');
        const keys = forge.pki.rsa.generateKeyPair(1024);
        const cert = forge.pki.createCertificate();
        cert.publicKey = keys.publicKey;
        cert.serialNumber = '01';
        cert.validity.notBefore = new Date();
        cert.validity.notAfter = new Date(Date.now() + 86400000);
        cert.setSubject([{ name: 'commonName', value: 'ioBroker' }]);
        cert.setIssuer([{ name: 'commonName', value: 'ioBroker' }]);
        cert.sign(keys.privateKey, forge.md.sha256.create());
        assert.ok(forge.pki.certificateToPem(cert).includes('BEGIN CERTIFICATE'));
    });
});
