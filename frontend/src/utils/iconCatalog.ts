import { createElement, forwardRef, useEffect, useState } from 'react';
import type { ComponentType, ForwardedRef, SVGProps } from 'react';
import { Icon } from 'lucide-react';
import type { IconNode, LucideIcon } from 'lucide-react';
import dynamicIconImports from 'lucide-react/dynamicIconImports';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Icon resolution (display path)
//
// Chosen icons are stored as canonical PascalCase Lucide names (e.g. 'Wallet',
// 'PiggyBank' — see the 20260622130000_normalize_account_icons_to_lucide
// migration) and rendered all over the app via `getIconByName`. To avoid
// bundling the entire ~2,000-icon set on every page, each icon is fetched
// lazily through Lucide's per-icon dynamic imports — so a page loads only the
// handful of icons that actually appear in its data. Each module's default
// export is the icon component (its documented use; the path data it holds is
// a Lucide internal, renamed in 1.42). Loaded components are cached
// module-side so re-renders are synchronous (no re-flash).
//
// The picker loads the full set on open via a separate lazy chunk; see
// `iconLibraryFull.ts` / `iconSearchIndex.ts`.
// ---------------------------------------------------------------------------

export type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

export interface IconOption {
  name: string;
  component: IconComponent;
}

const iconImporters = dynamicIconImports as Record<string, () => Promise<{ default?: LucideIcon }>>;

const kebabToPascalCase = (kebab: string): string =>
  kebab
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');

// Authoritative kebab icon names (keys of the dynamic-import map). We derive
// the PascalCase -> kebab lookup from these so resolution is exact even for the
// handful of names where a naive PascalCase->kebab conversion would differ
// (e.g. 'ArrowDown01' <-> 'arrow-down-0-1').
export const iconKebabNames: string[] = Object.keys(dynamicIconImports);

const pascalToKebab = new Map<string, string>();
for (const kebab of iconKebabNames) {
  pascalToKebab.set(kebabToPascalCase(kebab), kebab);
}

export { kebabToPascalCase };

// --- lazy component loading + cache --------------------------------------------

const componentCache = new Map<string, LucideIcon>();
const componentLoaders = new Map<string, Promise<void>>();
// Drawn while an icon loads, and for good if it can't: an empty icon of the same size.
const EMPTY_NODE: IconNode = [];

const loadIconComponent = (kebab: string): Promise<void> => {
  const existing = componentLoaders.get(kebab);
  if (existing) return existing;
  // getIconByName passes only names from these importers; one missing renders empty, below.
  const importer = iconImporters[kebab];
  const loader = (importer ? importer() : Promise.reject(new Error('no importer for the icon')))
    .then((mod) => {
      if (!mod.default) throw new Error('the icon module has no default export');
      componentCache.set(kebab, mod.default);
    })
    .catch((err: unknown) => {
      // Left uncached, so the icon renders empty; the warning makes a broken load visible.
      logger.warn({ err, icon: kebab }, 'Icon failed to load');
    });
  componentLoaders.set(kebab, loader);
  return loader;
};

// One stable component per icon name. Reusing the same component identity keeps
// React from remounting (and re-flashing) the icon on every parent render.
const boundComponents = new Map<string, IconComponent>();

const createLazyIcon = (kebab: string): IconComponent => {
  const LazyIcon = forwardRef(
    (props: SVGProps<SVGSVGElement> & { size?: number | string }, ref: ForwardedRef<SVGSVGElement>) => {
      const [Loaded, setLoaded] = useState<LucideIcon | undefined>(() => componentCache.get(kebab));

      useEffect(() => {
        if (Loaded) return;
        let active = true;
        loadIconComponent(kebab).then(() => {
          // An updater, so React stores the component rather than calling it.
          if (active) setLoaded(() => componentCache.get(kebab));
        });
        return () => {
          active = false;
        };
      }, [Loaded]);

      return Loaded
        ? createElement(Loaded, { ...props, ref })
        : createElement(Icon, { ...props, ref, iconNode: EMPTY_NODE });
    },
  );
  LazyIcon.displayName = `LazyIcon(${kebab})`;
  return LazyIcon as unknown as IconComponent;
};

const getBoundComponent = (kebab: string): IconComponent => {
  let component = boundComponents.get(kebab);
  if (!component) {
    component = createLazyIcon(kebab);
    boundComponents.set(kebab, component);
  }
  return component;
};

/**
 * Resolve a stored icon name to a (lazily-loading) component. Exact match on
 * the canonical PascalCase Lucide name; returns undefined for unknown names so
 * callers can fall back.
 */
export const getIconByName = (name: string | null | undefined): IconOption | undefined => {
  if (!name) return undefined;
  const kebab = pascalToKebab.get(name);
  if (!kebab) return undefined;
  return { name, component: getBoundComponent(kebab) };
};
