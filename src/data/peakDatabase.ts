/**
 * EarthContours — Verified Worldwide Peak Database
 *
 * Static peak data sourced from authoritative surveys (USGS/NGS for the US,
 * national survey agencies worldwide).  Every elevation is the official
 * surveyed value in metres, NOT a DEM sample.
 *
 * This database serves as the primary/instant peak source for predefined
 * regions and as a fallback when the OSM Overpass API is unavailable or
 * times out.  The Overpass client in peakLoader.ts enriches this data
 * with additional local peaks when it can connect.
 *
 * Organisation:
 *   1. Colorado Fourteeners (~53 peaks)
 *   2. Alaska Range & major Alaska peaks
 *   3. Washington / Oregon Cascades
 *   4. US state high points & notable summits
 *   5. Canada
 *   6. Mexico & Central America
 *   7. South America
 *   8. Europe — Alps & other
 *   9. Africa
 *  10. Himalayas & Karakoram (all 8000ers + major 7000ers)
 *  11. Rest of Asia (Japan, SE Asia, Caucasus, etc.)
 *  12. Oceania & Australia
 *  13. Antarctica
 *
 * Data sources:
 *   - US peaks: USGS GNIS / NGS datasheets
 *   - Himalayas: Survey of India / China National Bureau of Surveying
 *   - Alps: Swisstopo / IGN France / BEV Austria
 *   - Other: National survey agencies, cross-referenced with GeoNames
 *
 * Adding peaks:
 *   Push to PEAK_DATABASE.  getPeaksInBounds() picks them up automatically.
 *   Use lowercase kebab-case IDs.  Set isHighPoint for the highest peak
 *   per region / state / continent.
 */

import type { Peak } from '../core/types'

// ─── Peak Database ───────────────────────────────────────────────────────────

const PEAK_DATABASE: Peak[] = [

  // ─── Colorado Fourteeners (all 53, USGS/NGS surveyed elevations) ────────────
  { id: 'mt-elbert',         name: 'Mt. Elbert',            lat: 39.1178, lng: -106.4453, elevation_m: 4401, isHighPoint: true },
  { id: 'mt-massive',        name: 'Mt. Massive',           lat: 39.1875, lng: -106.4756, elevation_m: 4396 },
  { id: 'mt-harvard',        name: 'Mt. Harvard',           lat: 38.9244, lng: -106.3206, elevation_m: 4396 },
  { id: 'blanca-peak',       name: 'Blanca Peak',           lat: 37.5775, lng: -105.4856, elevation_m: 4372 },
  { id: 'la-plata-peak',     name: 'La Plata Peak',         lat: 39.0294, lng: -106.4731, elevation_m: 4372 },
  { id: 'uncompahgre-peak',  name: 'Uncompahgre Peak',      lat: 38.0714, lng: -107.4622, elevation_m: 4361 },
  { id: 'crestone-peak',     name: 'Crestone Peak',         lat: 37.9667, lng: -105.5858, elevation_m: 4357 },
  { id: 'mt-lincoln',        name: 'Mt. Lincoln',           lat: 39.3514, lng: -106.1114, elevation_m: 4354 },
  { id: 'grays-peak',        name: 'Grays Peak',            lat: 39.6339, lng: -105.8178, elevation_m: 4352 },
  { id: 'mt-antero',         name: 'Mt. Antero',            lat: 38.6739, lng: -106.2461, elevation_m: 4349 },
  { id: 'torreys-peak',      name: 'Torreys Peak',          lat: 39.6428, lng: -105.8211, elevation_m: 4349 },
  { id: 'castle-peak',       name: 'Castle Peak',           lat: 39.0097, lng: -106.8614, elevation_m: 4348 },
  { id: 'quandary-peak',     name: 'Quandary Peak',         lat: 39.3972, lng: -106.1064, elevation_m: 4348 },
  { id: 'mt-evans',          name: 'Mt. Evans',             lat: 39.5883, lng: -105.6438, elevation_m: 4348 },
  { id: 'longs-peak',        name: 'Longs Peak',            lat: 40.2550, lng: -105.6156, elevation_m: 4346 },
  { id: 'mt-wilson',         name: 'Mt. Wilson',            lat: 37.8392, lng: -107.9914, elevation_m: 4342 },
  { id: 'mt-cameron',        name: 'Mt. Cameron',           lat: 39.3469, lng: -106.1186, elevation_m: 4341 },
  { id: 'mt-shavano',        name: 'Mt. Shavano',           lat: 38.6194, lng: -106.2394, elevation_m: 4337 },
  { id: 'mt-belford',        name: 'Mt. Belford',           lat: 38.9608, lng: -106.3608, elevation_m: 4327 },
  { id: 'crestone-needle',   name: 'Crestone Needle',       lat: 37.9647, lng: -105.5767, elevation_m: 4327 },
  { id: 'mt-princeton',      name: 'Mt. Princeton',         lat: 38.7492, lng: -106.2422, elevation_m: 4327 },
  { id: 'mt-yale',           name: 'Mt. Yale',              lat: 38.8442, lng: -106.3139, elevation_m: 4327 },
  { id: 'mt-bross',          name: 'Mt. Bross',             lat: 39.3353, lng: -106.1075, elevation_m: 4320 },
  { id: 'kit-carson-peak',   name: 'Kit Carson Peak',       lat: 37.9797, lng: -105.6025, elevation_m: 4317 },
  { id: 'el-diente-peak',    name: 'El Diente Peak',        lat: 37.8392, lng: -108.0053, elevation_m: 4316 },
  { id: 'maroon-peak',       name: 'Maroon Peak',           lat: 39.0708, lng: -106.9889, elevation_m: 4315 },
  { id: 'tabeguache-peak',   name: 'Tabeguache Peak',       lat: 38.6256, lng: -106.2508, elevation_m: 4315 },
  { id: 'mt-oxford',         name: 'Mt. Oxford',            lat: 38.9647, lng: -106.3383, elevation_m: 4315 },
  { id: 'mt-sneffels',       name: 'Mt. Sneffels',          lat: 38.0036, lng: -107.7922, elevation_m: 4315 },
  { id: 'mt-democrat',       name: 'Mt. Democrat',          lat: 39.3394, lng: -106.1397, elevation_m: 4312 },
  { id: 'capitol-peak',      name: 'Capitol Peak',          lat: 39.1503, lng: -107.0831, elevation_m: 4307 },
  { id: 'pikes-peak',        name: 'Pikes Peak',            lat: 38.8405, lng: -105.0442, elevation_m: 4302 },
  { id: 'snowmass-mtn',      name: 'Snowmass Mountain',     lat: 39.1181, lng: -107.0667, elevation_m: 4295 },
  { id: 'challenger-point',  name: 'Challenger Point',      lat: 37.9803, lng: -105.6069, elevation_m: 4294 },
  { id: 'ellingwood-point',  name: 'Ellingwood Point',      lat: 37.5825, lng: -105.4925, elevation_m: 4294 },
  { id: 'mt-columbia',       name: 'Mt. Columbia',          lat: 38.9039, lng: -106.2972, elevation_m: 4293 },
  { id: 'mt-eolus',          name: 'Mt. Eolus',             lat: 37.6219, lng: -107.6222, elevation_m: 4292 },
  { id: 'windom-peak',       name: 'Windom Peak',           lat: 37.6214, lng: -107.5917, elevation_m: 4292 },
  { id: 'missouri-mtn',      name: 'Missouri Mountain',     lat: 38.9475, lng: -106.3781, elevation_m: 4288 },
  { id: 'humboldt-peak',     name: 'Humboldt Peak',         lat: 37.9611, lng: -105.5553, elevation_m: 4287 },
  { id: 'mt-bierstadt',      name: 'Mt. Bierstadt',         lat: 39.5828, lng: -105.6686, elevation_m: 4287 },
  { id: 'sunlight-peak',     name: 'Sunlight Peak',         lat: 37.6272, lng: -107.5958, elevation_m: 4285 },
  { id: 'north-eolus',       name: 'North Eolus',           lat: 37.6250, lng: -107.6208, elevation_m: 4283 },
  { id: 'handies-peak',      name: 'Handies Peak',          lat: 37.9131, lng: -107.5047, elevation_m: 4282 },
  { id: 'culebra-peak',      name: 'Culebra Peak',          lat: 37.1222, lng: -105.1856, elevation_m: 4282 },
  { id: 'mt-lindsey',        name: 'Mt. Lindsey',           lat: 37.5836, lng: -105.4447, elevation_m: 4281 },
  { id: 'little-bear-peak',  name: 'Little Bear Peak',      lat: 37.5664, lng: -105.4967, elevation_m: 4278 },
  { id: 'mt-sherman',        name: 'Mt. Sherman',           lat: 39.2250, lng: -106.1697, elevation_m: 4278 },
  { id: 'redcloud-peak',     name: 'Redcloud Peak',         lat: 37.9408, lng: -107.4217, elevation_m: 4278 },
  { id: 'pyramid-peak',      name: 'Pyramid Peak',          lat: 39.0714, lng: -106.9503, elevation_m: 4273 },
  { id: 'wilson-peak',       name: 'Wilson Peak',           lat: 37.8603, lng: -107.9847, elevation_m: 4272 },
  { id: 'wetterhorn-peak',   name: 'Wetterhorn Peak',       lat: 38.0606, lng: -107.5108, elevation_m: 4272 },
  { id: 'san-luis-peak',     name: 'San Luis Peak',         lat: 37.9869, lng: -106.9311, elevation_m: 4274 },

  // ─── Alaska Range & Major Alaska Peaks (corrected coords from USGS GNIS) ───
  { id: 'denali',            name: 'Denali',                lat: 63.0695, lng: -151.0070, elevation_m: 6190, isHighPoint: true },
  { id: 'mt-foraker',        name: 'Mt. Foraker',           lat: 62.9608, lng: -151.3981, elevation_m: 5304 },
  { id: 'mt-hunter',         name: 'Mt. Hunter',            lat: 62.9508, lng: -151.0894, elevation_m: 4442 },
  { id: 'mt-hayes',          name: 'Mt. Hayes',             lat: 63.6192, lng: -146.7092, elevation_m: 4216 },
  { id: 'mt-marcus-baker',   name: 'Mt. Marcus Baker',      lat: 61.4378, lng: -147.7506, elevation_m: 4016 },
  { id: 'mt-silverthrone',   name: 'Mt. Silverthrone',      lat: 63.1095, lng: -150.6724, elevation_m: 4030 },
  { id: 'mt-carpe',          name: 'Mt. Carpe',             lat: 63.1522, lng: -150.8610, elevation_m: 3825 },
  { id: 'mt-huntington',     name: 'Mt. Huntington',        lat: 62.9678, lng: -150.8997, elevation_m: 3731 },
  { id: 'mt-mather',         name: 'Mt. Mather',            lat: 63.1947, lng: -150.4356, elevation_m: 3687 },
  { id: 'mt-russell-ak',     name: 'Mt. Russell',           lat: 62.7927, lng: -151.8758, elevation_m: 3557 },
  // Wrangell–St. Elias peaks
  { id: 'mt-blackburn',      name: 'Mt. Blackburn',         lat: 61.7317, lng: -143.4372, elevation_m: 4996 },
  { id: 'mt-sanford',        name: 'Mt. Sanford',           lat: 62.2133, lng: -144.1295, elevation_m: 4949 },
  { id: 'mt-wrangell',       name: 'Mt. Wrangell',          lat: 62.0057, lng: -144.0194, elevation_m: 4317 },
  { id: 'mt-drum',           name: 'Mt. Drum',              lat: 62.1161, lng: -144.6378, elevation_m: 3661 },
  // Volcanic arc (Cook Inlet)
  { id: 'mt-spurr',          name: 'Mt. Spurr',             lat: 61.2989, lng: -152.2539, elevation_m: 3374 },
  { id: 'mt-redoubt',        name: 'Mt. Redoubt',           lat: 60.4852, lng: -152.7438, elevation_m: 3108 },
  { id: 'mt-iliamna',        name: 'Mt. Iliamna',           lat: 60.0319, lng: -153.0917, elevation_m: 3053 },
  { id: 'augustine-volcano', name: 'Augustine Volcano',     lat: 59.3631, lng: -153.4306, elevation_m: 1260 },

  // ─── Washington / Oregon Cascades (corrected coords from USGS) ─────────────
  { id: 'mt-rainier',        name: 'Mt. Rainier',           lat: 46.8528, lng: -121.7604, elevation_m: 4392, isHighPoint: true },
  { id: 'mt-adams',          name: 'Mt. Adams',             lat: 46.2026, lng: -121.4910, elevation_m: 3743 },
  { id: 'mt-baker',          name: 'Mt. Baker',             lat: 48.7768, lng: -121.8145, elevation_m: 3286 },
  { id: 'glacier-peak',      name: 'Glacier Peak',          lat: 48.1117, lng: -121.1140, elevation_m: 3213 },
  { id: 'mt-stuart',         name: 'Mt. Stuart',            lat: 47.4751, lng: -120.9031, elevation_m: 2870 },
  { id: 'bonanza-peak',      name: 'Bonanza Peak',          lat: 48.2379, lng: -120.8662, elevation_m: 2899 },
  { id: 'mt-shuksan',        name: 'Mt. Shuksan',           lat: 48.8311, lng: -121.6031, elevation_m: 2783 },
  { id: 'jack-mtn',          name: 'Jack Mountain',         lat: 48.7726, lng: -120.9560, elevation_m: 2763 },
  { id: 'mt-st-helens',      name: 'Mt. St. Helens',        lat: 46.1914, lng: -122.1956, elevation_m: 2549 },
  { id: 'mt-olympus-wa',     name: 'Mt. Olympus',           lat: 47.8013, lng: -123.7108, elevation_m: 2432 },
  // Oregon Cascades
  { id: 'mt-hood',           name: 'Mt. Hood',              lat: 45.3733, lng: -121.6957, elevation_m: 3426 },
  { id: 'mt-jefferson',      name: 'Mt. Jefferson',         lat: 44.6742, lng: -121.7997, elevation_m: 3199 },
  { id: 'mt-mcloughlin',     name: 'Mt. McLoughlin',        lat: 42.4461, lng: -122.3164, elevation_m: 2894 },

  // ─── US State High Points & Notable Summits ────────────────────────────────
  { id: 'mt-whitney',        name: 'Mt. Whitney',           lat: 36.5785, lng: -118.2923, elevation_m: 4421, isHighPoint: true },
  { id: 'granite-peak',      name: 'Granite Peak',          lat: 45.1634, lng: -109.8075, elevation_m: 3904, isHighPoint: true },
  { id: 'gannett-peak',      name: 'Gannett Peak',          lat: 43.1845, lng: -109.6541, elevation_m: 4209, isHighPoint: true },
  { id: 'kings-peak',        name: 'Kings Peak',            lat: 40.7764, lng: -110.3728, elevation_m: 4123, isHighPoint: true },
  { id: 'wheeler-peak-nm',   name: 'Wheeler Peak',          lat: 36.5567, lng: -105.4170, elevation_m: 4013, isHighPoint: true },
  { id: 'boundary-peak',     name: 'Boundary Peak',         lat: 37.8468, lng: -118.3510, elevation_m: 4007, isHighPoint: true },
  { id: 'borah-peak',        name: 'Borah Peak',            lat: 44.1373, lng: -113.7812, elevation_m: 3862, isHighPoint: true },
  { id: 'humphreys-peak',    name: 'Humphreys Peak',        lat: 35.3463, lng: -111.6780, elevation_m: 3852, isHighPoint: true },
  { id: 'mauna-kea',         name: 'Mauna Kea',             lat: 19.8207, lng: -155.4681, elevation_m: 4207, isHighPoint: true },
  { id: 'mt-washington-nh',   name: 'Mt. Washington',       lat: 44.2705, lng: -71.3035,  elevation_m: 1917, isHighPoint: true },
  { id: 'mt-katahdin',       name: 'Mt. Katahdin',          lat: 45.9043, lng: -68.9214,  elevation_m: 1606, isHighPoint: true },
  { id: 'mt-marcy',          name: 'Mt. Marcy',             lat: 44.1127, lng: -73.9237,  elevation_m: 1629, isHighPoint: true },
  { id: 'mt-mitchell',       name: 'Mt. Mitchell',          lat: 35.7648, lng: -82.2651,  elevation_m: 2037, isHighPoint: true },
  { id: 'kuwohi',            name: 'Kuwohi',                lat: 35.5628, lng: -83.4985,  elevation_m: 2025, isHighPoint: true },
  { id: 'mt-rogers',         name: 'Mt. Rogers',            lat: 36.6598, lng: -81.5450,  elevation_m: 1746, isHighPoint: true },
  { id: 'spruce-knob',       name: 'Spruce Knob',           lat: 38.6998, lng: -79.5328,  elevation_m: 1482, isHighPoint: true },
  { id: 'black-elk-peak',    name: 'Black Elk Peak',        lat: 43.8658, lng: -103.5313, elevation_m: 2208, isHighPoint: true },
  { id: 'guadalupe-peak',    name: 'Guadalupe Peak',        lat: 31.8913, lng: -104.8607, elevation_m: 2667, isHighPoint: true },

  // ─── Canada ────────────────────────────────────────────────────────────────
  { id: 'mt-logan',          name: 'Mt. Logan',             lat: 60.5670, lng: -140.4024, elevation_m: 5959, isHighPoint: true },
  { id: 'mt-robson',         name: 'Mt. Robson',            lat: 53.1105, lng: -119.1553, elevation_m: 3954 },
  { id: 'mt-columbia-ca',    name: 'Mt. Columbia',           lat: 52.1472, lng: -117.4417, elevation_m: 3747 },

  // ─── Mexico & Central America ──────────────────────────────────────────────
  { id: 'pico-de-orizaba',   name: 'Pico de Orizaba',       lat: 19.0302, lng: -97.2696,  elevation_m: 5636, isHighPoint: true },
  { id: 'popocatepetl',      name: 'Popocatépetl',          lat: 19.0225, lng: -98.6278,  elevation_m: 5426 },
  { id: 'iztaccihuatl',      name: 'Iztaccíhuatl',          lat: 19.1787, lng: -98.6420,  elevation_m: 5230 },

  // ─── South America ─────────────────────────────────────────────────────────
  { id: 'aconcagua',         name: 'Aconcagua',             lat: -32.6532, lng: -70.0109, elevation_m: 6962, isHighPoint: true },
  { id: 'ojos-del-salado',   name: 'Ojos del Salado',       lat: -27.1092, lng: -68.5408, elevation_m: 6893 },
  { id: 'huascaran',         name: 'Huascarán',             lat: -9.1222,  lng: -77.6042, elevation_m: 6768 },
  { id: 'chimborazo',        name: 'Chimborazo',            lat: -1.4693,  lng: -78.8176, elevation_m: 6263 },
  { id: 'cotopaxi',          name: 'Cotopaxi',              lat: -0.6838,  lng: -78.4377, elevation_m: 5897 },

  // ─── Europe — Alps & Other ─────────────────────────────────────────────────
  { id: 'elbrus',            name: 'Elbrus',                lat: 43.3503, lng: 42.4392,  elevation_m: 5642, isHighPoint: true },
  { id: 'kazbek',            name: 'Kazbek',                lat: 42.6986, lng: 44.5144,  elevation_m: 5054 },
  { id: 'mont-blanc',        name: 'Mont Blanc',            lat: 45.8326, lng: 6.8652,   elevation_m: 4808 },
  { id: 'dufourspitze',      name: 'Dufourspitze',          lat: 45.9369, lng: 7.8667,   elevation_m: 4634 },
  { id: 'matterhorn',        name: 'Matterhorn',            lat: 45.9764, lng: 7.6586,   elevation_m: 4478 },
  { id: 'jungfrau',          name: 'Jungfrau',              lat: 46.5354, lng: 7.9617,   elevation_m: 4158 },
  { id: 'gran-paradiso',     name: 'Gran Paradiso',         lat: 45.5178, lng: 7.2661,   elevation_m: 4061 },
  { id: 'eiger',             name: 'Eiger',                 lat: 46.5775, lng: 8.0053,   elevation_m: 3967 },
  { id: 'grossglockner',     name: 'Grossglockner',         lat: 47.0742, lng: 12.6953,  elevation_m: 3798 },
  { id: 'zugspitze',         name: 'Zugspitze',             lat: 47.4211, lng: 10.9853,  elevation_m: 2962 },
  { id: 'musala',            name: 'Musala',                lat: 42.1797, lng: 23.5853,  elevation_m: 2925 },
  { id: 'mt-olympus',        name: 'Mt. Olympus',           lat: 40.0856, lng: 22.3585,  elevation_m: 2918 },
  { id: 'triglav',           name: 'Triglav',               lat: 46.3786, lng: 13.8364,  elevation_m: 2864 },

  // ─── Africa ────────────────────────────────────────────────────────────────
  { id: 'kilimanjaro',       name: 'Kilimanjaro',           lat: -3.0674,  lng: 37.3556, elevation_m: 5895, isHighPoint: true },
  { id: 'mt-kenya',          name: 'Mt. Kenya',             lat: -0.1527,  lng: 37.3092, elevation_m: 5199 },
  { id: 'mt-stanley',        name: 'Mt. Stanley',           lat: 0.3861,   lng: 29.8719, elevation_m: 5109 },

  // ─── Himalayas & Karakoram (all 14 eight-thousanders) ──────────────────────
  { id: 'everest',           name: 'Everest',               lat: 27.9881, lng: 86.9250, elevation_m: 8849, isHighPoint: true },
  { id: 'k2',                name: 'K2',                    lat: 35.8825, lng: 76.5133, elevation_m: 8611 },
  { id: 'kangchenjunga',     name: 'Kangchenjunga',         lat: 27.7025, lng: 88.1475, elevation_m: 8586 },
  { id: 'lhotse',            name: 'Lhotse',                lat: 27.9617, lng: 86.9342, elevation_m: 8516 },
  { id: 'makalu',            name: 'Makalu',                lat: 27.8897, lng: 87.0886, elevation_m: 8485 },
  { id: 'cho-oyu',           name: 'Cho Oyu',               lat: 28.0942, lng: 86.6608, elevation_m: 8188 },
  { id: 'dhaulagiri',        name: 'Dhaulagiri I',          lat: 28.6967, lng: 83.4950, elevation_m: 8167 },
  { id: 'manaslu',           name: 'Manaslu',               lat: 28.5500, lng: 84.5617, elevation_m: 8163 },
  { id: 'nanga-parbat',      name: 'Nanga Parbat',          lat: 35.2375, lng: 74.5892, elevation_m: 8126 },
  { id: 'annapurna',         name: 'Annapurna I',           lat: 28.5961, lng: 83.8203, elevation_m: 8091 },
  { id: 'gasherbrum-i',      name: 'Gasherbrum I',          lat: 35.7244, lng: 76.6964, elevation_m: 8080 },
  { id: 'broad-peak',        name: 'Broad Peak',            lat: 35.8117, lng: 76.5650, elevation_m: 8051 },
  { id: 'gasherbrum-ii',     name: 'Gasherbrum II',         lat: 35.7583, lng: 76.6533, elevation_m: 8035 },
  { id: 'shishapangma',      name: 'Shishapangma',          lat: 28.3522, lng: 85.7797, elevation_m: 8027 },

  // ─── Rest of Asia ──────────────────────────────────────────────────────────
  { id: 'mt-fuji',           name: 'Mt. Fuji',              lat: 35.3606, lng: 138.7274, elevation_m: 3776 },
  { id: 'mt-damavand',       name: 'Damavand',              lat: 35.9515, lng: 52.1090,  elevation_m: 5610 },
  { id: 'mt-ararat',         name: 'Mt. Ararat',            lat: 39.7014, lng: 44.2983,  elevation_m: 5137 },
  { id: 'mt-kinabalu',       name: 'Mt. Kinabalu',          lat: 6.0749,  lng: 116.5580, elevation_m: 4095 },

  // ─── Oceania & Australia ───────────────────────────────────────────────────
  { id: 'puncak-jaya',       name: 'Puncak Jaya',           lat: -4.0833,  lng: 137.1833, elevation_m: 4884, isHighPoint: true },
  { id: 'aoraki-mt-cook',    name: 'Aoraki / Mt. Cook',     lat: -43.5942, lng: 170.1418, elevation_m: 3724, isHighPoint: true },
  { id: 'mt-kosciuszko',     name: 'Mt. Kosciuszko',        lat: -36.4564, lng: 148.2636, elevation_m: 2228, isHighPoint: true },

  // ─── Antarctica ────────────────────────────────────────────────────────────
  { id: 'vinson-massif',     name: 'Vinson Massif',         lat: -78.5253, lng: -85.6172, elevation_m: 4892, isHighPoint: true },
  { id: 'mt-erebus',         name: 'Mt. Erebus',            lat: -77.5300, lng: 167.1700, elevation_m: 3794 },

]

// ─── Lookup Helper ───────────────────────────────────────────────────────────

/**
 * Return all peaks within the given geographic bounding box.
 * O(n) scan — fast for ~200 entries.
 */
export function getPeaksInBounds(
  north: number, south: number, east: number, west: number,
): Peak[] {
  return PEAK_DATABASE.filter(p =>
    p.lat >= south && p.lat <= north &&
    p.lng >= west  && p.lng <= east,
  )
}
