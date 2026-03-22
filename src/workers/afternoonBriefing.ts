import axios from 'axios';
import cron from 'node-cron';
import { config } from '../config';
import { bot } from '../telegram/bot';
import { getScheduleCache } from './landscapeSync';
import logger from '../logger';
import { LandscapeCrewSchedule } from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP_CHAT_ID = config.telegram.groupId;

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

// ---------------------------------------------------------------------------
// Weather fetch
// ---------------------------------------------------------------------------

interface WeatherData {
  conditions: string;
  high: number;
  low: number;
  rainChance: number;
  windSpeed: number;
  windDir: string;
}

async function fetchTomorrowWeather(): Promise<WeatherData | null> {
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: 41.7606,
        longitude: -88.3201,
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

    const weatherCode = daily.weathercode?.[1] ?? 0;
    const conditions = WMO_DESCRIPTIONS[weatherCode] || 'Mixed conditions';

    return {
      conditions,
      high: Math.round(daily.temperature_2m_max?.[1] ?? 0),
      low: Math.round(daily.temperature_2m_min?.[1] ?? 0),
      rainChance: daily.precipitation_probability_max?.[1] ?? 0,
      windSpeed: Math.round(daily.windspeed_10m_max?.[1] ?? 0),
      windDir: windDegToDir(daily.winddirection_10m_dominant?.[1] ?? 0),
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
// Message builder
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

function buildBriefingMessage(
  weather: WeatherData | null,
  schedules: LandscapeCrewSchedule[]
): string {
  const tomorrowLabel = getTomorrowLabel();
  const lines: string[] = [];

  lines.push(`\u{1F324}\uFE0F <b>Tomorrow's Briefing \u2014 ${tomorrowLabel}</b>`);
  lines.push('');

  // Weather section
  if (weather) {
    lines.push('\u{1F321}\uFE0F <b>Weather \u2014 Aurora, IL</b>');
    lines.push(`Conditions: ${weather.conditions}`);
    lines.push(`High: ${weather.high}\u00B0F  |  Low: ${weather.low}\u00B0F`);
    lines.push(`Rain chance: ${weather.rainChance}%`);
    lines.push(`Wind: ${weather.windSpeed} mph ${weather.windDir}`);
    if (weather.rainChance > 40) {
      lines.push('\u26A0\uFE0F Rain likely \u2014 consider crew adjustments');
    }
  } else {
    lines.push('\u{1F321}\uFE0F <b>Weather \u2014 Aurora, IL</b>');
    lines.push('Weather data unavailable');
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

    const weather = await fetchTomorrowWeather();

    const cache = getScheduleCache();
    let schedules = cache.tomorrow;

    if (!cache.lastSync || schedules.length === 0) {
      // Cache not ready — send with notice
      const tomorrowLabel = getTomorrowLabel();
      const msg = weather
        ? buildBriefingMessage(weather, [])
        : `\u{1F324}\uFE0F <b>Tomorrow's Briefing \u2014 ${tomorrowLabel}</b>\n\nSchedule data still loading \u2014 check crews.sunsetapp.us`;

      await bot.sendMessage(GROUP_CHAT_ID, msg, { parse_mode: 'HTML' });
      logger.info({ event: 'afternoon_briefing_sent', weather: !!weather, scheduleReady: false });
      return;
    }

    const message = buildBriefingMessage(weather, schedules);
    await bot.sendMessage(GROUP_CHAT_ID, message, { parse_mode: 'HTML' });

    logger.info({ event: 'afternoon_briefing_sent', weather: !!weather, scheduleReady: true });
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
