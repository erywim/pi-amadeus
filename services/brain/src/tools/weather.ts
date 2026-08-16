import { type Static, Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { fetchJson } from './net.ts'

/** 天气查询：Open-Meteo 免费 API（无需密钥），先地理编码再取当前 + N 天预报 */

export const weatherToolSchema = Type.Object({
  location: Type.String({ description: '城市名（中文或英文），或 "纬度,经度"' }),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 7, description: '预报天数，默认 3' }))
})

type WeatherArgs = Static<typeof weatherToolSchema>

const WMO_CODES: Record<number, string> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '强雷暴伴大冰雹'
}

const wmo = (code: number): string => WMO_CODES[code] ?? '未知'

interface ForecastResponse {
  current?: {
    temperature_2m?: number
    apparent_temperature?: number
    relative_humidity_2m?: number
    weather_code?: number
    wind_speed_10m?: number
  }
  daily?: {
    time?: string[]
    weather_code?: number[]
    temperature_2m_max?: number[]
    temperature_2m_min?: number[]
  }
}

export function createWeatherTool(opts: { proxy?: string }): AgentTool<typeof weatherToolSchema> {
  return {
    name: 'weather',
    label: '天气查询',
    description: '查询指定城市（或经纬度）的当前天气与未来几天预报。用户询问天气相关问题时使用。',
    parameters: weatherToolSchema,
    execute: async (_toolCallId, params: WeatherArgs) => {
      const days = params.days ?? 3
      const { latitude, longitude, city } = await resolveLocation(params.location, opts.proxy)

      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=${days}`
      const json = (await fetchJson(url, { proxy: opts.proxy })) as ForecastResponse
      const current = json.current
      if (!current) throw new Error('天气数据获取失败')

      const lines: string[] = []
      lines.push(
        `${city}当前天气：${wmo(current.weather_code ?? 0)}，气温 ${current.temperature_2m ?? '?'}°C` +
          `（体感 ${current.apparent_temperature ?? '?'}°C），湿度 ${current.relative_humidity_2m ?? '?'}%，` +
          `风速 ${current.wind_speed_10m ?? '?'} km/h`
      )
      const daily = json.daily
      if (daily?.time) {
        daily.time.forEach((date, i) => {
          lines.push(
            `${date}：${wmo(daily.weather_code?.[i] ?? 0)}，` +
              `${daily.temperature_2m_min?.[i] ?? '?'}°C ~ ${daily.temperature_2m_max?.[i] ?? '?'}°C`
          )
        })
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { city, lat: latitude, lon: longitude }
      }
    }
  }
}

interface GeocodeResponse {
  results?: { latitude?: number; longitude?: number; name?: string }[]
}

/** 城市名 → 经纬度；"纬度,经度" 直用。未找到抛错（→ isError 结果，LLM 会再问用户） */
async function resolveLocation(
  location: string,
  proxy?: string
): Promise<{ latitude: number; longitude: number; city: string }> {
  const coord = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(location.trim())
  if (coord) {
    return { latitude: Number(coord[1]), longitude: Number(coord[2]), city: location.trim() }
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location.trim())}&count=1&language=zh&format=json`
  const json = (await fetchJson(url, { proxy })) as GeocodeResponse
  const hit = json.results?.[0]
  if (!hit || hit.latitude === undefined || hit.longitude === undefined) {
    throw new Error(`未找到地点：${location}`)
  }
  return { latitude: hit.latitude, longitude: hit.longitude, city: hit.name ?? location.trim() }
}
