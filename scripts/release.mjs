import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org/';

export function readNpmToken(path) {
    let token;
    try {
        token = parseEnv(readFileSync(path, 'utf8')).NPM_TOKEN;
    } catch {
        throw new Error('Cannot read NPM_TOKEN from .env');
    }
    if (!token || /\s/.test(token)) throw new Error('Set a valid NPM_TOKEN in the ignored .env file');
    return token;
}

export function validateArtifact(artifact, version) {
    if (artifact.name !== 'cycling-ble' || artifact.version !== version) {
        throw new Error('Packed package name or version does not match the release');
    }
    const paths = artifact.files.map((file) => file.path);
    const allowed = /^(dist\/|src\/|package\.json$|README\.md$|LICENSE$)/;
    if (
        paths.some(
            (path) =>
                !allowed.test(path) ||
                path.split('/').some((part) => part === '.npmrc' || part === '.env' || part.startsWith('.env.'))
        )
    ) {
        throw new Error('Package contains unexpected files or credential files');
    }
    for (const required of ['dist/index.js', 'dist/index.d.ts', 'src/connect.ts']) {
        if (!paths.includes(required)) throw new Error(`Package is missing ${required}`);
    }
    if (!/^sha512-/.test(artifact.integrity)) throw new Error('Package integrity is missing');
}

async function release(mode) {
    const token = readNpmToken(join(root, '.env'));
    const redact = (text) => text.replaceAll(token, '[REDACTED]');
    const run = (command, args, options = {}) => {
        if (!options.quiet) console.log(`> ${command} ${args.join(' ')}`);
        const result = spawnSync(command, args, {
            cwd: options.cwd ?? root,
            env: options.env ?? process.env,
            input: options.input,
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024,
            timeout: 120000,
        });
        if (!options.quiet || result.status !== 0) {
            if (result.stdout) process.stdout.write(redact(result.stdout));
            if (result.stderr) process.stderr.write(redact(result.stderr));
        }
        if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? 'could not start'})`);
        return result.stdout;
    };

    if (run('git', ['status', '--porcelain', '--untracked-files=no'], { quiet: true }).trim()) {
        throw new Error('Commit tracked changes before releasing');
    }
    if (run('git', ['ls-files', '--', '.env', '.env.*'], { quiet: true }).trim()) {
        throw new Error('Credential files must not be tracked in Git');
    }
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const versions = JSON.parse(
        run('npm', ['view', 'cycling-ble', 'versions', '--json', `--registry=${registry}`], { quiet: true })
    );
    if (versions.includes(version)) throw new Error(`cycling-ble@${version} is already published`);

    const directory = mkdtempSync(join(tmpdir(), 'cycling-ble-release-'));
    try {
        const source = join(directory, 'source');
        mkdirSync(source);
        const archive = execFileSync('git', ['archive', 'HEAD'], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
        run('tar', ['-xf', '-', '-C', source], { input: archive, quiet: true });
        symlinkSync(join(root, 'node_modules'), join(source, 'node_modules'), 'dir');

        // Check only committed source: local editor settings and credentials do
        // not belong in either the release checks or the published artifact.
        run('pnpm', ['run', 'check'], { cwd: source });
        const [artifact] = JSON.parse(
            run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
                cwd: source,
                quiet: true,
            })
        );
        validateArtifact(artifact, version);

        const npmrc = join(directory, 'npmrc');
        writeFileSync(npmrc, `registry=${registry}\n//registry.npmjs.org/:_authToken=\${CYCLING_BLE_NPM_TOKEN}\n`, {
            mode: 0o600,
        });
        const authEnvironment = {
            ...process.env,
            CYCLING_BLE_NPM_TOKEN: token,
            NPM_CONFIG_USERCONFIG: npmrc,
            NPM_CONFIG_CACHE: join(directory, 'npm-cache'),
        };
        const account = run('npm', ['whoami'], { cwd: source, env: authEnvironment, quiet: true }).trim();
        console.log(`Validated cycling-ble@${version}: ${artifact.files.length} files; npm account ${account}`);

        if (mode === '--dry-run') {
            console.log('Dry run passed. No package was published.');
            return;
        }
        // Publish the exact artifact checked above. Lifecycle checks already
        // ran in the clean export, and local publishing has no CI provenance.
        run(
            'npm',
            [
                'publish',
                join(directory, artifact.filename),
                '--access=public',
                '--tag=latest',
                '--ignore-scripts',
                '--provenance=false',
            ],
            {
                cwd: source,
                env: authEnvironment,
            }
        );
        let integrity;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                integrity = JSON.parse(
                    run(
                        'npm',
                        ['view', `cycling-ble@${version}`, 'dist.integrity', '--json', `--registry=${registry}`],
                        { quiet: true }
                    )
                );
                break;
            } catch {
                if (attempt < 4) await delay(2000);
            }
        }
        if (integrity !== artifact.integrity) {
            throw new Error('Publication completed, but registry integrity verification failed; do not republish');
        }
        console.log(`Published and verified cycling-ble@${version}.`);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--dry-run', '--publish'].includes(args[0])) {
        console.log(`Usage: node ${join(dirname(fileURLToPath(import.meta.url)), 'release.mjs')} --dry-run|--publish`);
        process.exitCode = args.length === 1 && args[0] === '--help' ? 0 : 1;
    } else {
        release(args[0]).catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
    }
}
