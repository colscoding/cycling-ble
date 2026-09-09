import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createReconnectionManager, type ReconnectionManager } from '../src/reconnection.js';
import type { ConnectionStatus } from '../src/types.js';

describe('createReconnectionManager', () => {
    let manager: ReconnectionManager;
    let statuses: ConnectionStatus[];

    beforeEach(() => {
        statuses = [];
    });

    afterEach(async () => {
        manager?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 30));
    });

    function make(options: { maxAttempts?: number; baseDelayMs?: number } | false = {}): ReconnectionManager {
        manager = createReconnectionManager({
            sensorName: 'Test Sensor',
            options: options === false ? false : { maxAttempts: 3, baseDelayMs: 5, ...options },
            onStatusChange: (s) => statuses.push(s),
        });
        return manager;
    }

    it('reconnects and reports connected via the caller-supplied connect fn', async () => {
        const m = make();
        let calls = 0;
        await m.attemptReconnect(async () => {
            calls++;
        });
        assert.equal(calls, 1);
        assert.deepEqual(statuses, ['reconnecting']);
    });

    it('retries with backoff and gives up after maxAttempts', async () => {
        const m = make({ maxAttempts: 2 });
        let calls = 0;
        await m.attemptReconnect(async () => {
            calls++;
            throw new Error('nope');
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(calls, 2, 'stops after two attempts');
        assert.ok(statuses.includes('failed'), 'reports failure');
    });

    it('does not reconnect after a manual disconnect', async () => {
        const m = make();
        m.markManualDisconnect();
        let calls = 0;
        await m.attemptReconnect(async () => {
            calls++;
        });
        assert.equal(calls, 0);
        assert.equal(m.isManualDisconnect(), true);
    });

    it('handleDisconnect reports disconnected then attempts a reconnect', async () => {
        const m = make();
        let calls = 0;
        m.handleDisconnect(async () => {
            calls++;
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(statuses[0], 'disconnected');
        assert.equal(calls, 1);
    });

    it('cancel stops a pending retry', async () => {
        const m = make({ baseDelayMs: 200 });
        let calls = 0;
        const pending = m.attemptReconnect(async () => {
            calls++;
        });
        m.cancel();
        await pending;
        assert.equal(calls, 0, 'the connect fn never runs after cancellation');
    });

    it('reset clears the attempt counter and the manual flag', async () => {
        const m = make();
        m.markManualDisconnect();
        m.reset();
        assert.equal(m.isManualDisconnect(), false);
        let calls = 0;
        await m.attemptReconnect(async () => {
            calls++;
        });
        assert.equal(calls, 1);
    });

    it('never reconnects when reconnection is disabled', async () => {
        const m = make(false);
        let calls = 0;
        m.handleDisconnect(async () => {
            calls++;
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(calls, 0);
        assert.deepEqual(statuses, ['disconnected'], 'still reports the disconnect');
    });
});
