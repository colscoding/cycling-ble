/**
 * cycling-ble — connect to cycling sensors over Web Bluetooth.
 *
 * Read-only: this package subscribes to notifications and never writes to a
 * GATT characteristic, so it cannot control trainer resistance or ERG mode.
 */

export { connectPower, connectHeartRate, connectCadence } from './connect.js';

export { classifyBluetoothError } from './errors.js';
export type { BluetoothErrorInfo, BluetoothErrorKind, ClassifyOptions } from './errors.js';

export type {
    BluetoothAdapter,
    ConnectOptions,
    ConnectionStatus,
    Logger,
    ReadingListener,
    ReconnectOptions,
    SensorConnection,
    SensorReading,
    StatusListener,
} from './types.js';
