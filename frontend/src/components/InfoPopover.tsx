import React, { useId, useState, type ReactNode } from 'react';
import { IconButton, Popover, Text } from '@radix-ui/themes';
import { Info } from 'lucide-react';

interface InfoPopoverProps {
  /** The button's name, read by screen readers ("About …"), and the open tip's. */
  label: string;
  children: ReactNode;
}

/**
 * An info icon that explains a section: a button that opens its text in a popover, by
 * click, tap or keyboard. It replaces hover-only tooltips, which the keyboard
 * couldn't reach and a touch screen opened only by accident of the hover variant.
 *
 * The open tip takes the focus, named by `label` and described by its text, which a screen
 * reader then reads. It has nothing to tab to, and Radix's focus scope swallowed Tab there,
 * so only Escape got out: Tab and Shift+Tab now close it, back on its button.
 */
const InfoPopover: React.FC<InfoPopoverProps> = ({ label, children }) => {
  const [open, setOpen] = useState(false);
  const textId = useId();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <IconButton type="button" variant="ghost" color="gray" size="1" aria-label={label}>
          <Info size={20} aria-hidden="true" />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content
        size="1"
        maxWidth="280px"
        aria-label={label}
        aria-describedby={textId}
        onKeyDown={(event) => {
          if (event.key === 'Tab') setOpen(false);
        }}
      >
        <Text as="p" size="2" id={textId}>{children}</Text>
      </Popover.Content>
    </Popover.Root>
  );
};

export default InfoPopover;
