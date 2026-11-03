import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bumpManifest, nextVersion, releaseChangelog, releaseNotes } from './release-workflow.mjs';

const changelog = `# Changelog

Intro text.

## [Unreleased]

### Fixed

- A fix.

## [0.2.0] - 2026-10-27

### Added

- A feature.

[Unreleased]: https://github.com/colscoding/cycling-ble/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/colscoding/cycling-ble/compare/v0.1.4...v0.2.0
`;

test('versions bump by semver increment', () => {
    assert.equal(nextVersion('0.2.0', 'patch'), '0.2.1');
    assert.equal(nextVersion('0.2.9', 'minor'), '0.3.0');
    assert.equal(nextVersion('0.2.9', 'major'), '1.0.0');
    assert.equal(nextVersion('1.9.9', 'major'), '2.0.0');
    assert.throws(() => nextVersion('0.2.0', 'premajor'), /Unknown version bump/);
    assert.throws(() => nextVersion('1.0.0-beta.1', 'patch'), /plain major\.minor\.patch/);
});

test('the manifest keeps its key order and formatting when bumped', () => {
    const text = JSON.stringify({ name: 'cycling-ble', version: '0.2.0', type: 'module' }, null, 4) + '\n';
    const bumped = bumpManifest(text, 'minor');
    assert.equal(bumped.previous, '0.2.0');
    assert.equal(bumped.version, '0.3.0');
    assert.equal(bumped.text, text.replace('0.2.0', '0.3.0'));
});

test('the changelog moves unreleased changes under the new version and updates comparison links', () => {
    const released = releaseChangelog(changelog, '0.2.0', '0.2.1', '2026-11-03');
    assert.match(
        released,
        /## \[Unreleased\]\n\n## \[0\.2\.1\] - 2026-11-03\n\n### Fixed\n\n- A fix\.\n\n## \[0\.2\.0\]/
    );
    assert.match(
        released,
        /^\[Unreleased\]: https:\/\/github\.com\/colscoding\/cycling-ble\/compare\/v0\.2\.1\.\.\.HEAD\n\[0\.2\.1\]: https:\/\/github\.com\/colscoding\/cycling-ble\/compare\/v0\.2\.0\.\.\.v0\.2\.1\n\[0\.2\.0\]:/m
    );
    assert.equal(releaseNotes(released, '0.2.1'), '### Fixed\n\n- A fix.\n');
    assert.equal(releaseNotes(released, '0.2.0'), '### Added\n\n- A feature.\n');
});

test('the changelog refuses an empty, already released, or unlinked release', () => {
    const empty = changelog.replace('### Fixed\n\n- A fix.\n\n', '### Fixed\n\n');
    assert.throws(() => releaseChangelog(empty, '0.2.0', '0.2.1', '2026-11-03'), /Unreleased section .* is empty/);
    assert.throws(() => releaseChangelog(changelog, '0.1.4', '0.2.0', '2026-11-03'), /already has a section/);
    assert.throws(() => releaseChangelog(changelog, '0.1.9', '0.2.1', '2026-11-03'), /compare\/v0\.1\.9\.\.\.HEAD/);
    assert.throws(() => releaseChangelog('# Changelog\n', '0.2.0', '0.2.1', '2026-11-03'), /no "## \[Unreleased\]"/);
    assert.throws(() => releaseNotes(changelog, '0.9.0'), /no section for 0\.9\.0/);
});
