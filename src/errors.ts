/**
 * Classify a Web Bluetooth failure into something a user interface can render.
 *
 * Browsers disagree on both the `name` and the wording of these errors, so
 * classification is message-sniffing by necessity. The branch order matters:
 * a `NotFoundError` means a cancelled chooser when its message mentions
 * cancellation, and nothing-found otherwise.
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

export function classifyBluetoothError(error: unknown, options: ClassifyOptions = {}): BluetoothErrorInfo {
    const label = options.sensorLabel ?? 'sensor';
    const text = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : '';

    if (
        text.includes('User cancelled') ||
        text.includes('cancelled the requestDevice') ||
        text.includes('dialog cancelled') ||
        text.includes('Chooser cancelled') ||
        (name === 'NotFoundError' && text.toLowerCase().includes('cancel'))
    ) {
        return {
            kind: 'cancelled',
            title: 'Connection cancelled',
            message: `${label} pairing was cancelled.`,
            suggestions: [],
            canRetry: true,
        };
    }

    if (
        text.includes('Bluetooth adapter not available') ||
        text.includes('Web Bluetooth API is not available') ||
        text.includes('Web Bluetooth is not available') ||
        (name === 'NotFoundError' && text.includes('Bluetooth'))
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
        text.includes('No Bluetooth devices') ||
        text.includes('No devices found') ||
        (name === 'NotFoundError' && !text.includes('Bluetooth'))
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
        text.includes('GATT') ||
        text.includes('Connection failed') ||
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

    if (text.includes('SecurityError') || text.includes('permission') || name === 'SecurityError') {
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

    if (text.includes('NetworkError') || text.includes('timeout') || name === 'NetworkError') {
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
        (text.includes('Service') && text.includes('not found')) ||
        text.includes('none of the expected BLE services')
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
