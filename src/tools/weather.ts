import { fetchRegionalForecast, fetchJobRainAlerts, WeatherData } from '../workers/afternoonBriefing';
import { getScheduleCache } from '../workers/landscapeSync';
import logger from '../logger';

const REGION_LABEL = 'Aurora-Naperville Region';

export async function getWeatherForecast(day: string): Promise<string> {
  try {
    const dayIndex = day === 'today' ? 0 : 1;
    const dayLabel = day === 'today' ? 'Today' : 'Tomorrow';
    const weather = await fetchRegionalForecast(dayIndex);

    if (!weather) {
      return `Weather data is currently unavailable. Try again in a few minutes.`;
    }

    const lines: string[] = [];
    lines.push(`\u2600\uFE0F Weather for ${dayLabel} \u2014 ${REGION_LABEL}`);
    lines.push(`Conditions: ${weather.conditions}`);
    lines.push(`High: ${weather.high}\u00B0F  |  Low: ${weather.low}\u00B0F`);
    lines.push(`Rain chance: ${weather.rainChance}%`);
    lines.push(`Wind: ${weather.windSpeed} mph ${weather.windDir}`);

    if (weather.rainChance > 40) {
      lines.push(`\u26A0\uFE0F Rain likely \u2014 consider crew adjustments`);

      // Fetch per-job rain alerts if schedule data is available
      const cache = getScheduleCache();
      const schedules = day === 'today' ? cache.today : cache.tomorrow;
      if (cache.lastSync && schedules.length > 0) {
        try {
          const rainAlerts = await fetchJobRainAlerts(schedules);
          if (rainAlerts.length > 0) {
            lines.push('');
            lines.push('\u26A0\uFE0F Rain Alert \u2014 Job-level forecast:');
            for (const alert of rainAlerts) {
              const warn = alert.rainChance > 50 ? ' \u26A0\uFE0F' : '';
              lines.push(`  ${alert.crewLabel} ${alert.leadName} \u2014 ${alert.city} (Job #${alert.jobNumber} ${alert.clientName}): ${alert.rainChance}% rain${warn}`);
            }
          }
        } catch (err) {
          logger.warn({
            event: 'weather_tool_rain_alert_error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return lines.join('\n');
  } catch (err) {
    logger.error({
      event: 'weather_tool_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return `Could not fetch weather: ${err instanceof Error ? err.message : String(err)}`;
  }
}
