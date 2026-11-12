import React from 'react';
import { Box, Container, type BoxProps } from '@radix-ui/themes';

/**
 * How wide a page is, by its kind:
 * - `wide` (the default): every page that shows content (lists, hubs, detail pages, reports,
 *   settings lists): up to 1600px, centred, so tables and card grids use a desktop's width.
 * - `form`: a single-column form (Radix `Container size="3"`, ~880px).
 * - `editor`: an editor with a side panel, like the budget-item and goal edit pages
 *   (`size="4"`, ~1136px).
 * - `auth`: a centred card, like sign-in (`size="1"`).
 */
export type PageWidth = 'wide' | 'form' | 'editor' | 'auth';

const CONTAINER_SIZE = { form: '3', editor: '4', auth: '1' } as const;

/** The side gutters every page has: 16px on a phone (Radix space 4), 32px from the `sm` breakpoint (space 6). */
export const PAGE_GUTTER = { initial: '4', sm: '6' } as const;

interface PageContainerProps {
  /** The page's kind; `wide` unless it is a form, an editor or a sign-in card. */
  width?: PageWidth;
  /** Space above and below, for a page with no header to set it (a not-found or an invitation page). */
  py?: BoxProps['py'] | undefined;
  children?: React.ReactNode;
}

/**
 * The one page wrapper: every page in src/pages renders inside it, in its loading, error and
 * empty states too, so it doesn't change width once its data arrives. `npm run lint:guard`
 * refuses a width wrapper written by hand in a page (a Radix `Container`, a `maxWidth` or a
 * `max-w-*` at page scale), and a page component that returns without this one.
 */
const PageContainer: React.FC<PageContainerProps> = ({ width = 'wide', py, children }) => {
  // Radix's py takes no `undefined` (exactOptionalPropertyTypes): only a page that sets it passes it.
  const space = py === undefined ? {} : { py };
  if (width === 'wide') {
    return (
      <Box width="100%" maxWidth="1600px" px={PAGE_GUTTER} mx="auto" {...space} data-page-width="wide">
        {children}
      </Box>
    );
  }
  return (
    <Container size={CONTAINER_SIZE[width]} px={PAGE_GUTTER} {...space} data-page-width={width}>
      {children}
    </Container>
  );
};

export default PageContainer;
