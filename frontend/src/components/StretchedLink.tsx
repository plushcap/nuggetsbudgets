import React from 'react';
import { Link, type LinkProps } from 'react-router-dom';

/**
 * Put on a control inside a card that has a StretchedLink (a button, another link), so
 * it sits above the link's overlay and keeps its own clicks.
 */
export const ABOVE_STRETCHED_LINK = 'relative z-[1]';

/**
 * The classes that stretch a link's (or a Radix ghost Button's) click area over the
 * nearest positioned ancestor (a Radix Card is one) with an `::after`, and draw its
 * keyboard focus ring around that whole area, inside the card's clipped edge.
 */
export const STRETCHED_OVERLAY =
  "after:absolute after:inset-0 after:content-[''] after:rounded-[inherit] focus-visible:outline-hidden focus-visible:after:outline-solid focus-visible:after:outline-2 focus-visible:after:outline-offset-[-2px] focus-visible:after:outline-[var(--accent-8)]";

/**
 * A card's main link (usually its title), stretched over the whole card, so a click
 * anywhere on the card follows it, as before, while the keyboard reaches the card as one
 * link, named by its text, with a focus ring around the card. It replaces an `onClick`
 * on the Card itself, which no keyboard or screen reader can reach.
 */
const StretchedLink: React.FC<LinkProps> = ({ className = '', ...props }) => (
  <Link {...props} className={`${STRETCHED_OVERLAY} ${className}`} />
);

export default StretchedLink;

/**
 * A table row's click handler for mouse users (a row can't hold a stretched link): it
 * follows the row's link, and leaves alone a click that lands on a control inside the
 * row, which does its own thing. Keyboard users use the link in the row's name cell.
 */
export const rowClick =
  (go: () => void) =>
  (event: React.MouseEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('a, button, input, label, [role="checkbox"], [role="menuitem"]')) return;
    go();
  };
