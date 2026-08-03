import {createHash} from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const dryRunIndex = args.indexOf('--dry-run');
const dryRun = dryRunIndex !== -1;
if (dryRun) args.splice(dryRunIndex, 1);

if (args.length !== 1) {
    console.error('Usage: npm run sync:minimaps -- <generated-minimaps-directory> [--dry-run]');
    process.exit(1);
}

const sourceRoot = resolve(args[0]);
const sourceGame = join(sourceRoot, 'game');
const sourceCoordinates = join(sourceRoot, 'coords.json');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = join(repositoryRoot, 'web', 'images', 'Maps');
const targetGame = join(targetRoot, 'game');
const targetCoordinates = join(targetRoot, 'coords.json');

for (const requiredPath of [sourceGame, sourceCoordinates]) {
    if (!existsSync(requiredPath)) {
        throw new Error(`Required generated input does not exist: ${requiredPath}`);
    }
}

const coordinatesDocument = JSON.parse(readFileSync(sourceCoordinates, 'utf8'));
const clusters = coordinatesDocument?.clusters;
if (!clusters || typeof clusters !== 'object' || Array.isArray(clusters)) {
    throw new Error(`${sourceCoordinates} does not contain a valid "clusters" object`);
}

const sourceFiles = readdirSync(sourceGame)
    .filter((name) => name.toLowerCase().endsWith('.webp'))
    .sort();

if (sourceFiles.length === 0) {
    throw new Error(`No .webp files found in ${sourceGame}`);
}

const sourceClusterNames = new Set(sourceFiles.map((name) => name.slice(0, -5)));
const coordinateClusterNames = Object.keys(clusters);
const missingCoordinates = [...sourceClusterNames].filter((name) => !clusters[name]);
const missingImages = coordinateClusterNames.filter((name) => !sourceClusterNames.has(name));

if (missingCoordinates.length || missingImages.length) {
    const details = [
        missingCoordinates.length
            ? `images without coordinates: ${missingCoordinates.slice(0, 10).join(', ')}`
            : null,
        missingImages.length
            ? `coordinates without images: ${missingImages.slice(0, 10).join(', ')}`
            : null,
    ].filter(Boolean).join('; ');
    throw new Error(`Generated minimap inputs do not match (${details})`);
}

for (const clusterName of coordinateClusterNames) {
    const geometry = clusters[clusterName]?.game_walk ?? clusters[clusterName]?.full;
    const size = geometry?.size;
    const zeroPixel = geometry?.zero_px;
    if (
        !Array.isArray(size) || size.length !== 2 ||
        !size.every((value) => Number.isFinite(value) && value > 0) ||
        !Array.isArray(zeroPixel) || zeroPixel.length !== 2 ||
        !zeroPixel.every(Number.isFinite)
    ) {
        throw new Error(`Invalid map geometry for cluster ${clusterName}`);
    }
}

function sha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesAreEqual(source, target) {
    if (!existsSync(target)) return false;
    if (statSync(source).size !== statSync(target).size) return false;
    return sha256(source) === sha256(target);
}

function synchronizeFile(source, target) {
    if (filesAreEqual(source, target)) return false;
    if (!dryRun) copyFileSync(source, target);
    return true;
}

if (!dryRun) {
    mkdirSync(targetGame, {recursive: true});
}

let copiedMaps = 0;
for (const fileName of sourceFiles) {
    if (synchronizeFile(join(sourceGame, fileName), join(targetGame, fileName))) {
        copiedMaps++;
    }
}

const copiedCoordinates = synchronizeFile(sourceCoordinates, targetCoordinates);
const unchangedMaps = sourceFiles.length - copiedMaps;
const prefix = dryRun ? 'Dry run complete' : 'Minimap sync complete';

console.log(`${prefix}: ${sourceFiles.length} maps validated`);
console.log(`Maps: ${copiedMaps} copied, ${unchangedMaps} unchanged`);
console.log(`coords.json: ${copiedCoordinates ? 'copied' : 'unchanged'}`);
console.log(`Target: ${targetRoot}`);
