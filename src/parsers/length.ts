/** Check skipped fields as well as fields that are decoded with DataView reads. */
export function requireLength(value: DataView, minimum: number): void {
    if (value.byteLength < minimum) {
        throw new RangeError(`BLE packet requires ${minimum} bytes, received ${value.byteLength}`);
    }
}
