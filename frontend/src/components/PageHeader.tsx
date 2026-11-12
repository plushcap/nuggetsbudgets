import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Flex, Box, Heading, Text, IconButton } from '@radix-ui/themes';

interface PageHeaderProps {
  /** Page title */
  title: string;
  /** Optional subtitle/description (string or node) */
  subtitle?: React.ReactNode;
  /** Optional icon rendered in an accent-themed tile */
  icon?: React.ReactNode;
  /** Right-aligned action slot (Radix Buttons/IconButtons) */
  actions?: React.ReactNode;
  /** Back navigation path; renders a back button when set */
  backPath?: string;
  /** Custom back handler (takes precedence over backPath) */
  onBack?: () => void;
  /** Optional secondary content rendered beneath the title/action row */
  children?: React.ReactNode;
}

/**
 * Shared, accent-driven page header for non-settings pages. Colour comes from
 * the theme (accent tile, gray title/subtitle) so it follows the theme picker.
 */
const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  icon,
  actions,
  backPath,
  onBack,
  children,
}) => {
  const navigate = useNavigate();
  const showBack = !!onBack || !!backPath;
  const handleBack = () => {
    if (onBack) onBack();
    else if (backPath) navigate(backPath);
  };

  return (
    <Flex direction="column" gap="4" mb="6">
      <Flex
        direction={{ initial: 'column', sm: 'row' }}
        align={{ initial: 'stretch', sm: 'center' }}
        justify="between"
        gap="4"
      >
        <Flex align="center" gap="3" minWidth="0">
          {showBack && (
            <IconButton
              onClick={handleBack}
              variant="soft"
              color="gray"
              aria-label="Go back"
              style={{ flexShrink: 0 }}
            >
              <ArrowLeft size={20} />
            </IconButton>
          )}
          {icon && (
            <Flex
              align="center"
              justify="center"
              width="40px"
              height="40px"
              flexShrink="0"
              className="bg-[var(--accent-3)] text-[var(--accent-11)] rounded-[var(--radius-3)]"
            >
              {icon}
            </Flex>
          )}
          <Box minWidth="0">
            <Heading size={{ initial: '5', sm: '6' }} truncate>
              {title}
            </Heading>
            {subtitle && (
              <Text as="p" size="2" color="gray">
                {subtitle}
              </Text>
            )}
          </Box>
        </Flex>

        {actions && (
          <Flex gap="2" align="center" justify="end" width={{ initial: '100%', sm: 'auto' }}>
            {actions}
          </Flex>
        )}
      </Flex>

      {children}
    </Flex>
  );
};

export default PageHeader;
