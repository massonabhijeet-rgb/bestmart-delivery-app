export type CheckoutMood =
  | 'breakfast'
  | 'midmorning'
  | 'lunch'
  | 'afternoon'
  | 'gym'
  | 'dinner'
  | 'latenight';

export interface CheckoutMoodCopy {
  emoji: string;
  eyebrow: string;
  title: string;
  subtitle: string;
}

export const CHECKOUT_MOOD_COPY: Record<CheckoutMood, CheckoutMoodCopy> = {
  breakfast: {
    emoji: '☕',
    eyebrow: 'Morning fuel',
    title: 'Start the day right',
    subtitle: 'Coffee, tea, breakfast staples — easy to add now.',
  },
  midmorning: {
    emoji: '🍪',
    eyebrow: 'Snack break',
    title: 'A little something with your tea?',
    subtitle: 'Biscuits, cookies and quick bites people grab around now.',
  },
  lunch: {
    emoji: '🥗',
    eyebrow: 'Lunch hour',
    title: 'Round out your meal',
    subtitle: 'Fresh juice, fruit, yogurt — light add-ons for lunch.',
  },
  afternoon: {
    emoji: '🍫',
    eyebrow: 'Afternoon treats',
    title: 'Treat yourself a little',
    subtitle: 'Chocolates, cookies and tasty snacks for the dip.',
  },
  gym: {
    emoji: '💪',
    eyebrow: 'Pre-workout boost',
    title: 'Heading to the gym?',
    subtitle:
      "It's that time — coffee, energy drinks and hydration to power through your workout.",
  },
  dinner: {
    emoji: '🍦',
    eyebrow: 'After-dinner treat',
    title: "Don't forget dessert",
    subtitle: 'Ice cream, sweets and soft drinks to end the day.',
  },
  latenight: {
    emoji: '🌙',
    eyebrow: 'Late-night cravings',
    title: 'Midnight snacking?',
    subtitle: 'Chips, instant noodles and sweet treats for late-night.',
  },
};

const MOOD_KEYWORDS: Record<CheckoutMood, string[]> = {
  breakfast: [
    'coffee', 'tea', 'chai', 'bread', 'butter', 'jam', 'cereal', 'oats',
    'milk', 'egg', 'cornflake', 'muesli', 'porridge',
  ],
  midmorning: [
    'biscuit', 'cookie', 'rusk', 'snack', 'bar', 'wafer', 'cracker',
  ],
  lunch: [
    'juice', 'salad', 'yogurt', 'curd', 'fruit', 'water', 'mineral',
    'lassi', 'buttermilk', 'smoothie',
  ],
  afternoon: [
    'chocolate', 'kitkat', 'snickers', 'dairy milk', 'cookie', 'biscuit',
    'chips', 'crisp', 'kurkure', 'lays', 'haldiram', 'sweet', 'candy',
    'tea', 'coffee',
  ],
  gym: [
    'coffee', 'espresso', 'energy drink', 'red bull', 'monster', 'sting',
    'caffeine', 'pre-workout', 'pre workout', 'protein', 'whey', 'shake',
    'electrolyte', 'isotonic', 'sports drink', 'gatorade', 'water',
    'mineral', 'banana',
  ],
  dinner: [
    'ice cream', 'kulfi', 'sweet', 'mithai', 'chocolate', 'dessert',
    'soft drink', 'cola', 'pepsi', 'sprite', 'fanta', 'thums up',
  ],
  latenight: [
    'chips', 'crisp', 'kurkure', 'lays', 'haldiram', 'maggi', 'noodle',
    'instant', 'ice cream', 'chocolate', 'biscuit', 'cookie', 'namkeen',
  ],
};

export function moodFromHour(hour: number): CheckoutMood {
  if (hour >= 5 && hour < 9) return 'breakfast';
  if (hour >= 9 && hour < 12) return 'midmorning';
  if (hour >= 12 && hour < 14) return 'lunch';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'gym';
  if (hour >= 21 && hour < 23) return 'dinner';
  return 'latenight';
}

/**
 * Pick products to suggest at checkout based on time of day. Excludes
 * anything already in the cart.
 */
export function pickCheckoutTreats<T extends {
  uniqueId: string;
  name: string;
  category: string | null;
  isActive: boolean;
  stockQuantity: number;
}>(
  products: T[],
  mood: CheckoutMood,
  cart: Record<string, number>,
  max = 8,
): T[] {
  const keywords = MOOD_KEYWORDS[mood];
  const matches: T[] = [];
  for (const p of products) {
    if (!p.isActive || p.stockQuantity <= 0) continue;
    if (cart[p.uniqueId]) continue; // already in cart
    const cat = (p.category ?? '').toLowerCase();
    const name = p.name.toLowerCase();
    if (keywords.some((k) => cat.includes(k) || name.includes(k))) {
      matches.push(p);
      if (matches.length >= max) break;
    }
  }
  return matches;
}
