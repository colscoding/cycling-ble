import type { ConnectionStatus, Logger, ReconnectOptions } from './types.js';
import { noopLogger } from './logger.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10_000;

export interface ReconnectionManager {
    /** Run one backoff cycle, retrying until success or exhaustion. */
    attemptReconnect(connectFn: () => Promise<void>): Promise<void>;
    /** Call from a disconnect event: reports the drop, then reconnects. */
    handleDisconnect(connectFn: () => Promise<void>): void;
    /** Record that the caller asked to disconnect, suppressing reconnection. */
    markManualDisconnect(): void;
    isManualDisconnect(): boolean;
    /** Clear the attempt counter and the manual and cancelled flags. */
    reset(): void;
    /** Cancel any pending retry and stop reconnecting. */
    cancel(): void;
}

export interface ReconnectionConfig {
    /** Human-readable name, used only in log lines. */
    sensorName: string;
    /** Tuning, or `false` to disable reconnection entirely. */
    options?: ReconnectOptions | false;
    logger?: Logger;
    onStatusChange?: (status: ConnectionStatus) => void;
}

/**
 * Reconnection with exponential backoff.
 *
 * The manager owns no transport. The caller supplies a `connectFn`, which
 * keeps this reusable across sensors and testable without Bluetooth.
 */
export function createReconnectionManager(config: ReconnectionConfig): ReconnectionManager {
    const { sensorName, options, logger = noopLogger, onStatusChange } = config;

    const enabled = options !== false;
    const tuning: ReconnectOptions = options === false || options === undefined ? {} : options;
    const maxAttempts = tuning.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseDelayMs = tuning.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const maxDelayMs = tuning.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

    let attempts = 0;
    let manualDisconnect = false;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pendingResolve: ((proceed: boolean) => void) | null = null;

    const notify = (status: ConnectionStatus): void => onStatusChange?.(status);

    /** Sleep that resolves false if cancelled, so a pending retry never hangs. */
    const sleep = (ms: number): Promise<boolean> =>
        new Promise((resolve) => {
            pendingResolve = resolve;
            timeoutId = setTimeout(() => {
                timeoutId = null;
                pendingResolve = null;
                resolve(!cancelled);
            }, ms);
        });

    const attemptReconnect = async (connectFn: () => Promise<void>): Promise<void> => {
        if (!enabled || manualDisconnect || cancelled) return;

        if (attempts >= maxAttempts) {
            logger.error(`[${sensorName}] max reconnection attempts reached`);
            notify('failed');
            return;
        }

        attempts++;
        const delay = Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs);
        logger.info(`[${sensorName}] reconnection attempt ${attempts}/${maxAttempts} in ${delay}ms`);
        notify('reconnecting');

        const proceed = await sleep(delay);
        if (!proceed || cancelled) {
            logger.info(`[${sensorName}] reconnection cancelled`);
            return;
        }

        try {
            await connectFn();
            logger.info(`[${sensorName}] reconnected`);
            attempts = 0;
        } catch (error) {
            logger.error(`[${sensorName}] reconnection failed:`, error);
            if (!cancelled) {
                await attemptReconnect(connectFn);
            }
        }
    };

    const cancel = (): void => {
        cancelled = true;
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        pendingResolve?.(false);
        pendingResolve = null;
    };

    return {
        attemptReconnect,

        handleDisconnect(connectFn: () => Promise<void>): void {
            if (manualDisconnect) return;
            notify('disconnected');
            if (!enabled) return;
            attemptReconnect(connectFn).catch((e) => logger.error(`[${sensorName}] reconnect failed:`, e));
        },

        markManualDisconnect(): void {
            manualDisconnect = true;
            cancel();
        },

        isManualDisconnect: () => manualDisconnect,

        reset(): void {
            attempts = 0;
            manualDisconnect = false;
            cancelled = false;
        },

        cancel,
    };
}
