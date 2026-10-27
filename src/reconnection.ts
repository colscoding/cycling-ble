import type { ConnectionStatus, Logger, ReconnectOptions } from './types.js';
import { noopLogger } from './logger.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10_000;
// Longer delays overflow the timer range in browsers and Node.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface ReconnectionManager {
    /**
     * Call from a disconnect event: reports the drop, then reconnects with
     * backoff until success or exhaustion. Resolves once the reconnection this
     * call started has ended, or at once if it started none.
     */
    handleDisconnect(connectFn: () => Promise<void>): Promise<void>;
    /** Record that the caller asked to disconnect: cancel any pending retry and stop reconnecting. */
    markManualDisconnect(): void;
    isManualDisconnect(): boolean;
    /** Clear the attempt counter and the manual and gave-up flags. */
    reset(): void;
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

    if (maxAttempts !== Infinity && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0)) {
        throw new RangeError('maxAttempts must be a nonnegative safe integer or Infinity');
    }
    for (const [name, delay] of [
        ['baseDelayMs', baseDelayMs],
        ['maxDelayMs', maxDelayMs],
    ] as const) {
        if (!Number.isInteger(delay) || delay < 0 || delay > MAX_TIMER_DELAY_MS) {
            throw new RangeError(`${name} must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`);
        }
    }

    let attempts = 0;
    let reconnecting = false;
    let manualDisconnect = false;
    /** Set once 'failed' is reported. Until reset(), further drops are ignored. */
    let gaveUp = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pendingResolve: (() => void) | null = null;

    const notify = (status: ConnectionStatus): void => onStatusChange?.(status);

    /** Sleep that markManualDisconnect() cuts short, so a pending retry never hangs. */
    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            pendingResolve = resolve;
            timeoutId = setTimeout(() => {
                timeoutId = null;
                pendingResolve = null;
                resolve();
            }, ms);
        });

    const attemptReconnect = async (connectFn: () => Promise<void>): Promise<void> => {
        // A loop rather than a retry that awaits itself: with maxAttempts set to
        // Infinity, recursion would chain one more pending promise per failed
        // attempt for as long as the outage lasts.
        while (enabled && !manualDisconnect) {
            if (attempts >= maxAttempts) {
                logger.error(`[${sensorName}] max reconnection attempts reached`);
                gaveUp = true;
                notify('failed');
                return;
            }

            attempts++;
            // With integer delays, 31 doublings already reach any allowed cap.
            // Bound the exponent so unlimited retries never compute 0 * Infinity.
            const delay = Math.min(baseDelayMs * 2 ** Math.min(attempts - 1, 31), maxDelayMs);
            logger.info(`[${sensorName}] reconnection attempt ${attempts}/${maxAttempts} in ${delay}ms`);
            notify('reconnecting');

            // A status listener may disconnect before a timer exists to cancel.
            if (manualDisconnect) return;
            await sleep(delay);
            if (manualDisconnect) {
                logger.info(`[${sensorName}] reconnection cancelled`);
                return;
            }

            try {
                await connectFn();
                logger.info(`[${sensorName}] reconnected`);
                attempts = 0;
                return;
            } catch (error) {
                logger.error(`[${sensorName}] reconnection failed:`, error);
            }
        }
    };

    return {
        handleDisconnect(connectFn: () => Promise<void>): Promise<void> {
            // A browser can report the same drop more than once, and another can
            // arrive while a retry is already in flight. Without this guard each
            // event starts its own backoff chain and they race each other.
            // After giving up, a late event — such as the one fired by closing a
            // half-open link — must not reopen a connection reported as failed.
            if (manualDisconnect || reconnecting || gaveUp) return Promise.resolve();

            notify('disconnected');
            if (!enabled) return Promise.resolve();

            reconnecting = true;
            return attemptReconnect(connectFn)
                .catch((e) => logger.error(`[${sensorName}] reconnect failed:`, e))
                .finally(() => {
                    reconnecting = false;
                });
        },

        markManualDisconnect(): void {
            manualDisconnect = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            pendingResolve?.();
            pendingResolve = null;
        },

        isManualDisconnect: () => manualDisconnect,

        reset(): void {
            attempts = 0;
            manualDisconnect = false;
            gaveUp = false;
        },
    };
}
