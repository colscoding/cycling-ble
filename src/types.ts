/**
 * A single timestamped frame decoded from one BLE notification.
 *
 * A frame may carry more than one metric: an FTMS Indoor Bike Data packet
 * reports power and cadence together. Absent metrics are omitted keys, never
 * `undefined` values — the package is built with `exactOptionalPropertyTypes`.
 */
export interface SensorReading {
    /** Unix timestamp in milliseconds. */
    timestamp: number;
    /** Instantaneous power in watts. */
    power?: number;
    /** Cadence in revolutions per minute. */
    cadence?: number;
    /** Heart rate in beats per minute. */
    heartRate?: number;
}

/** Lifecycle of a sensor connection, including automatic reconnection. */
export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting' | 'failed';

/** Called for each decoded frame. */
export type ReadingListener = (reading: SensorReading) => void;

/** Called when the connection lifecycle changes. */
export type StatusListener = (status: ConnectionStatus) => void;

/** A live connection to a BLE sensor. */
export interface SensorConnection {
    /**
     * Platform-assigned device id, when the browser exposes one. Persist it and
     * pass it back as `previousDeviceId` to reconnect without a chooser prompt.
     */
    readonly deviceId?: string;
    /** Advertised device name, or a generic fallback. */
    readonly deviceName: string;
    /** Subscribe to readings. Returns an unsubscribe function. */
    addListener(listener: ReadingListener): () => void;
    /** Subscribe to status changes. Returns an unsubscribe function. */
    onStatusChange(listener: StatusListener): () => void;
    /** Disconnect and stop reconnecting. */
    disconnect(): void;
}

/**
 * Minimal structural logger. Any object with these methods works, including
 * `console`. Defaults to a no-op so the package stays silent in someone
 * else's application.
 */
export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/** Automatic reconnection tuning. */
export interface ReconnectOptions {
    /** Attempts before giving up and reporting `failed`. Default 5. */
    maxAttempts?: number;
    /** First backoff delay in ms; doubles each attempt. Default 1000. */
    baseDelayMs?: number;
    /** Upper bound on the backoff delay in ms. Default 10000. */
    maxDelayMs?: number;
}

/**
 * The part of the Web Bluetooth `Bluetooth` interface this package uses.
 *
 * Declared structurally rather than as the DOM's `Bluetooth` type so that
 * consumers need no ambient Web Bluetooth typings of their own — a published
 * `.d.ts` that depends on an ambient global forces every consumer to configure
 * one. `navigator.bluetooth` satisfies this, and so does a polyfill or a fake.
 */
export interface BluetoothAdapter {
    /**
     * Matches the shape this package actually sends, not the full
     * `RequestDeviceOptions` union: a wider parameter type here would stop the
     * real `navigator.bluetooth` from satisfying the interface.
     */
    requestDevice(options: {
        filters: { services: (string | number)[] }[];
        optionalServices: (string | number)[];
    }): Promise<unknown>;
    getDevices?(): Promise<unknown[]>;
}

/** Options accepted by every connect function. */
export interface ConnectOptions {
    /** A previously returned `deviceId`, to reconnect without a chooser prompt. */
    previousDeviceId?: string;
    /** Where the package logs. Defaults to a no-op logger. */
    logger?: Logger;
    /** Reconnection tuning, or `false` to disable automatic reconnection. */
    reconnect?: ReconnectOptions | false;
    /**
     * Bluetooth implementation to use. Defaults to `navigator.bluetooth`.
     * Override to supply a polyfill (such as the `webbluetooth` package on
     * Node) or a fake in tests.
     */
    bluetooth?: BluetoothAdapter;
}
