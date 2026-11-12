import { useState, useCallback } from 'react';
import { ConfirmationDialogProps } from '../components/ConfirmationDialog';

export interface UseConfirmationOptions {
  title: string;
  message: string;
  confirmText?: string | undefined;
  cancelText?: string | undefined;
  variant?: 'danger' | 'warning' | 'info' | 'success' | undefined;
  icon?: React.ReactNode;
  details?: string[] | undefined;
}

export interface UseConfirmationReturn {
  isOpen: boolean;
  confirmAsync: (options?: Partial<UseConfirmationOptions>) => Promise<boolean>;
  confirm: (onConfirm: () => void, options?: Partial<UseConfirmationOptions>) => void;
  dialogProps: ConfirmationDialogProps;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

/** The options that were given a value: one passed as undefined keeps what it would replace. */
const given = (options?: Partial<UseConfirmationOptions>): Partial<UseConfirmationOptions> =>
  Object.fromEntries(Object.entries(options ?? {}).filter(([, value]) => value !== undefined));

/**
 * A dialog's options: those given to the call, over the hook's, over the plain defaults (spread
 * as they were, an option passed as undefined blanked the default, a title or button text).
 */
const mergeOptions = (
  defaultOptions?: UseConfirmationOptions,
  options?: Partial<UseConfirmationOptions>,
): UseConfirmationOptions => ({
  title: 'Confirm Action',
  message: 'Are you sure you want to continue?',
  ...given(defaultOptions),
  ...given(options),
});

export const useConfirmation = (defaultOptions?: UseConfirmationOptions): UseConfirmationReturn => {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [currentOptions, setCurrentOptions] = useState<UseConfirmationOptions | null>(null);
  const [resolvePromise, setResolvePromise] = useState<((confirmed: boolean) => void) | null>(null);
  const [confirmCallback, setConfirmCallback] = useState<(() => void) | null>(null);

  // Async version - returns a promise
  const confirmAsync = useCallback((options?: Partial<UseConfirmationOptions>): Promise<boolean> => {
    setCurrentOptions(mergeOptions(defaultOptions, options));
    setIsOpen(true);
    
    return new Promise<boolean>((resolve) => {
      setResolvePromise(() => resolve);
    });
  }, [defaultOptions]);

  // Callback version - executes callback on confirm
  const confirm = useCallback((onConfirm: () => void, options?: Partial<UseConfirmationOptions>) => {
    setCurrentOptions(mergeOptions(defaultOptions, options));
    setConfirmCallback(() => onConfirm);
    setIsOpen(true);
  }, [defaultOptions]);

  const handleConfirm = useCallback(() => {
    if (resolvePromise) {
      resolvePromise(true);
      setResolvePromise(null);
    }
    
    if (confirmCallback) {
      confirmCallback();
      setConfirmCallback(null);
    }
    
    setIsOpen(false);
    setIsLoading(false);
  }, [resolvePromise, confirmCallback]);

  const handleCancel = useCallback(() => {
    if (resolvePromise) {
      resolvePromise(false);
      setResolvePromise(null);
    }
    
    setConfirmCallback(null);
    setIsOpen(false);
    setIsLoading(false);
  }, [resolvePromise]);

  const dialogProps: ConfirmationDialogProps = {
    isOpen,
    title: currentOptions?.title || '',
    message: currentOptions?.message || '',
    confirmText: currentOptions?.confirmText,
    cancelText: currentOptions?.cancelText,
    variant: currentOptions?.variant,
    icon: currentOptions?.icon,
    details: currentOptions?.details,
    isLoading,
    onConfirm: handleConfirm,
    onCancel: handleCancel,
  };

  return {
    isOpen,
    confirmAsync,
    confirm,
    dialogProps,
    isLoading,
    setIsLoading,
  };
};
