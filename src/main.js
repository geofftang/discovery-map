import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import './registerServiceWorker.js';
import bakeryIcon from '@mapbox/maki/icons/bakery.svg?raw';
import barIcon from '@mapbox/maki/icons/bar.svg?raw';
import cafeIcon from '@mapbox/maki/icons/cafe.svg?raw';
import playgroundIcon from '@mapbox/maki/icons/playground.svg?raw';
import restaurantIcon from '@mapbox/maki/icons/restaurant.svg?raw';

// Public build reads the committed GeoJSON; the private build (vite --mode private, .env.private)
// reads ./private.json, the owner payload built by scripts/build_places_index.py.
const DATA_URL = import.meta.env.VITE_DATA_URL || './discovery.geojson';
const PRIVATE = import.meta.env.VITE_PRIVATE === '1';
// Fallback default when no one has ever set a home view (see HOME_STORAGE_KEY below).
// Currently Venice — the active trip leg. Update as the trip moves, or just use the
// "Set as home" button so this doesn't need a code change each time.
const DEFAULT_CENTER = [12.3358, 45.4342];
const DEFAULT_ZOOM = 13;
const HOME_STORAGE_KEY = 'discovery-map-home-view';
const BASE_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
// Free, no-key OpenStreetMap geocoder (CORS-enabled public instance). Lets the
// search box find places that aren't on the map yet, not just filter the dataset.
const PHOTON_URL = 'https://photon.komoot.io/api/';
const CATEGORY_COLORS = {
  Activities: '#16a34a',
  Cafe: '#f59e0b',
  Dessert: '#db2777',
  Drinks: '#7c3aed',
  Meal: '#dc6b19',
};
const DEFAULT_CATEGORY_COLOR = '#475569';
const CATEGORY_ICONS = {
  Activities: playgroundIcon,
  Cafe: cafeIcon,
  Dessert: bakeryIcon,
  Drinks: barIcon,
  Meal: restaurantIcon,
};
const CATEGORY_ICON_IDS = {
  Activities: 'category-playground',
  Cafe: 'category-cafe',
  Dessert: 'category-bakery',
  Drinks: 'category-bar',
  Meal: 'category-restaurant',
};

const state = {
  allData: null,
  filteredData: null,
  selectedCategories: new Set(),
  allCategories: new Set(),
  search: '',
  showAll: false,
  geoResults: [],
  geoPending: false,
  geoController: null,
  tempMarker: null,
};

const elements = {
  status: document.querySelector('#status'),
  resultCount: document.querySelector('#result-count'),
  toolbar: document.querySelector('.toolbar'),
  toolbarToggle: document.querySelector('#toolbar-toggle'),
  categoryOptions: document.querySelector('#category-options'),
  privateBadge: document.querySelector('#private-badge'),
  showAllControl: document.querySelector('#show-all-control'),
  showAll: document.querySelector('#show-all'),
  detailsAdvisory: document.querySelector('#details-advisory'),
  detailsEvidenceBlock: document.querySelector('#details-evidence-block'),
  detailsEvidence: document.querySelector('#details-evidence'),
  searchInput: document.querySelector('#search-input'),
  searchClear: document.querySelector('#search-clear'),
  searchResults: document.querySelector('#search-results'),
  details: document.querySelector('#details'),
  detailsName: document.querySelector('#details-name'),
  detailsMeta: document.querySelector('#details-meta'),
  detailsDescription: document.querySelector('#details-description'),
  detailsTake: document.querySelector('#details-take'),
  detailsTakeBlock: document.querySelector('#details-take-block'),
  detailsNotesLabel: document.querySelector('#details-notes-label'),
  detailsClose: document.querySelector('#details-close'),
  googleLink: document.querySelector('#google-link'),
};

function loadHomeView() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOME_STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.center) && typeof saved.zoom === 'number') return saved;
  } catch {
    // ignore corrupt localStorage value, fall through to default
  }
  return { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM };
}

function saveHomeView() {
  const center = map.getCenter();
  localStorage.setItem(
    HOME_STORAGE_KEY,
    JSON.stringify({ center: [center.lng, center.lat], zoom: map.getZoom() }),
  );
}

const homeView = loadHomeView();

const map = new maplibregl.Map({
  container: 'map',
  style: BASE_STYLE,
  center: homeView.center,
  zoom: homeView.zoom,
  maxZoom: 18,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
  }),
  'top-right',
);

// Small custom control, styled to match the built-in nav/geolocate buttons above it.
// Saves the current view as the load-time default (see loadHomeView/saveHomeView) —
// lets the default follow an active trip leg without a code change each time.
class SetHomeControl {
  onAdd() {
    this._container = document.createElement('div');
    this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    this._button = document.createElement('button');
    this._button.type = 'button';
    this._button.title = 'Set current view as the default on load';
    this._button.setAttribute('aria-label', 'Set current view as the default on load');
    this._button.textContent = '📍';
    this._button.addEventListener('click', () => {
      saveHomeView();
      this._button.textContent = '✓';
      setTimeout(() => {
        this._button.textContent = '📍';
      }, 1200);
    });
    this._container.appendChild(this._button);
    return this._container;
  }

  onRemove() {
    this._container.remove();
  }
}

map.addControl(new SetHomeControl(), 'top-right');

function setStatus(message) {
  elements.status.textContent = message;
  elements.status.hidden = false;
}

function clearStatus() {
  elements.status.hidden = true;
}

function setToolbarCollapsed(collapsed) {
  elements.toolbar.classList.toggle('collapsed', collapsed);
  elements.toolbarToggle.textContent = collapsed ? '+' : '−';
  elements.toolbarToggle.setAttribute('aria-label', collapsed ? 'Expand filters' : 'Collapse filters');
  elements.toolbarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function splitTags(value) {
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean);
  return String(value || '')
    .split(/[;,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function searchableText(feature) {
  const props = feature.properties || {};
  return normalize([
    props.name,
    props.category,
    props.description,
    props.my_take,
    props.secondary_tags,
    props.city,
    // private payload only: facets, lists, evidence lines (arrays)
    ...splitTags(props.kind),
    ...splitTags(props.cuisine),
    ...splitTags(props.lists),
    ...splitTags(props.tags),
    ...splitTags(props.evidence),
  ].filter(Boolean).join(' '));
}

function filterData() {
  const search = normalize(state.search);
  const features = state.allData.features.filter((feature) => {
    const props = feature.properties || {};
    const categoryMatch = !state.selectedCategories.size || state.selectedCategories.has(props.category);
    const searchMatch = !search || searchableText(feature).includes(search);
    // Owner build: the record's own status/hidden govern display (never a provider claim).
    // Closed and hidden pins stay out unless "Show closed & hidden" is on.
    const displayMatch = !PRIVATE || state.showAll || (props.status === 'open' && !props.hidden);
    return categoryMatch && searchMatch && displayMatch;
  });

  return {
    ...state.allData,
    features,
  };
}

function updateSource() {
  state.filteredData = filterData();
  const source = map.getSource('places');

  if (source) {
    source.setData(state.filteredData);
  }

  const visible = state.filteredData.features.length;
  const total = state.allData.features.length;
  elements.resultCount.textContent = visible === total
    ? `${total.toLocaleString()} places`
    : `${visible.toLocaleString()} of ${total.toLocaleString()} places`;
}

function fillCategoryOptions(data) {
  const categories = [...new Set(data.features.map((feature) => feature.properties?.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  for (const category of categories) {
    state.selectedCategories.add(category);
    state.allCategories.add(category);

    const label = document.createElement('label');
    label.className = `category-option ${categoryClass(category)}`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = category;
    input.checked = true;

    const swatch = document.createElement('span');
    swatch.className = 'category-swatch';
    swatch.style.backgroundColor = CATEGORY_COLORS[category] || DEFAULT_CATEGORY_COLOR;

    const text = document.createElement('span');
    text.textContent = category;

    label.append(input, swatch, text);
    elements.categoryOptions.appendChild(label);
  }
}

function categoryColorExpression() {
  const expression = ['match', ['get', 'category']];

  for (const [category, color] of Object.entries(CATEGORY_COLORS)) {
    expression.push(category, color);
  }

  expression.push(DEFAULT_CATEGORY_COLOR);
  return expression;
}

function categoryIconExpression() {
  const expression = ['match', ['get', 'category']];

  for (const [category, iconId] of Object.entries(CATEGORY_ICON_IDS)) {
    expression.push(category, iconId);
  }

  expression.push('category-restaurant');
  return expression;
}

function svgToImage(svgText) {
  return new Promise((resolve, reject) => {
    const image = new Image(18, 18);
    const svg = svgText.replace('<svg ', '<svg fill="#ffffff" ');
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load category icon.'));
    };
    image.src = url;
  });
}

async function registerCategoryIcons() {
  for (const [category, svgText] of Object.entries(CATEGORY_ICONS)) {
    const iconId = CATEGORY_ICON_IDS[category];

    if (!map.hasImage(iconId)) {
      map.addImage(iconId, await svgToImage(svgText), { pixelRatio: 1 });
    }
  }
}

function googleMapsUrl(feature) {
  const props = feature.properties || {};
  const [lng, lat] = feature.geometry?.coordinates || [];
  const placeQuery = [props.name, props.city || 'NYC'].filter(Boolean).join(' ');
  const query = encodeURIComponent(placeQuery);

  if (props.google_place_id) {
    return `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(props.google_place_id)}`;
  }

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }

  if (placeQuery.trim()) {
    return `https://www.google.com/maps/search/?api=1&query=${query}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function pill(label, variant = '') {
  const item = document.createElement('span');
  item.className = variant ? `pill ${variant}` : 'pill';
  item.textContent = label;
  return item;
}

function categoryClass(category) {
  return `category-${normalize(category).replaceAll(/[^a-z0-9]+/g, '-')}`;
}

function openDetails(feature) {
  const props = feature.properties || {};
  const tags = splitTags(props.secondary_tags ?? props.tags).slice(0, 6);
  const facetPills = PRIVATE
    ? [
      ...splitTags(props.kind).slice(1).map((k) => pill(k, 'facet')),
      ...splitTags(props.cuisine).map((c) => pill(c, 'facet')),
      ...splitTags(props.lists).map((l) => pill(l, 'list')),
    ]
    : [];
  const detailLines = [
    props.description,
  ].filter(Boolean);

  elements.detailsName.textContent = props.name || 'Untitled place';
  elements.detailsMeta.replaceChildren();

  if (props.category) elements.detailsMeta.appendChild(pill(props.category, categoryClass(props.category)));
  if (props.signal) elements.detailsMeta.appendChild(pill(props.signal, 'subtle'));
  if (PRIVATE && props.status && props.status !== 'open') elements.detailsMeta.appendChild(pill(props.status, 'status'));
  if (PRIVATE && props.hidden) elements.detailsMeta.appendChild(pill('hidden', 'status'));
  facetPills.forEach((p) => elements.detailsMeta.appendChild(p));
  tags.forEach((tag) => elements.detailsMeta.appendChild(pill(tag, 'subtle')));

  // Provider claim rendered as an advisory beside the owner's status -- surfaced, never resolved
  // (a Google closure has been wrong three times out of three noticed). Only the owner build has it.
  const providerStatus = String(props.provider_status || '');
  const advisory = PRIVATE && providerStatus && providerStatus !== 'OPERATIONAL'
    ? `Google reports ${providerStatus.toLowerCase().replaceAll('_', ' ')}`
      + (props.provider_observed_at ? `, seen ${String(props.provider_observed_at).slice(0, 10)}` : '')
      + ` — your record says ${props.status || 'open'}`
    : '';
  elements.detailsAdvisory.hidden = !advisory;
  elements.detailsAdvisory.textContent = advisory;

  const evidence = PRIVATE ? splitTags(props.evidence) : [];
  elements.detailsEvidenceBlock.hidden = !evidence.length;
  elements.detailsEvidence.replaceChildren(...evidence.map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));

  // Two separate blocks, not one string with a separator in it. The user's own
  // verdict and third-party sourced notes are different things and answer
  // different questions; merging them re-creates the mixed-purpose field the
  // schema split exists to avoid. textContent (not innerHTML) throughout —
  // this text comes from a CSV, so rendering it as markup would be an
  // injection hole.
  const take = props.my_take;
  elements.detailsTakeBlock.hidden = !take;
  elements.detailsTake.textContent = take || '';

  const notes = detailLines.length ? detailLines.join('\n\n') : '';
  // Only label the notes when there is a take to distinguish them from.
  elements.detailsNotesLabel.hidden = !(take && notes);
  elements.detailsDescription.textContent = notes || (take ? '' : 'No notes yet.');
  elements.googleLink.href = googleMapsUrl(feature);
  elements.details.hidden = false;
}

function closeDetails() {
  elements.details.hidden = true;
}

function buildResultItem({ title, subtitle, remote, onSelect }) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = remote ? 'search-result-item search-result-item--remote' : 'search-result-item';
  const nameEl = document.createElement('span');
  nameEl.className = 'search-result-name';
  nameEl.textContent = title || 'Untitled';
  const subEl = document.createElement('span');
  subEl.className = 'search-result-cat';
  subEl.textContent = subtitle || '';
  item.append(nameEl, subEl);
  item.addEventListener('click', onSelect);
  return item;
}

function localMatches(query) {
  if (!state.allData) return [];
  return state.allData.features
    .filter((f) => searchableText(f).includes(query))
    .slice(0, 5);
}

function clearTempMarker() {
  if (state.tempMarker) {
    state.tempMarker.remove();
    state.tempMarker = null;
  }
}

// Turn a Photon result into a feature the existing detail panel + Google handoff
// already know how to render. These places are NOT in the dataset.
function photonToFeature(raw) {
  const coords = raw.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const p = raw.properties || {};
  const streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
  const name = p.name || streetLine || p.city || 'Unnamed place';
  const address = [streetLine, p.city || p.district, p.state, p.country]
    .filter(Boolean)
    .filter((part) => part !== name)
    .join(', ');

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [coords[0], coords[1]] },
    properties: {
      name,
      signal: 'Not on your map',
      description: address,
      city: p.city || '',
      remote: true,
    },
  };
}

// Picking a result is an act of navigation, not filtering — drop the text filter
// so the user's own pins stay visible around wherever they're heading.
function resetSearchFilter() {
  state.search = '';
  state.geoResults = [];
  state.geoPending = false;
  if (state.geoController) state.geoController.abort();
  elements.searchInput.value = '';
  elements.searchClear.hidden = true;
  updateSource();
}

function selectGeocoded(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  clearTempMarker();
  state.tempMarker = new maplibregl.Marker({ color: '#2563eb' })
    .setLngLat([lng, lat])
    .addTo(map);
  resetSearchFilter();
  map.flyTo({ center: [lng, lat], zoom: 16, duration: 600 });
  openDetails(feature);
  elements.searchResults.hidden = true;
}

function renderSearchResults() {
  const query = normalize(state.search);
  if (!query) {
    elements.searchResults.replaceChildren();
    elements.searchResults.hidden = true;
    return;
  }

  const frag = document.createDocumentFragment();
  const local = localMatches(query);

  for (const feature of local) {
    const props = feature.properties || {};
    frag.appendChild(buildResultItem({
      title: props.name,
      subtitle: props.category || '',
      onSelect: () => {
        const [lng, lat] = feature.geometry.coordinates;
        clearTempMarker();
        resetSearchFilter();
        map.flyTo({ center: [lng, lat], zoom: 16, duration: 500 });
        openDetails(feature);
        elements.searchResults.hidden = true;
      },
    }));
  }

  if (state.geoResults.length) {
    const header = document.createElement('div');
    header.className = 'search-result-header';
    header.textContent = 'Not on your map · OpenStreetMap';
    frag.appendChild(header);
    for (const feature of state.geoResults) {
      const props = feature.properties || {};
      frag.appendChild(buildResultItem({
        title: props.name,
        subtitle: props.description || '',
        remote: true,
        onSelect: () => selectGeocoded(feature),
      }));
    }
  } else if (state.geoPending) {
    const pending = document.createElement('div');
    pending.className = 'search-result-pending';
    pending.textContent = 'Searching everywhere…';
    frag.appendChild(pending);
  }

  const hasContent = local.length || state.geoResults.length || state.geoPending;
  elements.searchResults.replaceChildren(frag);
  elements.searchResults.hidden = !hasContent;
}

async function runGeocode() {
  const query = normalize(state.search);
  // Skip very short queries — too noisy, and respects the public instance's fair use.
  if (query.length < 3) {
    state.geoResults = [];
    state.geoPending = false;
    renderSearchResults();
    return;
  }

  if (state.geoController) state.geoController.abort();
  const controller = new AbortController();
  state.geoController = controller;
  state.geoPending = true;
  state.geoResults = [];
  renderSearchResults();

  const center = map.getCenter();
  const url = `${PHOTON_URL}?q=${encodeURIComponent(state.search)}&limit=5&lang=en`
    + `&lat=${center.lat}&lon=${center.lng}`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Photon ${response.status}`);
    const data = await response.json();
    if (normalize(state.search) !== query) return; // a newer query superseded this one
    state.geoResults = (data.features || []).map(photonToFeature).filter(Boolean);
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Geocoder error', error);
      state.geoResults = [];
    }
  } finally {
    if (state.geoController === controller) {
      state.geoController = null;
      state.geoPending = false;
      renderSearchResults();
    }
  }
}

function debounce(fn, wait) {
  let timeoutId;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => fn(...args), wait);
  };
}

function addPlaceLayers(data) {
  map.addSource('places', {
    type: 'geojson',
    data,
    cluster: true,
    clusterRadius: 32,
    clusterMaxZoom: 12,
  });

  map.addLayer({
    id: 'clusters',
    type: 'circle',
    source: 'places',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': ['step', ['get', 'point_count'], '#0f766e', 25, '#2563eb', 100, '#7c3aed'],
      'circle-radius': ['step', ['get', 'point_count'], 17, 25, 23, 100, 31],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });

  map.addLayer({
    id: 'cluster-count',
    type: 'symbol',
    source: 'places',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-size': 12,
    },
    paint: {
      'text-color': '#ffffff',
    },
  });

  map.addLayer({
    id: 'unclustered-point',
    type: 'circle',
    source: 'places',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': categoryColorExpression(),
      'circle-radius': 11,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2.5,
    },
  });

  map.addLayer({
    id: 'category-icons',
    type: 'symbol',
    source: 'places',
    filter: ['!', ['has', 'point_count']],
    layout: {
      'icon-image': categoryIconExpression(),
      'icon-size': 0.9,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  map.addLayer({
    id: 'place-labels',
    type: 'symbol',
    source: 'places',
    minzoom: 14,
    filter: ['!', ['has', 'point_count']],
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-anchor': 'top',
      'text-offset': [0, 1.35],
      'text-max-width': 10,
      'text-padding': 4,
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': '#172026',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1.4,
      'text-halo-blur': 0.3,
    },
  });
}

function bindMapInteractions() {
  map.on('click', 'clusters', async (event) => {
    const features = map.queryRenderedFeatures(event.point, { layers: ['clusters'] });
    const cluster = features[0];
    const clusterId = cluster?.properties?.cluster_id;
    if (clusterId === undefined) return;

    const zoom = await map.getSource('places').getClusterExpansionZoom(clusterId);
    map.easeTo({ center: cluster.geometry.coordinates, zoom, duration: 350 });
  });

  map.on('click', 'unclustered-point', (event) => {
    const feature = event.features?.[0];
    if (feature) openDetails(feature);
  });

  for (const layerId of ['clusters', 'unclustered-point']) {
    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}

async function loadData() {
  const response = await fetch(DATA_URL);
  if (!response.ok) throw new Error(`Failed to load ${DATA_URL}: ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data.features)) throw new Error('GeoJSON does not contain a features array.');

  return data;
}

map.on('load', async () => {
  try {
    setStatus('Loading places...');
    state.allData = await loadData();
    state.filteredData = state.allData;

    fillCategoryOptions(state.allData);
    await registerCategoryIcons();
    addPlaceLayers(state.filteredData);
    bindMapInteractions();
    updateSource();
    clearStatus();
  } catch (error) {
    console.error(error);
    setStatus('Could not load the discovery map data.');
  }
});

map.on('error', (event) => {
  console.error(event.error || event);
});

elements.categoryOptions.addEventListener('click', (event) => {
  const label = event.target.closest('.category-option');
  if (!label) return;
  event.preventDefault();
  const input = label.querySelector('input');
  const category = input.value;
  // Everything selected (the unfiltered default) reads as "no filter" — clicking a
  // category from there isolates to just that one. From a partial selection, clicks
  // toggle normally (add if absent, remove if present); emptying the set falls back
  // to "show everything" rather than showing nothing.
  const isUnfiltered = state.selectedCategories.size === state.allCategories.size;

  if (isUnfiltered) {
    state.selectedCategories.clear();
    state.selectedCategories.add(category);
  } else if (state.selectedCategories.has(category)) {
    state.selectedCategories.delete(category);
    if (state.selectedCategories.size === 0) {
      state.allCategories.forEach((c) => state.selectedCategories.add(c));
    }
  } else {
    state.selectedCategories.add(category);
  }

  elements.categoryOptions.querySelectorAll('input').forEach((inp) => {
    inp.checked = state.selectedCategories.has(inp.value);
  });

  closeDetails();
  updateSource();
});

const debouncedGeocode = debounce(runGeocode, 300);

elements.searchInput.addEventListener('input', debounce((event) => {
  state.search = event.target.value;
  elements.searchClear.hidden = !state.search;
  closeDetails();
  updateSource();
  renderSearchResults();
  debouncedGeocode();
}, 120));

elements.searchClear.addEventListener('click', () => {
  elements.searchInput.value = '';
  elements.searchClear.hidden = true;
  elements.searchResults.hidden = true;
  state.search = '';
  state.geoResults = [];
  state.geoPending = false;
  if (state.geoController) state.geoController.abort();
  clearTempMarker();
  closeDetails();
  updateSource();
  elements.searchInput.focus();
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.search-control')) {
    elements.searchResults.hidden = true;
  }
});

elements.toolbarToggle.addEventListener('click', () => {
  setToolbarCollapsed(!elements.toolbar.classList.contains('collapsed'));
});


elements.detailsClose.addEventListener('click', closeDetails);

if (PRIVATE) {
  elements.privateBadge.hidden = false;
  elements.showAllControl.hidden = false;
  elements.showAll.addEventListener('change', (event) => {
    state.showAll = event.target.checked;
    closeDetails();
    if (state.allData) updateSource();
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDetails();
});
