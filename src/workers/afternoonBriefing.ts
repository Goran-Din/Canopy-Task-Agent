import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { bot } from '../telegram/bot';
import { getScheduleCache } from './landscapeSync';
import logger from '../logger';
import { LandscapeCrewSchedule, LandscapeJobCard } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP_CHAT_ID = config.telegram.groupId;

// Regional center point: Aurora-Naperville midpoint
const REGION_LAT = 41.7200;
const REGION_LON = -88.2000;
const REGION_LABEL = 'Aurora-Naperville Region';

const CREW_LABELS: Record<string, string> = {
  lp1: 'LP#1',
  lp2: 'LP#2',
  lp3: 'LP#3',
  lp4: 'LP#4',
};

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Foggy',
  51: 'Drizzle',
  53: 'Drizzle',
  55: 'Drizzle',
  61: 'Rain',
  63: 'Rain',
  65: 'Rain',
  71: 'Snow',
  73: 'Snow',
  75: 'Snow',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

const WIND_DIRECTIONS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function windDegToDir(deg: number): string {
  const idx = Math.round(deg / 22.5) % 16;
  return WIND_DIRECTIONS[idx];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Regional weather fetch
// ---------------------------------------------------------------------------

export interface WeatherData {
  conditions: string;
  high: number;
  low: number;
  rainChance: number;
  windSpeed: number;
  windDir: string;
}

/** Fetch regional forecast. dayIndex 0 = today, 1 = tomorrow */
export async function fetchRegionalForecast(dayIndex: number = 1): Promise<WeatherData | null> {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: REGION_LAT,
        longitude: REGION_LON,
        daily: 'weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max,winddirection_10m_dominant',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        timezone: 'America/Chicago',
        forecast_days: 2,
      },
      timeout: 10000,
    });

    const daily = res.data?.daily;
    if (!daily) return null;

    const idx = dayIndex === 0 ? 0 : 1;
    const weatherCode = daily.weathercode?.[idx] ?? 0;
    const conditions = WMO_DESCRIPTIONS[weatherCode] || 'Mixed conditions';

    return {
      conditions,
      high: Math.round(daily.temperature_2m_max?.[idx] ?? 0),
      low: Math.round(daily.temperature_2m_min?.[idx] ?? 0),
      rainChance: daily.precipitation_probability_max?.[idx] ?? 0,
      windSpeed: Math.round(daily.windspeed_10m_max?.[idx] ?? 0),
      windDir: windDegToDir(daily.winddirection_10m_dominant?.[idx] ?? 0),
    };
  } catch (err) {
    logger.error({
      event: 'afternoon_briefing_weather_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-city geocoding + weather
// ---------------------------------------------------------------------------

interface CityCoords {
  latitude: number;
  longitude: number;
  name: string;
}

interface CityWeather {
  rainChance: number;
  weatherCode: number;
}

/** Extract city name from address like "2303 Bill Court, Naperville, IL 60565" */
function extractCity(address: string): string | null {
  if (!address) return null;
  const match = address.match(/,\s*([^,]+),\s*[A-Z]{2}\s*\d{5}/);
  return match ? match[1].trim() : null;
}

async function geocodeCity(city: string): Promise<CityCoords | null> {
  try {
    const res = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
      params: { name: city, count: 1, country_code: 'US' },
      timeout: 5000,
    });
    const result = res.data?.results?.[0];
    if (!result) return null;
    return { latitude: result.latitude, longitude: result.longitude, name: result.name };
  } catch {
    return null;
  }
}

async function fetchCityWeather(coords: CityCoords): Promise<CityWeather | null> {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: coords.latitude,
        longitude: coords.longitude,
        daily: 'precipitation_probability_max,weathercode',
        timezone: 'America/Chicago',
        forecast_days: 2,
      },
      timeout: 5000,
    });
    const daily = res.data?.daily;
    if (!daily) return null;
    return {
      rainChance: daily.precipitation_probability_max?.[1] ?? 0,
      weatherCode: daily.weathercode?.[1] ?? 0,
    };
  } catch {
    return null;
  }
}

interface JobRainAlert {
  crewLabel: string;
  leadName: string;
  city: string;
  jobNumber: string;
  clientName: string;
  rainChance: number;
}

/** Fetch per-job rain forecasts for all jobs across all crews */
export async function fetchJobRainAlerts(
  schedules: LandscapeCrewSchedule[]
): Promise<JobRainAlert[]> {
  // Collect unique cities from all job addresses
  const cityJobs: Map<string, { crew: LandscapeCrewSchedule; job: LandscapeJobCard }[]> = new Map();

  for (const crew of schedules) {
    for (const job of crew.jobs) {
      const city = extractCity(job.address);
      if (!city) continue;
      const cityLower = city.toLowerCase();
      if (!cityJobs.has(cityLower)) cityJobs.set(cityLower, []);
      cityJobs.get(cityLower)!.push({ crew, job });
    }
  }

  if (cityJobs.size === 0) return [];

  // Geocode each unique city with 100ms delay between calls
  const cityCoords: Map<string, CityCoords> = new Map();
  for (const cityLower of cityJobs.keys()) {
    const coords = await geocodeCity(cityLower);
    if (coords) cityCoords.set(cityLower, coords);
    await delay(100);
  }

  if (cityCoords.size === 0) return [];

  // Fetch weather for each unique city
  const cityWeather: Map<string, CityWeather> = new Map();
  for (const [cityLower, coords] of cityCoords) {
    const weather = await fetchCityWeather(coords);
    if (weather) cityWeather.set(cityLower, weather);
    await delay(100);
  }

  if (cityWeather.size === 0) return [];

  // Build rain alerts
  const alerts: JobRainAlert[] = [];
  for (const [cityLower, jobs] of cityJobs) {
    const weather = cityWeather.get(cityLower);
    if (!weather) continue;
    const displayCity = cityCoords.get(cityLower)?.name || cityLower;
    for (const { crew, job } of jobs) {
      alerts.push({
        crewLabel: CREW_LABELS[crew.crew_id] || crew.crew_id.toUpperCase(),
        leadName: crew.lead_name,
        city: displayCity,
        jobNumber: job.job_number,
        clientName: job.client_name,
        rainChance: weather.rainChance,
      });
    }
  }

  // Sort by rain chance descending
  alerts.sort((a, b) => b.rainChance - a.rainChance);
  return alerts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr.replace(' ', 'T'));
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Chicago',
    }).toLowerCase().replace(' ', '');
  } catch {
    return dateStr;
  }
}

function getTomorrowLabel(): string {
  const tom = new Date(Date.now() + 86400000);
  return tom.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Chicago',
  });
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

function buildBriefingMessage(
  weather: WeatherData | null,
  schedules: LandscapeCrewSchedule[],
  rainAlerts: JobRainAlert[]
): string {
  const tomorrowLabel = getTomorrowLabel();
  const lines: string[] = [];

  lines.push(`\u{1F324}\uFE0F <b>Tomorrow's Briefing \u2014 ${tomorrowLabel}</b>`);
  lines.push('');

  // Weather section
  if (weather) {
    lines.push(`\u{1F321}\uFE0F <b>${REGION_LABEL}</b>`);
    lines.push(`Conditions: ${weather.conditions}`);
    lines.push(`High: ${weather.high}\u00B0F  |  Low: ${weather.low}\u00B0F`);
    lines.push(`Rain chance: ${weather.rainChance}%`);
    lines.push(`Wind: ${weather.windSpeed} mph ${weather.windDir}`);
    if (weather.rainChance > 40) {
      lines.push('\u26A0\uFE0F Rain likely \u2014 consider crew adjustments');
    }
  } else {
    lines.push(`\u{1F321}\uFE0F <b>${REGION_LABEL}</b>`);
    lines.push('Weather data unavailable');
  }

  // Rain alert drill-down (only when regional rain > 40%)
  if (rainAlerts.length > 0) {
    lines.push('');
    lines.push('<b>\u26A0\uFE0F Rain Alert \u2014 Job-level forecast:</b>');
    for (const alert of rainAlerts) {
      const warn = alert.rainChance > 50 ? ' \u26A0\uFE0F' : '';
      lines.push(`  ${alert.crewLabel} ${alert.leadName} \u2014 ${alert.city} (Job #${alert.jobNumber} ${alert.clientName}): ${alert.rainChance}% rain${warn}`);
    }
    const hasHighRisk = rainAlerts.some((a) => a.rainChance > 60);
    if (hasHighRisk) {
      lines.push('');
      lines.push('Consider adjusting schedules for high-risk jobs.');
    }
  }

  lines.push('');

  // Crew schedule section
  lines.push('\u{1F4CB} <b>Crew Schedule \u2014 Tomorrow</b>');

  const emptyCrews: string[] = [];

  for (const crew of schedules) {
    const label = CREW_LABELS[crew.crew_id] || crew.crew_id.toUpperCase();

    if (crew.jobs.length === 0) {
      lines.push(`${label} ${crew.lead_name} \u2014 No jobs scheduled \u26A0\uFE0F`);
      emptyCrews.push(`${label} ${crew.lead_name}`);
    } else {
      const totalHrs = crew.total_hours;
      lines.push(`${label} ${crew.lead_name} \u2014 ${crew.jobs.length} job${crew.jobs.length > 1 ? 's' : ''} \u00B7 ${totalHrs}h`);
      for (const job of crew.jobs) {
        const time = formatTime(job.scheduled_start);
        lines.push(`  ${time} #${job.job_number} ${job.client_name} \u2014 ${job.description} (${job.estimated_hours}h)`);
      }
    }
  }

  lines.push('');

  if (emptyCrews.length === 0) {
    lines.push('\u2705 All crews scheduled tomorrow');
  } else {
    for (const c of emptyCrews) {
      lines.push(`\u26A0\uFE0F ${c} has no jobs tomorrow`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Send briefing
// ---------------------------------------------------------------------------

export async function sendAfternoonBriefing(): Promise<void> {
  try {
    logger.info({ event: 'afternoon_briefing_start' });

    const weather = await fetchRegionalForecast(1);

    const cache = getScheduleCache();
    const schedules = cache.tomorrow;

    if (!cache.lastSync || schedules.length === 0) {
      const tomorrowLabel = getTomorrowLabel();
      const msg = weather
        ? buildBriefingMessage(weather, [], [])
        : `\u{1F324}\uFE0F <b>Tomorrow's Briefing \u2014 ${tomorrowLabel}</b>\n\nSchedule data still loading \u2014 check crews.sunsetapp.us`;

      logger.info({ event: 'afternoon_briefing_message', message: msg });
      await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'HTML' });
      logger.info({ event: 'afternoon_briefing_sent', weather: !!weather, scheduleReady: false });
      return;
    }

    // Fetch per-job rain alerts only when regional rain > 40%
    let rainAlerts: JobRainAlert[] = [];
    if (weather && weather.rainChance > 40) {
      try {
        rainAlerts = await fetchJobRainAlerts(schedules);
        logger.info({ event: 'afternoon_briefing_rain_alerts', count: rainAlerts.length });
      } catch (err) {
        logger.warn({
          event: 'afternoon_briefing_rain_alert_error',
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue without rain alerts
      }
    }

    const message = buildBriefingMessage(weather, schedules, rainAlerts);
    logger.info({ event: 'afternoon_briefing_message', message });
    await bot.sendMessage(GROUP_CHAT_ID, message, { parse_mode: 'HTML' });

    logger.info({ event: 'afternoon_briefing_sent', weather: !!weather, scheduleReady: true, rainAlerts: rainAlerts.length });

    // --- Overbooking alert (DM to Mark + Goran) ---
    const OVERBOOKING_THRESHOLD = 10;
    const overbooked: { label: string; name: string; hours: number }[] = [];
    const available: { label: string; name: string }[] = [];

    for (const crew of schedules) {
      const label = CREW_LABELS[crew.crew_id] || crew.crew_id.toUpperCase();
      const totalHours = crew.jobs.reduce((sum, job) => sum + (job.estimated_hours || 0), 0);
      if (totalHours > OVERBOOKING_THRESHOLD) {
        overbooked.push({ label, name: crew.lead_name, hours: totalHours });
      } else if (totalHours === 0) {
        available.push({ label, name: crew.lead_name });
      }
    }

    if (overbooked.length > 0) {
      const tomorrowLabel = getTomorrowLabel();
      const alertLines: string[] = [];
      alertLines.push(`\u26A0\uFE0F <b>Scheduling Alert \u2014 Tomorrow ${tomorrowLabel}</b>`);
      alertLines.push('');
      alertLines.push('The following crews need attention:');
      alertLines.push('');
      alertLines.push('<b>Overbooked:</b>');
      for (const c of overbooked) {
        alertLines.push(`  \u{1F534} ${c.label} ${c.name} \u2014 ${c.hours} hrs scheduled (limit: ${OVERBOOKING_THRESHOLD} hrs)`);
      }

      if (available.length > 0) {
        alertLines.push('');
        alertLines.push('<b>Available capacity:</b>');
        for (const c of available) {
          alertLines.push(`  \u{1F7E2} ${c.label} ${c.name} \u2014 0 hrs (no jobs scheduled)`);
        }
      }

      alertLines.push('');
      alertLines.push('Please review and redistribute jobs in ServiceM8 before tomorrow morning.');

      const alertMessage = alertLines.join('\n');
      await bot.sendMessage(5028364135, alertMessage, { parse_mode: 'HTML' }); // Mark Janev
      await bot.sendMessage(1996235953, alertMessage, { parse_mode: 'HTML' }); // Goran
      logger.info({
        event: 'overbooking_alert_sent',
        overbooked: overbooked.map((c) => `${c.label} ${c.name}: ${c.hours}h`),
        available: available.map((c) => `${c.label} ${c.name}`),
      });
    }
  } catch (err) {
    logger.error({
      event: 'afternoon_briefing_error',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}

/** Manual trigger for testing */
export async function sendAfternoonBriefingNow(): Promise<void> {
  return sendAfternoonBriefing();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function startAfternoonBriefing(): void {
  logger.info({ event: 'afternoon_briefing_init' });

  // 6:00 PM CT daily
  cron.schedule('0 18 * * *', () => {
    sendAfternoonBriefing();
  }, { timezone: 'America/Chicago' });

  logger.info({ event: 'afternoon_briefing_scheduled', time: '6:00 PM CT' });
}
