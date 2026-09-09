/**
 * Simulated sensors with the same shape as a real connection.
 *
 * Useful for demo modes, UI development without hardware, and end-to-end
 * tests. Nothing here touches Bluetooth, so it runs anywhere.
 */

import type { ConnectionStatus, ReadingListener, SensorConnection, SensorReading, StatusListener } from './types.js';

const DEFAULT_INTERVAL_MS = 1000;

export interface MockSensorOptions {
    /** Reported as `deviceName`. */
    deviceName?: string;
    /** How often to emit generated readings. Default 1000. */
    intervalMs?: number;
    /** Begin emitting immediately. Default true; pass false to drive `emit`. */
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
}

function createMockSensor(
    defaultName: string,
    generate: () => Omit<SensorReading, 'timestamp'>,
    options: MockSensorOptions = {}
): MockSensorConnection {
    const { deviceName = defaultName, intervalMs = DEFAULT_INTERVAL_MS, autoStart = true } = options;

    const readingListeners = new Set<ReadingListener>();
    const statusListeners = new Set<StatusListener>();
    let timer: ReturnType<typeof setInterval> | null = null;
    let disconnected = false;

    const notifyStatus = (status: ConnectionStatus): void => {
        for (const listener of [...statusListeners]) listener(status);
    };

    const emit = (fields: Omit<SensorReading, 'timestamp'>): void => {
        if (disconnected) return;
        const reading: SensorReading = { timestamp: Date.now(), ...fields };
        for (const listener of [...readingListeners]) listener(reading);
    };

    const start = (): void => {
        if (timer !== null || disconnected) return;
        timer = setInterval(() => emit(generate()), intervalMs);
        // Node's setInterval returns a Timeout carrying unref(); the browser's
        // returns a bare numeric handle that has no such method. Unref where it
        // exists so a running mock never holds a Node process open.
        (timer as unknown as { unref?: () => void }).unref?.();
    };

    const stop = (): void => {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };

    if (autoStart) start();

    return {
        deviceName,
        addListener(listener: ReadingListener): () => void {
            readingListeners.add(listener);
            return () => {
                readingListeners.delete(listener);
            };
        },
        onStatusChange(listener: StatusListener): () => void {
            statusListeners.add(listener);
            return () => {
                statusListeners.delete(listener);
            };
        },
        disconnect(): void {
            stop();
            disconnected = true;
            notifyStatus('disconnected');
        },
        emit,
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
