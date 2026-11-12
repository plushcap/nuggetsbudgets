import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Flex, Heading, Text, Button, IconButton } from '@radix-ui/themes';

interface SettingsPageHeaderProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description */
  subtitle?: string | undefined;
  /** Icon component to display */
  icon: React.ReactNode;
  /** The icon's background: a Radix variable class (default `bg-[var(--accent-3)]`). */
  iconBackground?: string;
  /** Primary action button config */
  primaryAction?: {
    label: string;
    onClick: (e?: React.MouseEvent) => void;
    icon?: React.ReactNode;
    disabled?: boolean;
    loading?: boolean;
  };
  /** Optional secondary action button */
  secondaryAction?: {
    label: string;
    onClick: (e?: React.MouseEvent) => void;
    icon?: React.ReactNode;
    variant?: 'primary' | 'secondary';
  };
  /** Back navigation path (defaults to /settings) */
  backPath?: string;
  /** Hide back button */
  hideBackButton?: boolean;
}

/**
 * Reusable header component for settings pages. One responsive layout: stacked on a
 * narrow screen (full-width actions under the title), a row from `md` up. The title is
 * the page's <h1>, which a screen reader lists and the app focuses after navigating.
 */
const SettingsPageHeader: React.FC<SettingsPageHeaderProps> = ({
  title,
  subtitle,
  icon,
  iconBackground = 'bg-[var(--accent-3)]',
  primaryAction,
  secondaryAction,
  backPath = '/settings',
  hideBackButton = false,
}) => {
  const navigate = useNavigate();

  return (
    <Flex
      direction={{ initial: 'column', md: 'row' }}
      align={{ initial: 'stretch', md: 'center' }}
      justify="between"
      gap="4"
      mb={{ initial: '6', md: '8' }}
    >
      <Flex align="center" gap="3" minWidth="0">
        {!hideBackButton && (
          <IconButton
            onClick={() => navigate(backPath)}
            variant="soft"
            color="gray"
            aria-label="Back to settings"
            style={{ flexShrink: 0 }}
          >
            <ArrowLeft size={20} />
          </IconButton>
        )}
        <Flex width="40px" height="40px" align="center" justify="center" flexShrink="0" className={`${iconBackground} rounded-[var(--radius-5)]`}>
          {icon}
        </Flex>
        <Flex direction="column" minWidth="0">
          <Heading as="h1" size={{ initial: '5', md: '6' }} weight="bold" color="gray" highContrast>
            {title}
          </Heading>
          {subtitle && (
            <Text size="2" color="gray">
              {subtitle}
            </Text>
          )}
        </Flex>
      </Flex>

      {(primaryAction || secondaryAction) && (
        <Flex direction={{ initial: 'column', md: 'row' }} align={{ initial: 'stretch', md: 'center' }} gap={{ initial: '2', md: '3' }}>
          {secondaryAction && (
            <Button
              onClick={secondaryAction.onClick}
              variant={secondaryAction.variant === 'primary' ? 'solid' : 'soft'}
              {...(secondaryAction.variant === 'primary' ? {} : { color: 'gray' as const })}
              className="min-h-[44px] md:min-h-0"
            >
              {secondaryAction.icon}
              <span>{secondaryAction.label}</span>
            </Button>
          )}
          {primaryAction && (
            <Button
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled ?? false}
              loading={primaryAction.loading ?? false}
              className="min-h-[44px] md:min-h-0"
            >
              {primaryAction.icon}
              <span>{primaryAction.label}</span>
            </Button>
          )}
        </Flex>
      )}
    </Flex>
  );
};

export default SettingsPageHeader;
