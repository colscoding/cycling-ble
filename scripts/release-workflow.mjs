// Steps of the GitHub release workflow (.github/workflows/release.yml) that are
// worth testing. Each command reads and writes files in the repository root.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArtifact, verifyPublication } from './release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bumps = ['patch', 'minor', 'major'];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function nextVersion(current, bump) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
    if (!match) throw new Error(`Cannot bump ${current}: only plain major.minor.patch versions are supported`);
    const [major, minor, patch] = match.slice(1).map(Number);
    if (bump === 'major') return `${major + 1}.0.0`;
    if (bump === 'minor') return `${major}.${minor + 1}.0`;
    if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
    throw new Error(`Unknown version bump "${bump}"; use ${bumps.join(', ')}`);
}

// Prettier formats package.json exactly as JSON.stringify does, so rewriting
// the parsed manifest changes only the version line.
export function bumpManifest(text, bump) {
    const manifest = JSON.parse(text);
    const version = nextVersion(manifest.version, bump);
    return { previous: manifest.version, version, text: JSON.stringify({ ...manifest, version }, null, 4) + '\n' };
}

// Content up to the next version heading or the comparison links at the end.
const sectionBody = (rest) => {
    const end = /^(## \[|\[[^\]]+\]: )/m.exec(rest);
    return end ? rest.slice(0, end.index) : rest;
};

export function releaseChangelog(changelog, previous, version, date) {
    const heading = /^## \[Unreleased\][ \t]*$/m.exec(changelog);
    if (!heading) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
    if (new RegExp(`^## \\[${escape(version)}\\]`, 'm').test(changelog)) {
        throw new Error(`CHANGELOG.md already has a section for ${version}`);
    }
    const bodyStart = heading.index + heading[0].length;
    const body = sectionBody(changelog.slice(bodyStart));
    if (!body.split('\n').some((line) => line.trim() && !line.startsWith('#'))) {
        throw new Error('The Unreleased section of CHANGELOG.md is empty; record the changes before releasing');
    }
    const unreleasedLink = `/compare/v${previous}...HEAD`;
    const link = new RegExp(`^\\[Unreleased\\]: (\\S+)${escape(unreleasedLink)}$`, 'm').exec(changelog);
    if (!link) throw new Error(`CHANGELOG.md has no [Unreleased] link ending in ${unreleasedLink}`);
    const base = link[1];
    const released = changelog.slice(0, bodyStart) + `\n\n## [${version}] - ${date}` + changelog.slice(bodyStart);
    return released.replace(
        link[0],
        () =>
            `[Unreleased]: ${base}/compare/v${version}...HEAD\n[${version}]: ${base}/compare/v${previous}...v${version}`
    );
}

export function releaseNotes(changelog, version) {
    const heading = new RegExp(`^## \\[${escape(version)}\\] - .*$`, 'm').exec(changelog);
    if (!heading) throw new Error(`CHANGELOG.md has no section for ${version}`);
    return sectionBody(changelog.slice(heading.index + heading[0].length)).trim() + '\n';
}

const read = (name) => readFileSync(join(root, name), 'utf8');
const packageVersion = () => JSON.parse(read('package.json')).version;

const commands = {
    // Writes the next version to package.json and CHANGELOG.md, and prints it.
    bump(bump) {
        const manifest = bumpManifest(read('package.json'), bump);
        const date = new Date().toISOString().slice(0, 10);
        const changelog = releaseChangelog(read('CHANGELOG.md'), manifest.previous, manifest.version, date);
        writeFileSync(join(root, 'package.json'), manifest.text);
        writeFileSync(join(root, 'CHANGELOG.md'), changelog);
        console.log(manifest.version);
    },
    // Prints the changelog section of the version in package.json.
    notes() {
        process.stdout.write(releaseNotes(read('CHANGELOG.md'), packageVersion()));
    },
    // Checks `npm pack --json` output against the release rules and prints the tarball name.
    validate(packJson) {
        const [artifact] = JSON.parse(readFileSync(packJson, 'utf8'));
        validateArtifact(artifact, packageVersion());
        console.log(artifact.filename);
    },
    // Waits until the registry serves the version in package.json with this tarball's integrity.
    async verify(tarball) {
        const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
        try {
            await verifyPublication(packageVersion(), integrity);
        } catch (error) {
            if (!/still processing/.test(error.message)) throw error;
            throw new Error(
                'npm accepted the release but it is still processing. Once npmjs.com lists the version, re-run the failed publish job; it does not publish again',
                { cause: error }
            );
        }
    },
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [command, argument, ...extra] = process.argv.slice(2);
    const expectsArgument = command !== 'notes';
    if (!Object.hasOwn(commands, command) || extra.length || expectsArgument !== (argument !== undefined)) {
        console.error(
            'Usage: node scripts/release-workflow.mjs bump <patch|minor|major> | notes | validate <pack.json> | verify <tarball>'
        );
        process.exitCode = 1;
    } else {
        Promise.resolve()
            .then(() => commands[command](argument))
            .catch((error) => {
                console.error(error.message);
                process.exitCode = 1;
            });
    }
}
