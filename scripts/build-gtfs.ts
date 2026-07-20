import { loadGTFS } from '../src/server/gtfs/loader.js';

console.log('Starting pre-build of GTFS database...');
loadGTFS()
    .then(() => {
        console.log('GTFS Database successfully pre-built!');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Failed to build GTFS Database:', err);
        process.exit(1);
    });
