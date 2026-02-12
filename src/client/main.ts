import { api, RouteInfo, StopInfo, DetourData, VehicleData } from './services';

// ─── Declare Leaflet global from CDN ───
declare const L: any;

// ─── State ───
let map: any;
let selectedRoute: RouteInfo | null = null;
let selectedDirection = 0;
let allRoutes: RouteInfo[] = [];

// Map layers
let routeShapeLayer: any = null;
let stopsLayer: any = null;
let detourShapeLayer: any = null;
let replacementStopsLayer: any = null;
let vehiclesLayer: any = null;
let nearbyStopsLayer: any = null;
let activeDetoursLayer: any = null;

// Detour creation state
type DetourStep = 'idle' | 'select-diverge' | 'trace-path' | 'select-rejoin' | 'configure';
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

    // Dark map tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
    }).addTo(map);

    // Initialize layer groups
    routeShapeLayer = L.layerGroup().addTo(map);
    stopsLayer = L.layerGroup().addTo(map);
    activeDetoursLayer = L.layerGroup().addTo(map);
    detourShapeLayer = L.layerGroup().addTo(map);
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
        // If we have traced at least 2 points, treat clicking a route stop as the rejoin point
        if (detourPathPoints.length >= 2) {
            // Check if this stop is AFTER the diverge stop in the sequence
            const divergeIdx = currentRouteStops.findIndex(s => s.stop_id === divergeStopId);
            const thisIdx = currentRouteStops.findIndex(s => s.stop_id === stop.stop_id);
            if (thisIdx > divergeIdx) {
                // Auto-rejoin: snap the detour line to this stop and go to configure
                finalizeRejoinStop(stop);
                return;
            }
        }
        // Otherwise treat as a replacement stop along the detour
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

    detourStep = 'configure';
    updateDetourStepUI();
    showMapTooltip([stop.stop_lat, stop.stop_lon], '✔ Rejoin set! Configure detour details in the sidebar.', 3000);
}

async function onMapClick(e: any) {
    if (detourStep !== 'trace-path') return;

    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    // Snap to road using OSRM and add all snapped points
    if (detourPathPoints.length > 0) {
        const prev = detourPathPoints[detourPathPoints.length - 1];
        const snappedSegment = await snapToRoad(prev[0], prev[1], lat, lng);
        if (snappedSegment.length > 0) {
            // Add all snapped points (skip first since it duplicates previous end)
            for (let i = 1; i < snappedSegment.length; i++) {
                detourPathPoints.push(snappedSegment[i]);
            }
        } else {
            // Fallback: straight line
            detourPathPoints.push([lat, lng]);
        }
    } else {
        detourPathPoints.push([lat, lng]);
    }
    redrawDetourPath();

    // Check for nearby existing stops near the clicked point
    try {
        const nearbyStops = await api.getNearbyStops(lat, lng, 100);
        nearbyStopsLayer.clearLayers();

        if (nearbyStops.length > 0) {
            // Show nearby stops user could snap to
            for (const stop of nearbyStops) {
                const marker = L.circleMarker([stop.stop_lat, stop.stop_lon], {
                    radius: 7,
                    fillColor: '#f59e0b',
                    color: '#ffffff',
                    weight: 2,
                    fillOpacity: 0.9,
                });
                marker.bindTooltip(`📍 ${stop.stop_name} (click to add)`, { direction: 'top' });
                marker.on('click', () => {
                    addReplacementStop(stop.stop_id, stop.stop_name, stop.stop_lat, stop.stop_lon, false);
                    nearbyStopsLayer.clearLayers();
                });
                marker.addTo(nearbyStopsLayer);
            }
        } else {
            // Offer to create a temporary stop
            pendingTempStopLatLng = [lat, lng];
            showTempStopModal();
        }
    } catch (err) {
        // If nearby search fails, just offer temp stop
        pendingTempStopLatLng = [lat, lng];
        showTempStopModal();
    }
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
    const steps = ['select-diverge', 'trace-path', 'select-rejoin', 'configure'];
    const currentIdx = steps.indexOf(detourStep);

    for (let i = 0; i < 4; i++) {
        const indicator = document.getElementById(`step-${i + 1}-indicator`)!;
        indicator.classList.remove('active', 'completed');
        if (i < currentIdx) indicator.classList.add('completed');
        if (i === currentIdx) indicator.classList.add('active');
    }

    const instructions = document.getElementById('step-instructions')!;
    switch (detourStep) {
        case 'select-diverge':
            instructions.innerHTML = 'Click on a stop where the detour <strong>begins</strong> (diverge point).';
            document.getElementById('detour-config')!.style.display = 'none';
            break;
        case 'trace-path':
            instructions.innerHTML = 'Click the map to trace the detour path <em>(snaps to roads)</em>. Click a <strong>route stop</strong> to set the rejoin point, or right-click to undo.';
            // Show undo and set-rejoin buttons
            instructions.innerHTML += '<br><br><div style="display:flex;gap:6px"><button class="btn btn-secondary btn-sm" id="btn-undo-segment">↩ Undo</button><button class="btn btn-secondary btn-sm" id="btn-set-rejoin">Set Rejoin Point →</button></div>';
            document.getElementById('btn-undo-segment')?.addEventListener('click', undoLastSegment);
            document.getElementById('btn-set-rejoin')?.addEventListener('click', () => {
                detourStep = 'select-rejoin';
                updateDetourStepUI();
            });
            break;
        case 'select-rejoin':
            instructions.innerHTML = 'Click on a stop where the detour <strong>ends</strong> (rejoin point).';
            break;
        case 'configure':
            instructions.innerHTML = 'Configure the detour details and activate when ready.';
            document.getElementById('detour-config')!.style.display = 'block';
            // Set default start time to now, end time to 4 hours from now
            const now = new Date();
            const later = new Date(now.getTime() + 4 * 60 * 60 * 1000);
            (document.getElementById('detour-start') as HTMLInputElement).value = toLocalISO(now);
            (document.getElementById('detour-end') as HTMLInputElement).value = toLocalISO(later);
            break;
    }
}



// ─── Activate Detour ───

async function activateDetour() {
    if (!selectedRoute || !divergeStopId || !rejoinStopId) return;

    const description = (document.getElementById('detour-description') as HTMLTextAreaElement).value;
    const startTime = (document.getElementById('detour-start') as HTMLInputElement).value;
    const endTime = (document.getElementById('detour-end') as HTMLInputElement).value;

    if (!startTime || !endTime) {
        alert('Please set start and end times.');
        return;
    }

    try {
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
        cancelDetourCreation();
        await loadActiveDetours();
    } catch (err) {
        console.error('Failed to create detour:', err);
        alert('Failed to create detour. Check console for details.');
    }
}

// ─── Active Detours ───

async function loadActiveDetours() {
    try {
        const detours = await api.getDetours();
        renderActiveDetours(detours);
        renderActiveDetoursOnMap(detours);
    } catch (err) {
        console.error('Failed to load detours:', err);
    }
}

function renderActiveDetours(detours: DetourData[]) {
    const container = document.getElementById('active-detours-list')!;
    const countBadge = document.getElementById('active-detour-count')!;

    const now = new Date();
    const active = detours.filter(d => new Date(d.startTime) <= now && new Date(d.endTime) >= now);
    countBadge.textContent = String(active.length);

    if (detours.length === 0) {
        container.innerHTML = '<p class="empty-state">No active detours</p>';
        return;
    }

    container.innerHTML = detours.map(d => {
        const isActive = new Date(d.startTime) <= now && new Date(d.endTime) >= now;
        const route = allRoutes.find(r => r.route_id === d.routeId);
        return `
      <div class="detour-card" data-detour-id="${d.id}">
        <div class="detour-card-header">
          <span class="detour-card-route">Route ${route?.route_short_name || d.routeId}</span>
          <div style="display:flex;gap:4px">
            <button class="btn btn-secondary btn-sm btn-show-detour" data-detour-id="${d.id}" title="Show on map">📍</button>
            <button class="btn btn-danger btn-sm btn-end-detour" data-detour-id="${d.id}">End</button>
          </div>
        </div>
        <div class="detour-card-description">${d.description || 'No description'}</div>
        <div class="detour-card-time">
          ${isActive ? '🔴 ACTIVE' : '⏳ Scheduled'} · ${formatTime(d.startTime)} → ${formatTime(d.endTime)}
        </div>
      </div>
    `;
    }).join('');

    container.querySelectorAll('.btn-end-detour').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = (e.target as HTMLElement).getAttribute('data-detour-id')!;
            if (confirm('End this detour?')) {
                await api.deleteDetour(id);
                await loadActiveDetours();
            }
        });
    });

    container.querySelectorAll('.btn-show-detour').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = (e.target as HTMLElement).getAttribute('data-detour-id')!;
            const detour = detours.find(d => d.id === id);
            if (detour && detour.detourShape && detour.detourShape.length > 1) {
                map.fitBounds(L.latLngBounds(detour.detourShape), { padding: [80, 80] });
            }
        });
    });
}

/**
 * Render active detours on the map with dashed red lines and labeled markers.
 */
function renderActiveDetoursOnMap(detours: DetourData[]) {
    activeDetoursLayer.clearLayers();
    const now = new Date();

    for (const d of detours) {
        const isActive = new Date(d.startTime) <= now && new Date(d.endTime) >= now;
        if (!isActive) continue;

        const route = allRoutes.find(r => r.route_id === d.routeId);
        const routeLabel = route ? route.route_short_name : d.routeId;

        // Draw detour path
        if (d.detourShape && d.detourShape.length > 1) {
            L.polyline(d.detourShape, {
                color: '#ef4444',
                weight: 5,
                opacity: 0.85,
                dashArray: '10, 6',
            }).bindTooltip(`Route ${routeLabel} Detour`, { sticky: true })
                .addTo(activeDetoursLayer);
        }

        // Diverge marker — use enriched stop info from API
        const diverge = d.startStopInfo;
        if (diverge) {
            L.circleMarker([diverge.stop_lat, diverge.stop_lon], {
                radius: 9, fillColor: '#ef4444', color: '#fff', weight: 2, fillOpacity: 1
            }).bindTooltip(`⚠ DETOUR START: ${diverge.stop_name} (Rt ${routeLabel})`, { permanent: false, direction: 'top' })
                .addTo(activeDetoursLayer);
        }

        // Rejoin marker — use enriched stop info from API
        const rejoin = d.endStopInfo;
        if (rejoin) {
            L.circleMarker([rejoin.stop_lat, rejoin.stop_lon], {
                radius: 9, fillColor: '#10b981', color: '#fff', weight: 2, fillOpacity: 1
            }).bindTooltip(`✓ DETOUR END: ${rejoin.stop_name} (Rt ${routeLabel})`, { permanent: false, direction: 'top' })
                .addTo(activeDetoursLayer);
        }

        // Replacement stop markers
        for (const rs of d.replacementStops || []) {
            L.circleMarker([rs.lat, rs.lon], {
                radius: 6, fillColor: rs.isTemporary ? '#f59e0b' : '#3b82f6',
                color: '#fff', weight: 1.5, fillOpacity: 0.9
            }).bindTooltip(rs.stopName + (rs.isTemporary ? ' (temp)' : ''), { direction: 'top' })
                .addTo(activeDetoursLayer);
        }
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

function toLocalISO(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ─── Boot ───
init();
