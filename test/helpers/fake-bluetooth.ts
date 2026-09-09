/**
 * A minimal fake of the Web Bluetooth objects the connect layer touches.
 *
 * Only the surface `connect.ts` actually uses is implemented, and the fakes
 * are cast to the DOM types at the boundary. Casting is confined to this file
 * so production code stays honestly typed.
 */

type Listener = (event: Event) => void;

export class FakeCharacteristic {
    public notificationsStarted = false;
    public notificationsStopped = false;
    public value: DataView | undefined;
    private listeners: Listener[] = [];

    constructor(public readonly uuid: string) {}

    async startNotifications(): Promise<FakeCharacteristic> {
        this.notificationsStarted = true;
        return this;
    }

    async stopNotifications(): Promise<FakeCharacteristic> {
        this.notificationsStopped = true;
        return this;
    }

    addEventListener(_type: string, listener: Listener): void {
        this.listeners.push(listener);
    }

    removeEventListener(_type: string, listener: Listener): void {
        this.listeners = this.listeners.filter((l) => l !== listener);
    }

    /** Deliver a notification exactly as the browser would. */
    emit(value: DataView): void {
        this.value = value;
        const event = { target: this } as unknown as Event;
        for (const listener of [...this.listeners]) listener(event);
    }

    get listenerCount(): number {
        return this.listeners.length;
    }
}

export class FakeService {
    constructor(
        public readonly uuid: string,
        private readonly characteristics: Map<string, FakeCharacteristic>
    ) {}

    async getCharacteristic(uuid: string): Promise<FakeCharacteristic> {
        const found = this.characteristics.get(uuid);
        if (!found) throw new Error(`Characteristic ${uuid} not found`);
        return found;
    }
}

export class FakeGattServer {
    public connected = false;
    public disconnectCalls = 0;

    constructor(private readonly services: Map<string, FakeService>) {}

    async connect(): Promise<FakeGattServer> {
        this.connected = true;
        return this;
    }

    disconnect(): void {
        this.connected = false;
        this.disconnectCalls++;
    }

    async getPrimaryService(uuid: string): Promise<FakeService> {
        const found = this.services.get(uuid);
        if (!found) throw new Error(`Service ${uuid} not found`);
        return found;
    }
}

export class FakeDevice {
    public readonly gatt: FakeGattServer;
    private listeners = new Map<string, Listener[]>();

    constructor(
        public readonly id: string,
        public readonly name: string | undefined,
        public readonly services: Map<string, FakeService>
    ) {
        this.gatt = new FakeGattServer(services);
    }

    addEventListener(type: string, listener: Listener): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    removeEventListener(type: string, listener: Listener): void {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(
            type,
            list.filter((l) => l !== listener)
        );
    }

    /** How many listeners are registered for an event type. */
    listenerCountFor(type: string): number {
        return (this.listeners.get(type) ?? []).length;
    }

    /** Simulate the browser firing gattserverdisconnected. */
    dropConnection(): void {
        this.gatt.connected = false;
        for (const listener of [...(this.listeners.get('gattserverdisconnected') ?? [])]) {
            listener({} as Event);
        }
    }
}

export interface FakeBluetoothSetup {
    /** service uuid -> characteristic uuid -> characteristic */
    services: Record<string, Record<string, FakeCharacteristic>>;
    deviceId?: string;
    deviceName?: string | undefined;
    /** Devices returned by getDevices(), for the previousDeviceId path. */
    permitted?: boolean;
    /** Make requestDevice reject, simulating a cancelled chooser. */
    rejectRequest?: Error;
}

export interface FakeBluetooth {
    bluetooth: Bluetooth;
    device: FakeDevice;
    requestDeviceCalls: { filters?: unknown; optionalServices?: unknown }[];
    characteristic(serviceUuid: string, characteristicUuid: string): FakeCharacteristic;
}

/** Build a fake `Bluetooth` plus the device it hands out. */
export function createFakeBluetooth(setup: FakeBluetoothSetup): FakeBluetooth {
    const serviceMap = new Map<string, FakeService>();
    for (const [serviceUuid, chars] of Object.entries(setup.services)) {
        const charMap = new Map<string, FakeCharacteristic>(Object.entries(chars));
        serviceMap.set(serviceUuid, new FakeService(serviceUuid, charMap));
    }

    const device = new FakeDevice(setup.deviceId ?? 'fake-device-1', setup.deviceName, serviceMap);
    const requestDeviceCalls: { filters?: unknown; optionalServices?: unknown }[] = [];

    const bluetooth = {
        async requestDevice(options: { filters?: unknown; optionalServices?: unknown }) {
            requestDeviceCalls.push(options);
            if (setup.rejectRequest) throw setup.rejectRequest;
            return device;
        },
        async getDevices() {
            return setup.permitted ? [device] : [];
        },
    } as unknown as Bluetooth;

    return {
        bluetooth,
        device,
        requestDeviceCalls,
        characteristic(serviceUuid: string, characteristicUuid: string): FakeCharacteristic {
            const service = setup.services[serviceUuid];
            if (!service) throw new Error(`test setup has no service ${serviceUuid}`);
            const char = service[characteristicUuid];
            if (!char) throw new Error(`test setup has no characteristic ${characteristicUuid}`);
            return char;
        },
    };
}

/** A Cycling Power Measurement payload carrying the given watts. */
export function powerPacket(watts: number): DataView {
    const v = new DataView(new ArrayBuffer(4));
    v.setInt16(2, watts, true);
    return v;
}

/** An FTMS Indoor Bike Data payload with instantaneous cadence and power. */
export function indoorBikePacket(rpm: number, watts: number): DataView {
    const v = new DataView(new ArrayBuffer(6));
    v.setUint16(0, (1 << 0) | (1 << 2) | (1 << 6), true);
    v.setUint16(2, rpm * 2, true);
    v.setInt16(4, watts, true);
    return v;
}

/** A CSC Measurement payload with crank revolution data only. */
export function cscPacket(revs: number, timeUnits: number): DataView {
    const v = new DataView(new ArrayBuffer(5));
    v.setUint8(0, 0x02);
    v.setUint16(1, revs, true);
    v.setUint16(3, timeUnits, true);
    return v;
}

/** A Heart Rate Measurement payload in uint8 format. */
export function heartRatePacket(bpm: number): DataView {
    const v = new DataView(new ArrayBuffer(2));
    v.setUint8(0, 0x00);
    v.setUint8(1, bpm);
    return v;
}
