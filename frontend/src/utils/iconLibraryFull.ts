import * as LucideIcons from 'lucide-react';
import type { IconComponent } from './iconCatalog';

// ---------------------------------------------------------------------------
// Full icon library (picker only)
//
// `import *` pulls the entire Lucide set into ONE chunk. This module is only
// ever loaded via dynamic import() from the icon picker, so that chunk ships
// lazily when the picker opens (never on the pages that merely render a chosen
// icon — those use the per-icon lazy path in iconCatalog.ts). Loading the whole
// set together lets the picker grid render instantly while browsing.
// ---------------------------------------------------------------------------

const NON_ICON_EXPORTS = new Set(['createLucideIcon', 'Icon', 'icons', 'createReactComponent', 'default']);

const isCanonicalIconName = (name: string): boolean => {
  if (NON_ICON_EXPORTS.has(name)) return false;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return false;
  if (name.endsWith('Icon')) return false;
  if (name.startsWith('Lucide')) return false;
  return true;
};

const fullIconMap = new Map<string, IconComponent>();
for (const [name, value] of Object.entries(LucideIcons)) {
  if (!isCanonicalIconName(name)) continue;
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
  fullIconMap.set(name, value as IconComponent);
}

/** Resolve a PascalCase Lucide name to its component (full set in memory). */
export const getFullIcon = (name: string): IconComponent | undefined => fullIconMap.get(name);
