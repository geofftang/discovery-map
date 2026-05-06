import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import bakeryIcon from '@mapbox/maki/icons/bakery.svg?raw';
import barIcon from '@mapbox/maki/icons/bar.svg?raw';
import cafeIcon from '@mapbox/maki/icons/cafe.svg?raw';
import playgroundIcon from '@mapbox/maki/icons/playground.svg?raw';
import restaurantIcon from '@mapbox/maki/icons/restaurant.svg?raw';

const DATA_URL = './discovery.geojson';
const NYC_CENTER = [-73.9857, 40.7484];
const BASE_STYLE = 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
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
  search: '',
};

const elements = {
  status: document.querySelector('#status'),
  resultCount: document.querySelector('#result-count'),
  toolbar: document.querySelector('.toolbar'),
  toolbarToggle: document.querySelector('#toolbar-toggle'),
  categoryOptions: document.querySelector('#category-options'),
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
  const features = state.allData.features.filter((feature) => {
    const props = feature.properties || {};
    const categoryMatch = !state.selectedCategories.size || state.selectedCategories.has(props.category);
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
    state.selectedCategories.add(category);

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
  const tags = splitTags(props.secondary_tags).slice(0, 6);
  const detailLines = [
    props.description,
    props.hours_summary ? `Hours: ${props.hours_summary}` : '',
    props.rating ? `Rating: ${props.rating}` : '',
  ].filter(Boolean);

  elements.detailsName.textContent = props.name || 'Untitled place';
  elements.detailsMeta.replaceChildren();

  if (props.category) elements.detailsMeta.appendChild(pill(props.category, categoryClass(props.category)));
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

elements.categoryOptions.addEventListener('change', (event) => {
  if (!event.target.matches('input[type="checkbox"]')) return;

  if (event.target.checked) {
    state.selectedCategories.add(event.target.value);
  } else {
    state.selectedCategories.delete(event.target.value);
  }

  closeDetails();
  updateSource();
});

elements.searchInput.addEventListener('input', debounce((event) => {
  state.search = event.target.value;
  closeDetails();
  updateSource();
}, 120));

elements.toolbarToggle.addEventListener('click', () => {
  setToolbarCollapsed(!elements.toolbar.classList.contains('collapsed'));
});

elements.detailsClose.addEventListener('click', closeDetails);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDetails();
});
