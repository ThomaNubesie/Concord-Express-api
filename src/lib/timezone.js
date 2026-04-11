// Timezone utility — maps country codes to IANA timezones
const COUNTRY_TIMEZONES = {
  // North America
  CA: 'America/Toronto',
  US: 'America/New_York',
  // Europe
  FR: 'Europe/Paris',
  GB: 'Europe/London',
  DE: 'Europe/Berlin',
  ES: 'Europe/Madrid',
  IT: 'Europe/Rome',
  PT: 'Europe/Lisbon',
  BE: 'Europe/Brussels',
  NL: 'Europe/Amsterdam',
  CH: 'Europe/Zurich',
  // Africa
  SN: 'Africa/Dakar',        // Senegal
  CM: 'Africa/Douala',       // Cameroon
  CI: 'Africa/Abidjan',      // Ivory Coast
  NG: 'Africa/Lagos',        // Nigeria
  GH: 'Africa/Accra',        // Ghana
  MA: 'Africa/Casablanca',   // Morocco
  TN: 'Africa/Tunis',        // Tunisia
  DZ: 'Africa/Algiers',      // Algeria
  ML: 'Africa/Bamako',       // Mali
  BF: 'Africa/Ouagadougou',  // Burkina Faso
  GN: 'Africa/Conakry',      // Guinea
  TG: 'Africa/Lome',         // Togo
  BJ: 'Africa/Porto-Novo',   // Benin
  NE: 'Africa/Niamey',       // Niger
  CD: 'Africa/Kinshasa',     // DRC
  CG: 'Africa/Brazzaville',  // Congo
  GA: 'Africa/Libreville',   // Gabon
  CF: 'Africa/Bangui',       // CAR
  // Default fallback
  DEFAULT: 'America/Toronto',
};

// City-based timezone detection for cases where country isn't available
const CITY_TIMEZONES = {
  // Canada
  ottawa: 'America/Toronto', toronto: 'America/Toronto', montreal: 'America/Toronto',
  kingston: 'America/Toronto', cornwall: 'America/Toronto', peterborough: 'America/Toronto',
  vancouver: 'America/Vancouver', calgary: 'America/Edmonton', winnipeg: 'America/Winnipeg',
  // France
  paris: 'Europe/Paris', lyon: 'Europe/Paris', marseille: 'Europe/Paris',
  // Senegal
  dakar: 'Africa/Dakar', 'saint-louis': 'Africa/Dakar',
  // Cameroon
  yaounde: 'Africa/Douala', douala: 'Africa/Douala', bafoussam: 'Africa/Douala',
  // Ivory Coast
  abidjan: 'Africa/Abidjan', yamoussoukro: 'Africa/Abidjan',
};

function getTimezone(country, city) {
  if (city) {
    const cityTz = CITY_TIMEZONES[city.toLowerCase().trim()];
    if (cityTz) return cityTz;
  }
  if (country) {
    const countryTz = COUNTRY_TIMEZONES[country.toUpperCase().trim()];
    if (countryTz) return countryTz;
  }
  return COUNTRY_TIMEZONES.DEFAULT;
}

function formatTimeInZone(date, country, city) {
  const tz = getTimezone(country, city);
  return new Date(date).toLocaleTimeString('en-CA', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: tz,
  });
}

function formatDateTimeInZone(date, country, city) {
  const tz = getTimezone(country, city);
  return new Date(date).toLocaleString('en-CA', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: tz,
  });
}

module.exports = { getTimezone, formatTimeInZone, formatDateTimeInZone, COUNTRY_TIMEZONES };
