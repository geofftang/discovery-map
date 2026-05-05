import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

const DATA_URL = './discovery.geojson';
const NYC_CENTER = [-73.9857, 40.7484];
const BASE_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';

const state = {
  allData: null,
  filteredData: null,
  category: '',
  search: '',
};

const elements = {
  status: document.querySelector('#status'),
  resultCount: document.querySelector('#result-count'),
  categorySelect: document.querySelector('#category-select'),
  searchInput: document.querySelector('#search-input'),
  details: document.querySelector('#details'),
  detailsName: document.querySelector('#details-name'),
  detailsMeta: document.querySelector('#details-meta'),
  detailsDescription: document.querySelector('#details-description'),
  detailsClose: document.querySelector('#details-close'),
  googleLink: document.querySelector('#google-link'),
};

const map = new maplibregl.Map({
  container: 'map',
  style: BASE_STYLE,
  center: NYC_CENTER,
  zoom: 11,
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

function setStatus(message) {
  elements.status.textContent = message;
  elements.status.hidden = false;
}

function clearStatus() {
  elements.status.hidden = true;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function splitTags(value) {
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
    props.secondary_tags,
    props.city,
    props.hours_summary,
  ].filter(Boolean).join(' '));
}

function filterData() {
  const search = normalize(state.search);
  const category = state.category;
  const features = state.allData.features.filter((feature) => {
    const props = feature.properties || {};
    const categoryMatch = !category || props.category === category;
    const searchMatch = !search || searchableText(feature).includes(search);
    return categoryMatch && searchMatch;
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
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    elements.categorySelect.appendChild(option);
  }
}

function googleMapsUrl(feature) {
  const props = feature.properties || {};
  const [lng, lat] = feature.geometry?.coordinates || [];
  const query = encodeURIComponent([props.name, props.city].filter(Boolean).join(' '));

  if (props.google_place_id) {
    return `https://www.google.com/maps/search/?api=1&query=${query}&query_place_id=${encodeURIComponent(props.google_place_id)}`;
  }

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }

  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function pill(label, variant = '') {
  const item = document.createElement('span');
  item.className = variant ? `pill ${variant}` : 'pill';
  item.textContent = label;
  return item;
}

function openDetails(feature) {
  const props = feature.properties || {};
  const tags = splitTags(props.secondary_tags).slice(0, 6);
  const detailLines = [
    props.description,
    props.hours_summary ? `Hours: ${props.hours_summary}` : '',
    props.rating ? `Rating: ${props.rating}` : '',
  ].filter(Boolean);

  elements.detailsName.textContent = props.name || 'Untitled place';
  elements.detailsMeta.replaceChildren();

  if (props.category) elements.detailsMeta.appendChild(pill(props.category));
  if (props.signal) elements.detailsMeta.appendChild(pill(props.signal, 'subtle'));
  tags.forEach((tag) => elements.detailsMeta.appendChild(pill(tag, 'subtle')));

  elements.detailsDescription.textContent = detailLines.length ? detailLines.join('\n\n') : 'No notes yet.';
  elements.googleLink.href = googleMapsUrl(feature);
  elements.details.hidden = false;
}

function closeDetails() {
  elements.details.hidden = true;
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
    clusterRadius: 48,
    clusterMaxZoom: 14,
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
      'circle-color': '#f8fafc',
      'circle-radius': 6,
      'circle-stroke-color': '#0f766e',
      'circle-stroke-width': 2,
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

elements.categorySelect.addEventListener('change', (event) => {
  state.category = event.target.value;
  closeDetails();
  updateSource();
});

elements.searchInput.addEventListener('input', debounce((event) => {
  state.search = event.target.value;
  closeDetails();
  updateSource();
}, 120));

elements.detailsClose.addEventListener('click', closeDetails);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDetails();
});
