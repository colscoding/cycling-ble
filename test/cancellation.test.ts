import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectPower } from '../src/connect.js';
import type { ConnectionStatus, SensorReading } from '../src/types.js';
import { createFakeBluetooth, FakeCharacteristic, powerPacket, waitFor } from './helpers/fake-bluetooth.js';

function setup() {
    const char = new FakeCharacteristic('cycling_power_measurement');
    const fake = createFakeBluetooth({ services: { cycling_power: { cycling_power_measurement: char } } });
    return { ...fake, char };
}

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release: () => release() };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('cancelling asynchronous setup', () => {
    const stages = ['connect', 'service', 'characteristic', 'notifications'] as const;
    for (const stage of stages) {
        for (const rejects of [false, true]) {
            it(`stops after a cancelled ${stage} operation ${rejects ? 'rejects' : 'resolves'}`, async () => {
                const fake = setup();
                const conn = await connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 1 } });
                const gatt = fake.device.gatt;
                const service = await gatt.getPrimaryService('cycling_power');
                const held = gate();
                const calls: string[] = [];
                const statuses: ConnectionStatus[] = [];
                conn.onStatusChange((status) => statuses.push(status));
                const run = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
                    calls.push(name);
                    if (name === stage) {
                        await held.promise;
                        if (rejects) throw new DOMException('Attribute disappeared', 'NotFoundError');
                    }
                    return action();
                };
                const connect = gatt.connect.bind(gatt);
                const getService = gatt.getPrimaryService.bind(gatt);
                const getCharacteristic = service.getCharacteristic.bind(service);
                const start = fake.char.startNotifications.bind(fake.char);
                gatt.connect = () => run('connect', connect);
                gatt.getPrimaryService = (uuid) => run('service', () => getService(uuid));
                service.getCharacteristic = (uuid) => run('characteristic', () => getCharacteristic(uuid));
                fake.char.startNotifications = () => run('notifications', start);

                try {
                    fake.device.dropConnection();
                    await waitFor(() => calls.includes(stage));
                    conn.disconnect();
                    held.release();
                    await flush();

                    assert.deepEqual(calls, stages.slice(0, stages.indexOf(stage) + 1));
                    assert.deepEqual(statuses, ['disconnected', 'reconnecting', 'disconnected']);
                    assert.equal(gatt.connected, false);
                    assert.equal(fake.char.listenerCount, 0);
                    assert.equal(fake.device.listenerCountFor('gattserverdisconnected'), 0);
                } finally {
                    conn.disconnect();
                    held.release();
                    await flush();
                }
            });
        }
    }

    for (const rejects of [false, true]) {
        it(`keeps a replacement connection alive when an old attempt ${rejects ? 'rejects' : 'resolves'}`, async () => {
            const fake = setup();
            const old = await connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 1 } });
            const held = gate();
            const gatt = fake.device.gatt;
            const connect = gatt.connect.bind(gatt);
            let calls = 0;
            gatt.connect = async () => {
                if (++calls === 1) {
                    await held.promise;
                    if (rejects) throw new Error('Old attempt failed');
                }
                return connect();
            };
            fake.device.dropConnection();
            await waitFor(() => calls === 1);
            old.disconnect();
            const replacement = await connectPower({ bluetooth: fake.bluetooth });
            try {
                const readings: SensorReading[] = [];
                replacement.addListener((reading) => readings.push(reading));
                const disconnects = gatt.disconnectCalls;
                held.release();
                await flush();
                assert.equal(gatt.disconnectCalls, disconnects, 'old cleanup must not close the newer attempt');
                assert.equal(gatt.connected, true);
                assert.equal(fake.char.listenerCount, 1);
                fake.char.emit(powerPacket(250));
                assert.equal(readings.length, 1);
            } finally {
                held.release();
                replacement.disconnect();
            }
        });
    }

    it('does not start a second attempt while initial setup is still pending', async () => {
        const fake = setup();
        const held = gate();
        const connect = fake.device.gatt.connect.bind(fake.device.gatt);
        let connects = 0;
        let subscribing = false;
        fake.device.gatt.connect = async () => {
            connects++;
            return connect();
        };
        fake.char.startNotifications = async () => {
            subscribing = true;
            await held.promise;
            return fake.char;
        };
        const pending = connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 1 } });
        await waitFor(() => subscribing);
        fake.device.dropConnection();
        await new Promise((resolve) => setTimeout(resolve, 10));
        const rejected = assert.rejects(pending, /GATT server disconnected during setup/);
        held.release();
        await rejected;
        assert.equal(connects, 1);
        assert.equal(fake.char.listenerCount, 0);
        assert.equal(fake.device.listenerCountFor('gattserverdisconnected'), 0);
    });
});
