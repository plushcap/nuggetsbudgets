import React, { useId } from 'react';
import { LucideIcon } from 'lucide-react';
import { Button, Card, Flex, Text, Box } from '@radix-ui/themes';
import StretchedLink, { STRETCHED_OVERLAY } from './StretchedLink';
import { toCents } from '../utils/currency';

/**
 * A card's colour: its left border and its icon, both at step 9 (a fill and an icon, which
 * aren't text). Whole class names, so Tailwind finds them in the source.
 */
const CARD_COLORS = {
  green: { border: 'border-l-4 border-[var(--green-9)]', icon: 'text-[var(--green-9)]' },
  red: { border: 'border-l-4 border-[var(--red-9)]', icon: 'text-[var(--red-9)]' },
  blue: { border: 'border-l-4 border-[var(--blue-9)]', icon: 'text-[var(--blue-9)]' },
  purple: { border: 'border-l-4 border-[var(--purple-9)]', icon: 'text-[var(--purple-9)]' },
  amber: { border: 'border-l-4 border-[var(--amber-9)]', icon: 'text-[var(--amber-9)]' },
} as const;

export type DashboardCardColor = keyof typeof CARD_COLORS;

interface DashboardSummaryCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  subtitle?: string;
  borderColor: DashboardCardColor;
  loading?: boolean;
  amount?: number; // Optional raw amount for negative value styling
  /** Where the card leads: its label becomes a link over the whole card. */
  to?: string;
  /** What the card does instead (e.g. opens a dialog): its action becomes a button over the whole card. */
  onClick?: () => void;
  actionLabel?: string; // Optional call-to-action shown when the card leads somewhere (e.g. "View items →")
}

const DashboardSummaryCard: React.FC<DashboardSummaryCardProps> = ({
  icon: Icon,
  label,
  value,
  subtitle,
  borderColor,
  loading = false,
  amount,
  to,
  onClick,
  actionLabel
}) => {
  const id = useId();
  const colors = CARD_COLORS[borderColor];
  if (loading) {
    return (
      <Card size="2" className={`animate-pulse ${colors.border}`}>
        <Box height="80px" className="bg-[var(--gray-3)] rounded-[var(--radius-2)]"></Box>
      </Card>
    );
  }

  // Red for an amount below zero by its cents: -0.004 shows as $0.00, not in red.
  const isNegative = amount !== undefined && toCents(amount) < 0;
  const valueColor = isNegative ? 'text-[var(--red-11)]' : 'text-[var(--gray-12)]';

  return (
    <Card size="2" className={`hover:shadow-md transition-shadow ${colors.border}`}>
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2">
          <Icon size={20} className={colors.icon} aria-hidden="true" />
          {to ? (
            <Text size="2" weight="medium" className="text-[var(--gray-11)]" asChild>
              <StretchedLink to={to} aria-describedby={subtitle ? `${id}-value ${id}-subtitle` : `${id}-value`}>
                {label}
              </StretchedLink>
            </Text>
          ) : (
            <Text id={`${id}-label`} size="2" weight="medium" className="text-[var(--gray-11)]">
              {label}
            </Text>
          )}
        </Flex>
        
        <Text id={`${id}-value`} size="7" weight="bold" className={valueColor}>
          {value}
        </Text>
        
        {subtitle && (
          <Text id={`${id}-subtitle`} size="2" className="text-[var(--gray-11)]">
            {subtitle}
          </Text>
        )}

        {to && actionLabel && (
          <Text size="1" weight="medium" className="text-[var(--accent-11)]" aria-hidden="true">
            {actionLabel}
          </Text>
        )}

        {!to && onClick && (
          <Button
            variant="ghost"
            size="1"
            onClick={onClick}
            aria-describedby={`${id}-label ${id}-value`}
            className={`${STRETCHED_OVERLAY} self-start`}
          >
            {(actionLabel ?? 'Open').replace(/\s*→\s*$/, '')}
            <span aria-hidden="true">→</span>
          </Button>
        )}
      </Flex>
    </Card>
  );
};

export default DashboardSummaryCard;
