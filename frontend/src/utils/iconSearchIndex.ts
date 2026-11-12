import { iconKebabNames, kebabToPascalCase } from './iconCatalog';

// ---------------------------------------------------------------------------
// Lazy icon search index
//
// Builds a searchable, grouped index over the entire Lucide icon set. The
// keyword data (lucide-static/tags.json, ~230KB) is dynamically imported so it
// only ships in the chunk loaded when the icon picker first opens — it never
// weighs down the forms that merely *render* a chosen icon.
//
// Lucide does not publish its official category metadata to npm (only search
// tags), so the named groups below are derived from each icon's name segments
// and tags via keyword rules. An icon can belong to several groups.
// ---------------------------------------------------------------------------

export interface IconIndexEntry {
  /** Canonical PascalCase Lucide name (the stored value). */
  name: string;
  /** Kebab-case name + search tags, lower-cased, for substring matching. */
  searchText: string;
  /** Group labels this icon belongs to. */
  groups: string[];
}

/** The "browse by group" filters offered in the picker, in display order. */
export const ICON_GROUPS = [
  'Food & beverage',
  'Home',
  'Medical',
  'Nature',
  'Navigation & Places',
  'Tools',
  'Transportation',
  'Travel',
] as const;

export type IconGroup = (typeof ICON_GROUPS)[number];

// Keyword tokens that place an icon into a group. Matched against the icon's
// kebab-name segments and its lucide tags (token-equality, not substring, to
// avoid false positives like "home" matching "chrome").
const GROUP_KEYWORDS: Record<IconGroup, string[]> = {
  'Food & beverage': [
    'food', 'beverage', 'drink', 'drinks', 'coffee', 'tea', 'restaurant', 'meal', 'dining',
    'fruit', 'vegetable', 'vegetables', 'pizza', 'burger', 'sandwich', 'wine', 'beer', 'cocktail',
    'martini', 'cup', 'mug', 'bottle', 'cake', 'dessert', 'candy', 'cookie', 'egg', 'milk', 'soup',
    'salad', 'utensils', 'fork', 'spoon', 'chef', 'croissant', 'donut', 'popcorn', 'ice', 'cream',
    'apple', 'banana', 'grape', 'cherry', 'carrot', 'fish', 'ham', 'drumstick', 'wheat', 'soda',
  ],
  Home: [
    'home', 'house', 'furniture', 'sofa', 'couch', 'armchair', 'bed', 'lamp', 'door', 'kitchen',
    'appliance', 'fridge', 'refrigerator', 'microwave', 'oven', 'blender', 'washing', 'laundry',
    'bath', 'bathtub', 'shower', 'toilet', 'roof', 'garage', 'household', 'vacuum', 'iron',
  ],
  Medical: [
    'medical', 'health', 'hospital', 'doctor', 'nurse', 'clinic', 'pill', 'pills', 'medicine',
    'syringe', 'vaccine', 'injection', 'stethoscope', 'pulse', 'heartbeat', 'bandage', 'plaster',
    'ambulance', 'dna', 'brain', 'tooth', 'dental', 'bone', 'virus', 'bacteria', 'microscope',
    'thermometer', 'wheelchair', 'cross',
  ],
  Nature: [
    'nature', 'tree', 'trees', 'leaf', 'leaves', 'flower', 'plant', 'sprout', 'forest', 'mountain',
    'mountains', 'sun', 'sunrise', 'sunset', 'moon', 'cloud', 'rain', 'snow', 'snowflake', 'wind',
    'droplet', 'water', 'wave', 'waves', 'fire', 'flame', 'earth', 'animal', 'bird', 'fish', 'bug',
    'paw', 'feather', 'eclipse', 'tornado', 'rainbow', 'shell',
  ],
  'Navigation & Places': [
    'navigation', 'navigate', 'map', 'pin', 'location', 'gps', 'compass', 'route', 'signpost',
    'direction', 'directions', 'place', 'places', 'building', 'buildings', 'landmark', 'monument',
    'flag', 'milestone', 'waypoint', 'marker', 'locate',
  ],
  Tools: [
    'tool', 'tools', 'wrench', 'hammer', 'screwdriver', 'drill', 'saw', 'axe', 'pickaxe',
    'construction', 'repair', 'toolbox', 'pliers', 'shovel', 'nut', 'bolt', 'hardhat',
  ],
  Transportation: [
    'transport', 'transportation', 'car', 'bus', 'train', 'truck', 'plane', 'airplane', 'aircraft',
    'bike', 'bicycle', 'motorcycle', 'vehicle', 'taxi', 'tram', 'ship', 'boat', 'ferry', 'fuel',
    'gasoline', 'scooter', 'drone', 'sailboat', 'caravan', 'forklift', 'tractor', 'fuel',
  ],
  Travel: [
    'travel', 'luggage', 'suitcase', 'baggage', 'map', 'compass', 'ticket', 'hotel', 'beach',
    'vacation', 'holiday', 'passport', 'tent', 'camping', 'backpack', 'flight', 'palm', 'parasol',
    'concierge', 'souvenir', 'umbrella',
  ],
};

const GROUP_KEYWORD_SETS: Array<{ group: IconGroup; set: Set<string> }> = ICON_GROUPS.map((group) => ({
  group,
  set: new Set(GROUP_KEYWORDS[group]),
}));

let indexPromise: Promise<IconIndexEntry[]> | null = null;

/** The index entry for one Lucide icon, by its kebab name. */
const entryFor = (kebab: string, tags: Record<string, string[]>): IconIndexEntry => {
  const name = kebabToPascalCase(kebab);
  const keywords = tags[kebab] ?? [];

  // Tokens used for group matching: name segments + individual tag words.
  const tokens = new Set<string>(kebab.split('-'));
  for (const keyword of keywords) {
    for (const word of keyword.split(/\s+/)) {
      if (word) tokens.add(word.toLowerCase());
    }
  }

  const groups = GROUP_KEYWORD_SETS.filter(({ set }) => {
    for (const token of tokens) {
      if (set.has(token)) return true;
    }
    return false;
  }).map(({ group }) => group);

  const searchText = [kebab, ...keywords].join(' ').toLowerCase();

  return { name, searchText, groups };
};

const buildIndex = async (): Promise<IconIndexEntry[]> => {
  const tags = ((await import('lucide-static/tags.json')).default ?? {}) as Record<string, string[]>;

  // One entry per stored name: four Lucide pairs (arrow-down-0-1 and arrow-down-01, …) are the
  // same PascalCase name, the same icon. Two entries with one name gave the picker's grid
  // duplicate React keys, which left stale buttons after a search. Their tags are merged.
  const byName = new Map<string, IconIndexEntry>();
  for (const entry of iconKebabNames.map((kebab) => entryFor(kebab, tags))) {
    const seen = byName.get(entry.name);
    if (!seen) byName.set(entry.name, entry);
    else {
      seen.searchText = `${seen.searchText} ${entry.searchText}`;
      seen.groups = [...new Set([...seen.groups, ...entry.groups])];
    }
  }
  return [...byName.values()];
};

/** Build (once) and return the full searchable icon index. */
export const loadIconIndex = (): Promise<IconIndexEntry[]> => {
  if (!indexPromise) indexPromise = buildIndex();
  return indexPromise;
};
