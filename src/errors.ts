/**
 * Stable category of a Web Bluetooth failure.
 *
 * - `cancelled` — the user dismissed the device chooser. Usually not an error
 *   worth showing.
 * - `unavailable` — no Bluetooth: unsupported browser, insecure context, or the
 *   adapter is off. Retrying will not help until something changes.
 * - `not-found` — the chooser found no matching device, or a saved
 *   `previousDeviceId` is no longer among the permitted devices.
 * - `connection-failed` — a device was chosen but the GATT connection failed.
 * - `permission-denied` — the browser or OS refused access.
 * - `timeout` — the connection attempt timed out or hit a network error.
 * - `incompatible` — the device lacks the service this sensor type needs.
 * - `unknown` — none of the above matched.
 */
export type BluetoothErrorKind =
    | 'cancelled'
    | 'unavailable'
    | 'not-found'
    | 'connection-failed'
    | 'permission-denied'
    | 'timeout'
    | 'incompatible'
    | 'unknown';

export interface BluetoothErrorInfo {
    /** Stable machine-readable category. Safe to branch on. */
    kind: BluetoothErrorKind;
    /** Short headline. */
    title: string;
    /** One sentence explaining what happened. */
    message: string;
    /** Troubleshooting steps, most likely first. May be empty. */
    suggestions: string[];
    /** Whether retrying the same call could plausibly succeed. */
    canRetry: boolean;
}

export interface ClassifyOptions {
    /** How to name the sensor in `message`. Defaults to `'sensor'`. */
    sensorLabel?: string;
}

/**
 * Classify a Web Bluetooth failure into something a user interface can render.
 *
 * Accepts anything a `catch` can receive. Errors thrown by this package's own
 * connect functions are recognised as well as browser errors.
 *
 * Browsers disagree on both the `name` and the wording of these errors, so
 * classification is message-sniffing by necessity. The branch order matters:
 * a `NotFoundError` means a cancelled chooser when its message mentions
 * cancellation; service discovery errors need different advice from chooser errors.
 *
 * @example
 * try {
 *     await connectPower();
 * } catch (error) {
 *     const info = classifyBluetoothError(error, { sensorLabel: 'power meter' });
 *     if (info.kind !== 'cancelled') showError(info.title, info.message);
 * }
 */
export function classifyBluetoothError(error: unknown, options: ClassifyOptions = {}): BluetoothErrorInfo {
    const label = options.sensorLabel ?? 'sensor';
    const { name, message } = nameAndMessage(error);
    // Wording is matched case-insensitively: a message usually starts a
    // sentence, so "Failed to connect" has to match "fail" and "connect".
    const text = message.toLowerCase();

    if (
        text.includes('user cancelled') ||
        text.includes('cancelled the requestdevice') ||
        text.includes('dialog cancelled') ||
        text.includes('chooser cancelled') ||
        (name === 'NotFoundError' && text.includes('cancel'))
    ) {
        return {
            kind: 'cancelled',
            title: 'Connection cancelled',
            message: `${label} pairing was cancelled.`,
            suggestions: [],
            canRetry: true,
        };
    }

    if (text.includes('securityerror') || text.includes('permission') || name === 'SecurityError') {
        return {
            kind: 'permission-denied',
            title: 'Permission denied',
            message: 'Bluetooth permission was denied.',
            suggestions: [
                'Allow Bluetooth access in the browser settings',
                'Choose "Allow" when prompted',
                'Reload the page and try again',
                'Make sure the page is served over HTTPS or localhost',
            ],
            canRetry: true,
        };
    }

    if (
        text.includes('networkerror') ||
        text.includes('timeout') ||
        text.includes('timed out') ||
        name === 'NetworkError'
    ) {
        return {
            kind: 'timeout',
            title: 'Connection timed out',
            message: `The connection to the ${label} timed out.`,
            suggestions: [
                'Make sure the sensor is in range and powered on',
                'Move closer to the sensor',
                'Power cycle the sensor and try again',
                'Check for interference from other wireless devices',
            ],
            canRetry: true,
        };
    }

    if (
        ((text.includes('service') || text.includes('characteristic')) && text.includes('not found')) ||
        text.includes('no services matching uuid') ||
        text.includes('no characteristics matching uuid') ||
        text.includes('none of the expected ble services')
    ) {
        return {
            kind: 'incompatible',
            title: 'Incompatible sensor',
            message: `That device does not look like a compatible ${label}.`,
            suggestions: [
                'Check that the correct sensor type was chosen',
                'Confirm the sensor supports the standard Bluetooth profiles',
                'Some sensors need a firmware update to expose standard services',
                "Consult the sensor's documentation for compatibility",
            ],
            canRetry: true,
        };
    }

    if (
        text.includes('bluetooth adapter not available') ||
        text.includes('web bluetooth api is not available') ||
        text.includes('web bluetooth is not available') ||
        // Thrown by the connect functions when previousDeviceId is given and
        // the browser cannot look devices up. Retrying the same call cannot
        // help, which is what separates this from a lookup that failed.
        text.includes('does not support getdevices') ||
        (name === 'NotFoundError' && text.includes('bluetooth'))
    ) {
        return {
            kind: 'unavailable',
            title: 'Bluetooth unavailable',
            message: 'Bluetooth is not available on this device or browser.',
            suggestions: [
                'Check that Bluetooth is enabled in your device settings',
                'Use a Chromium-based browser such as Chrome, Edge, or Opera',
                'On macOS, grant Bluetooth permission in System Settings',
                'On Windows, check that the Bluetooth adapter is working',
            ],
            canRetry: false,
        };
    }

    if (
        text.includes('no bluetooth devices') ||
        text.includes('no devices found') ||
        // Thrown by the connect functions for a stale previousDeviceId.
        text.includes('not found in the permitted device list') ||
        (name === 'NotFoundError' && !text.includes('bluetooth'))
    ) {
        return {
            kind: 'not-found',
            title: 'No sensors found',
            message: `No compatible ${label} was found nearby.`,
            suggestions: [
                'Make sure the sensor is powered on',
                'Wake the sensor by spinning the pedals or moving it',
                'Bring the sensor closer to this device',
                'Check that the sensor battery is not depleted',
                'Make sure the sensor is not already connected to another device',
            ],
            canRetry: true,
        };
    }

    if (
        text.includes('gatt') ||
        text.includes('connection failed') ||
        (text.includes('connect') && text.includes('fail'))
    ) {
        return {
            kind: 'connection-failed',
            title: 'Connection failed',
            message: `Could not connect to the ${label}.`,
            suggestions: [
                'Move closer to the sensor',
                'Power cycle the sensor',
                'Check that no other device is connected to it',
                'Restart Bluetooth on this device',
                'Close other applications that may hold the connection',
            ],
            canRetry: true,
        };
    }

    return {
        kind: 'unknown',
        title: 'Connection error',
        message: `Failed to connect to the ${label}.`,
        suggestions: [
            'Make sure the sensor is powered on and nearby',
            'Power cycle the sensor',
            'Restart Bluetooth on this device',
            'Reload the page and try again',
        ],
        canRetry: true,
    };
}

/**
 * The name and message of anything a `catch` can receive. Errors that cross a
 * realm, a worker, or a serialisation boundary are no longer `instanceof Error`
 * but keep both fields, so read them structurally.
 */
function nameAndMessage(error: unknown): { name: string; message: string } {
    if (typeof error === 'object' && error !== null) {
        const { name, message } = error as { name?: unknown; message?: unknown };
        return {
            name: typeof name === 'string' ? name : '',
            message: typeof message === 'string' ? message : String(error),
        };
    }
    return { name: '', message: String(error) };
}

/** Only a missing attribute permits probing the next candidate service. */
export function isMissingGattAttribute(error: unknown): boolean {
    return nameAndMessage(error).name === 'NotFoundError';
}
