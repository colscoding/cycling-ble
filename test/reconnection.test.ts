import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createReconnectionManager, type ReconnectionManager } from '../src/reconnection.js';
import type { ConnectionStatus } from '../src/types.js';
import { recordingLogger } from './helpers/fake-bluetooth.js';

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

    it('emits no status churn after a manual disconnect', async () => {
        // Bailing out late would still skip the reconnect, but only after
        // announcing 'reconnecting' to every listener first.
        const m = make();
        m.markManualDisconnect();
        await m.attemptReconnect(async () => {});
        assert.deepEqual(statuses, [], 'a reconnect that will not happen must not be announced');
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

    it('stops retrying when cancelled while a failing attempt is in flight', async () => {
        const m = make({ maxAttempts: 5, baseDelayMs: 1 });
        let calls = 0;
        await m.attemptReconnect(async () => {
            calls++;
            m.cancel();
            throw new Error('failed after the caller gave up');
        });
        assert.equal(calls, 1, 'no further attempt once cancelled');
        assert.deepEqual(statuses, ['reconnecting'], 'and no failure announced for a cancelled cycle');
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

    it('runs one backoff cycle even when the drop is reported repeatedly', async () => {
        // A browser can report the same drop more than once. Each event used to
        // start its own chain, and they raced.
        const m = make({ baseDelayMs: 10 });
        let calls = 0;
        const connectFn = async (): Promise<void> => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 20));
        };

        m.handleDisconnect(connectFn);
        m.handleDisconnect(connectFn);
        m.handleDisconnect(connectFn);
        await new Promise((resolve) => setTimeout(resolve, 120));

        assert.equal(calls, 1, 'one reconnect, not one per event');
        assert.deepEqual(statuses, ['disconnected', 'reconnecting'], 'and one round of status events');
    });

    it('doubles the delay each attempt and caps it at maxDelayMs', async () => {
        const { logger, calls } = recordingLogger();
        manager = createReconnectionManager({
            sensorName: 'Test Sensor',
            options: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4 },
            logger,
            onStatusChange: (s) => statuses.push(s),
        });
        await manager.attemptReconnect(async () => {
            throw new Error('still down');
        });

        const delays = calls.info.map((m) => /in (\d+)ms/.exec(m)?.[1]).filter((d) => d !== undefined);
        assert.deepEqual(delays, ['1', '2', '4', '4', '4']);
        assert.equal(calls.error.filter((m) => m.includes('reconnection failed')).length, 5);
        assert.deepEqual(
            statuses.filter((s) => s === 'failed'),
            ['failed'],
            'failure is reported exactly once'
        );
    });

    it('defaults to 5 attempts starting at 1000 ms', async () => {
        // The README and the ReconnectOptions docs both state these numbers.
        const { logger, calls } = recordingLogger();
        manager = createReconnectionManager({ sensorName: 'Test Sensor', logger });
        const pending = manager.attemptReconnect(async () => {});
        manager.cancel();
        await pending;
        assert.match(calls.info[0]!, /attempt 1\/5 in 1000ms/);
    });

    it('caps the default backoff at 10 s', async () => {
        const { logger, calls } = recordingLogger();
        manager = createReconnectionManager({
            sensorName: 'Test Sensor',
            options: { baseDelayMs: 60_000 },
            logger,
        });
        const pending = manager.attemptReconnect(async () => {});
        manager.cancel();
        await pending;
        assert.match(calls.info[0]!, /in 10000ms/);
    });

    it('a successful attempt restores the full attempt budget', async () => {
        const m = make({ maxAttempts: 1 });
        await m.attemptReconnect(async () => {});
        await m.attemptReconnect(async () => {});
        assert.equal(statuses.includes('failed'), false);
    });

    it('ignores a drop reported after it has given up', async () => {
        // 'failed' is final. Closing a half-open link can itself fire another
        // disconnect event, and that must not start the announcements again.
        const m = make({ maxAttempts: 1 });
        await m.attemptReconnect(async () => {
            throw new Error('still down');
        });
        assert.deepEqual(statuses, ['reconnecting', 'failed']);

        let calls = 0;
        m.handleDisconnect(async () => {
            calls++;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.equal(calls, 0);
        assert.deepEqual(statuses, ['reconnecting', 'failed'], 'no second disconnected/failed');
    });

    it('reset() after giving up allows reconnection again', async () => {
        const m = make({ maxAttempts: 1 });
        await m.attemptReconnect(async () => {
            throw new Error('still down');
        });
        m.reset();

        let calls = 0;
        m.handleDisconnect(async () => {
            calls++;
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
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
