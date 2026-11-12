/**
 * A Card's corners at the radius every Close-Out card has (size 1's and 2's: radius-4, 8px at
 * the theme's medium radius), whatever its size. The larger cards take their padding from a Card
 * size (3 is 24px, 5 is 48px, as the Tailwind p-6 and p-12 they replaced), and a larger size
 * brings larger corners too (radius-5, radius-6), which set them apart from the cards beside
 * them. It follows the theme picker's radius, as a size's own corners do.
 */
export const CARD_CORNERS = '[--card-border-radius:var(--radius-4)]';
