import { api, RouteInfo, StopInfo, DetourData, VehicleData } from './services';

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
let isLightTheme = false;

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
    tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Initialize layer groups
    routeShapeLayer = L.layerGroup().addTo(map);
    stopsLayer = L.layerGroup().addTo(map);
    activeDetoursLayer = L.featureGroup().addTo(map); // FeatureGroup for getBounds()
    detourShapeLayer = L.layerGroup().addTo(map);
    replacementStopsLayer = L.layerGroup().addTo(map);
    candidateStopsLayer = L.layerGroup().addTo(map);
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
    <div class="route-item" data-route-id="${r.route_id}" id="route-item-${r.route_id}">
      <span class="route-badge" style="background:#${r.route_color || '3b82f6'};color:#${r.route_text_color || 'ffffff'}">${r.route_short_name}</span>
      <span class="route-name">${r.route_long_name}</span>
    </div>
  `).join('');

    // Click handlers
    container.querySelectorAll('.route-item').forEach(el => {
        el.addEventListener('click', () => {
            const routeId = el.getAttribute('data-route-id')!;
            selectRoute(routeId);
        });
    });
}

async function selectRoute(routeId: string) {
    const route = allRoutes.find(r => r.route_id === routeId);
    if (!route) return;

    selectedRoute = route;

    // Highlight in list
    document.querySelectorAll('.route-item').forEach(el => el.classList.remove('selected'));
    document.getElementById(`route-item-${routeId}`)?.classList.add('selected');

    // Show direction toggle
    document.getElementById('direction-group')!.style.display = 'block';

    // Show create detour button
    document.getElementById('btn-create-detour')!.style.display = 'flex';

    // Load shape and stops
    await loadRouteDisplay();
}

async function loadRouteDisplay() {
    if (!selectedRoute) return;

    try {
        // Load shape
        const shapeData = await api.getRouteShape(selectedRoute.route_id, selectedDirection);
        routeShapeLayer.clearLayers();
        if (shapeData.points.length > 0) {
            const latLngs = shapeData.points.map(p => [p.lat, p.lon]);
            L.polyline(latLngs, {
                color: `#${selectedRoute.route_color || '3b82f6'}`,
                weight: 4,
                opacity: 0.8,
            }).addTo(routeShapeLayer);

            // Fit map to route
            map.fitBounds(L.latLngBounds(latLngs), { padding: [50, 50] });
        }

        // Load stops
        currentRouteStops = await api.getRouteStops(selectedRoute.route_id, selectedDirection);
        renderStopsOnMap(currentRouteStops);
    } catch (err) {
        console.error('Failed to load route display:', err);
    }
}

function renderStopsOnMap(stops: StopInfo[]) {
    stopsLayer.clearLayers();
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

        marker.on('click', () => onStopClick(stop));
        marker.addTo(stopsLayer);
    }
}

// ─── Detour Creation ───

function startDetourCreation() {
    if (!selectedRoute) return;

    detourStep = 'select-diverge';
    divergeStopId = null;
    divergeStop = null;
    rejoinStopId = null;
    rejoinStop = null;
    detourPathPoints = [];
    replacementStops = [];

    // Show detour panel
    document.getElementById('detour-panel')!.style.display = 'block';

    // Clear any previous detour display
    detourShapeLayer.clearLayers();
    replacementStopsLayer.clearLayers();
    nearbyStopsLayer.clearLayers();

    updateDetourStepUI();
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
        const divergeIdx = currentRouteStops.findIndex(s => s.stop_id === divergeStopId);
        const thisIdx = currentRouteStops.findIndex(s => s.stop_id === stop.stop_id);

        if (divergeIdx !== -1 && thisIdx > divergeIdx) {
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
    if (detourStep === 'trace-path') {
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
    } else if (detourStep === 'add-stops') {
        // Add temp stop
        const lat = e.latlng.lat;
        const lng = e.latlng.lng;
        pendingTempStopLatLng = [lat, lng];
        showTempStopModal();
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
        L.circleMarker([s.lat, s.lon], {
            radius: 7,
            fillColor: s.isTemporary ? '#f59e0b' : '#3b82f6',
            color: '#ffffff',
            weight: 2,
            fillOpacity: 1,
        }).bindTooltip(s.stopName + (s.isTemporary ? ' (temp)' : ''), { direction: 'top' })
            .addTo(replacementStopsLayer);
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
            document.getElementById('detour-config')!.style.display = 'none';
            replacement.style.display = 'none';
            candidateStopsLayer.clearLayers();
            break;
        case 'trace-path':
            instructions.innerHTML = 'Click the map to trace the detour path <em>(snaps to roads)</em>. Click a <strong>route stop</strong> to set the rejoin point, or right-click to undo.';
            instructions.innerHTML += '<br><br><div style="display:flex;gap:6px;flex-wrap:wrap">' +
                '<button class="btn btn-secondary btn-sm" id="btn-back-to-diverge">← Back</button>' +
                '<button class="btn btn-secondary btn-sm" id="btn-undo-segment">↩ Undo</button></div>';
            document.getElementById('btn-back-to-diverge')?.addEventListener('click', () => goBackStep('select-diverge'));
            document.getElementById('btn-undo-segment')?.addEventListener('click', undoLastSegment);
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
        maxLat = Math.max(maxLat, lat); maxLon = Math.max(maxLon, lon);
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
            marker.bindTooltip(`Click to add: ${stop.stop_name}`, { direction: 'top', offset: [0, -5] });
            marker.on('click', () => {
                addReplacementStop(stop.stop_id, stop.stop_name, stop.stop_lat, stop.stop_lon, false);
                candidateStopsLayer.removeLayer(marker);
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
function goBackStep(targetStep: DetourStep) {
    if (targetStep === 'select-diverge') {
        const confirmReset = confirm('Going back to start will clear the entire detour. Are you sure?');
        if (!confirmReset) return;

        // Reset everything
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
    if (!selectedRoute || !divergeStopId || !rejoinStopId) return;

    // Disable button to prevent duplicates
    const activateBtn = document.getElementById('activate-detour') as HTMLButtonElement;
    activateBtn.disabled = true;
    activateBtn.textContent = 'Activating...';

    const description = (document.getElementById('detour-description') as HTMLTextAreaElement).value;
    const startTime = (document.getElementById('detour-start') as HTMLInputElement).value;
    const endTime = (document.getElementById('detour-end') as HTMLInputElement).value;

    if (!startTime || !endTime) {
        alert('Please set start and end times.');
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

        const startName = detour.startStopInfo?.stop_name || 'Start';
        const endName = detour.endStopInfo?.stop_name || 'End';

        routeInfo.innerHTML = `
            <div><strong>Route:</strong> ${savedRoute.route_short_name} ${savedRoute.route_long_name}</div>
            <div style="margin-top:4px"><strong>Detour:</strong> ${startName} → ${endName}</div>
            <div style="margin-top:4px"><strong>Effective:</strong> ${startStr} — ${endStr}</div>
        `;
        modal.style.display = 'flex';

        // Pre-fill opposite direction data
        const oppDir = savedDirection === 0 ? 1 : 0;

        // Setup Modal Listeners (one-time)
        const btnDismiss = document.getElementById('modal-btn-dismiss')!;
        const btnCreate = document.getElementById('modal-btn-create')!;

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
            setDirection(oppDir);

            // Wait for route load
            setTimeout(() => {
                startDetourCreation();

                // Pre-fill
                const descInput = document.getElementById('detour-description') as HTMLTextAreaElement;
                const startInput = document.getElementById('detour-start') as HTMLInputElement;
                const endInput = document.getElementById('detour-end') as HTMLInputElement;

                if (descInput) descInput.value = savedDescription;
                if (startInput) startInput.value = savedStartTime;
                if (endInput) endInput.value = savedEndTime;

                showMapTooltip([map.getCenter().lat, map.getCenter().lng], 'Switched to opposite direction. Please select the new diverge stop.', 4000);
            }, 600);
        });

    } catch (err: any) {
        alert('Failed to activate detour: ' + err.message);
        activateBtn.disabled = false;
        activateBtn.textContent = 'Activate Detour';
    }
}

// ─── Active Detours ───

async function loadActiveDetours() {
    try {
        const detours = await api.getDetours();
        renderActiveDetours(detours);
        // Don't auto-render on map — user uses Show button per detour
    } catch (err) {
        console.error('Failed to load detours:', err);
    }
}

function renderActiveDetours(detours: DetourData[]) {
    const container = document.getElementById('active-detours-list')!;
    const countBadge = document.getElementById('active-detour-count')!;
    cachedDetours = detours; // cache for View All toggle

    const now = new Date();
    const active = detours.filter(d => new Date(d.startTime) <= now && new Date(d.endTime) >= now);
    countBadge.textContent = String(active.length);

    if (detours.length === 0) {
        container.innerHTML = '<p class="empty-state">No active detours</p>';
        return;
    }

    // Group by route
    const grouped = new Map<string, DetourData[]>();
    for (const d of detours) {
        const key = d.routeId;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(d);
    }

    let html = '';
    for (const [routeId, routeDetours] of grouped) {
        const route = allRoutes.find(r => r.route_id === routeId);
        const routeName = route ? route.route_short_name : routeId;
        const routeLong = route?.route_long_name || '';
        const activeCount = routeDetours.filter(d => new Date(d.startTime) <= now && new Date(d.endTime) >= now).length;

        html += `<div class="detour-route-group">
          <div class="detour-route-header">
            <div>
              <span class="detour-route-badge">Rt ${routeName}</span>
              <span class="detour-route-name">${routeLong}</span>
            </div>
            <span class="detour-route-count">${activeCount} active</span>
          </div>`;

        for (const d of routeDetours) {
            const isActive = new Date(d.startTime) <= now && new Date(d.endTime) >= now;
            const dirLabel = d.directionId === 0 ? 'Outbound' : 'Inbound';
            const divergeName = d.startStopInfo?.stop_name || d.startStopId;
            const rejoinName = d.endStopInfo?.stop_name || d.endStopId;

            html += `
          <div class="detour-card" data-detour-id="${d.id}">
            <div class="detour-card-header">
              <div class="detour-card-dir">${dirLabel}</div>
              <div style="display:flex;gap:4px">
                <button class="btn btn-secondary btn-sm btn-show-detour" data-detour-id="${d.id}" title="Show on map">👁</button>
                <button class="btn btn-danger btn-sm btn-end-detour" data-detour-id="${d.id}">End</button>
              </div>
            </div>
            <div class="detour-card-description">${d.description || 'No description'}</div>
            <div class="detour-card-segment">
              <span class="segment-label">⚠</span> ${divergeName} → <span class="segment-label">✓</span> ${rejoinName}
            </div>
            <div class="detour-card-time">
              ${isActive ? '🔴 ACTIVE' : '⏳ Scheduled'} · ${formatTime(d.startTime)} → ${formatTime(d.endTime)}
            </div>
            <div class="detour-card-expand" data-detour-id="${d.id}">▸ Details</div>
            <div class="detour-card-details" id="detour-details-${d.id}" style="display:none">
              <div class="detail-loading">Loading...</div>
            </div>
          </div>`;
        }

        html += '</div>';
    }

    container.innerHTML = html;

    // Bind end buttons
    container.querySelectorAll('.btn-end-detour').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = (e.target as HTMLElement).getAttribute('data-detour-id')!;
            if (confirm('End this detour?')) {
                await api.deleteDetour(id);
                await loadActiveDetours();
            }
        });
    });

    // Bind show-on-map buttons
    container.querySelectorAll('.btn-show-detour').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = (e.target as HTMLElement).getAttribute('data-detour-id')!;
            const detour = detours.find(d => d.id === id);
            if (!detour) return;
            await showDetourOnMap(detour);
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
                await loadDetourDetails(id, detours);
            } else {
                detailsEl.style.display = 'none';
                expandEl.textContent = '▸ Details';
            }
        });
    });
}

/** Cache detours for View All toggle */
let cachedDetours: DetourData[] = [];
let allDetoursVisible = false;

/**
 * Show a single detour on the map with full route context and affected segment highlighting.
 */
async function showDetourOnMap(detour: DetourData) {
    activeDetoursLayer.clearLayers();
    await addRouteContextToLayer(detour, activeDetoursLayer);
    addDetourOverlayToLayer(detour, activeDetoursLayer);

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

    activeDetoursLayer.clearLayers();
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
        document.getElementById('stat-vehicles')!.textContent = `${status.activeVehicles} vehicles`;
        document.getElementById('stat-detours')!.textContent = `${status.activeDetours} detours`;
        updateStatusConnected();
        await loadActiveDetours();
    } catch {
        updateStatusDisconnected();
    }
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
    document.getElementById('btn-create-detour')!.addEventListener('click', startDetourCreation);
    document.getElementById('close-detour-panel')!.addEventListener('click', cancelDetourCreation);

    // Activate detour
    document.getElementById('activate-detour')!.addEventListener('click', activateDetour);

    // Toggle vehicles
    document.getElementById('btn-toggle-vehicles')!.addEventListener('click', toggleVehicles);

    // Toggle all detours
    document.getElementById('btn-toggle-all-detours')!.addEventListener('click', toggleAllDetours);
}

function setDirection(dir: number) {
    selectedDirection = dir;
    document.getElementById('dir-btn-0')!.classList.toggle('active', dir === 0);
    document.getElementById('dir-btn-1')!.classList.toggle('active', dir === 1);
    loadRouteDisplay();
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
}

// ─── Boot ───
init();
bindThemeEvents();
