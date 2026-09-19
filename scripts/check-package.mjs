import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('packed package supports isolated imports, declarations, and source navigation', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'cycling-ble-consumer-'));
    const run = (command, args, cwd = consumer) =>
        execFileSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    try {
        const [packed] = JSON.parse(
            run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', consumer], root)
        );
        writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
        run('npm', [
            'install',
            join(consumer, packed.filename),
            '--offline',
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--package-lock=false',
        ]);
        const installed = join(consumer, 'node_modules', 'cycling-ble');
        const maps = packed.files.filter(({ path }) => path.endsWith('.map'));
        assert.ok(maps.some(({ path }) => path.endsWith('.js.map')));
        assert.ok(maps.some(({ path }) => path.endsWith('.d.ts.map')));
        for (const { path } of maps) {
            const mapPath = join(installed, path);
            const map = JSON.parse(readFileSync(mapPath, 'utf8'));
            for (const [index, source] of map.sources.entries()) {
                const sourcePath = resolve(dirname(mapPath), map.sourceRoot || '', source);
                assert.ok(
                    typeof map.sourcesContent?.[index] === 'string' || existsSync(sourcePath),
                    `${path} cannot resolve ${source}`
                );
            }
        }

        writeFileSync(
            join(consumer, 'smoke.mjs'),
            `
import assert from 'node:assert/strict';
import { connectPower, connectCadence, connectHeartRate, classifyBluetoothError } from 'cycling-ble';
import { parsePowerMeasurement, parseIndoorBikeData, parseHeartRateMeasurement, parseCadenceMeasurement, initialCadenceState } from 'cycling-ble/parsers';
import { createMockPowerSensor, createMockHeartRateSensor, createMockCadenceSensor } from 'cycling-ble/mock';
for (const connect of [connectPower, connectCadence, connectHeartRate]) assert.equal(typeof connect, 'function');
assert.equal(classifyBluetoothError(new Error('GATT operation failed')).kind, 'connection-failed');
const view = bytes => new DataView(Uint8Array.from(bytes).buffer);
assert.equal(parsePowerMeasurement(view([0, 0, 250, 0])), 250);
assert.equal(parseHeartRateMeasurement(view([0, 72])), 72);
assert.deepEqual(parseIndoorBikeData(view([0x45, 0, 180, 0, 250, 0])), { powerW: 250, cadenceRpm: 90 });
assert.equal(parseCadenceMeasurement(view([2, 0, 0, 0, 0]), initialCadenceState).rpm, null);
for (const create of [createMockPowerSensor, createMockHeartRateSensor, createMockCadenceSensor]) {
    const sensor = create({ autoStart: false });
    const readings = [];
    sensor.addListener(reading => readings.push(reading));
    sensor.emit({ power: 250 });
    assert.equal(readings.length, 1);
    sensor.disconnect();
}
`
        );
        run(process.execPath, ['smoke.mjs']);

        writeFileSync(
            join(consumer, 'consumer.ts'),
            `
import { connectPower, type BluetoothAdapter, type SensorConnection } from 'cycling-ble';
import { parseIndoorBikeData, parseCadenceMeasurement, initialCadenceState } from 'cycling-ble/parsers';
import { createMockPowerSensor, type MockSensorConnection } from 'cycling-ble/mock';
const bluetooth: BluetoothAdapter = { requestDevice: async () => ({}) };
const connection: Promise<SensorConnection> = connectPower({ bluetooth });
const mock: MockSensorConnection = createMockPowerSensor({ autoStart: false });
mock.emit({ power: 250 });
void connection;
void parseIndoorBikeData;
void parseCadenceMeasurement;
void initialCadenceState;
`
        );
        writeFileSync(
            join(consumer, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    lib: ['ES2022', 'DOM'],
                    strict: true,
                    exactOptionalPropertyTypes: true,
                    noEmit: true,
                    skipLibCheck: false,
                    types: [],
                },
                files: ['consumer.ts'],
            })
        );
        // Use the repository compiler, but resolve consumer imports and ambient
        // types entirely inside the isolated project.
        run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')]);
    } finally {
        rmSync(consumer, { recursive: true, force: true });
    }
});
