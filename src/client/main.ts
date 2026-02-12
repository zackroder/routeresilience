import { api, RouteInfo, StopInfo, DetourData, VehicleData } from './api/client.js';

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
    initMap();
    await loadRoutes();
    bindEvents();
    pollStatus();
    setInterval(pollStatus, 15000);
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
    detourShapeLayer = L.layerGroup().addTo(map);
    replacementStopsLayer = L.layerGroup().addTo(map);
    vehiclesLayer = L.layerGroup().addTo(map);
    nearbyStopsLayer = L.layerGroup().addTo(map);

    // Map click handler for detour tracing
    map.on('click', onMapClick);
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
    } else if (detourStep === 'select-rejoin') {
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

        detourStep = 'configure';
        updateDetourStepUI();
    } else if (detourStep === 'trace-path') {
        // Clicking a route stop during trace can be used as a replacement stop
        addReplacementStop(stop.stop_id, stop.stop_name, stop.stop_lat, stop.stop_lon, false);
    }
}

async function onMapClick(e: any) {
    if (detourStep !== 'trace-path') return;

    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    // Add point to detour path
    detourPathPoints.push([lat, lng]);
    redrawDetourPath();

    // Check for nearby existing stops
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
            instructions.innerHTML = 'Click on the map to trace the detour path. Click existing stops or create temporary ones along the way. When done, click <strong>"Set Rejoin Point"</strong> below.';
            // Show a button to move to rejoin selection
            instructions.innerHTML += '<br><br><button class="btn btn-secondary btn-sm" id="btn-set-rejoin">Set Rejoin Point →</button>';
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

// ─── Temp Stop Modal ───

function showTempStopModal() {
    document.getElementById('temp-stop-modal')!.style.display = 'flex';
    (document.getElementById('temp-stop-name') as HTMLInputElement).value = '';
    (document.getElementById('temp-stop-name') as HTMLInputElement).focus();
}

function hideTempStopModal() {
    document.getElementById('temp-stop-modal')!.style.display = 'none';
    pendingTempStopLatLng = null;
}

function confirmTempStop() {
    const name = (document.getElementById('temp-stop-name') as HTMLInputElement).value.trim();
    if (!name || !pendingTempStopLatLng) return;

    const stopId = `temp_${++tempStopCounter}_${Date.now()}`;
    addReplacementStop(stopId, name, pendingTempStopLatLng[0], pendingTempStopLatLng[1], true);
    hideTempStopModal();
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
      <div class="detour-card">
        <div class="detour-card-header">
          <span class="detour-card-route">Route ${route?.route_short_name || d.routeId}</span>
          <button class="btn btn-danger btn-sm" data-detour-id="${d.id}">End</button>
        </div>
        <div class="detour-card-description">${d.description || 'No description'}</div>
        <div class="detour-card-time">
          ${isActive ? '🔴 ACTIVE' : '⏳ Scheduled'} · ${formatTime(d.startTime)} → ${formatTime(d.endTime)}
        </div>
      </div>
    `;
    }).join('');

    container.querySelectorAll('.btn-danger').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = (e.target as HTMLElement).getAttribute('data-detour-id')!;
            if (confirm('End this detour?')) {
                await api.deleteDetour(id);
                await loadActiveDetours();
            }
        });
    });
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
            const icon = L.divIcon({
                className: 'vehicle-marker-container',
                html: `<div class="vehicle-marker" style="transform:rotate(${v.bearing}deg)" title="Bus ${v.vehicleId} — ${v.status}">🚌</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12],
            });
            L.marker([v.lat, v.lon], { icon }).addTo(vehiclesLayer);
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

    // Temp stop modal
    document.getElementById('confirm-temp-stop')!.addEventListener('click', confirmTempStop);
    document.getElementById('cancel-temp-stop')!.addEventListener('click', hideTempStopModal);

    // Toggle vehicles
    document.getElementById('btn-toggle-vehicles')!.addEventListener('click', toggleVehicles);
}

function setDirection(dir: number) {
    selectedDirection = dir;
    document.getElementById('dir-btn-0')!.classList.toggle('active', dir === 0);
    document.getElementById('dir-btn-1')!.classList.toggle('active', dir === 1);
    loadRouteDisplay();
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
