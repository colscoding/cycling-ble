import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readNpmToken, validateArtifact } from './release.mjs';

const artifact = () => ({
    name: 'cycling-ble',
    version: '0.1.3',
    integrity: 'sha512-example',
    files: ['dist/index.js', 'dist/index.d.ts', 'src/connect.ts', 'README.md', 'LICENSE', 'package.json'].map(
        (path) => ({ path })
    ),
});

test('release accepts the complete built package and refuses missing or mismatched artifacts', () => {
    assert.doesNotThrow(() => validateArtifact(artifact(), '0.1.3'));
    assert.throws(() => validateArtifact(artifact(), '0.1.4'), /version/);
    assert.throws(() => validateArtifact({ ...artifact(), files: [] }, '0.1.3'), /missing/);
    assert.throws(() => validateArtifact({ ...artifact(), integrity: '' }, '0.1.3'), /integrity/);
});

test('release refuses credentials and unexpected files in the npm tarball', () => {
    for (const path of ['.env', '.npmrc', 'src/.env.local', 'dist/.npmrc', 'scripts/release.mjs']) {
        const unsafe = artifact();
        unsafe.files.push({ path });
        assert.throws(() => validateArtifact(unsafe, '0.1.3'), /unexpected files or credential files/);
    }
});

test('dotenv tokens are parsed as data and invalid input never appears in errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cycling-ble-release-test-'));
    const path = join(directory, '.env');
    try {
        writeFileSync(path, 'export NPM_TOKEN="npm_example$(do_not_execute)"\n');
        assert.equal(readNpmToken(path), 'npm_example$(do_not_execute)');
        writeFileSync(path, 'NPM_TOKEN="secret with spaces"\n');
        assert.throws(
            () => readNpmToken(path),
            (error) => {
                assert.doesNotMatch(error.message, /secret with spaces/);
                return /valid NPM_TOKEN/.test(error.message);
            }
        );
        writeFileSync(path, 'UNRELATED=value\n');
        assert.throws(() => readNpmToken(path), /valid NPM_TOKEN/);
        assert.throws(() => readNpmToken(join(directory, 'missing')), /Cannot read NPM_TOKEN/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
