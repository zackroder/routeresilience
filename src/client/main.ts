import { api, RouteInfo, StopInfo, DetourData, VehicleData, BlockData, BlockTrip } from './services';

// ─── Declare Leaflet global from CDN ───
declare const L: any;

// ─── State ───
let map: any;
let selectedRoute: RouteInfo | null = null;
let selectedDirection = 0;
let allRoutes: RouteInfo[] = [];

// Map layers
// Map layers
let tileLayer: any = null;
let routeShapeLayer: any = null;
let stopsLayer: any = null;
let detourShapeLayer: any = null;
let replacementStopsLayer: any = null;
let vehiclesLayer: any = null;
let nearbyStopsLayer: any = null;
let activeDetoursLayer: any = null;
let candidateStopsLayer: any = null;

// Theme
let isLightTheme = true;

// Detour creation state
type DetourStep = 'idle' | 'select-diverge' | 'trace-path' | 'select-rejoin' | 'add-stops' | 'configure';
let detourStep: DetourStep = 'idle';
let divergeStopId: string | null = null;
let divergeStop: StopInfo | null = null;
let rejoinStopId: string | null = null;
let rejoinStop: StopInfo | null = null;
let detourPathPoints: [number, number][] = [];
let replacementStops: {
    stopId: string; stopName: string;
    lat: number; lon: number;
    isTemporary: boolean; travelTimeFromPrevious: number;
}[] = [];
let tempStopCounter = 0;
let pendingTempStopLatLng: [number, number] | null = null;

// Vehicle display
let showVehicles = false;
let vehicleUpdateTimer: ReturnType<typeof setInterval> | null = null;

// Route stops data
let currentRouteStops: StopInfo[] = [];

// Block View state
let activeView: 'map' | 'blocks' | 'cancelled' = 'map';
let blockViewDate = new Date().toISOString().slice(0, 10);
let cachedBlocks: BlockData[] = [];
let loadedBlockDate: string | null = null;

// Multi-select state for block viewer
let selectedTripIds = new Set<string>();
let lastClickedTripId: string | null = null;
let visibleTripOrder: string[] = []; // flat ordered list of trip IDs from last render (for shift-range)
// let pixelsPerHour = 100; // Zoom removed

// Detour expansion state
let expandedDetourIds = new Set<string>();


// ─── Modal Helpers ───

interface ModalOptions {
    title: string;
    message: string;
    type?: 'info' | 'danger' | 'warning';
    confirmText?: string;
    cancelText?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
}

function showModal(opts: ModalOptions) {
    const overlay = document.getElementById('system-modal');
    // Ensure overlay exists (in case index.html update failed or hasn't loaded)
    if (!overlay) {
        alert(opts.message); // Fallback
        if (opts.onConfirm) opts.onConfirm();
        return;
    }

    const card = overlay.querySelector('.modal-card');
    const title = document.getElementById('sys-modal-title');
    const body = document.getElementById('sys-modal-message');
    const actions = document.getElementById('sys-modal-actions');

    if (!card || !title || !body || !actions) return;

    // Reset classes
    card.className = 'modal-card';
    if (opts.type) card.classList.add(opts.type);

    // Content
    title.textContent = opts.title;
    body.innerHTML = opts.message.replace(/\n/g, '<br>');

    // Buttons
    actions.innerHTML = '';

    if (opts.onCancel || opts.cancelText) {
        const btnCancel = document.createElement('button');
        btnCancel.className = 'btn-modal-cancel';
        btnCancel.textContent = opts.cancelText || 'Cancel';
        btnCancel.onclick = () => {
            closeModal();
            if (opts.onCancel) opts.onCancel();
        };
        actions.appendChild(btnCancel);
    }

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'btn-modal-confirm';
    btnConfirm.textContent = opts.confirmText || 'OK';
    btnConfirm.onclick = () => {
        closeModal();
        if (opts.onConfirm) opts.onConfirm();
    };
    actions.appendChild(btnConfirm);

    overlay.style.display = 'flex';
}

function closeModal() {
    const overlay = document.getElementById('system-modal');
    if (overlay) overlay.style.display = 'none';
}

function showConfirm(message: string, onConfirm: () => void, title = 'Are you sure?', confirmText = 'Confirm', cancelText = 'Cancel') {
    showModal({
        title,
        message,
        type: 'warning',
        confirmText,
        cancelText,
        onConfirm,
        onCancel: () => { }
    });
}

function showAlert(message: string, title = 'Alert') {
    showModal({
        title,
        message,
        type: 'info',
        confirmText: 'OK'
    });
}

function showError(message: string) {
    showModal({
        title: 'Error',
        message,
        type: 'danger',
        confirmText: 'Close'
    });
}

// Global exposure
(window as any).showAlert = showAlert;
(window as any).showError = showError;
(window as any).showConfirm = showConfirm;


// ─── Initialize ───

async function init() {
    console.log('[TDM] Initializing...');
    try {
        initMap();
        console.log('[TDM] Map initialized');
        await loadRoutes();
        console.log('[TDM] Routes loaded');
        bindEvents();
        console.log('[TDM] Events bound');
        pollStatus();
        setInterval(pollStatus, 15000);
        await loadActiveDetours();
        console.log('[TDM] Ready!');
    } catch (err) {
        console.error('[TDM] Init failed:', err);
        // Show error visually
        const el = document.getElementById('route-list');
        if (el) el.innerHTML = `<p class="empty-state" style="color:#ef4444">Init error: ${err}</p>`;
    }
}

function initMap() {
    map = L.map('map', {
        center: [41.8781, -87.6298], // Chicago
        zoom: 12,
        minZoom: 10,
        maxZoom: 18,
        maxBounds: [
            [41.60, -88.10], // SW corner
            [42.10, -87.40], // NE corner
        ],
        zoomControl: true,
    });

    // Map tiles
    const tileUrl = isLightTheme
        ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

    tileLayer = L.tileLayer(tileUrl, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Initialize layer groups
    routeShapeLayer = L.layerGroup().addTo(map);
    stopsLayer = L.layerGroup().addTo(map);
    activeDetoursLayer = L.featureGroup().addTo(map); // FeatureGroup for getBounds()
    detourShapeLayer = L.layerGroup().addTo(map);
    candidateStopsLayer = L.layerGroup().addTo(map);
    replacementStopsLayer = L.layerGroup().addTo(map);
    vehiclesLayer = L.layerGroup().addTo(map);
    nearbyStopsLayer = L.layerGroup().addTo(map);

    // Map click handler for detour tracing
    map.on('click', onMapClick);
    // Right-click to undo last segment
    map.on('contextmenu', onMapRightClick);
}

// ─── Routes ───

async function loadRoutes() {
    try {
        allRoutes = await api.getRoutes();
        renderRouteList(allRoutes);
        updateStatusConnected();
    } catch (err) {
        console.error('Failed to load routes:', err);
        document.getElementById('route-list')!.innerHTML =
            '<p class="empty-state">Failed to connect to server. Is it running?</p>';
    }
}

function renderRouteList(routes: RouteInfo[]) {
    const container = document.getElementById('route-list')!;
    if (routes.length === 0) {
        container.innerHTML = '<p class="empty-state">No routes found</p>';
        return;
    }

    container.innerHTML = routes.map(r => `
    <div class="route-item-container">
        <div class="route-item" data-route-id="${r.route_id}" id="route-item-${r.route_id}">
          <div class="route-header" style="display:flex;align-items:center;width:100%">
              <span class="route-badge" style="background:#${r.route_color || '3b82f6'};color:#${r.route_text_color || 'ffffff'}">${r.route_short_name}</span>
              <span class="route-name" style="flex:1">${r.route_long_name}</span>
                <button class="btn-expand-route" data-route-id="${r.route_id}" style="background:none;border:none;cursor:pointer;padding:4px;color:var(--text-secondary)" title="View Patterns">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                </button>
            </div>
            ${renderRouteStatus(r.route_id)}
          </div>
        <div class="route-details" id="route-details-${r.route_id}" style="display:none;padding-left:12px;border-left:2px solid var(--border);margin-left:12px;margin-bottom:8px">
            <div class="loading-spinner" style="padding:8px 0;font-size:12px;color:var(--text-muted)">Loading patterns...</div>
        </div>
    </div>
  `).join('');

    // Click handlers
    container.querySelectorAll('.route-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.btn-expand-route')) return;
            const routeId = el.getAttribute('data-route-id')!;
            selectRoute(routeId);
        });
    });

    container.querySelectorAll('.btn-expand-route').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const routeId = btn.getAttribute('data-route-id')!;
            toggleRouteDetails(routeId);
        });
    });
}

function renderRouteStatus(routeId: string) {
    if (!cachedDetours) return '';
    const now = new Date();
    const detours = cachedDetours.filter(d => d.routeId === routeId);
    if (detours.length === 0) return '';

    const hasActive = detours.some(d => new Date(d.startTime) <= now && new Date(d.endTime) >= now);
    const hasScheduled = detours.some(d => new Date(d.startTime) > now);

    let html = '<div style="display:flex;gap:4px;margin-top:2px;font-size:10px">';
    if (hasActive) html += '<span style="background:var(--accent-red);color:white;padding:1px 4px;border-radius:4px">DETOUR</span>';
    if (hasScheduled) html += '<span style="background:var(--accent-green);color:black;padding:1px 4px;border-radius:4px">PLANNED</span>';
    html += '</div>';

    return html;
}

async function toggleRouteDetails(routeId: string) {
    const details = document.getElementById(`route-details-${routeId}`)!;
    const isVisible = details.style.display === 'block';

    if (isVisible) {
        details.style.display = 'none';
        return;
    }

    details.style.display = 'block';

    // Check if already loaded
    if (details.dataset.loaded === 'true') return;

    try {
        const route = allRoutes.find(r => r.route_id === routeId);
        const dir0Label = route?.directions?.[0] || 'Outbound';
        const dir1Label = route?.directions?.[1] || 'Inbound';

        const [shape0, shape1] = await Promise.all([
            api.getRouteShape(routeId, 0),
            api.getRouteShape(routeId, 1)
        ]);

        let html = '';
        const renderDir = (dirLabel: string, patterns: any[]) => {
            if (!patterns || patterns.length === 0) return '';
            let s = `<div style="font-size:11px;font-weight:700;margin-top:8px;margin-bottom:4px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">${dirLabel}</div>`;
            patterns.forEach(p => {
                s += `<div style="font-size:12px;margin-top:3px;display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle)">
                    <div style="display:flex;align-items:stretch;gap:6px;flex:1;min-width:0">
                        <div style="display:flex;flex-direction:column;align-items:center;padding:2px 0;flex-shrink:0">
                            <div style="width:7px;height:7px;border-radius:50%;background:var(--text-secondary);flex-shrink:0"></div>
                            <div style="width:1px;flex:1;min-height:5px;background:var(--border)"></div>
                            <div style="width:7px;height:7px;border-radius:50%;border:1.5px solid var(--text-muted);flex-shrink:0"></div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">
                            <span style="color:var(--text-secondary);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${p.firstStopName}">${p.firstStopName}</span>
                            <span style="color:var(--text-muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${p.lastStopName}">${p.lastStopName}</span>
                        </div>
                    </div>
                    <span style="color:var(--text-muted);font-size:11px;white-space:nowrap;flex-shrink:0">${p.tripCount} scheduled today</span>
                </div>`;


            });
            return s;
        };

        html += renderDir(dir0Label, shape0.patterns || []);
        html += renderDir(dir1Label, shape1.patterns || []);

        if (!html) html = '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No patterns found</div>';

        details.innerHTML = html;
        details.dataset.loaded = 'true';
    } catch (err) {
        console.error(err);
        details.innerHTML = '<div style="color:var(--accent-red);font-size:12px;padding:4px 0">Failed to load details</div>';
    }
}

async function selectRoute(routeId: string) {
    const route = allRoutes.find(r => r.route_id === routeId);
    if (!route) return;

    selectedRoute = route;

    // Highlight in list
    document.querySelectorAll('.route-item').forEach(el => el.classList.remove('selected'));
    document.getElementById(`route-item-${routeId}`)?.classList.add('selected');

    // Show direction toggle and update labels
    const dirGroup = document.getElementById('direction-group')!;
    dirGroup.style.display = 'block';

    // Update direction button labels using aggregated GTFS data
    // Update direction button labels using aggregated GTFS data
    const btn0 = document.getElementById('dir-btn-0'); // Fix ID: index.html says dir-btn-0
    const btn1 = document.getElementById('dir-btn-1'); // Fix ID: index.html says dir-btn-1
    console.log('[TDM] Route directions:', route.directions);
    if (btn0) btn0.textContent = route.directions?.[0] || 'Outbound';
    if (btn1) btn1.textContent = route.directions?.[1] || 'Inbound';

    // Show create detour button
    // Show create detour button logic - ensure correct button is shown
    const btnCreate = document.getElementById('btn-create-detour-panel');
    if (btnCreate) btnCreate.style.display = 'flex';

    // Load shape and stops for BOTH directions
    await loadRouteDisplay(null);
}

function clearAllMapLayers() {
    routeShapeLayer.clearLayers();
    stopsLayer.clearLayers();
    activeDetoursLayer.clearLayers();
    detourShapeLayer.clearLayers();
    replacementStopsLayer.clearLayers();
    candidateStopsLayer.clearLayers();
    nearbyStopsLayer.clearLayers();
    vehiclesLayer.clearLayers();
}

function deselectRoute() {
    selectedRoute = null;
    currentRouteStops = [];

    // Clear highlights in list
    document.querySelectorAll('.route-item').forEach(el => el.classList.remove('selected'));

    // Hide UI elements
    const dirGroup = document.getElementById('direction-group');
    if (dirGroup) dirGroup.style.display = 'none';

    const btnCreate = document.getElementById('btn-create-detour-panel');
    if (btnCreate) btnCreate.style.display = 'none';

    clearAllMapLayers();
}

async function loadRouteDisplay(direction: number | null = null, preserveView: boolean = false) {
    if (!selectedRoute) return;

    try {
        clearAllMapLayers();
        const bounds = L.latLngBounds([]);

        // If direction is null, load both (0 and 1)
        const dirs = direction !== null ? [direction] : [0, 1];

        for (const dir of dirs) {
            // Load Shape
            const shapeData = await api.getRouteShape(selectedRoute.route_id, dir);
            if (shapeData.points.length > 0) {
                const latLngs = shapeData.points.map(p => [p.lat, p.lon] as [number, number]);
                L.polyline(latLngs, {
                    color: `#${selectedRoute.route_color || '3b82f6'}`,
                    weight: 4,
                    opacity: 0.8,
                }).addTo(routeShapeLayer);
                latLngs.forEach(p => bounds.extend(p));
            }

            // Load Stops
            const stops = await api.getRouteStops(selectedRoute.route_id, dir);
            renderStopsOnMap(stops, false); // Append stops (we cleared at start)

            // If we are loading a specific direction (detour mode), update currentRouteStops for logic
            if (direction !== null) {
                currentRouteStops = stops;
            }
        }

        // Fit map
        if (!preserveView && bounds.isValid()) {
            map.fitBounds(bounds, { padding: [50, 50] });
        }

        // Render active detours (show all or filtr by direction?)
        // If viewing both, show all. If viewing one, show one.
        const allDetours = await api.getDetours();
        const activeDetours = allDetours.filter(d =>
            String(d.routeId) === String(selectedRoute!.route_id) &&
            (direction === null || d.directionId === direction) &&
            new Date(d.endTime) > new Date()
        );

        for (const d of activeDetours) {
            if (d.path && d.path.length > 0) {
                L.polyline(d.path, {
                    color: '#d97706', // amber-600
                    weight: 4,
                    opacity: 1,
                    dashArray: '10, 10'
                }).addTo(routeShapeLayer);
            }
        }


    } catch (err) {
        console.error('Failed to load route display:', err);
    }
}

function renderStopsOnMap(stops: StopInfo[], clear: boolean = true) {
    if (clear) stopsLayer.clearLayers();
    for (const stop of stops) {
        const marker = L.circleMarker([stop.stop_lat, stop.stop_lon], {
            radius: 5,
            fillColor: '#3b82f6',
            color: '#ffffff',
            weight: 1.5,
            fillOpacity: 0.9,
        });

        marker.bindTooltip(stop.stop_name, {
            className: 'stop-tooltip',
            direction: 'top',
            offset: [0, -8],
        });

        marker.on('click', (e: any) => {
            L.DomEvent.stopPropagation(e);
            onStopClick(stop);
        });
        marker.addTo(stopsLayer);
    }
}

// ─── Detour Creation ───

function startDetourCreation(initialDirection?: number, preserveView: boolean = false) {
    if (!selectedRoute) return;

    // Switch to creation view
    document.getElementById('sidebar-home')!.style.display = 'none';
    document.getElementById('sidebar-detours')!.style.display = 'none';
    document.getElementById('detour-panel')!.style.display = 'flex';

    // Initialize state
    detourStep = 'select-diverge'; // Start at step 1, but with direction toggle active above
    selectedDirection = initialDirection !== undefined ? initialDirection : 0; // Use provided dir or default 0
    divergeStop = null;
    rejoinStop = null;
    detourPathPoints = [];
    replacementStops = [];

    // Initialize UI for direction
    document.querySelectorAll('.direction-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.getAttribute('data-dir') || '-1') === selectedDirection);
    });

    // Load map for specific direction
    loadRouteDisplay(selectedDirection, preserveView);
    updateDetourStepUI();

    // Clear any previous detour display
    detourShapeLayer.clearLayers();
    replacementStopsLayer.clearLayers();
    nearbyStopsLayer.clearLayers();
}

// ─── Panels ───

function closeDetourPanel() {
    document.getElementById('detour-panel')!.style.display = 'none';
    showHomeView();
}

function cancelDetourCreation() {
    detourStep = 'idle';
    segmentBoundaries = [];
    document.getElementById('detour-panel')!.style.display = 'none';
    document.getElementById('affected-patterns-section')!.style.display = 'none';
    document.getElementById('create-opposite-dir')!.style.display = 'none';
    detourShapeLayer.clearLayers();
    replacementStopsLayer.clearLayers();
    nearbyStopsLayer.clearLayers();

    closeDetourPanel();
}

function onStopClick(stop: StopInfo) {
    if (detourStep === 'select-diverge') {
        divergeStopId = stop.stop_id;
        divergeStop = stop;

        // Highlight diverge stop
        L.circleMarker([stop.stop_lat, stop.stop_lon], {
            radius: 8,
            fillColor: '#ef4444',
            color: '#ffffff',
            weight: 2,
            fillOpacity: 1,
        }).bindTooltip('DIVERGE: ' + stop.stop_name, { permanent: true, direction: 'top' })
            .addTo(detourShapeLayer);

        detourStep = 'trace-path';
        detourPathPoints.push([stop.stop_lat, stop.stop_lon]);
        updateDetourStepUI();
        showMapTooltip([stop.stop_lat, stop.stop_lon], '✔ Diverge set! Now click the map to trace the detour path.', 3000);
    } else if (detourStep === 'select-rejoin') {
        finalizeRejoinStop(stop);
    } else if (detourStep === 'trace-path') {
        // In trace-path, clicking a route stop is ONLY for setting it as rejoin
        const divergeIdx = divergeStopId ? currentRouteStops.findIndex(s => s.stop_id === divergeStopId) : -1;
        const thisIdx = currentRouteStops.findIndex(s => s.stop_id === stop.stop_id);

        if ((divergeIdx !== -1 && thisIdx > divergeIdx) || (divergeStopId === null && thisIdx !== -1)) {
            // Check if this is a valid downstream stop
            showRejoinOptionsPopup(stop);
            return;
        }
        // Otherwise ignore or show tooltip
        showMapTooltip([stop.stop_lat, stop.stop_lon], 'Finish tracing or click a downstream stop to rejoin.', 2000);
    } else if (detourStep === 'add-stops') {
        // Add as replacement stop
        addReplacementStop(stop.stop_id, stop.stop_name, stop.stop_lat, stop.stop_lon, false);
    }
}

async function finalizeRejoinStop(stop: StopInfo) {
    rejoinStopId = stop.stop_id;
    rejoinStop = stop;

    // Snap detour line from last point to rejoin stop
    if (detourPathPoints.length > 0) {
        const lastPt = detourPathPoints[detourPathPoints.length - 1];
        const snapped = await snapToRoad(lastPt[0], lastPt[1], stop.stop_lat, stop.stop_lon);
        if (snapped.length > 1) {
            for (let i = 1; i < snapped.length; i++) detourPathPoints.push(snapped[i]);
        } else {
            detourPathPoints.push([stop.stop_lat, stop.stop_lon]);
        }
    }
    redrawDetourPath();

    // Highlight rejoin stop
    L.circleMarker([stop.stop_lat, stop.stop_lon], {
        radius: 8,
        fillColor: '#10b981',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 1,
    }).bindTooltip('REJOIN: ' + stop.stop_name, { permanent: true, direction: 'top' })
        .addTo(detourShapeLayer);

    detourStep = 'add-stops';
    updateDetourStepUI();
    showMapTooltip([stop.stop_lat, stop.stop_lon], '✔ Rejoin set! Now add replacement stops if needed.', 3000);
}

async function onMapClick(e: any) {
    if (detourStep === 'add-stops') {
        showTempStopPopup(e.latlng.lat, e.latlng.lng);
    } else if (detourStep === 'trace-path') {
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        // Check if click is near existing detour path (within 50m)
        const nearPath = detourPathPoints.length >= 2 && distanceToPolyline(lat, lng) < 50;

        if (!nearPath) {
            // Far from path: extend the detour polyline via OSRM snap
            if (detourPathPoints.length > 0) {
                const prev = detourPathPoints[detourPathPoints.length - 1];
                const snappedSegment = await snapToRoad(prev[0], prev[1], lat, lng);
                if (snappedSegment.length > 0) {
                    for (let i = 1; i < snappedSegment.length; i++) {
                        detourPathPoints.push(snappedSegment[i]);
                    }
                } else {
                    detourPathPoints.push([lat, lng]);
                }
            } else {
                detourPathPoints.push([lat, lng]);
            }
            redrawDetourPath();
        }

    } else if (detourStep === 'idle' && selectedRoute) {
        // Deselect if clicking map in idle state with a route selected
        deselectRoute();
    }
}

/**
 * Show a popup at a route stop offering "Auto-route" or "Keep current path"
 * so the user controls how the detour reaches the rejoin stop.
 */
function showRejoinOptionsPopup(stop: StopInfo) {
    const popup = L.popup({
        closeButton: true,
        className: 'rejoin-options-popup',
        maxWidth: 240,
        autoPan: true,
        offset: [0, -5],
    })
        .setLatLng([stop.stop_lat, stop.stop_lon])
        .setContent(`
            <div class="rejoin-options">
                <div class="rejoin-title">Set <strong>${stop.stop_name}</strong> as rejoin?</div>
                <div class="rejoin-btns">
                    <button class="rejoin-btn rejoin-btn-auto" id="rejoin-auto">🛣️ Snap via streets</button>
                    <button class="rejoin-btn rejoin-btn-direct" id="rejoin-direct">📏 Connect directly</button>
                </div>
            </div>
        `)
        .openOn(map);

    setTimeout(() => {
        document.getElementById('rejoin-auto')?.addEventListener('click', () => {
            map.closePopup(popup);
            finalizeRejoinStop(stop);
        });
        document.getElementById('rejoin-direct')?.addEventListener('click', () => {
            map.closePopup(popup);
            finalizeRejoinStopKeepPath(stop);
        });
    }, 50);
}

/**
 * Set the rejoin stop WITHOUT adding any OSRM routing — keep the path as-is.
 */
function finalizeRejoinStopKeepPath(stop: StopInfo) {
    rejoinStopId = stop.stop_id;
    rejoinStop = stop;

    // Highlight rejoin stop
    L.circleMarker([stop.stop_lat, stop.stop_lon], {
        radius: 8,
        fillColor: '#10b981',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 1,
    }).bindTooltip('REJOIN: ' + stop.stop_name, { permanent: true, direction: 'top' })
        .addTo(detourShapeLayer);

    detourStep = 'add-stops';
    updateDetourStepUI();
    showMapTooltip([stop.stop_lat, stop.stop_lon], '✔ Rejoin set! Now add replacement stops if needed.', 3000);
}

function onMapRightClick(e: any) {
    e.originalEvent.preventDefault();
    undoLastSegment();
}

/**
 * Undo the last drawn segment (remove points back to the previous click).
 * Each click adds a snapped segment (multiple points), so we undo by removing
 * back to the previous segment boundary, tracked via segmentBoundaries.
 */
function undoLastSegment() {
    if (detourStep !== 'trace-path' || detourPathPoints.length <= 1) return;

    // Remove the last segment: go back to just the diverge point if only one segment,
    // otherwise remove about 80% of points added in the last click (rough heuristic)
    // Keep at least the first point (diverge stop)
    if (segmentBoundaries.length > 0) {
        const restoreTo = segmentBoundaries.pop()!;
        detourPathPoints.length = restoreTo;
    } else {
        // Fallback: just remove last point
        detourPathPoints.pop();
    }
    redrawDetourPath();
}

// Track segment boundaries for undo
let segmentBoundaries: number[] = [];

/**
 * Snap a line segment to the road network using OSRM's public demo API.
 * Falls back to a straight line if the API is unavailable.
 */
async function snapToRoad(lat1: number, lon1: number, lat2: number, lon2: number): Promise<[number, number][]> {
    // Record the boundary before adding new points (for undo)
    segmentBoundaries.push(detourPathPoints.length);

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`;
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return [];
        const data = await res.json();
        if (data.routes && data.routes.length > 0) {
            const coords = data.routes[0].geometry.coordinates;
            return coords.map((c: number[]) => [c[1], c[0]] as [number, number]);
        }
    } catch {
        // OSRM unavailable — fall back to straight line
        console.warn('[TDM] Road snapping unavailable, using straight line');
    }
    return [];
}

function addReplacementStop(stopId: string, name: string, lat: number, lon: number, isTemporary: boolean) {
    // Toggle: if stop already exists, remove it instead of adding a duplicate
    const existingIdx = replacementStops.findIndex(s => s.stopId === stopId);
    if (existingIdx !== -1) {
        replacementStops.splice(existingIdx, 1);
        rebuildReplacementStopMarkers();
        renderReplacementStopsList();
        return;
    }

    // Estimate travel time from previous point
    let travelTime = 60; // default 60s
    if (detourPathPoints.length > 0) {
        const prev = detourPathPoints[detourPathPoints.length - 1];
        const dist = haversine(prev[0], prev[1], lat, lon);
        travelTime = Math.round(dist / 8.9); // speed / 8.9 m/s (~20 mph)
    }

    replacementStops.push({
        stopId,
        stopName: name,
        lat, lon,
        isTemporary,
        travelTimeFromPrevious: travelTime,
    });

    // Add marker
    const marker = L.circleMarker([lat, lon], {
        radius: 7,
        fillColor: isTemporary ? '#f59e0b' : '#3b82f6',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 1,
    }).bindTooltip(name + (isTemporary ? ' (temp)' : ''), { direction: 'top' });

    marker.on('click', (e: any) => {
        L.DomEvent.stopPropagation(e);
        addReplacementStop(stopId, name, lat, lon, isTemporary);
    });

    marker.addTo(replacementStopsLayer);

    renderReplacementStopsList();
}

/**
 * Show a non-blocking Leaflet popup for creating a temporary stop.
 */
function showTempStopPopup(lat: number, lng: number) {
    const popup = L.popup({
        closeButton: true,
        className: 'temp-stop-popup',
        maxWidth: 240,
    })
        .setLatLng([lat, lng])
        .setContent(`
        <div class="temp-stop-form">
            <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-primary)">Create Temporary Stop</div>
            <input type="text" id="temp-stop-name-input" placeholder="Stop name"
                   style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);font-family:var(--font-family);font-size:12px;margin-bottom:6px;box-sizing:border-box" />
            <div style="display:flex;gap:4px">
                <button id="temp-stop-confirm-btn" class="btn btn-primary btn-sm" style="flex:1">Add Stop</button>
                <button id="temp-stop-cancel-btn" class="btn btn-secondary btn-sm" style="flex:1">Cancel</button>
            </div>
        </div>
    `)
        .openOn(map);

    setTimeout(() => {
        const nameInput = document.getElementById('temp-stop-name-input') as HTMLInputElement;
        const confirmBtn = document.getElementById('temp-stop-confirm-btn');
        const cancelBtn = document.getElementById('temp-stop-cancel-btn');

        if (nameInput) nameInput.focus();

        confirmBtn?.addEventListener('click', () => {
            const name = nameInput?.value.trim() || `Temp Stop ${++tempStopCounter}`;
            const stopId = `temp_${Date.now()}`;
            addReplacementStop(stopId, name, lat, lng, true);
            map.closePopup(popup);
        });

        cancelBtn?.addEventListener('click', () => {
            map.closePopup(popup);
        });

        nameInput?.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') confirmBtn?.click();
        });
    }, 50);
}

function rebuildReplacementStopMarkers() {
    replacementStopsLayer.clearLayers();
    for (const s of replacementStops) {
        const marker = L.circleMarker([s.lat, s.lon], {
            radius: 7,
            fillColor: s.isTemporary ? '#f59e0b' : '#3b82f6',
            color: '#ffffff',
            weight: 2,
            fillOpacity: 1,
        }).bindTooltip(s.stopName + (s.isTemporary ? ' (temp)' : ''), { direction: 'top' });

        marker.on('click', (e: any) => {
            L.DomEvent.stopPropagation(e);
            addReplacementStop(s.stopId, s.stopName, s.lat, s.lon, s.isTemporary);
        });

        marker.addTo(replacementStopsLayer);
    }
}

function renderReplacementStopsList() {
    const container = document.getElementById('replacement-stops-list')!;
    document.getElementById('replacement-stops-section')!.style.display = 'block';

    container.innerHTML = replacementStops.map((rs, i) => `
    <div class="replacement-stop-item">
      <span class="stop-icon ${rs.isTemporary ? '' : 'existing'}"></span>
      <span class="stop-name">${rs.stopName}</span>
      <button class="stop-remove" data-index="${i}" title="Remove">✕</button>
    </div>
  `).join('');

    container.querySelectorAll('.stop-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt((e.target as HTMLElement).getAttribute('data-index')!);
            replacementStops.splice(idx, 1);
            renderReplacementStopsList();
        });
    });
}

function redrawDetourPath() {
    // Remove existing detour line (if any) but keep markers
    detourShapeLayer.eachLayer((layer: any) => {
        if (layer instanceof L.Polyline && !(layer instanceof L.CircleMarker)) {
            detourShapeLayer.removeLayer(layer);
        }
    });

    if (detourPathPoints.length > 1) {
        L.polyline(detourPathPoints, {
            color: '#ef4444',
            weight: 4,
            opacity: 0.8,
            dashArray: '8, 8',
        }).addTo(detourShapeLayer);
    }
}

function updateDetourStepUI() {
    const steps: DetourStep[] = ['select-diverge', 'trace-path', 'select-rejoin', 'add-stops', 'configure'];
    const currentIdx = steps.indexOf(detourStep);

    for (let i = 0; i < 5; i++) {
        const indicator = document.getElementById(`step-${i + 1}-indicator`);
        if (!indicator) continue;
        indicator.classList.remove('active', 'completed');
        if (i < currentIdx) indicator.classList.add('completed');
        if (i === currentIdx) indicator.classList.add('active');
    }

    const instructions = document.getElementById('step-instructions')!;
    const replacement = document.getElementById('replacement-stops-section')!;
    const backBtn = document.getElementById('btn-back-header')!;

    // Re-enable activate button (in case it was disabled)
    const activateBtn = document.getElementById('activate-detour') as HTMLButtonElement;
    if (activateBtn) { activateBtn.disabled = false; activateBtn.textContent = 'Activate Detour'; }

    // Header Back Button Logic
    backBtn.style.display = (detourStep === 'idle' || detourStep === 'select-diverge') ? 'none' : 'block';

    // Lock direction toggle during active detour creation
    const dirBtns = document.querySelectorAll('.direction-toggle button');
    dirBtns.forEach(btn => {
        if (detourStep !== 'idle' && detourStep !== 'select-diverge') btn.classList.add('disabled');
        else btn.classList.remove('disabled');
    });



    // Determine back target
    let backTarget: DetourStep | null = null;
    if (detourStep === 'trace-path') backTarget = 'select-diverge';
    else if (detourStep === 'select-rejoin') backTarget = 'trace-path';
    else if (detourStep === 'add-stops') backTarget = 'select-rejoin';
    else if (detourStep === 'configure') backTarget = 'add-stops';

    // Clone and replace to remove old listeners
    const newBackBtn = backBtn.cloneNode(true);
    backBtn.parentNode!.replaceChild(newBackBtn, backBtn);
    if (backTarget) {
        newBackBtn.addEventListener('click', () => goBackStep(backTarget!));
    }

    switch (detourStep) {
        case 'select-diverge':
            instructions.innerHTML = 'Click on a stop where the detour <strong>begins</strong> (diverge point).';
            instructions.innerHTML += '<br><br><button class="btn btn-secondary btn-sm" id="btn-skip-diverge" style="width:100%">Detour Route Start</button>';
            document.getElementById('detour-config')!.style.display = 'none';
            replacement.style.display = 'none';
            candidateStopsLayer.clearLayers();

            document.getElementById('btn-skip-diverge')?.addEventListener('click', () => {
                divergeStopId = null;
                divergeStop = null;
                detourStep = 'trace-path';
                detourPathPoints = [];
                updateDetourStepUI();
                showMapTooltip([map.getCenter().lat, map.getCenter().lng], 'Route start replaced. Click the map to trace the path.', 3000);
            });
            break;
        case 'trace-path':
            instructions.innerHTML = 'Click the map to trace the detour path <em>(snaps to roads)</em>. Click a <strong>route stop</strong> to set the rejoin point, or right-click to undo.';
            instructions.innerHTML += '<br><br><div style="display:flex;gap:6px;flex-wrap:wrap">' +
                '<button class="btn btn-secondary btn-sm" id="btn-back-to-diverge">← Back</button>' +
                '<button class="btn btn-secondary btn-sm" id="btn-skip-rejoin">Detour Route End</button>' +
                '<button class="btn btn-secondary btn-sm" id="btn-undo-segment">↩ Undo</button></div>';
            document.getElementById('btn-back-to-diverge')?.addEventListener('click', () => goBackStep('select-diverge'));
            document.getElementById('btn-undo-segment')?.addEventListener('click', undoLastSegment);
            document.getElementById('btn-skip-rejoin')?.addEventListener('click', () => {
                rejoinStopId = null;
                rejoinStop = null;
                detourStep = 'add-stops';
                updateDetourStepUI();
                showMapTooltip([map.getCenter().lat, map.getCenter().lng], 'Route end replaced. Now add replacement stops if needed.', 3000);
            });
            replacement.style.display = 'block';
            candidateStopsLayer.clearLayers();
            break;
        case 'select-rejoin':
            // Logic integrated into click handlers of step 2, but just in case
            instructions.innerHTML = 'Review the rejoin stop.';
            replacement.style.display = 'block';
            break;
        case 'add-stops':
            instructions.innerHTML = 'Add stops along the detour. Click <strong style="color:#f59e0b">orange candidates</strong> to add, or click empty map for temp stops.';
            document.getElementById('detour-config')!.style.display = 'none';
            replacement.style.display = 'block';
            findCandidateStops();
            instructions.innerHTML += '<br><br><button class="btn btn-primary btn-sm" id="btn-proceed-config">Done Adding Stops →</button>';
            document.getElementById('btn-proceed-config')?.addEventListener('click', () => {
                detourStep = 'configure';
                updateDetourStepUI();
            });
            break;
        case 'configure':
            instructions.innerHTML = 'Review details, set times, and activate.' +
                '<br><br><button class="btn btn-secondary btn-sm" id="btn-back-to-stops">← Back to stops</button>';
            document.getElementById('btn-back-to-stops')?.addEventListener('click', () => goBackStep('add-stops'));
            document.getElementById('detour-config')!.style.display = 'block';
            replacement.style.display = 'block';
            candidateStopsLayer.clearLayers();

            // Set default times if empty
            const now = new Date();
            const later = new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4 hours
            const startInput = document.getElementById('detour-start') as HTMLInputElement;
            const endInput = document.getElementById('detour-end') as HTMLInputElement;
            if (!startInput.value) startInput.value = toLocalISO(now);
            if (!endInput.value) endInput.value = toLocalISO(later);

            // Auto update button text based on time
            const updateBtnText = () => {
                const s = new Date(startInput.value).getTime();
                const n = new Date().getTime();
                const btn = document.getElementById('activate-detour');
                if (btn) {
                    if (s > n + 60000) { // Future > 1 min
                        btn.innerHTML = '📅 Schedule Detour';
                        btn.classList.remove('btn-danger'); // Assuming activate is danger from common usage or style
                        btn.classList.add('btn-primary');
                    } else {
                        btn.innerHTML = '⚡ Activate Detour';
                        btn.classList.remove('btn-primary');
                        btn.classList.add('btn-danger'); // Assuming danger for immediate action? Or just primary
                        // Actually style.css defines .btn-primary as green/blue. I'll stick to primary vs maybe accent?
                        // Let's just use text for now.
                    }
                }
            };
            startInput.addEventListener('change', updateBtnText);
            updateBtnText(); // Initial call

            showAffectedPatterns();
            break;
    }
}

async function findCandidateStops() {
    candidateStopsLayer.clearLayers();
    if (detourPathPoints.length < 2) return;

    // Bounds
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const [lat, lon] of detourPathPoints) {
        minLat = Math.min(minLat, lat); minLon = Math.min(minLon, lon);
        maxLat = Math.max(maxLat, lat); maxLon = Math.max(maxLat, lon);
    }
    const pad = 0.005; // ~500m buffer for query

    try {
        const stops = await api.getStopsInBounds(minLat - pad, minLon - pad, maxLat + pad, maxLon + pad);

        for (const stop of stops) {
            // Filter 1: Must be effectively close to the line (buffer 50m)
            const dist = distanceToPolyline(stop.stop_lat, stop.stop_lon);
            if (dist > 50) continue;

            // Filter 2: Skip stops already in replacement list
            if (replacementStops.some(s => s.stopId === stop.stop_id)) continue;

            // Filter 3: Skip diverge/rejoin stops
            if (stop.stop_id === divergeStopId || stop.stop_id === rejoinStopId) continue;

            // Render
            const marker = L.circleMarker([stop.stop_lat, stop.stop_lon], {
                radius: 6,
                fillColor: '#f59e0b',
                color: '#ffffff',
                weight: 1.5,
                fillOpacity: 0.9,
                className: 'candidate-stop-marker'
            });
            marker.bindTooltip(`Click to add: ${stop.stop_name}`, {
                direction: 'top',
                offset: [0, -25], // Increase offset to avoid cursor overlap
                opacity: 0.9,
                className: 'candidate-tooltip',
                sticky: false, // Ensure it's static relative to marker
                interactive: false // Don't capture mouse events
            });
            marker.on('click', (e: any) => {
                L.DomEvent.stopPropagation(e);
                addReplacementStop(stop.stop_id, stop.stop_name, stop.stop_lat, stop.stop_lon, false);
            });
            marker.addTo(candidateStopsLayer);
        }
    } catch (err) {
        console.error('Failed to find candidates:', err);
    }
}

/**
 * Navigate back to a previous step in the detour creation wizard.
 */
function resetDetourCreation() {
    divergeStopId = null;
    divergeStop = null;
    rejoinStopId = null;
    rejoinStop = null;
    detourPathPoints = [];
    replacementStops = [];
    detourShapeLayer.clearLayers();
    replacementStopsLayer.clearLayers();
    candidateStopsLayer.clearLayers();
    detourStep = 'idle';
    startDetourCreation();
}

/**
 * Navigate back to a previous step in the detour creation wizard.
 */
function goBackStep(targetStep: DetourStep) {
    if (targetStep === 'select-diverge') {
        showConfirm('Going back to start will clear the entire detour. Are you sure?', () => {
            resetDetourCreation();
        }, 'Restart Detour');
        return;
    } else if (targetStep === 'trace-path') {
        // Keep the path but clear the rejoin
        rejoinStopId = null;
        rejoinStop = null;
        candidateStopsLayer.clearLayers();

        document.getElementById('detour-config')!.style.display = 'none';

        // Remove rejoin highlight marker (green) - recreate diverge marker only
        detourShapeLayer.clearLayers();
        if (divergeStop) {
            L.circleMarker([divergeStop.stop_lat, divergeStop.stop_lon], {
                radius: 8,
                fillColor: '#ef4444',
                color: '#ffffff',
                weight: 2,
                fillOpacity: 1,
            }).bindTooltip('DIVERGE: ' + divergeStop.stop_name, { permanent: true, direction: 'top' })
                .addTo(detourShapeLayer);
        }
        redrawDetourPath();
    } else if (targetStep === 'select-rejoin') {
        // Coming back from add-stops
        candidateStopsLayer.clearLayers();
        // Keep replacement stops? Maybe. Or clear them since we are "going back"?
        // Let's keep them in case accidental back
    }

    detourStep = targetStep;
    updateDetourStepUI();
}



// ─── Activate Detour ───

async function activateDetour() {
    if (!selectedRoute || divergeStopId === undefined || rejoinStopId === undefined) return;

    // Disable button to prevent duplicates
    const activateBtn = document.getElementById('activate-detour') as HTMLButtonElement;
    activateBtn.disabled = true;
    activateBtn.textContent = 'Activating...';

    const description = (document.getElementById('detour-description') as HTMLTextAreaElement).value;
    const startTime = (document.getElementById('detour-start') as HTMLInputElement).value;
    const endTime = (document.getElementById('detour-end') as HTMLInputElement).value;

    if (!startTime || !endTime) {
        showError('Please set start and end times.');
        activateBtn.disabled = false;
        activateBtn.textContent = 'Activate Detour';
        return;
    }

    if (new Date(startTime) >= new Date(endTime)) {
        showError('End time must be after start time.');
        activateBtn.disabled = false;
        activateBtn.textContent = 'Activate Detour';
        return;
    }

    try {
        const savedRoute = selectedRoute;
        const savedDirection = selectedDirection;
        const savedDescription = description;
        const savedStartTime = startTime;
        const savedEndTime = endTime;
        const savedDivergeStop = divergeStop;
        const savedRejoinStop = rejoinStop;

        // Calculate skipped stops
        let skippedStops: { stopId: string; stopName: string }[] = [];
        const dIdx = divergeStopId ? currentRouteStops.findIndex(s => s.stop_id === divergeStopId) : -1;
        const rIdx = rejoinStopId ? currentRouteStops.findIndex(s => s.stop_id === rejoinStopId) : currentRouteStops.length;
        if (dIdx >= -1 && rIdx <= currentRouteStops.length && rIdx > dIdx + 1) {
            skippedStops = currentRouteStops.slice(dIdx + 1, rIdx).map(s => ({
                stopId: s.stop_id,
                stopName: s.stop_name
            }));
        }

        const detour = await api.createDetour({
            routeId: selectedRoute.route_id,
            directionId: selectedDirection,
            startStopId: divergeStopId,
            endStopId: rejoinStopId,
            replacementStops,
            detourShape: detourPathPoints,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            description,
            skippedStops,
        });

        console.log('Detour created:', detour);

        // Close the panel immediately
        cancelDetourCreation();
        await loadActiveDetours();

        // Show Success Modal
        const modal = document.getElementById('opp-dir-modal')!;
        const routeInfo = document.getElementById('modal-route-info')!;

        // Format dates for display
        const startStr = new Date(savedStartTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const endStr = new Date(savedEndTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

        const startName = detour.startStopInfo?.stop_name || savedDivergeStop?.stop_name || 'Start';
        const endName = detour.endStopInfo?.stop_name || savedRejoinStop?.stop_name || 'End';

        routeInfo.innerHTML = `
            <div><strong>Route:</strong> ${savedRoute.route_short_name} ${savedRoute.route_long_name}</div>
            <div style="margin-top:4px"><strong>Detour:</strong> ${startName} → ${endName}</div>
            <div style="margin-top:4px"><strong>Effective:</strong> ${startStr} — ${endStr}</div>
        `;
        modal.style.display = 'flex';

        // Pre-fill opposite direction data
        const oppDir = savedDirection === 0 ? 1 : 0;

        // Check overlap - fetch fresh data to ensure we see the just-created detour
        const freshDetours = await api.getDetours();
        const dimStart = new Date(savedStartTime).getTime();
        const dimEnd = new Date(savedEndTime).getTime();

        const hasOpposite = freshDetours.some(d =>
            String(d.routeId) === String(savedRoute.route_id) &&
            Number(d.directionId) === Number(oppDir) &&
            new Date(d.endTime).getTime() > dimStart &&
            new Date(d.startTime).getTime() < dimEnd
        );

        // Setup Modal Listeners (one-time)
        const btnDismiss = document.getElementById('modal-btn-dismiss')!;
        const btnCreate = document.getElementById('modal-btn-create')!;

        // Update Header Title
        const headerTitle = modal.querySelector('h3');
        if (headerTitle) {
            const isFuture = new Date(savedStartTime).getTime() > Date.now() + 60000;
            headerTitle.innerHTML = isFuture
                ? '<span style="color:var(--accent-green)">📅</span> Detour Scheduled'
                : '<span style="color:var(--accent-green)">✓</span> Detour Activated';
        }

        const promptText = document.getElementById('modal-opp-dir-prompt');

        if (hasOpposite) {
            btnCreate.style.display = 'none';
            if (promptText) promptText.style.display = 'none';
            btnDismiss.textContent = 'Close';
        } else {
            btnCreate.style.display = 'inline-block';
            if (promptText) promptText.style.display = 'block';
            btnDismiss.textContent = "No, I'm done";
        }

        // Clone to remove old listeners
        const newBtnDismiss = btnDismiss.cloneNode(true);
        btnDismiss.parentNode!.replaceChild(newBtnDismiss, btnDismiss);
        const newBtnCreate = btnCreate.cloneNode(true);
        btnCreate.parentNode!.replaceChild(newBtnCreate, btnCreate);

        const close = () => { modal.style.display = 'none'; };

        newBtnDismiss.addEventListener('click', close);
        newBtnCreate.addEventListener('click', () => {
            close();
            // Start creation for opposite direction
            startDetourCreation(oppDir, true);

            // Pre-fill
            const descInput = document.getElementById('detour-description') as HTMLTextAreaElement;
            const startInput = document.getElementById('detour-start') as HTMLInputElement;
            const endInput = document.getElementById('detour-end') as HTMLInputElement;

            if (descInput) descInput.value = savedDescription;
            if (startInput) startInput.value = savedStartTime;
            if (endInput) endInput.value = savedEndTime;

            showMapTooltip([map.getCenter().lat, map.getCenter().lng], 'Switched to opposite direction. Please select the new diverge stop.', 4000);
        });


    } catch (err: any) {
        showError('Failed to activate detour: ' + err.message);
        const activateBtn = document.getElementById('activate-detour') as HTMLButtonElement;
        if (activateBtn) {
            activateBtn.disabled = false;
            activateBtn.textContent = 'Activate Detour';
        }
    }
}

// ─── Active Detours ───

async function loadActiveDetours() {
    try {
        const detours = await api.getDetours(); // This gets ALL detours on server
        renderDetourLists(detours);
    } catch (err) {
        console.error('Failed to load detours:', err);
    }
}

function renderDetourLists(detours: DetourData[]) {
    cachedDetours = detours;
    const listActive = document.getElementById('list-active-detours');
    const listUpcoming = document.getElementById('list-upcoming-detours');
    // Widgets
    const countActive = document.getElementById('count-active-detours');
    const countUpcoming = document.getElementById('count-upcoming-detours');
    const activeDetourCountBadge = document.getElementById('active-detour-count');

    if (!listActive || !listUpcoming) return;

    const now = new Date();

    // Split detours
    const active = detours.filter(d => new Date(d.startTime) <= now && new Date(d.endTime) >= now);
    const upcoming = detours.filter(d => new Date(d.startTime) > now);

    // Update counts
    if (countActive) countActive.textContent = String(active.length);
    if (countUpcoming) countUpcoming.textContent = String(upcoming.length);
    if (activeDetourCountBadge) activeDetourCountBadge.textContent = String(active.length); // Keep the map view badge updated too?

    // Helper to render a group
    const renderGroup = (items: DetourData[], container: HTMLElement) => {
        if (items.length === 0) {
            container.innerHTML = '<p class="empty-state">None</p>';
            return;
        }

        // Group by route
        const grouped = new Map<string, DetourData[]>();
        for (const d of items) {
            const key = d.routeId;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(d);
        }

        let html = '';
        for (const [routeId, routeDetours] of grouped) {
            const route = allRoutes.find(r => r.route_id === routeId);
            const routeName = route ? route.route_short_name : routeId;
            const routeLong = route?.route_long_name || '';
            const badgeColor = route?.route_color || '3b82f6';
            const badgeText = route?.route_text_color || 'ffffff';

            html += `<div class="detour-route-group">
              <div class="detour-route-header">
                <div>
                  <span class="route-badge" style="background:#${badgeColor};color:#${badgeText};display:inline-flex;margin-right:8px">${routeName}</span>
                  <span class="detour-route-name">${routeLong}</span>
                </div>
                <span class="detour-route-count" style="color:var(--text-muted)">${routeDetours.length}</span>
              </div>`;

            for (const d of routeDetours) {
                const isActive = new Date(d.startTime) <= now && new Date(d.endTime) >= now;
                const dirLabel = route?.directions?.[d.directionId] || (d.directionId === 0 ? 'Outbound' : 'Inbound');
                const divergeName = d.startStopInfo?.stop_name || d.startStopId;
                const rejoinName = d.endStopInfo?.stop_name || d.endStopId;

                html += `
              <div class="detour-card detour-card-clickable" data-route-id="${routeId}" style="cursor:pointer">
                <div class="detour-card-header">
                  <div class="detour-card-dir">${dirLabel}</div>
                  <div style="display:flex;gap:4px">
                    <!-- The specific view button is kept for clarity, but clicking the card will do the same -->
                    <button class="btn btn-secondary btn-sm btn-show-detour" data-route-id="${routeId}" title="Show on map">👁</button>
                    ${isActive ? `<button class="btn btn-danger btn-sm btn-end-detour" data-detour-id="${d.id}">End</button>` : ''}
                    ${!isActive ? `<button class="btn btn-danger btn-sm btn-end-detour" data-detour-id="${d.id}">Delete</button>` : ''}
                  </div>
                </div>
                <div class="detour-card-description">${d.description || 'No description'}</div>
                <div class="detour-card-segment">
                  <span class="segment-label">⚠</span> ${divergeName} <br>
                  <span class="segment-label">✓</span> ${rejoinName}
                </div>
                <div class="detour-card-time">
                  ${isActive ? '🔴 ACTIVE' : '⏳ Scheduled'} · ${formatTime(d.startTime)} → ${formatTime(d.endTime)}
                </div>
                <div class="detour-card-expand" data-detour-id="${d.id}">${expandedDetourIds.has(d.id) ? '▾' : '▸'} Details</div>
                <div class="detour-card-details" id="detour-details-${d.id}" style="display:${expandedDetourIds.has(d.id) ? 'block' : 'none'}">
                  <div class="detail-loading">Loading...</div>
                </div>
              </div>`;
            }
            html += '</div>';
        }
        container.innerHTML = html;
        bindActiveDetourEvents(container, detours);

        // Auto-load details for expanded items (after re-render)
        items.forEach(d => {
            if (expandedDetourIds.has(d.id)) {
                loadDetourDetails(d.id, detours);
            }
        });
    };

    renderGroup(active, listActive);
    renderGroup(upcoming, listUpcoming);
}

function bindActiveDetourEvents(container: HTMLElement, detours: DetourData[]) {
    // Bind end buttons
    container.querySelectorAll('.btn-end-detour').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = (e.target as HTMLElement).getAttribute('data-detour-id')!;
            showConfirm('Are you sure you want to end this detour early?', async () => {
                await api.deleteDetour(id);
                await loadActiveDetours();
            }, 'End Detour');
        });
    });

    // Bind show-on-map buttons and entire card clicks
    container.querySelectorAll('.detour-card-clickable, .btn-show-detour').forEach(el => {
        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            
            // If clicking the card but we actually clicked a button inside (other than the show button), ignore
            const target = e.target as HTMLElement;
            if (el.classList.contains('detour-card-clickable') && target.closest('button') && !target.closest('.btn-show-detour')) {
                return;
            }

            const routeId = (el as HTMLElement).getAttribute('data-route-id')!;
            const routeDetours = detours.filter(d => d.routeId === routeId);
            if (routeDetours.length > 0) {
                await showDetoursOnMap(routeDetours);
            }
        });
    });

    // Bind expand toggles
    container.querySelectorAll('.detour-card-expand').forEach(el => {
        el.addEventListener('click', async (e) => {
            const id = (e.target as HTMLElement).getAttribute('data-detour-id')!;
            const detailsEl = document.getElementById(`detour-details-${id}`);
            const expandEl = e.target as HTMLElement;
            if (!detailsEl) return;

            if (detailsEl.style.display === 'none') {
                detailsEl.style.display = 'block';
                expandEl.textContent = '▾ Details';
                expandedDetourIds.add(id);
                await loadDetourDetails(id, detours);
            } else {
                detailsEl.style.display = 'none';
                expandEl.textContent = '▸ Details';
                expandedDetourIds.delete(id);
            }
        });
    });
}

/** Cache detours for View All toggle */
let cachedDetours: DetourData[] = [];
let allDetoursVisible = false;

/**
 * Show detours on the map with full route context and affected segment highlighting.
 */
async function showDetoursOnMap(detours: DetourData[]) {
    deselectRoute(); // Clears all layers and selected route state
    
    // Un-highlight view all if it was active
    allDetoursVisible = false;
    const btn = document.getElementById('btn-toggle-all-detours');
    if (btn) btn.textContent = '🗺 View All';

    await Promise.all(detours.map(async d => {
        await addRouteContextToLayer(d, activeDetoursLayer);
        addDetourOverlayToLayer(d, activeDetoursLayer);
    }));

    // Zoom to show everything
    const bounds = activeDetoursLayer.getBounds();
    if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [60, 60] });
    }
}

/**
 * Helper to draw the route context (normal parts + grayed out part) for a detour.
 */
async function addRouteContextToLayer(detour: DetourData, layer: any) {
    const route = allRoutes.find(r => r.route_id === detour.routeId);
    const routeLabel = route ? route.route_short_name : detour.routeId;

    try {
        const shapeData = await api.getRouteShape(detour.routeId, detour.directionId);
        if (shapeData.points && shapeData.points.length > 1) {
            const routeCoords: [number, number][] = shapeData.points.map((p: any) => [p.lat, p.lon] as [number, number]);

            // Find affected segment indices on the route shape
            const divergeLatLon = detour.startStopInfo
                ? [detour.startStopInfo.stop_lat, detour.startStopInfo.stop_lon]
                : null;
            const rejoinLatLon = detour.endStopInfo
                ? [detour.endStopInfo.stop_lat, detour.endStopInfo.stop_lon]
                : null;

            let divergeIdx = -1, rejoinIdx = -1;
            if (divergeLatLon && rejoinLatLon) {
                divergeIdx = findClosestPointIndex(routeCoords, divergeLatLon[0], divergeLatLon[1]);
                rejoinIdx = findClosestPointIndex(routeCoords, rejoinLatLon[0], rejoinLatLon[1]);
                if (rejoinIdx <= divergeIdx) rejoinIdx = -1; // safety
            }

            if (divergeIdx >= 0 && rejoinIdx > divergeIdx) {
                // Draw BEFORE affected segment (normal route dimmed)
                if (divergeIdx > 0) {
                    L.polyline(routeCoords.slice(0, divergeIdx + 1), {
                        color: '#3b82f6', weight: 3, opacity: 0.35,
                    }).bindTooltip(`Rt ${routeLabel} (normal)`, { sticky: true })
                        .addTo(layer);
                }
                // Draw AFFECTED segment (greyed out / striped)
                L.polyline(routeCoords.slice(divergeIdx, rejoinIdx + 1), {
                    color: '#ef4444', weight: 5, opacity: 0.25,
                    dashArray: '2, 8',
                }).bindTooltip(`Rt ${routeLabel} — BYPASSED`, { sticky: true })
                    .addTo(layer);
                // Draw AFTER affected segment (normal route dimmed)
                if (rejoinIdx < routeCoords.length - 1) {
                    L.polyline(routeCoords.slice(rejoinIdx), {
                        color: '#3b82f6', weight: 3, opacity: 0.35,
                    }).bindTooltip(`Rt ${routeLabel} (normal)`, { sticky: true })
                        .addTo(layer);
                }
            } else {
                // Fallback: show full route dimmed
                L.polyline(routeCoords, {
                    color: '#3b82f6', weight: 3, opacity: 0.35,
                    dashArray: '4, 4',
                }).bindTooltip(`Rt ${routeLabel} (normal)`, { sticky: true })
                    .addTo(layer);
            }
        }
    } catch { /* route shape optional */ }
}

/**
 * Draw a single detour's path, markers, and replacement stops on a layer.
 */
function addDetourOverlayToLayer(d: DetourData, layer: any) {
    const route = allRoutes.find(r => r.route_id === d.routeId);
    const routeLabel = route ? route.route_short_name : d.routeId;

    if (d.detourShape && d.detourShape.length > 1) {
        L.polyline(d.detourShape, {
            color: '#ef4444', weight: 5, opacity: 0.85, dashArray: '10, 6',
        }).bindTooltip(`Rt ${routeLabel} Detour`, { sticky: true })
            .addTo(layer);
    }

    const diverge = d.startStopInfo;
    if (diverge) {
        L.circleMarker([diverge.stop_lat, diverge.stop_lon], {
            radius: 9, fillColor: '#ef4444', color: '#fff', weight: 2, fillOpacity: 1
        }).bindTooltip(`⚠ DETOUR START: ${diverge.stop_name} (Rt ${routeLabel})`, { direction: 'top' })
            .addTo(layer);
    }

    const rejoin = d.endStopInfo;
    if (rejoin) {
        L.circleMarker([rejoin.stop_lat, rejoin.stop_lon], {
            radius: 9, fillColor: '#10b981', color: '#fff', weight: 2, fillOpacity: 1
        }).bindTooltip(`✓ DETOUR END: ${rejoin.stop_name} (Rt ${routeLabel})`, { direction: 'top' })
            .addTo(layer);
    }

    for (const rs of d.replacementStops || []) {
        L.circleMarker([rs.lat, rs.lon], {
            radius: 6, fillColor: rs.isTemporary ? '#f59e0b' : '#3b82f6',
            color: '#fff', weight: 1.5, fillOpacity: 0.9
        }).bindTooltip(rs.stopName + (rs.isTemporary ? ' (temp)' : ''), { direction: 'top' })
            .addTo(layer);
    }
}

/**
 * Toggle all active detours on/off on the map.
 */
async function toggleAllDetours() {
    if (allDetoursVisible) {
        activeDetoursLayer.clearLayers();
        allDetoursVisible = false;
        const btn = document.getElementById('btn-toggle-all-detours');
        if (btn) btn.textContent = '🗺 View All';
        return;
    }

    clearAllMapLayers();
    const now = new Date();
    const activeDetours = cachedDetours.filter(d =>
        new Date(d.startTime) <= now && new Date(d.endTime) >= now
    );

    // Parallel fetch allowed for responsiveness
    await Promise.all(activeDetours.map(async d => {
        await addRouteContextToLayer(d, activeDetoursLayer);
        addDetourOverlayToLayer(d, activeDetoursLayer);
    }));

    allDetoursVisible = true;
    const btn = document.getElementById('btn-toggle-all-detours');
    if (btn) btn.textContent = '🗺 Hide All';

    const bounds = activeDetoursLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 60] });
}

/**
 * Load expanded details for a detour card (affected patterns, skipped stops).
 */
async function loadDetourDetails(detourId: string, detours: DetourData[]) {
    const detour = detours.find(d => d.id === detourId);
    const detailsEl = document.getElementById(`detour-details-${detourId}`);
    if (!detour || !detailsEl) return;

    let html = '';
    const dirLabel = detour.directionId === 0 ? 'Outbound' : 'Inbound';
    html += `<div class="detail-row"><strong>Direction:</strong> ${dirLabel}</div>`;

    // Load patterns and determine which are affected
    try {
        const shapeData = await api.getRouteShape(detour.routeId, detour.directionId);
        if (shapeData.patterns && shapeData.patterns.length > 0) {
            html += '<div class="detail-section"><strong>Patterns:</strong></div>';
            for (const p of shapeData.patterns) {
                const pInfo = p as any;
                const stopIds: string[] = pInfo.stopIds || [];
                const affected = stopIds.includes(detour.startStopId) && stopIds.includes(detour.endStopId);
                const label = `${pInfo.firstStopName} → ${pInfo.lastStopName}`;
                const trips = `${pInfo.tripCount} trips`;
                const icon = affected ? '✓' : '—';
                const cls = affected ? 'pattern-affected' : 'pattern-unaffected';
                html += `<div class="detail-pattern ${cls}">
                  <span class="pattern-icon">${icon}</span>
                  <span class="pattern-label">${label}</span>
                  <span class="pattern-trips">${trips}</span>
                </div>`;
            }
        }
    } catch { /* patterns optional */ }

    // Replacement stops
    if (detour.replacementStops && detour.replacementStops.length > 0) {
        html += '<div class="detail-section"><strong>Replacement Stops:</strong></div>';
        for (const rs of detour.replacementStops) {
            html += `<div class="detail-stop">${rs.isTemporary ? '🟡' : '🔵'} ${rs.stopName}${rs.isTemporary ? ' (temp)' : ''}</div>`;
        }
    }

    // Skipped stops
    if (detour.skippedStops && detour.skippedStops.length > 0) {
        html += '<div class="detail-section"><strong>Skipped Stops:</strong></div>';
        for (const ss of detour.skippedStops) {
            html += `<div class="detail-stop">❌ ${ss.stopName}</div>`;
        }
    }

    detailsEl.innerHTML = html || '<div class="detail-row">No additional details</div>';
}

/**
 * Find closest point index on a polyline to a given lat/lon.
 */
function findClosestPointIndex(coords: [number, number][], lat: number, lon: number): number {
    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < coords.length; i++) {
        const dx = (coords[i][0] - lat) * 111320;
        const dy = (coords[i][1] - lon) * 111320 * Math.cos(lat * Math.PI / 180);
        const dist = dx * dx + dy * dy; // no need for sqrt, comparing only
        if (dist < minDist) {
            minDist = dist;
            bestIdx = i;
        }
    }
    return bestIdx;
}

/**
 * Show affected patterns in the configure step during detour creation.
 */
async function showAffectedPatterns() {
    if (!selectedRoute || !divergeStopId || !rejoinStopId) return;

    const section = document.getElementById('affected-patterns-section')!;
    const list = document.getElementById('affected-patterns-list')!;
    section.style.display = 'block';

    try {
        const shapeData = await api.getRouteShape(selectedRoute.route_id, selectedDirection);
        if (!shapeData.patterns || shapeData.patterns.length <= 1) {
            section.style.display = 'none'; // only 1 pattern, no need to show
            return;
        }

        let html = '';
        for (const p of shapeData.patterns) {
            const pInfo = p as any;
            const stopIds: string[] = pInfo.stopIds || [];
            const affected = stopIds.includes(divergeStopId) && stopIds.includes(rejoinStopId);
            const label = `${pInfo.firstStopName} → ${pInfo.lastStopName}`;
            const trips = `${pInfo.tripCount} trips`;
            const icon = affected ? '✓' : '—';
            const cls = affected ? 'pattern-affected' : 'pattern-unaffected';
            html += `<div class="detail-pattern ${cls}">
              <span class="pattern-icon">${icon}</span>
              <span class="pattern-label">${label}</span>
              <span class="pattern-trips">${trips}</span>
            </div>`;
        }
        list.innerHTML = html;
    } catch {
        section.style.display = 'none';
    }
}

function findStopById(stopId: string): { stop_lat: number; stop_lon: number; stop_name: string } | null {
    // Check current route stops first
    const fromRoute = currentRouteStops.find(s => s.stop_id === stopId);
    if (fromRoute) return fromRoute;
    // Fall back to global search (would need full stop data, but for now return null)
    return null;
}

// ─── Vehicles ───

async function toggleVehicles() {
    showVehicles = !showVehicles;
    const btn = document.getElementById('btn-toggle-vehicles')!;
    btn.classList.toggle('active', showVehicles);

    if (showVehicles) {
        await updateVehicles();
        vehicleUpdateTimer = setInterval(updateVehicles, 5000);
    } else {
        if (vehicleUpdateTimer) clearInterval(vehicleUpdateTimer);
        vehiclesLayer.clearLayers();
    }
}

async function updateVehicles() {
    if (!showVehicles) return;
    try {
        const data = await api.getVehicles();
        vehiclesLayer.clearLayers();

        // If a route is selected, only show vehicles for that route
        const vehicles = selectedRoute
            ? data.vehicles.filter(v => v.routeId === selectedRoute!.route_id)
            : data.vehicles;

        for (const v of vehicles) {
            const route = allRoutes.find(r => r.route_id === v.routeId);
            const routeName = route ? `${route.route_short_name} — ${route.route_long_name}` : v.routeId;
            const dirLabel = v.directionId === 0 ? 'Outbound' : 'Inbound';
            const speedMph = Math.round(v.speed * 2.237);
            const statusLabel = v.status === 'IN_TRANSIT' ? '🟢 In Transit' : v.status === 'AT_STOP' ? '🔴 At Stop' : v.status;

            const icon = L.divIcon({
                className: 'vehicle-marker-container',
                html: `<div class="vehicle-marker" style="transform:rotate(${v.bearing}deg)">🚌</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12],
            });
            const marker = L.marker([v.lat, v.lon], { icon });
            marker.bindTooltip(`
                <div class="vehicle-tooltip">
                    <div class="vt-header">Route ${routeName}</div>
                    <div class="vt-row"><span class="vt-label">Direction</span><span>${dirLabel}</span></div>
                    <div class="vt-row"><span class="vt-label">Vehicle #</span><span>${v.vehicleId}</span></div>
                    <div class="vt-row"><span class="vt-label">Trip ID</span><span style="font-size:10px">${v.tripId.slice(0, 20)}</span></div>
                    <div class="vt-row"><span class="vt-label">Status</span><span>${statusLabel}</span></div>
                    <div class="vt-row"><span class="vt-label">Speed</span><span>${speedMph} mph</span></div>
                    <div class="vt-row"><span class="vt-label">Bearing</span><span>${Math.round(v.bearing)}°</span></div>
                </div>
            `, { direction: 'top', offset: [0, -12], className: 'vehicle-tooltip-container' });
            marker.addTo(vehiclesLayer);
        }
    } catch (err) {
        console.error('Failed to update vehicles:', err);
    }
}

// ─── Status Polling ───

async function pollStatus() {
    try {
        const status = await api.getStatus();
        const elVehicles = document.getElementById('val-vehicles');
        const elDetours = document.getElementById('val-detours');

        if (elVehicles) elVehicles.textContent = String(status.activeVehicles);
        if (elDetours) elDetours.textContent = String(status.activeDetours);

        updateStatusConnected();
        await loadActiveDetours();
        await loadCancelledTrips();
    } catch {
        updateStatusDisconnected();
    }
}

// ─── Cancelled View State ───
let selectedCancelledIds = new Set<string>();

async function loadCancelledTrips() {
    try {
        const cancellations = await api.getCancellations();
        const container = document.getElementById('cancelled-trips-list');
        if (!container) return;

        const items = cancellations as any[];

        const nowSec = getNowSeconds();
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        
        let activeCount = 0;
        for (const t of items) {
            const isPassed = t.raw_date < todayStr || (t.raw_date === todayStr && parseTime(t.end_time) <= nowSec);
            if (!isPassed) activeCount++;
        }

        // Update widget count
        const widgetCount = document.getElementById('count-cancelled');
        if (widgetCount) widgetCount.textContent = String(activeCount);

        renderHomeCancelledSummary(activeCount);

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
        return `${h}:${String(m).padStart(2, '0')}`;
    };

    // Group items by block_id
    const grouped = new Map<string, any[]>();
    items.forEach(item => {
        const bId = item.block_id || 'No Block';
        if (!grouped.has(bId)) grouped.set(bId, []);
        grouped.get(bId)!.push(item);
    });

    const nowSec = getNowSeconds();
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    let html = '';
    grouped.forEach((trips, blockId) => {
        const allChecked = trips.every(t => selectedCancelledIds.has(t.trip_id));

        html += `
        <div class="cancelled-block-group" style="grid-column: 1 / -1; margin-top: 16px;">
            <div class="detour-section-header" style="display:flex; align-items:center; gap:8px; margin-bottom:12px; border-bottom:1px solid var(--border-subtle); padding-bottom:4px;">
                <input type="checkbox" class="block-select-all" data-block-id="${blockId}" 
                    style="cursor:pointer; accent-color:var(--accent-blue)" ${allChecked ? 'checked' : ''}>
                <span>Block: <strong>${blockId}</strong></span>
                <span style="font-size:10px; color:var(--text-muted); text-transform:none; font-weight:normal;">(${trips.length} trips)</span>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px;">
                ${trips.map((t: any) => {
            const uniqueId = `${t.trip_id}_${t.raw_date}`;
            const isChecked = selectedCancelledIds.has(uniqueId);
            const routeColor = t.route_color ? `#${t.route_color}` : 'var(--accent-blue)';
            const routeTextColor = t.route_text_color ? `#${t.route_text_color}` : '#fff';
            const startStr = t.start_time != null ? formatTime(t.start_time) : '—';
            const endStr = t.end_time != null ? formatTime(t.end_time) : '—';
            const first = t.first_stop_name || '—';
            const last = t.last_stop_name || '—';
            
            const isPassed = t.raw_date < todayStr || (t.raw_date === todayStr && parseTime(t.end_time) <= nowSec);
            const opacityStyle = isPassed ? 'opacity: 0.5;' : '';

            return `
                    <div class="cancelled-trip-card${isChecked ? ' card-selected' : ''}" data-trip-id="${uniqueId}" data-block-id="${blockId}" style="${opacityStyle}">
                        <div style="display:flex;align-items:flex-start;gap:10px">
                            <input type="checkbox" class="cancel-check" data-trip-id="${uniqueId}" data-block-id="${blockId}"
                                style="margin-top:3px;flex-shrink:0;cursor:pointer;accent-color:var(--accent-blue)"
                                ${isChecked ? 'checked' : ''}>
                            <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:0">
                                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                                    <span style="font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;background:${routeColor};color:${routeTextColor};white-space:nowrap">
                                        ${t.route_short_name || t.route_id}
                                    </span>
                                    <span style="font-size:10px;color:var(--text-muted)">
                                        ${isPassed ? '<span style="color:var(--accent-red);font-weight:600;">(Passed)</span> ' : ''}
                                        ${t.date} · ${startStr} – ${endStr}
                                    </span>
                                </div>
                                <div style="display:flex;align-items:stretch;gap:6px">
                                    <div style="display:flex;flex-direction:column;align-items:center;padding:2px 0;flex-shrink:0">
                                        <div style="width:7px;height:7px;border-radius:50%;background:var(--text-secondary);flex-shrink:0"></div>
                                        <div style="width:1px;flex:1;min-height:5px;background:var(--border)"></div>
                                        <div style="width:7px;height:7px;border-radius:50%;border:1.5px solid var(--text-muted);flex-shrink:0"></div>
                                    </div>
                                    <div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1">
                                        <span style="font-size:10px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${first}">${first}</span>
                                        <span style="font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${last}">${last}</span>
                                    </div>
                                </div>
                            </div>
                            <button class="btn btn-secondary btn-sm btn-restore-single" data-trip-id="${uniqueId}"
                                style="flex-shrink:0;align-self:center">Restore</button>
                        </div>
                    </div>`;
        }).join('')}
            </div>
        </div>`;
    });

    container.innerHTML = html;

    // "Select All" in block header
    container.querySelectorAll('.block-select-all').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const input = e.target as HTMLInputElement;
            const bId = input.dataset.blockId!;
            const tripChecks = container.querySelectorAll<HTMLInputElement>(`.cancel-check[data-block-id="${bId}"]`);

            tripChecks.forEach(tripCb => {
                const tripId = tripCb.dataset.tripId!;
                tripCb.checked = input.checked;
                if (input.checked) selectedCancelledIds.add(tripId);
                else selectedCancelledIds.delete(tripId);
                tripCb.closest('.cancelled-trip-card')?.classList.toggle('card-selected', input.checked);
            });
            renderCancelledActionBar();
        });
    });

    // Individual trip checkboxes
    container.querySelectorAll('.cancel-check').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const input = e.target as HTMLInputElement;
            const id = input.dataset.tripId!;
            const bId = input.dataset.blockId!;

            if (input.checked) selectedCancelledIds.add(id);
            else selectedCancelledIds.delete(id);

            input.closest('.cancelled-trip-card')?.classList.toggle('card-selected', input.checked);

            // Update the "Select All" checkbox for this block
            const blockCb = container.querySelector<HTMLInputElement>(`.block-select-all[data-block-id="${bId}"]`);
            if (blockCb) {
                const tripChecks = Array.from(container.querySelectorAll<HTMLInputElement>(`.cancel-check[data-block-id="${bId}"]`));
                blockCb.checked = tripChecks.every(c => c.checked);
                blockCb.indeterminate = tripChecks.some(c => c.checked) && !blockCb.checked;
            }

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
    slot.innerHTML = `
    <div class="block-action-bar">
        <span class="block-action-info">
            <strong>${count}</strong> trip${count !== 1 ? 's' : ''} selected
        </span>
        <div style="display:flex;gap:8px">
            <button class="btn btn-secondary btn-sm" id="btn-restore-selected">Restore ${count}</button>
            <button class="btn btn-outline btn-sm" id="btn-clear-cancelled-sel">Clear</button>
        </div>
    </div>`;
    document.getElementById('btn-restore-selected')?.addEventListener('click', () => {
        doRestoreTrips(Array.from(selectedCancelledIds));
    });
    document.getElementById('btn-clear-cancelled-sel')?.addEventListener('click', () => {
        selectedCancelledIds.clear();
        loadCancelledTrips();
    });
}

function doRestoreTrips(ids: string[]) {
    const label = ids.length === 1 ? 'this trip' : `${ids.length} trips`;
    showConfirm(`Restore ${label}?`, async () => {
        try {
            await Promise.all(ids.map(uid => {
                const [tId, rawDate] = uid.split('_');
                return api.restoreTrip(tId, rawDate);
            }));
            selectedCancelledIds.clear();
            await loadCancelledTrips();
            if (activeView === 'blocks') loadBlockView();
        } catch (err: any) { showError('Failed to restore: ' + err.message); }
    }, 'Restore Trip');
}

function renderHomeCancelledSummary(count: number) {
    const container = document.getElementById('home-cancelled-summary');
    if (!container) return;

    if (count === 0) {
        container.style.display = 'flex';
        container.innerHTML = `
            <div style="font-size:24px;font-weight:700;color:var(--text-muted);line-height:1">0</div>
            <div style="display:flex;flex-direction:column;justify-content:center">
                <div style="font-weight:600;color:var(--text-primary);font-size:13px">Cancelled Trips</div>
                <div style="font-size:11px;color:var(--text-secondary)">Active & Upcoming</div>
            </div>
        `;
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = `
        <div style="font-size:24px;font-weight:700;color:var(--accent-red);line-height:1">${count}</div>
        <div style="display:flex;flex-direction:column;justify-content:center">
            <div style="font-weight:600;color:var(--text-primary);font-size:13px">Cancelled Trips</div>
            <div style="font-size:11px;color:var(--text-secondary)">Active & Upcoming</div>
        </div>
    `;
}

function getNowSeconds(): number {
    const now = new Date();
    return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}


function updateStatusConnected() {
    document.getElementById('status-text')!.textContent = 'Connected';
    document.querySelector('.status-dot')!.classList.add('connected');
}

function updateStatusDisconnected() {
    document.getElementById('status-text')!.textContent = 'Disconnected';
    document.querySelector('.status-dot')!.classList.remove('connected');
}

// ─── Event Binding ───

function bindEvents() {
    // Route search
    document.getElementById('route-search')!.addEventListener('input', (e) => {
        const query = (e.target as HTMLInputElement).value.toLowerCase();
        const filtered = allRoutes.filter(r =>
            r.route_short_name.toLowerCase().includes(query) ||
            r.route_long_name.toLowerCase().includes(query)
        );
        renderRouteList(filtered);
    });

    // Direction toggle
    document.getElementById('dir-btn-0')!.addEventListener('click', () => setDirection(0));
    document.getElementById('dir-btn-1')!.addEventListener('click', () => setDirection(1));

    // Create detour button
    // Create detour button (sidebar)
    const btnCreate = document.getElementById('btn-create-detour-panel');
    if (btnCreate) btnCreate.addEventListener('click', () => startDetourCreation());
    document.getElementById('close-detour-panel')!.addEventListener('click', cancelDetourCreation);

    // Activate detour
    document.getElementById('activate-detour')!.addEventListener('click', activateDetour);

    // Toggle vehicles
    document.getElementById('btn-toggle-vehicles')!.addEventListener('click', toggleVehicles);

    // Toggle all detours
    document.getElementById('btn-toggle-all-detours')!.addEventListener('click', toggleAllDetours);

    // Modal buttons
    document.getElementById('modal-btn-create')!.addEventListener('click', () => {
        document.getElementById('opp-dir-modal')!.style.display = 'none';
        startDetourCreationOppositeDirection();
    });
    document.getElementById('modal-btn-dismiss')!.addEventListener('click', () => {
        document.getElementById('opp-dir-modal')!.style.display = 'none';
        closeDetourPanel();
    });

    // Block view controls handled in setupNavigation()

    // ─── Sidebar View Switching ───
    document.getElementById('widget-cancelled')?.addEventListener('click', () => {
        // For now, cancelled trips is a separate view (existing navigation)
        // Switch to "Cancelled" tab in sidebar nav (leftmost)
        const btn = document.querySelector('.nav-item[data-view="cancelled"]') as HTMLElement;
        if (btn) btn.click();
    });

    document.getElementById('widget-active-detours')?.addEventListener('click', showDetourView);
    document.getElementById('widget-upcoming-detours')?.addEventListener('click', showDetourView);
    document.getElementById('btn-back-home')?.addEventListener('click', showHomeView);
}

function showHomeView() {
    document.getElementById('sidebar-home')!.style.display = 'flex';
    document.getElementById('sidebar-detours')!.style.display = 'none';
    document.getElementById('detour-panel')!.style.display = 'none';
}

function showDetourView() {
    document.getElementById('sidebar-home')!.style.display = 'none';
    document.getElementById('sidebar-detours')!.style.display = 'flex';
    document.getElementById('detour-panel')!.style.display = 'none';
    loadActiveDetours(); // Refresh
}

function startDetourCreationOppositeDirection() {
    // Only allow switching if step is 'select-diverge' (Step 1) or 'idle'
    if (detourStep === 'select-diverge' || detourStep === 'idle') {
        // Calculate opposite
        const oppositeDir = 1 - selectedDirection;
        // Start creation with opposite direction, PRESERVING VIEW
        startDetourCreation(oppositeDir, true);
    }
}

function setDirection(dir: number, preserveView: boolean = false) {
    // Only allow switching if step is 'select-diverge' (Step 1) or 'idle'
    if (detourStep === 'select-diverge' || detourStep === 'idle') {
        selectedDirection = dir;
        document.querySelectorAll('.direction-btn').forEach(b => b.classList.toggle('active',
            parseInt(b.getAttribute('data-dir') || '-1') === dir
        ));
        loadRouteDisplay(selectedDirection, true); // true = preserve view
    }
}

// ─── Map Tooltip Popup ───

let mapTooltipTimer: ReturnType<typeof setTimeout> | null = null;
let mapTooltipPopup: any = null;

/**
 * Show a temporary tooltip popup on the map at the given coordinates.
 * Auto-removes after `durationMs` milliseconds.
 */
function showMapTooltip(latlng: [number, number], message: string, durationMs: number = 3000) {
    if (mapTooltipPopup) {
        map.closePopup(mapTooltipPopup);
    }
    if (mapTooltipTimer) clearTimeout(mapTooltipTimer);

    mapTooltipPopup = L.popup({
        closeButton: false,
        className: 'map-instruction-popup',
        autoPan: false,
        offset: [0, -15],
    })
        .setLatLng(latlng)
        .setContent(`<div class="map-tip">${message}</div>`)
        .openOn(map);

    mapTooltipTimer = setTimeout(() => {
        if (mapTooltipPopup) map.closePopup(mapTooltipPopup);
        mapTooltipPopup = null;
    }, durationMs);
}

// ─── Temp Stop (non-blocking popup) ───

let tempStopPopup: any = null;

function showTempStopModal() {
    if (!pendingTempStopLatLng) return;
    // Close any existing popup
    hideTempStopModal();

    const [lat, lng] = pendingTempStopLatLng;
    const suggestedName = `Temp Stop ${tempStopCounter + 1}`;

    tempStopPopup = L.popup({
        closeButton: true,
        className: 'temp-stop-popup',
        maxWidth: 260,
        minWidth: 220,
        autoPan: true,
        offset: [0, -5],
    })
        .setLatLng([lat, lng])
        .setContent(`
            <div class="temp-stop-form">
                <div class="temp-stop-title">📍 Add Temporary Stop</div>
                <input type="text" id="popup-temp-name" class="temp-stop-input" 
                       value="${suggestedName}" placeholder="Stop name..." />
                <div class="temp-stop-actions">
                    <button class="temp-stop-btn temp-stop-btn-cancel" id="popup-temp-cancel">Skip</button>
                    <button class="temp-stop-btn temp-stop-btn-confirm" id="popup-temp-confirm">Add Stop</button>
                </div>
            </div>
        `)
        .openOn(map);

    // Bind events after popup opens
    setTimeout(() => {
        const input = document.getElementById('popup-temp-name') as HTMLInputElement;
        if (input) {
            input.focus();
            input.select();
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') confirmTempStop();
                if (e.key === 'Escape') hideTempStopModal();
            });
        }
        document.getElementById('popup-temp-confirm')?.addEventListener('click', confirmTempStop);
        document.getElementById('popup-temp-cancel')?.addEventListener('click', hideTempStopModal);
    }, 50);
}

function hideTempStopModal() {
    if (tempStopPopup) {
        map.closePopup(tempStopPopup);
        tempStopPopup = null;
    }
    pendingTempStopLatLng = null;
}

function confirmTempStop() {
    if (!pendingTempStopLatLng) return;
    const input = document.getElementById('popup-temp-name') as HTMLInputElement;
    const name = input?.value?.trim() || `Temp Stop ${++tempStopCounter}`;
    const [lat, lng] = pendingTempStopLatLng;
    const stopId = `TEMP_${Date.now()}_${tempStopCounter}`;

    addReplacementStop(stopId, name, lat, lng, true);
    hideTempStopModal();
}

// ─── Utilities ───

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Minimum distance (meters) from a point to the detour polyline.
 * Uses point-to-segment projection for accuracy.
 */
function distanceToPolyline(lat: number, lon: number): number {
    if (detourPathPoints.length < 2) return Infinity;

    // Convert to rough meters for projection math (local flat-earth approx)
    const cosLat = Math.cos(lat * Math.PI / 180);
    const pxM = lat * 111320;
    const pyM = lon * 111320 * cosLat;

    let minDist = Infinity;
    for (let i = 0; i < detourPathPoints.length - 1; i++) {
        const [aLat, aLon] = detourPathPoints[i];
        const [bLat, bLon] = detourPathPoints[i + 1];
        const axM = aLat * 111320;
        const ayM = aLon * 111320 * cosLat;
        const bxM = bLat * 111320;
        const byM = bLon * 111320 * cosLat;

        // Project point onto segment
        const dx = bxM - axM, dy = byM - ayM;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) {
            const d = Math.sqrt((pxM - axM) ** 2 + (pyM - ayM) ** 2);
            if (d < minDist) minDist = d;
            continue;
        }
        let t = ((pxM - axM) * dx + (pyM - ayM) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const projX = axM + t * dx;
        const projY = ayM + t * dy;
        const d = Math.sqrt((pxM - projX) ** 2 + (pyM - projY) ** 2);
        if (d < minDist) minDist = d;
    }
    return minDist;
}

function toLocalISO(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ─── Theme Controller ───

function toggleTheme() {
    isLightTheme = !isLightTheme;
    document.body.classList.toggle('light-theme', isLightTheme);

    // Update map tiles
    const url = isLightTheme
        ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

    if (tileLayer) tileLayer.setUrl(url);

    // Update button text? Only icon for now.
}

// ─── Event Binding (Extra) ───
// Add to existing bindEvents or append at end of init
function bindThemeEvents() {
    const btn = document.getElementById('btn-theme-toggle');
    if (btn) btn.addEventListener('click', toggleTheme);

    const btnClose = document.getElementById('close-detour-panel');
    if (btnClose) btnClose.addEventListener('click', closeDetourPanel);
}


// ─── Block Viewer Logic ───

function toggleView(view: 'map' | 'blocks') {
    activeView = view;
    const mapContainer = document.getElementById('map-container')!;
    const blocksContainer = document.getElementById('block-view-container')!;
    const sidebar = document.getElementById('sidebar')!;

    if (view === 'blocks') {
        mapContainer.style.display = 'none';
        sidebar.style.display = 'none';
        blocksContainer.style.display = 'flex';
        loadBlockView();
    } else {
        mapContainer.style.display = 'flex';
        sidebar.style.display = 'flex';
        blocksContainer.style.display = 'none';
        setTimeout(() => map.invalidateSize(), 100);
    }
}

async function loadBlockView(forceRefresh = false) {
    const container = document.getElementById('block-view-content')!;

    // Always clear multi-select when the view is (re)loaded
    selectedTripIds.clear();
    lastClickedTripId = null;

    // Check cache
    if (!forceRefresh && cachedBlocks.length > 0 && loadedBlockDate === blockViewDate) {
        renderBlockViewchart();
        return;
    }

    container.innerHTML = '<div class="loading-spinner">Loading blocks...</div>';

    try {
        const dateStr = blockViewDate.replace(/-/g, '');
        cachedBlocks = await api.getBlocks(dateStr);
        loadedBlockDate = blockViewDate;
        renderBlockViewchart();
    } catch (err) {
        console.error('Failed to load blocks:', err);
        container.innerHTML = '<p class="empty-state" style="color:var(--accent-red)">Failed to load blocks</p>';
    }
}

function renderBlockViewchart() {
    const filterInput = document.getElementById('block-view-filter') as HTMLInputElement;
    const filter = filterInput ? filterInput.value.toLowerCase() : '';
    const container = document.getElementById('block-view-content')!;

    if (!cachedBlocks) return;

    const filtered = cachedBlocks.filter(b =>
        b.block_id.toLowerCase().includes(filter) ||
        b.trips.some(t => t.route_id.toLowerCase().includes(filter))
    );

    if (filtered.length === 0) {
        container.innerHTML = '<p class="empty-state">No blocks found matching filter</p>';
        return;
    }

    filtered.sort((a, b) => a.block_id.localeCompare(b.block_id));

    // Rebuild flat trip order for shift-click range selection
    visibleTripOrder = [];
    for (const block of filtered) {
        for (const trip of block.trips) {
            visibleTripOrder.push(trip.trip_id);
        }
    }

    // Prune selectedTripIds to only trips still visible (e.g. filter changed)
    for (const id of selectedTripIds) {
        if (!visibleTripOrder.includes(id)) selectedTripIds.delete(id);
    }

    const START_HOUR = 4;
    const END_HOUR = 30; // 30 = 6am next day
    const PIXELS_PER_HOUR = 100;
    const CHART_WIDTH = (END_HOUR - START_HOUR) * PIXELS_PER_HOUR;
    const nowSec = getNowSeconds();

    // ── Action bar (shown when trips are selected) ──────────────────────────
    const selCount = selectedTripIds.size;
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');

    const cancellableCount = [...selectedTripIds].filter(id => {
        for (const b of cachedBlocks) {
            const t = b.trips.find(t => t.trip_id === id);
            if (t) {
                if (t.is_cancelled) return false;
                if (selectedDateStr < todayStr) return false;
                if (selectedDateStr === todayStr && parseTime(t.end_time) <= nowSec) return false;
                return true;
            }
        }
        return false;
    }).length;

    const actionSlot = document.getElementById('block-action-bar-slot')!;
    if (selCount > 0) {
        actionSlot.innerHTML = `
        <div class="block-action-bar" id="block-action-bar">
            <span class="block-action-info">
                <strong>${selCount}</strong> trip${selCount !== 1 ? 's' : ''} selected
                ${cancellableCount > 0 ? `<span class="block-action-sub">&nbsp;·&nbsp;${cancellableCount} cancellable</span>` : ''}
            </span>
            <div style="display:flex;gap:8px">
                ${cancellableCount > 0
                ? `<button class="btn btn-danger btn-sm" id="btn-cancel-selected">Cancel ${cancellableCount}</button>`
                : ''}
                <button class="btn btn-secondary btn-sm" id="btn-clear-selection">Clear</button>
            </div>
        </div>`;
    } else {
        actionSlot.innerHTML = '';
    }

    // ── Chart ───────────────────────────────────────────────────────────────
    let html = `<div class="block-chart-container" style="width:${CHART_WIDTH + 80}px">`;

    // Header
    html += `<div class="timeline-header"><div class="time-scale" style="width:${CHART_WIDTH}px">`;
    for (let h = START_HOUR; h <= END_HOUR; h++) {
        const left = (h - START_HOUR) * PIXELS_PER_HOUR;
        const displayH = h % 24;
        const ampm = displayH >= 12 ? 'PM' : 'AM';
        const label = `${displayH === 0 ? 12 : (displayH > 12 ? displayH - 12 : displayH)} ${ampm}`;
        html += `<div class="time-marker" style="left:${left}px">${label}</div>`;
    }
    html += `</div></div>`;

    // Blocks
    for (const block of filtered) {
        const blockTrips = block.trips;
        const blockTripIds = blockTrips.map(t => t.trip_id);
        const selectedInBlock = blockTripIds.filter(id => selectedTripIds.has(id)).length;
        const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        
        const cancellableInBlock = blockTrips.filter(t => {
            if (t.is_cancelled) return false;
            if (selectedDateStr < todayStr) return false; // Past days cannot be cancelled
            if (selectedDateStr === todayStr && parseTime(t.end_time) <= nowSec) return false;
            return true;
        }).length;
        
        const labelClass = selectedInBlock === 0 ? '' :
            (selectedInBlock === cancellableInBlock ? 'all-selected' : 'partial-selected');

        html += `<div class="block-row" data-block-id="${block.block_id}">`;
        html += `<div class="block-label ${labelClass}"
                      data-block-id="${block.block_id}"
                      title="Click to select all trips in block ${block.block_id}">${block.block_id}</div>`;
        html += `<div class="block-track">`;

        // Grid lines
        for (let h = START_HOUR; h <= END_HOUR; h++) {
            const left = (h - START_HOUR) * PIXELS_PER_HOUR;
            html += `<div class="grid-line" style="left:${left}px"></div>`;
        }

        // Trips
        for (const trip of block.trips) {
            const startSec = parseTime(trip.start_time);
            const endSec = parseTime(trip.end_time);

            const startPx = ((startSec / 3600) - START_HOUR) * PIXELS_PER_HOUR;
            const widthPx = ((endSec - startSec) / 3600) * PIXELS_PER_HOUR;

            if (widthPx < 2) continue;

            const isCancelled = trip.is_cancelled;
            const isDetoured = trip.is_detoured;
            const isSelected = selectedTripIds.has(trip.trip_id);
            
            const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');
            
            const isCompleted = (selectedDateStr < todayStr) || (selectedDateStr === todayStr && endSec < nowSec);

            const route = allRoutes.find(r => r.route_id === trip.route_id);

            const bgStyle = isCancelled
                ? ''
                : (trip.direction_id === 1
                    ? `background:repeating-linear-gradient(45deg, #${route?.route_color || '3b82f6'}, #${route?.route_color || '3b82f6'} 10px, white 10px, white 12px)` // Hatched for Dir 1
                    : `background:#${route?.route_color || '3b82f6'}`);

            const additionalClass = [
                isCancelled ? 'cancelled' : (isDetoured ? 'detoured' : ''),
                isSelected ? 'trip-selected' : '',
                isCompleted ? 'completed' : ''
            ].filter(Boolean).join(' ');

            html += `<div class="trip-bar ${additionalClass}" 
                          style="left:${startPx}px;width:${widthPx}px;${bgStyle}"
                          data-trip-id="${trip.trip_id}"
                          title="Route ${trip.route_id} (${trip.trip_id})&#10;Ctrl/⌘+click to select · Shift+click to range-select">
                        <span style="font-weight:700;margin-right:4px">${trip.route_id}</span> 
                        ${trip.trip_headsign}
                     </div>`;
        }

        html += `</div></div>`; // Close track, Close row
    }
    html += `</div>`; // Close chart container

    container.innerHTML = html;

    // Wire up action bar buttons (now in the sibling slot, not in container)
    document.getElementById('btn-cancel-selected')?.addEventListener('click', cancelSelectedTrips);
    document.getElementById('btn-clear-selection')?.addEventListener('click', () => {
        selectedTripIds.clear();
        lastClickedTripId = null;
        renderBlockViewchart();
    });

    console.log(`[TDM] Rendered ${filtered.length} blocks, ${selCount} selected.`);
}

/** Select / deselect all cancellable trips in a block (toggle). */
function selectBlock(blockId: string) {
    const block = cachedBlocks.find(b => b.block_id === blockId);
    if (!block) return;

    const nowSec = getNowSeconds();
    const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const cancellable = block.trips.filter(t => {
        if (t.is_cancelled) return false;
        if (selectedDateStr < todayStr) return false;
        if (selectedDateStr === todayStr && parseTime(t.end_time) <= nowSec) return false;
        return true;
    });
    if (cancellable.length === 0) {
        showAlert(`No cancellable trips in block ${blockId}.`);
        return;
    }

    // Toggle: if all are already selected, deselect; otherwise select all
    const allSelected = cancellable.every(t => selectedTripIds.has(t.trip_id));
    if (allSelected) {
        cancellable.forEach(t => selectedTripIds.delete(t.trip_id));
    } else {
        cancellable.forEach(t => selectedTripIds.add(t.trip_id));
        lastClickedTripId = cancellable[cancellable.length - 1].trip_id;
    }
    renderBlockViewchart();
}

/** Confirm and cancel all currently selected (and cancellable) trips. */
async function cancelSelectedTrips() {
    const nowSec = getNowSeconds();
    const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    const toCancel: string[] = [];
    for (const id of selectedTripIds) {
        for (const b of cachedBlocks) {
            const trip = b.trips.find(t => t.trip_id === id);
            if (trip && !trip.is_cancelled) {
                // Must be valid for cancellation
                if (selectedDateStr > todayStr || (selectedDateStr === todayStr && parseTime(trip.end_time) > nowSec)) {
                    toCancel.push(id);
                    break;
                }
            }
        }
    }
    
    if (toCancel.length === 0) {
        showAlert('No cancellable trips in selection (they may already be cancelled or in the past).');
        return;
    }

    const defaultDate = (document.getElementById('block-view-date') as HTMLInputElement).value;
    const countStr = toCancel.length === 1 ? 'Cancel 1 Trip' : `Cancel ${toCancel.length} Trips`;
    
    const htmlMessage = `
        <div style="margin-bottom: 12px;">Select the date range for this cancellation:</div>
        <div style="display: flex; gap: 12px; align-items: center; justify-content: center; margin-bottom: 8px;">
            <div style="display: flex; flex-direction: column; align-items: flex-start;">
                <label style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;">Start Date</label>
                <input type="date" id="cancel-start-date" value="${defaultDate}" class="app-input" style="width: 140px;">
            </div>
            <span style="color:var(--text-secondary); margin-top:16px;">&rarr;</span>
            <div style="display: flex; flex-direction: column; align-items: flex-start;">
                <label style="font-size:11px; color:var(--text-secondary); margin-bottom:4px;">End Date</label>
                <input type="date" id="cancel-end-date" value="${defaultDate}" class="app-input" style="width: 140px;">
            </div>
        </div>
    `;

    showModal({
        title: 'Cancel Trips',
        message: htmlMessage,
        type: 'danger',
        confirmText: countStr,
        cancelText: 'Abort',
        onConfirm: async () => {
            const startVal = (document.getElementById('cancel-start-date') as HTMLInputElement).value.replace(/-/g, '');
            const endVal = (document.getElementById('cancel-end-date') as HTMLInputElement).value.replace(/-/g, '');
            
            if (!startVal || !endVal || startVal > endVal) {
                showAlert('Invalid date range selected.');
                return;
            }
            
            try {
                // Execute cancellations
                await Promise.all(toCancel.map(id => api.cancelTrip(id, startVal, endVal)));
                
                // Update local cache so the chart re-renders correctly if the cancellation applies to the current view
                if (startVal <= selectedDateStr && selectedDateStr <= endVal) {
                    for (const id of toCancel) {
                        for (const b of cachedBlocks) {
                            const trip = b.trips.find(t => t.trip_id === id);
                            if (trip) trip.is_cancelled = true;
                        }
                    }
                }
                selectedTripIds.clear();
                lastClickedTripId = null;
                renderBlockViewchart();
            } catch (err: any) {
                showError('Failed to cancel some trips: ' + err.message);
            }
        }
    });
}

function parseTime(time: string | number): number {
    if (typeof time === 'number') return time;
    const [h, m, s] = time.split(':').map(Number);
    return h * 3600 + m * 60 + s;
}

function formatSeconds(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function showTripPopover(tripElem: HTMLElement, tripId: string) {
    console.log(`[TDM] showTripPopover called for ${tripId}`);
    let trip: BlockTrip | undefined;
    for (const b of cachedBlocks) {
        // Use loose equality or string conversion to handle potential number/string mismatch from JSON
        trip = b.trips.find(t => String(t.trip_id) === String(tripId));
        if (trip) break;
    }

    if (!trip) {
        console.error(`[TDM] Trip ${tripId} not found in cachedBlocks`);
        return;
    }
    console.log('[TDM] Trip found, creating popover');


    const existing = document.querySelector('.trip-popover');
    if (existing) existing.remove();

    // Append to the scroll container so it moves with content
    const scrollContainer = document.getElementById('block-view-content') as HTMLElement;
    if (!scrollContainer) {
        console.error('[TDM] Scroll container not found!');
        return;
    }

    const popover = document.createElement('div');
    popover.className = 'trip-popover';

    // Calculate position relative to the SCROLL CONTAINER
    // tripElem.offsetLeft is relative to the .block-row
    // .block-row is relative to .block-chart-container
    // We need (tripElem absolute left) - (scrollContainer absolute left) + (scrollContainer.scrollLeft)
    // Actually, simply appending to document.body and updating on scroll is jerky.
    // Appending to the content container is better if we set position absolute.
    // However, .block-view-content has overflow:auto. If we append inside, and position it, it will scroll.
    // BUT, we need to make sure z-index is high enough and it doesn't get clipped if it overflows the container.
    // "Fixed" strategy: Append to body, but update position on scroll events.

    // User asked: "remain right under the trip as we scroll". 
    // If I append to the row, it will be clipped by row overflow (if any) or covered by sticky headers?
    // Let's try appending to the .block-view-content, but outside the rows.
    // AND ensure .block-view-content has overflow:auto but NOT hidden.

    // Refined strategy: Append to .block-track of the specific row? No, clipping.
    // Strategy: Append to .block-chart-container. It is the scrollable content.
    // Position: Absolute relative to chart container.

    // Append to body to avoid overflow clipping and ensure z-index
    // Append to scroll container to fix horizontal scrolling behavior
    scrollContainer.appendChild(popover);

    // Position relative to the SCROLL CONTAINER
    const tripRect = tripElem.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();

    // Ensure container is positioned
    scrollContainer.style.position = 'relative';

    const topVal = tripRect.bottom - containerRect.top + scrollContainer.scrollTop + 4;
    const leftVal = tripRect.left - containerRect.left + scrollContainer.scrollLeft;

    // Position below the trip bar
    popover.style.top = `${topVal}px`;
    popover.style.left = `${leftVal}px`;
    popover.style.position = 'absolute';
    popover.style.zIndex = '500'; // Below block labels (1000), above content
    popover.style.display = 'block';

    // Display formatted time
    const startStr = formatSeconds(parseTime(trip.start_time));
    const endStr = formatSeconds(parseTime(trip.end_time));

    // Get route info for tooltip
    const route = allRoutes.find(r => r.route_id === trip.route_id);
    const routeName = route ? `${route.route_short_name} ${route.route_long_name}` : `Route ${trip.route_id}`;
    // Subtitle: Direction (Start -> End)
    const dirName = route?.directions?.[trip['direction_id']] || (trip.direction_id === 0 ? 'Outbound' : 'Inbound');
    const subtitle = `${dirName} (${trip.start_stop_name || '?'} → ${trip.end_stop_name || '?'})`;

    popover.innerHTML = `
        <div class="popover-header">
            <div style="padding-right: 20px;">
                <strong>${trip.route_id}</strong> <span style="font-weight:normal">${route ? route.route_long_name : ''}</span>
                <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${subtitle}</div>
            </div>
            <button id="btn-close-popover-x" style="position:absolute;top:8px;right:8px;background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:16px;line-height:1;padding:4px;">✕</button>
        </div>
        <div class="popover-body">
            <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px">
                ${trip.trip_headsign}
            </div>
             <p style="margin:4px 0">
                <strong>Time:</strong> ${startStr} - ${endStr}<br>
                <strong>Status:</strong> <span style="color:${trip.is_cancelled ? 'var(--accent-red)' : 'var(--accent-green)'}">
                    ${trip.is_cancelled ? 'CANCELLED' : 'Scheduled'}
                </span>
            </p>
            <div class="trip-popover-actions">
                ${(() => {
                    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
                    const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');
                    const isPassed = selectedDateStr < todayStr || (selectedDateStr === todayStr && parseTime(trip.end_time) <= getNowSeconds());
                    if (!trip.is_cancelled && !isPassed) {
                        return `<button class="btn btn-danger btn-sm" id="btn-cancel-trip">Cancel</button>`;
                    }
                    return '';
                })()}
                ${trip.is_cancelled
            ? `<button class="btn btn-secondary btn-sm" id="btn-restore-trip">Restore</button>`
            : ''}
            </div>
        </div>
    `;

    // Global click listener to close if clicked outside
    // Use a small timeout to avoid immediate close from the triggering click
    setTimeout(() => {
        const closeHandler = (e: MouseEvent) => {
            const target = e.target as Node;
            if (!popover.contains(target) && !tripElem.contains(target)) {
                console.log('[TDM] Valid outside click detected, closing popover');
                popover.remove();
                document.removeEventListener('click', closeHandler);
            }
        };
        document.addEventListener('click', closeHandler);
    }, 100);

    // Button Listeners
    popover.querySelector('#btn-close-popover-x')?.addEventListener('click', () => popover.remove());

    const btnCancel = popover.querySelector('#btn-cancel-trip');
    if (btnCancel) {
        btnCancel.addEventListener('click', async () => {
            showConfirm('Are you sure you want to CANCEL this trip?', async () => {
                try {
                    const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');
                    await api.cancelTrip(tripId, selectedDateStr, selectedDateStr);
                    trip!.is_cancelled = true;
                    popover.remove();
                    renderBlockViewchart();
                } catch (err: any) { showError('Failed to cancel trip: ' + err.message); }
            }, 'Cancel Trip', 'Yes, Cancel Trip', 'No, Keep It');
        });
    }

    const btnRestore = popover.querySelector('#btn-restore-trip');
    if (btnRestore) {
        btnRestore.addEventListener('click', async () => {
            showConfirm('Restore this trip? The cancellation will be removed.', async () => {
                try {
                    const selectedDateStr = (document.getElementById('block-view-date') as HTMLInputElement).value.replace(/-/g, '');
                    await api.restoreTrip(tripId, selectedDateStr);
                    trip!.is_cancelled = false;
                    popover.remove();
                    renderBlockViewchart();
                } catch (err: any) { showError('Failed to restore trip: ' + err.message); }
            }, 'Restore Trip', 'Yes, Restore', 'No');
        });
    }
}

// Update bindEvents to include new listeners
const originalBindEvents = bindThemeEvents; // Hack to chain if needed, but better to just add listeners

// ─── Navigation & View Management ───

function setupNavigation() {
    // 1. Side Nav Toggle
    const navAndSidebar = () => {
        const sideNav = document.getElementById('side-nav');
        const toggleBtn = document.getElementById('nav-toggle');
        if (sideNav && toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                sideNav.classList.toggle('expanded');
                toggleBtn.textContent = sideNav.classList.contains('expanded') ? '«' : '»';
            });
        }
    };
    navAndSidebar();

    // 2. View Switching
    const navItems = document.querySelectorAll('.nav-item[data-view]');
    navItems.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const view = (e.currentTarget as HTMLElement).getAttribute('data-view');
            if (view) switchView(view);
        });
    });

    // 3. Logo Click -> Home
    document.getElementById('nav-logo')?.addEventListener('click', (e) => {
        e.preventDefault();
        switchView('map');
    });

    // 4. Cancelled Summary Widget Click -> Cancelled View
    document.getElementById('home-cancelled-summary')?.addEventListener('click', () => {
        switchView('cancelled');
    });

    // 5. Theme Toggle
    document.getElementById('btn-theme-toggle')?.addEventListener('click', toggleTheme);

    // 6. Block View Controls
    const btnRefresh = document.getElementById('btn-refresh-blocks');
    if (btnRefresh) btnRefresh.addEventListener('click', () => loadBlockView(true));

    const dateInput = document.getElementById('block-view-date') as HTMLInputElement;
    if (dateInput) {
        const today = new Date().toISOString().slice(0, 10);
        dateInput.min = today;   // Prevent selecting past dates
        dateInput.value = blockViewDate;
        dateInput.addEventListener('change', (e) => {
            blockViewDate = (e.target as HTMLInputElement).value;
            loadBlockView();
        });
    }

    const filterInput = document.getElementById('block-view-filter');
    if (filterInput) filterInput.addEventListener('input', renderBlockViewchart);

    // 7. Event Delegation for Block Viewer
    const blockContent = document.getElementById('block-view-content');
    if (blockContent) {
        blockContent.addEventListener('click', (e) => {
            const clickedEl = e.target as HTMLElement;

            // — Block label click: select/deselect all trips in the block
            const labelTarget = clickedEl.closest('.block-label') as HTMLElement | null;
            if (labelTarget?.dataset.blockId) {
                selectBlock(labelTarget.dataset.blockId);
                return;
            }

            // — Trip bar click
            const tripTarget = clickedEl.closest('.trip-bar') as HTMLElement | null;
            if (!tripTarget) return;
            const tripId = tripTarget.dataset.tripId;
            if (!tripId) return;

            if (e.ctrlKey || e.metaKey) {
                // Ctrl/⌘: toggle this trip in/out of selection
                if (selectedTripIds.has(tripId)) {
                    selectedTripIds.delete(tripId);
                } else {
                    selectedTripIds.add(tripId);
                    lastClickedTripId = tripId;
                }
                renderBlockViewchart();

            } else if (e.shiftKey && lastClickedTripId) {
                // Shift: range-select from anchor to here (inclusive)
                const anchorIdx = visibleTripOrder.indexOf(lastClickedTripId);
                const targetIdx = visibleTripOrder.indexOf(tripId);
                if (anchorIdx !== -1 && targetIdx !== -1) {
                    const [lo, hi] = anchorIdx < targetIdx
                        ? [anchorIdx, targetIdx]
                        : [targetIdx, anchorIdx];
                    for (let i = lo; i <= hi; i++) {
                        selectedTripIds.add(visibleTripOrder[i]);
                    }
                    renderBlockViewchart();
                }

            } else {
                // Plain click: open the trip popover (existing behaviour)
                showTripPopover(tripTarget, tripId);
            }
        });

        // Escape key: clear selection when block viewer is active
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && activeView === 'blocks' && selectedTripIds.size > 0) {
                selectedTripIds.clear();
                lastClickedTripId = null;
                renderBlockViewchart();
            }
        });
    }
}

function switchView(viewName: string) {
    if (viewName !== 'map' && viewName !== 'blocks' && viewName !== 'cancelled') return;
    activeView = viewName;

    // Update Nav State
    document.querySelectorAll('.nav-item[data-view]').forEach(el => {
        el.classList.remove('active');
        if (el.getAttribute('data-view') === viewName) el.classList.add('active');
    });

    // Update Containers
    document.querySelectorAll('.view-container').forEach(el => {
        el.classList.remove('active');
    });

    const target = document.getElementById(`view-${viewName}`);
    if (target) {
        target.classList.add('active');
    }

    // Specific logic
    if (viewName === 'map') {
        setTimeout(() => map.invalidateSize(), 100); // Resize map
    } else if (viewName === 'blocks') {
        loadBlockView();
    } else if (viewName === 'cancelled') {
        loadCancelledTrips();
    }
}


// Export helpers for global scope if needed (though not using modules fully here)
// Simply defining them at top level is enough, but TS needs to know they exist.
// The issue is likely Block Scope or Ordering.
// Moving init logic to the bottom was correct.
// The error "Cannot find name" suggests they are not in scope.
// Let's ensure they are defined in the file scope.

// They are defined above in the file.
// The issue might be that I pasted the call BEFORE the definition?
// No, functions are hoisted.
// Unless they are inside another function?
// Let's check where loadDetours is defined.
// It is defined around line 900.
// Let's check if it's inside startDetourCreation? 
// Ah, `startDetourCreation` ends at line 760?
// Let's check the file structure.

// To trigger a clean build/check, I'll just touch the file again but ensuring the calls are clean.
// The previous lints might be stale or due to the chunk error.




// Export helpers for global scope if needed (though not using modules fully here)
(window as any).loadDetours = loadActiveDetours;

// Initialize
init();
setupNavigation();

