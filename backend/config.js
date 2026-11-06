export const AIRPORTS = [
  { icao: 'KCDW', code: 'CDW', name: 'Essex County Airport', shortName: 'Essex County', city: 'Caldwell, New Jersey', region: 'NJ', lat: 40.8752, lon: -74.2814, zoom: 12 },
  { icao: 'KJFK', code: 'JFK', name: 'John F. Kennedy International Airport', shortName: 'John F. Kennedy', city: 'Queens, New York', region: 'NY', lat: 40.639928, lon: -73.778692, zoom: 11 },
];

export const AIRPORT = AIRPORTS[0];
export function airportByIcao(icao) { return AIRPORTS.find(airport => airport.icao === icao); }

export const CHANNELS = [
  { id: 'atis', airportIcao: 'KCDW', name: 'KCDW ATIS', shortName: 'ATIS', description: 'Automatic Terminal Information Service', mount: 'kcdw2_atis', env: 'KCDW_ATIS_STREAM_URL', frequencies: [{ facility: 'Caldwell ATIS', mhz: '135.500' }] },
  { id: 'radio-1', airportIcao: 'KCDW', name: 'KCDW Del/Gnd/Twr #1', shortName: 'Radio #1', description: 'Clearance · Ground · Tower', mount: 'kcdw1', env: 'KCDW_RADIO_1_STREAM_URL', frequencies: [{ facility: 'Caldwell Clearance', mhz: '121.100' }, { facility: 'Caldwell Ground', mhz: '121.900' }, { facility: 'Caldwell Tower', mhz: '119.800' }] },
  { id: 'radio-2', airportIcao: 'KCDW', name: 'KCDW Del/Gnd/Twr #2', shortName: 'Radio #2', description: 'Clearance · Ground · Tower', mount: 'kcdw2_del_gnd_twr', env: 'KCDW_RADIO_2_STREAM_URL', frequencies: [{ facility: 'Caldwell Clearance', mhz: '121.100' }, { facility: 'Caldwell Ground', mhz: '121.900' }, { facility: 'Caldwell Tower', mhz: '119.800' }] },
  { id: 'jfk-main-tower', airportIcao: 'KJFK', name: 'KJFK Main Tower', shortName: 'Main Tower', description: 'Kennedy Ground / Tower feed', mount: 'kjfk9_s', env: 'KJFK_MAIN_TOWER_STREAM_URL', frequencies: [{ facility: 'Kennedy Tower · 4R/22L', mhz: '119.100' }, { facility: 'Kennedy Tower · 4L/22R', mhz: '123.900' }] },
].map(channel => ({ ...channel, sourcePage: `https://www.liveatc.net/hlisten.php?mount=${channel.mount}&icao=${channel.airportIcao.toLowerCase()}` }));

export function channelById(id) { return CHANNELS.find(channel => channel.id === id); }
