export type WeatherMood = 'hot' | 'warm' | 'rainy' | 'cool' | 'cold';

export interface MoodCopy {
  emoji: string;
  eyebrow: string;
  title: string;
  subtitle: string;
}

export const MOOD_COPY: Record<WeatherMood, MoodCopy> = {
  hot: {
    emoji: '☀️',
    eyebrow: 'Beat the heat',
    title: 'Cold drinks & summer must-haves',
    subtitle: 'It\'s warm out there — stay cool with these picks.',
  },
  warm: {
    emoji: '🌤️',
    eyebrow: 'Sunny & pleasant',
    title: 'Fresh picks for the day',
    subtitle: 'Light, refreshing options hand-picked for today.',
  },
  rainy: {
    emoji: '🌧️',
    eyebrow: 'Monsoon mood',
    title: 'Warm brews & rainy-day snacks',
    subtitle: 'A cup of tea and something crunchy — the perfect combo.',
  },
  cool: {
    emoji: '🍃',
    eyebrow: 'Cool breeze',
    title: 'Cosy kitchen staples',
    subtitle: 'Warm up with tea, coffee, and comforting bites.',
  },
  cold: {
    emoji: '❄️',
    eyebrow: 'Winter essentials',
    title: 'Warm-up picks for a chilly day',
    subtitle: 'Boost your pantry with hot drinks and nourishing staples.',
  },
};

const MOOD_KEYWORDS: Record<WeatherMood, string[]> = {
  hot: [
    'cold drink', 'juice', 'soda', 'soft drink', 'lemonade', 'lassi',
    'buttermilk', 'butter milk', 'chhaas', 'curd', 'yogurt', 'yoghurt',
    'ice cream', 'kulfi', 'sorbet', 'coconut water', 'watermelon',
    'shake', 'smoothie', 'chilled', 'fruit', 'mint', 'nimbu', 'jaljeera',
  ],
  warm: [
    'fruit', 'juice', 'salad', 'yogurt', 'curd', 'smoothie', 'shake',
    'fresh', 'vegetable',
  ],
  rainy: [
    'tea', 'coffee', 'maggi', 'noodle', 'instant', 'pakora', 'pakoda',
    'fritter', 'bhajiya', 'samosa', 'soup', 'chai', 'masala', 'chips',
    'crisps', 'chivda', 'namkeen', 'biscuit', 'cookie', 'rusk',
  ],
  cool: [
    'tea', 'coffee', 'chai', 'biscuit', 'cookie', 'rusk', 'soup',
    'oats', 'porridge', 'nuts', 'dry fruit', 'almond', 'cashew',
  ],
  cold: [
    'tea', 'coffee', 'chai', 'soup', 'ghee', 'jaggery', 'honey',
    'dry fruit', 'almond', 'cashew', 'chyawanprash', 'turmeric',
    'chilli', 'pepper', 'pickle', 'masala', 'hot', 'broth',
  ],
};

/**
 * Rough India-calendar classification used when we don't have live
 * weather data. Months are 0-indexed (0 = Jan).
 */
export function moodFromIndiaCalendar(date = new Date()): WeatherMood {
  const m = date.getMonth(); // 0..11
  if (m >= 2 && m <= 5) return 'hot'; // Mar–Jun
  if (m >= 6 && m <= 8) return 'rainy'; // Jul–Sep
  if (m === 9) return 'warm'; // Oct
  return 'cold'; // Nov–Feb
}

/**
 * Map (temperature, weather code) to a mood. Weather codes follow the
 * WMO convention used by Open-Meteo.
 */
export function moodFromWeather(tempC: number, weatherCode: number): WeatherMood {
  const rainyCodes = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
  if (rainyCodes.has(weatherCode)) return 'rainy';
  if (tempC >= 30) return 'hot';
  if (tempC >= 22) return 'warm';
  if (tempC >= 12) return 'cool';
  return 'cold';
}

export async function fetchOpenMeteoMood(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<WeatherMood | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      current?: { temperature_2m?: number; weather_code?: number };
    };
    const temp = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    if (typeof temp !== 'number' || typeof code !== 'number') return null;
    return moodFromWeather(temp, code);
  } catch {
    return null;
  }
}

/**
 * Pick products whose name OR category matches any keyword for the mood.
 * Limits to `max` items.
 */
export function pickProductsForMood<T extends { name: string; category: string | null }>(
  products: T[],
  mood: WeatherMood,
  max = 12,
): T[] {
  const keywords = MOOD_KEYWORDS[mood];
  const matches: T[] = [];
  for (const p of products) {
    const cat = (p.category ?? '').toLowerCase();
    const name = p.name.toLowerCase();
    if (keywords.some((k) => cat.includes(k) || name.includes(k))) {
      matches.push(p);
      if (matches.length >= max) break;
    }
  }
  return matches;
}
