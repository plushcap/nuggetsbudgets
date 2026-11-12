import React from 'react';
import { AlertTriangle, Trash2, Check, Info } from 'lucide-react';
import { AlertDialog, Button, Flex, Box, Text as RadixText } from '@radix-ui/themes';

export interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string | undefined;
  cancelText?: string | undefined;
  variant?: 'danger' | 'warning' | 'info' | 'success' | undefined;
  icon?: React.ReactNode;
  details?: string[] | undefined;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean | undefined;
}

const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  icon,
  details,
  onConfirm,
  onCancel,
  isLoading = false
}) => {
  // Variant configurations
  const variantConfig = {
    danger: {
      iconColor: 'text-[var(--red-11)]',
      iconBg: 'bg-[var(--red-3)]',
      buttonColor: 'red' as const,
      defaultIcon: <Trash2 size={24} />
    },
    warning: {
      iconColor: 'text-[var(--amber-12)]',
      iconBg: 'bg-[var(--amber-3)]',
      buttonColor: 'amber' as const,
      defaultIcon: <AlertTriangle size={24} />
    },
    info: {
      iconColor: 'text-[var(--accent-11)]',
      iconBg: 'bg-[var(--accent-3)]',
      buttonColor: undefined as 'red' | 'amber' | 'green' | undefined,
      defaultIcon: <Info size={24} />
    },
    success: {
      iconColor: 'text-[var(--green-12)]',
      iconBg: 'bg-[var(--green-3)]',
      buttonColor: 'green' as const,
      defaultIcon: <Check size={24} />
    }
  };

  const config = variantConfig[variant];

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={(open) => !open && !isLoading && onCancel()}>
      <AlertDialog.Content maxWidth="450px">
        {/* Icon */}
        <Flex mx="auto" mb="4" width="64px" height="64px" align="center" justify="center" className={`rounded-full ${config.iconBg}`}>
          <div className={config.iconColor}>
            {icon || config.defaultIcon}
          </div>
        </Flex>

        {/* Title */}
        <AlertDialog.Title align="center">
          {title}
        </AlertDialog.Title>

        {/* Message */}
        <AlertDialog.Description align="center">
          <RadixText as="span" className="whitespace-pre-line block">
            {message}
          </RadixText>

          {/* Details */}
          {details && details.length > 0 && (
            <Box mt="4" p="4" className="bg-[var(--gray-3)] rounded-[var(--radius-4)] text-left">
              <RadixText size="1" weight="medium" as="div" mb="2" className="text-[var(--gray-11)] uppercase tracking-wide">
                Details:
              </RadixText>
              <ul className="text-sm text-[var(--gray-11)] space-y-1">
                {details.map((detail, index) => (
                  <Flex asChild key={index} align="start"><li>
                    <Box as="span" display="inline" mr="2" className="text-[var(--gray-11)]">•</Box>
                    <span>{detail}</span>
                  </li></Flex>
                ))}
              </ul>
            </Box>
          )}
        </AlertDialog.Description>

        {/* Buttons */}
        <Flex gap="3" mt="4" justify="end">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray" disabled={isLoading}>
              {cancelText}
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button
              {...(config.buttonColor ? { color: config.buttonColor } : {})}
              onClick={onConfirm}
              disabled={isLoading}
              loading={isLoading}
            >
              {confirmText}
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
};

export default ConfirmationDialog;
