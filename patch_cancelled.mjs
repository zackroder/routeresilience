import { readFileSync, writeFileSync } from 'fs';

const file = 'src/client/main.ts';
let content = readFileSync(file, 'utf8');

// Find the range to replace: from "async function loadCancelledTrips()" 
// to end of the window.restoreTrip block
const startMarker = 'async function loadCancelledTrips()';
const endMarker = `    }, 'Restore Trip');\r\n};\r\n`;

const startIdx = content.indexOf(startMarker);
const endIdx = content.indexOf(endMarker) + endMarker.length;

if (startIdx === -1 || endIdx < endMarker.length) {
    console.error('Markers not found!', { startIdx, endIdx });
    process.exit(1);
}

console.log(`Replacing bytes ${startIdx}–${endIdx}`);

const newCode = `// ─── Cancelled View State ───
let selectedCancelledIds = new Set<string>();

async function loadCancelledTrips() {
    selectedCancelledIds.clear();
    try {
        const cancellations = await api.getCancellations();
        const container = document.getElementById('cancelled-trips-list');
        if (!container) return;

        const items = cancellations as any[];

        // Update widget count
        const widgetCount = document.getElementById('count-cancelled');
        if (widgetCount) widgetCount.textContent = String(items.length);

        renderHomeCancelledSummary(items.length);

        if (items.length === 0) {
            container.innerHTML = '<div class="empty-state">No cancelled trips</div>';
            renderCancelledActionBar();
            return;
        }

        renderCancelledList(items);
        renderCancelledActionBar();
    } catch (err) {
        console.error('Failed to load cancellations:', err);
    }
}

function renderCancelledList(items: any[]) {
    const container = document.getElementById('cancelled-trips-list');
    if (!container) return;

    const formatTime = (secs: number) => {
        const h = Math.floor(secs / 3600) % 24;
        const m = Math.floor((secs % 3600) / 60);
        return \`\${h}:\${String(m).padStart(2, '0')}\`;
    };

    container.innerHTML = items.map((t: any) => {
        const isChecked = selectedCancelledIds.has(t.trip_id);
        const routeColor = t.route_color ? \`#\${t.route_color}\` : 'var(--accent-blue)';
        const routeTextColor = t.route_text_color ? \`#\${t.route_text_color}\` : '#fff';
        const startStr = t.start_time != null ? formatTime(t.start_time) : '—';
        const endStr   = t.end_time   != null ? formatTime(t.end_time)   : '—';
        const first    = t.first_stop_name || '—';
        const last     = t.last_stop_name  || '—';

        return \`
        <div class="cancelled-trip-card\${isChecked ? ' card-selected' : ''}" data-trip-id="\${t.trip_id}">
            <div style="display:flex;align-items:flex-start;gap:10px">
                <input type="checkbox" class="cancel-check" data-trip-id="\${t.trip_id}"
                    style="margin-top:3px;flex-shrink:0;cursor:pointer;accent-color:var(--accent-blue)"
                    \${isChecked ? 'checked' : ''}>
                <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:0">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                        <span style="font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;background:\${routeColor};color:\${routeTextColor};white-space:nowrap">
                            \${t.route_short_name || t.route_id}
                        </span>
                        <span style="font-size:10px;color:var(--text-muted)">\${startStr} – \${endStr}</span>
                    </div>
                    <div style="display:flex;align-items:stretch;gap:6px">
                        <div style="display:flex;flex-direction:column;align-items:center;padding:2px 0;flex-shrink:0">
                            <div style="width:7px;height:7px;border-radius:50%;background:var(--text-secondary);flex-shrink:0"></div>
                            <div style="width:1px;flex:1;min-height:5px;background:var(--border)"></div>
                            <div style="width:7px;height:7px;border-radius:50%;border:1.5px solid var(--text-muted);flex-shrink:0"></div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">
                            <span style="font-size:10px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="\${first}">\${first}</span>
                            <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="\${last}">\${last}</span>
                        </div>
                    </div>
                </div>
                <button class="btn btn-secondary btn-sm btn-restore-single" data-trip-id="\${t.trip_id}"
                    style="flex-shrink:0;align-self:center">Restore</button>
            </div>
        </div>\`;
    }).join('');

    container.querySelectorAll('.cancel-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const input = e.target as HTMLInputElement;
            const id = input.dataset.tripId!;
            if (input.checked) selectedCancelledIds.add(id);
            else selectedCancelledIds.delete(id);
            input.closest('.cancelled-trip-card')?.classList.toggle('card-selected', input.checked);
            renderCancelledActionBar();
        });
    });

    container.querySelectorAll('.btn-restore-single').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = (e.currentTarget as HTMLElement).dataset.tripId!;
            doRestoreTrips([id]);
        });
    });
}

function renderCancelledActionBar() {
    const slot = document.getElementById('cancelled-action-bar-slot');
    if (!slot) return;
    const count = selectedCancelledIds.size;
    if (count === 0) { slot.innerHTML = ''; return; }
    slot.innerHTML = \`
    <div class="block-action-bar">
        <span class="block-action-info">
            <strong>\${count}</strong> trip\${count !== 1 ? 's' : ''} selected
        </span>
        <div style="display:flex;gap:8px">
            <button class="btn btn-secondary btn-sm" id="btn-restore-selected">Restore \${count}</button>
            <button class="btn btn-outline btn-sm" id="btn-clear-cancelled-sel">Clear</button>
        </div>
    </div>\`;
    document.getElementById('btn-restore-selected')?.addEventListener('click', () => {
        doRestoreTrips(Array.from(selectedCancelledIds));
    });
    document.getElementById('btn-clear-cancelled-sel')?.addEventListener('click', () => {
        selectedCancelledIds.clear();
        loadCancelledTrips();
    });
}

function doRestoreTrips(ids: string[]) {
    const label = ids.length === 1 ? 'this trip' : \`\${ids.length} trips\`;
    showConfirm(\`Restore \${label}?\`, async () => {
        try {
            await Promise.all(ids.map(id => api.restoreTrip(id)));
            selectedCancelledIds.clear();
            await loadCancelledTrips();
            if (activeView === 'blocks') loadBlockView();
        } catch (err: any) { showError('Failed to restore: ' + err.message); }
    }, 'Restore Trip');
}
`;

content = content.slice(0, startIdx) + newCode + content.slice(endIdx);
writeFileSync(file, content, 'utf8');
console.log('Done. File written.');
