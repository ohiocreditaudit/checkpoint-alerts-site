'use strict';

/*
 * Checkpoint times are Ohio wall-clock whatever the viewer's timezone is;
 * a checkpoint that ran 8 pm to midnight should never display as 5 pm
 * because someone opened this in California.
 */
const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
});

const COLORS = { active: '#c22f3d', upcoming: '#c22f3d', past: '#7c8592' };

/** Only web links leave this page. Data is trusted, but links stay boring. */
function safeUrl(url) {
  return /^https?:\/\//i.test(url ?? '') ? url : null;
}

function statusOf(props, now) {
  const starts = props.startsAt ? new Date(props.startsAt) : null;
  const ends = props.endsAt ? new Date(props.endsAt) : null;
  if (starts && starts > now) return 'upcoming';
  if (ends && ends >= now) return 'active';
  // Some notices state only a start. Six hours outlasts any real checkpoint;
  // the data keeps the end honestly absent, this is display classification.
  if (starts && !ends && now - starts < 6 * 3_600_000) return 'active';
  return 'past';
}

function whenText(props) {
  if (!props.startsAt) return 'time not announced';
  const starts = new Date(props.startsAt);
  const day = DAY_FMT.format(starts);
  if (!props.endsAt) return `${day}, from ${TIME_FMT.format(starts)}`;
  return `${day}, ${TIME_FMT.format(starts)} – ${TIME_FMT.format(new Date(props.endsAt))}`;
}

/** Popup panel: what, when, who, and how it was placed on the map. */
function popupFor(props) {
  const el = document.createElement('div');
  el.className = 'popup';

  const where = document.createElement('p');
  where.className = 'where';
  where.textContent = `${props.location} — ${props.county} County`;

  const when = document.createElement('p');
  when.className = 'when';
  when.textContent = whenText(props);

  const agency = document.createElement('p');
  agency.className = 'agency';
  agency.textContent = props.agency;

  const how = document.createElement('p');
  how.className = 'how';
  how.textContent = `Placed as: ${props.method} (${props.confidence} confidence)`;

  el.append(where, when, agency, how);

  for (const note of props.notes || []) {
    const p = document.createElement('p');
    p.className = 'notes';
    p.textContent = note;
    el.append(p);
  }

  if (safeUrl(props.sourceUrl)) {
    const a = document.createElement('a');
    a.href = props.sourceUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Official announcement';
    el.append(a);
  }
  return el;
}

function layerFor(feature, status) {
  const color = COLORS[status];
  const props = feature.properties;

  if (feature.geometry.type === 'LineString') {
    const latlngs = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    return L.polyline(latlngs, { color, weight: 6, opacity: 0.8 });
  }

  const latlng = [feature.geometry.coordinates[1], feature.geometry.coordinates[0]];

  // A checkpoint that is running or coming up announces itself.
  if (status !== 'past') {
    return L.marker(latlng, {
      icon: L.divIcon({ className: 'live-pin', iconSize: [16, 16], iconAnchor: [8, 8] }),
    });
  }

  // A low-confidence point is a neighborhood, not a doorstep; the hollow
  // dashed ring is the map admitting that.
  const vague = props.confidence === 'low';
  return L.circleMarker(
    latlng,
    vague
      ? { radius: 14, color, weight: 2, dashArray: '4 5', fillColor: color, fillOpacity: 0.12 }
      : { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.92 },
  );
}

function listItem(props, status, focus) {
  const li = document.createElement('li');
  li.className = status;

  const where = document.createElement('p');
  where.className = 'where';
  const dot = document.createElement('span');
  dot.className = 'dot';
  where.append(dot, document.createTextNode(props.location));

  const when = document.createElement('p');
  when.className = 'when';
  const county = document.createElement('span');
  county.className = 'county';
  county.textContent = props.county;
  when.append(county, document.createTextNode(` · ${whenText(props)}`));

  li.append(where, when);
  li.addEventListener('click', focus);
  return li;
}

async function main() {
  const map = L.map('map', { zoomSnap: 0.5 }).setView([40.2, -82.75], 7);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const toggle = document.getElementById('panel-toggle');
  const panel = document.getElementById('panel');
  toggle.addEventListener('click', () => {
    const hidden = panel.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!hidden));
    map.invalidateSize();
  });

  // Deployed, the data sits beside the page; in the repository it lives in
  // data/. The page works from either without being told which it is.
  const res = await fetch('./checkpoints.geojson').then((r) =>
    r.ok ? r : fetch('../data/checkpoints.geojson'),
  );
  const collection = await res.json();
  const now = new Date();

  const upcoming = [];
  const past = [];
  const forecasts = [];
  for (const feature of collection.features) {
    // A feature without geometry is a forecast: the county is announced, the
    // road is not. It belongs in the list, not on the map.
    if (!feature.geometry) {
      forecasts.push(feature.properties);
      continue;
    }
    const status = statusOf(feature.properties, now);
    const layer = layerFor(feature, status).addTo(map);
    layer.bindPopup(() => popupFor(feature.properties));
    (status === 'past' ? past : upcoming).push({ feature, status, layer });
  }

  // Soonest first while it still matters, most recent first once it doesn't.
  const startMs = (e) => Date.parse(e.feature.properties.startsAt ?? 0);
  upcoming.sort((a, b) => startMs(a) - startMs(b));
  past.sort((a, b) => startMs(b) - startMs(a));

  const fill = (sectionId, entries) => {
    const section = document.getElementById(sectionId);
    const list = section.querySelector('ol');
    for (const { feature, status, layer } of entries) {
      list.append(
        listItem(feature.properties, status, () => {
          const bounds = layer.getBounds ? layer.getBounds() : layer.getLatLng().toBounds(800);
          map.fitBounds(bounds, { maxZoom: 14 });
          layer.openPopup();
        }),
      );
    }
    const empty = section.querySelector('.empty');
    if (empty) empty.hidden = entries.length > 0;
  };
  fill('upcoming', upcoming);
  fill('past', past);

  // History hides by default — the map is about what is coming, and sixty
  // gray dots bury three red ones. The toggle brings it back.
  const pastSection = document.getElementById('past');
  const showPast = document.getElementById('show-past');
  const applyHistory = () => {
    pastSection.classList.toggle('collapsed', !showPast.checked);
    for (const { layer } of past) {
      if (showPast.checked) layer.addTo(map);
      else layer.remove();
    }
  };
  showPast.checked = upcoming.length === 0 && forecasts.length === 0;
  applyHistory();
  showPast.addEventListener('change', applyHistory);

  if (forecasts.length) {
    const list = document.querySelector('#upcoming ol');
    const empty = document.querySelector('#upcoming .empty');
    if (empty) empty.hidden = true;
    forecasts.sort((a, b) => (a.announcedFor < b.announcedFor ? -1 : 1));
    for (const props of forecasts) {
      const li = document.createElement('li');
      li.className = 'upcoming';

      const where = document.createElement('p');
      where.className = 'where';
      const dot = document.createElement('span');
      dot.className = 'dot';
      where.append(dot, document.createTextNode(`${props.county} County`));

      const when = document.createElement('p');
      when.className = 'when';
      when.textContent = `checkpoint announced for ${props.announcedFor} · location to follow`;

      li.append(where, when);
      li.addEventListener('click', () => {
        const url = safeUrl(props.sourceUrl);
        if (url) window.open(url, '_blank', 'noopener');
      });
      list.prepend(li);
    }
  }

  // Open on what matters: the announced checkpoints, or failing that,
  // everything on record.
  const focus = (upcoming.length ? upcoming : upcoming.concat(past)).map((e) => e.layer);
  if (focus.length) {
    map.fitBounds(L.featureGroup(focus).getBounds().pad(0.15));
  }
}

main();
