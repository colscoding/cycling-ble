/**
 * Simulated sensors with the same shape as a real connection.
 *
 * Useful for demo modes, UI development without hardware, and end-to-end
 * tests. Nothing here touches Bluetooth, so it runs anywhere.
 */

import type { ConnectionStatus, ReadingListener, SensorConnection, SensorReading, StatusListener } from './types.js';
import { createListeners } from './listeners.js';

const DEFAULT_INTERVAL_MS = 1000;
// Longer delays overflow the timer range in browsers and Node.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface MockSensorOptions {
    /** Reported as `deviceName`. */
    deviceName?: string;
    /** Finite ms in [0, 2147483647] between generated readings. Default 1000. */
    intervalMs?: number;
    /**
     * Start the interval immediately; the first reading follows after intervalMs.
     * Default true; pass false to drive emit() yourself.
     */
    autoStart?: boolean;
}

export interface MockSensorConnection extends SensorConnection {
    /**
     * Emit one reading now, stamped with the current time.
     *
     * Pair with `autoStart: false` to drive the sensor yourself instead of
     * waiting on generated values.
     */
    emit(fields: Omit<SensorReading, 'timestamp'>): void;

    /**
     * Report a lifecycle status to exercise UI states without hardware.
     * Does not schedule retries; even `failed` can be followed by `connected`.
     *
     * Readings flow only while the simulated status is `connected`: a real
     * link that is down delivers nothing, so generated readings and `emit()`
     * are dropped until then. Ignored after `disconnect()`.
     *
     * Nested status changes are queued so every listener sees transitions in
     * order, matching a real connection. Listener errors are rethrown after
     * every queued transition has run.
     */
    simulateStatus(status: ConnectionStatus): void;
}

function createMockSensor(
    defaultName: string,
    generate: () => Omit<SensorReading, 'timestamp'>,
    options: MockSensorOptions = {}
): MockSensorConnection {
    const { deviceName = defaultName, intervalMs = DEFAULT_INTERVAL_MS, autoStart = true } = options;

    if (!Number.isFinite(intervalMs) || intervalMs < 0 || intervalMs > MAX_TIMER_DELAY_MS) {
        throw new RangeError(`intervalMs must be a finite number between 0 and ${MAX_TIMER_DELAY_MS}`);
    }

    const readingListeners = createListeners<SensorReading>();
    const statusListeners = createListeners<ConnectionStatus>();
    let timer: ReturnType<typeof setInterval> | undefined;
    // disconnect() is final; a simulated drop only takes the link down.
    let stopped = false;
    let linkUp = true;

    // Unlike a real connection, the caller triggers delivery here — usually a
    // test calling emit() — so a listener's error goes back to that caller, as
    // an assertion failing inside a listener should. Every listener runs first.
    const throwFirst = (errors: unknown[]): void => {
        if (errors.length > 0) throw errors[0];
    };

    const pendingStatuses: ConnectionStatus[] = [];
    let notifyingStatus = false;
    const notifyStatus = (status: ConnectionStatus): void => {
        // Match real connections: finish delivering the current status to every
        // subscriber before running any nested transition a listener triggered.
        pendingStatuses.push(status);
        if (notifyingStatus) return;

        notifyingStatus = true;
        const errors: unknown[] = [];
        try {
            let next: ConnectionStatus | undefined;
            while ((next = pendingStatuses.shift()) !== undefined) {
                errors.push(...statusListeners.emit(next));
            }
        } finally {
            notifyingStatus = false;
        }
        throwFirst(errors);
    };

    const emit = (fields: Omit<SensorReading, 'timestamp'>): void => {
        if (stopped || !linkUp) return;
        const reading: SensorReading = { timestamp: Date.now(), ...fields };
        throwFirst(readingListeners.emit(reading));
    };

    if (autoStart) {
        timer = setInterval(() => emit(generate()), intervalMs);
        // Node's setInterval returns a Timeout carrying unref(); the browser's
        // returns a bare numeric handle that has no such method. Unref where it
        // exists so a running mock never holds a Node process open.
        (timer as unknown as { unref?: () => void }).unref?.();
    }

    return {
        deviceName,
        addListener(listener: ReadingListener): () => void {
            return readingListeners.add(listener);
        },
        onStatusChange(listener: StatusListener): () => void {
            return statusListeners.add(listener);
        },
        disconnect(): void {
            if (stopped) return;
            clearInterval(timer);
            stopped = true;
            notifyStatus('disconnected');
        },
        emit,
        simulateStatus(status: ConnectionStatus): void {
            if (stopped) return;
            linkUp = status === 'connected';
            notifyStatus(status);
        },
    };
}

const randomBetween = (min: number, max: number): number => Math.floor(min + Math.random() * (max - min + 1));

/** A power meter reporting 200-250 W. */
export function createMockPowerSensor(options?: MockSensorOptions): MockSensorConnection {
    return createMockSensor('Mock Power Sensor', () => ({ power: randomBetween(200, 250) }), options);
}

/** A heart rate monitor reporting 140-160 bpm. */
export function createMockHeartRateSensor(options?: MockSensorOptions): MockSensorConnection {
    return createMockSensor('Mock Heart Rate Monitor', () => ({ heartRate: randomBetween(140, 160) }), options);
}

/** A cadence sensor reporting 80-100 rpm. */
export function createMockCadenceSensor(options?: MockSensorOptions): MockSensorConnection {
    return createMockSensor('Mock Cadence Sensor', () => ({ cadence: randomBetween(80, 100) }), options);
}
