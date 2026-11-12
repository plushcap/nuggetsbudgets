import React, { useId, useState } from 'react';
import { format } from 'date-fns';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import { Popover, Box, Flex } from '@radix-ui/themes';
import { DateUtils } from '../utils/dateUtils';

export interface RadixDatePickerProps {
  value?: string; // ISO date string (YYYY-MM-DD)
  onChange: (date: string) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean;
  size?: '1' | '2' | '3';
  className?: string | undefined;
  /** The id of this field's visible label. The trigger is named by it, then by the date it shows. */
  'aria-labelledby'?: string | undefined;
  /** A name for a picker without a visible label (e.g. "From"); the date it shows follows it. */
  'aria-label'?: string | undefined;
  /** Ids of the field's hint and error messages (fieldErrorProps): read after its name. */
  'aria-describedby'?: string | undefined;
  /**
   * The trigger button's id, for a `focusFirstError` selector or a `fieldErrorProps` field id,
   * so a refused date is focused on the button itself. Without one it makes its own.
   */
  id?: string | undefined;
}

const RadixDatePicker: React.FC<RadixDatePickerProps> = ({
  value,
  onChange,
  placeholder = 'Pick a date',
  disabled = false,
  required = false,
  size = '3',
  className = '',
  'aria-labelledby': labelledBy,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  id,
}) => {
  const ownId = useId();
  const triggerId = id ?? ownId;
  const [open, setOpen] = useState(false);

  // Convert ISO string to Date object using DateUtils to avoid timezone issues
  const selectedDate = value ? DateUtils.parseBusinessDate(value) : undefined;

  const handleSelect = (date: Date | undefined) => {
    if (date) {
      // Convert to ISO date string (YYYY-MM-DD)
      const isoDate = format(date, 'yyyy-MM-dd');
      onChange(isoDate);
      setOpen(false);
    }
  };

  const shown = value ? format(DateUtils.parseBusinessDate(value), 'PPP') : placeholder;

  // Size mapping to match Radix TextField exactly (the 10px padding of size 2 has no space token).
  const sizeHeights = { '1': '24px', '2': '32px', '3': '40px' } as const;
  const sizeClasses = {
    '1': 'px-2 text-xs',
    '2': 'px-2.5 text-sm',
    '3': 'px-3 text-base'
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Flex asChild width="100%" height={sizeHeights[size]} align="center" gap="2">
        <button
          type="button"
          disabled={disabled}
          id={triggerId}
          aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
          aria-label={ariaLabel ? (value || placeholder !== ariaLabel ? `${ariaLabel}: ${shown}` : ariaLabel) : undefined}
          aria-describedby={describedBy}
          className={`
            ${sizeClasses[size]}
            bg-[var(--color-surface)]
            field-border border border-[var(--gray-a7)]
            rounded-[var(--radius-3)]
            hover:border-[var(--gray-a8)]
            focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--accent-9)] focus-visible:ring-offset-0
            disabled:opacity-50 disabled:cursor-not-allowed
            transition-colors
            ${value ? 'text-[var(--gray-12)]' : 'text-[var(--gray-11)]'}
            ${className}
          `}
        >
          <CalendarIcon size={16} className="shrink-0" />
          <Box as="span" display="inline" flexGrow="1" flexBasis="0%" className="text-left">
            {shown}
          </Box>
        </button>
        </Flex>
      </Popover.Trigger>
      {/* Radix Themes' Popover (not the standalone @radix-ui/react-popover): it shares
          Themes' Radix internals, so inside a Themes Dialog the two dismissable layers
          know about each other and the calendar stays clickable, and its portal keeps
          the theme's CSS variables. minWidth="0" lets it hug the calendar: Themes makes a
          popover at least as wide as its trigger, which pushed the next-month arrow off to
          the right of a wide field. */}
      <Popover.Content align="start" sideOffset={8} minWidth="0">
          <style>{`
            /* v9 CSS Variables */
            .rdp-custom {
              --rdp-accent-color: var(--accent-9);
              --rdp-accent-background-color: var(--accent-9);
            }

            /* Root container */
            .rdp-custom .rdp-root {
              margin: 0;
            }

            /* Month container */
            .rdp-custom .rdp-month {
              width: 280px;
            }

            /* Month caption (header with month/year) */
            .rdp-custom .rdp-month_caption {
              display: flex;
              justify-content: center;
              align-items: center;
              padding: 0.5rem 0 1rem 0;
              position: relative;
              font-size: 0.875rem;
              font-weight: 500;
              color: var(--gray-12);
            }

            /* Navigation container - hide to allow absolute positioning of buttons */
            .rdp-custom .rdp-nav {
              position: static;
            }
            
            /* Navigation buttons - base styles */
            .rdp-custom .rdp-button_previous,
            .rdp-custom .rdp-button_next {
              width: 28px;
              height: 28px;
              padding: 0;
              background: transparent;
              border: none;
              border-radius: var(--radius-1);
              display: inline-flex;
              align-items: center;
              justify-content: center;
              color: var(--gray-11);
              cursor: pointer;
              transition: background-color 0.15s ease;
              position: absolute;
              top: 0.5rem;
              /* Above the month caption, which is positioned and comes later in the DOM,
                 so it would otherwise cover the buttons and take their clicks. */
              z-index: 1;
            }
            
            /* Position previous button on left with small margin */
            .rdp-custom .rdp-button_previous {
              left: 0.25rem;
            }
            
            /* Position next button on right with small margin */
            .rdp-custom .rdp-button_next {
              right: 0.25rem;
            }
            .rdp-custom .rdp-button_previous:hover:not(:disabled),
            .rdp-custom .rdp-button_next:hover:not(:disabled) {
              background-color: var(--gray-3);
            }
            .rdp-custom .rdp-button_previous:disabled,
            .rdp-custom .rdp-button_next:disabled {
              opacity: 0.3;
              cursor: not-allowed;
            }

            /* Caption label - positioned between nav buttons */
            .rdp-custom .rdp-caption_label {
              flex: 1;
              text-align: center;
            }

            /* Month grid (table) */
            .rdp-custom .rdp-month_grid {
              width: 100%;
              border-collapse: collapse;
              margin-top: 0.5rem;
            }

            /* Weekday headers */
            .rdp-custom .rdp-weekday {
              width: 40px;
              height: 32px;
              text-align: center;
              font-size: 0.75rem;
              font-weight: 500;
              color: var(--gray-11);
              padding: 0.25rem 0;
            }

            /* Day cell container */
            .rdp-custom .rdp-day {
              width: 40px;
              height: 40px;
              text-align: center;
              padding: 2px;
            }

            /* Day button */
            .rdp-custom .rdp-day_button {
              width: 36px;
              height: 36px;
              padding: 0;
              font-size: 0.875rem;
              border: none;
              background: transparent;
              border-radius: var(--radius-2);
              display: inline-flex;
              align-items: center;
              justify-content: center;
              color: var(--gray-12);
              cursor: pointer;
              transition: background-color 0.15s ease;
            }

            /* Day button hover */
            .rdp-custom .rdp-day_button:hover:not(.rdp-selected):not(.rdp-disabled) {
              background-color: var(--gray-3);
            }

            /* Selected day */
            .rdp-custom .rdp-selected .rdp-day_button {
              background-color: var(--accent-9) !important;
              color: var(--accent-contrast) !important;
              font-weight: 500;
            }

            /* Today */
            .rdp-custom .rdp-today:not(.rdp-selected) .rdp-day_button {
              background-color: var(--gray-4);
              font-weight: 600;
            }


            /* Disabled days */
            .rdp-custom .rdp-disabled .rdp-day_button {
              color: var(--gray-8);
              cursor: not-allowed;
              opacity: 0.3;
            }
          `}</style>
          <Box className="rdp-custom">
            <DayPicker
              mode="single"
              selected={selectedDate}
              onSelect={handleSelect}
              disabled={disabled ? { before: new Date(0) } : undefined}
              required={required}
              components={{
                Chevron: ({ orientation }) =>
                  orientation === 'left' ?
                    <ChevronLeft size={16} /> :
                    <ChevronRight size={16} />
              }}
            />
          </Box>
      </Popover.Content>
    </Popover.Root>
  );
};

export default RadixDatePicker;
