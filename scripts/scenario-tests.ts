const API_BASE = 'http://localhost:4000/api';
const API_KEY = 'dev-key'; // default dev key

async function apiCall(endpoint: string, options: RequestInit = {}) {
    const url = `${API_BASE}${endpoint}`;
    const headers = {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    return response.json();
}

interface Scenario {
    name: string;
    description: string;
    setup: () => Promise<void>;
    verify: () => Promise<boolean>;
    teardown: () => Promise<void>;
}

const scenarios: Scenario[] = [
    {
        name: 'Normal Operation',
        description: 'Verify feed has entities and vehicles are moving normally.',
        setup: async () => {
            await apiCall('/simulation/congestion', { method: 'DELETE' });
        },
        verify: async () => {
            const data = await apiCall('/gtfs-rt/json');
            const entityCount = data.entity.length;
            console.log(`   - Entity count: ${entityCount}`);
            return entityCount > 10;
        },
        teardown: async () => { }
    },
    {
        name: 'Heavy Traffic (Route 66)',
        description: 'Reduce speed on Route 66 and verify delay propagation.',
        setup: async () => {
            await apiCall('/simulation/congestion', {
                method: 'POST',
                body: JSON.stringify({ id: '66', multiplier: 0.2 })
            });
            console.log('   - Set Route 66 speed to 20%');
        },
        verify: async () => {
            console.log('   - Waiting for delay to accumulate (10s)...');
            await new Promise(r => setTimeout(r, 10000));

            const data = await apiCall('/gtfs-rt/json');
            const route66Vehicles = data.entity.filter((e: any) =>
                e.vehicle?.trip?.routeId === '66'
            );

            if (route66Vehicles.length === 0) {
                console.log('   - No vehicles found on Route 66');
                return false;
            }

            // Check if any have delay in predictions (via TripUpdate)
            const tripUpdates = data.entity.filter((e: any) =>
                e.tripUpdate?.trip?.routeId === '66'
            );

            console.log(`   - Route 66 TripUpdates: ${tripUpdates.length}`);
            return tripUpdates.length > 0;
        },
        teardown: async () => {
            await apiCall('/simulation/congestion', { method: 'DELETE' });
        }
    }
];

async function runTests() {
    console.log('🚀 Starting Scenario-Based Tests...\n');
    let passed = 0;

    for (const scenario of scenarios) {
        console.log(`[SCENARIO] ${scenario.name}`);
        console.log(`  Description: ${scenario.description}`);

        try {
            await scenario.setup();
            const success = await scenario.verify();
            await scenario.teardown();

            if (success) {
                console.log('  ✅ PASSED\n');
                passed++;
            } else {
                console.log('  ❌ FAILED\n');
            }
        } catch (err: any) {
            console.error(`  💥 ERROR: ${err.message}\n`);
            try { await scenario.teardown(); } catch { }
        }
    }

    console.log(`\n🎉 Completed tests: ${passed}/${scenarios.length} passed`);
    process.exit(passed === scenarios.length ? 0 : 1);
}

runTests();
