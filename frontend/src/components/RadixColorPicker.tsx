import React, { useId, useState } from 'react';
import { Box, Flex, Grid, TextField, Button, Text, Popover } from '@radix-ui/themes';
import { Palette } from 'lucide-react';
import { colorPresets } from './colorPresets';

interface RadixColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean | undefined;
  label?: string;
  placeholder?: string;
  /** The id of a visible label elsewhere that names this field (instead of `label`). */
  'aria-labelledby'?: string | undefined;
  /** Ids of the field's hint and error messages (fieldErrorDescribedBy): read after its name. */
  'aria-describedby'?: string | undefined;
}

// Preset colors organized by category
export const RadixColorPicker: React.FC<RadixColorPickerProps> = ({
  value,
  onChange,
  disabled = false,
  label = 'Color',
  placeholder = '#3B82F6',
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}) => {
  const labelId = useId();
  const triggerId = useId();
  const hexId = useId();
  // Named by its label, then by the value it shows.
  const labelledBy = ariaLabelledBy ?? (label ? labelId : undefined);
  const [isOpen, setIsOpen] = useState(false);
  const [hexInput, setHexInput] = useState(value);

  const handleColorSelect = (color: string) => {
    onChange(color);
    setHexInput(color);
  };

  const handleHexInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setHexInput(newValue);
    
    // Validate hex color format
    if (/^#[0-9A-Fa-f]{6}$/.test(newValue)) {
      onChange(newValue);
    }
  };

  const handleHexInputBlur = () => {
    // Reset to current value if invalid
    if (!/^#[0-9A-Fa-f]{6}$/.test(hexInput)) {
      setHexInput(value);
    }
  };

  return (
    <Flex direction="column" gap="2">
      {label && !ariaLabelledBy && (
        <Text size="2" weight="medium" as="div" id={labelId}>
          {label}
        </Text>
      )}
      
      <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
        <Popover.Trigger>
          <Button
            type="button"
            variant="surface"
            color="gray"
            // An input's border (index.css): 3:1 against the dark page.
            className="field-border"
            disabled={disabled}
            id={triggerId}
            aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
            aria-describedby={ariaDescribedBy}
            style={{
              width: '100%',
              justifyContent: 'space-between',
              minHeight: '44px',
            }}
          >
            <Flex align="center" gap="3">
              <Box
                width="32px"
                height="32px"
                className="border-2 border-[var(--gray-6)] rounded-[var(--radius-4)]"
                style={{
                  // lint:guard colour: a swatch of the colour being picked.
                  backgroundColor: value || placeholder,
                }}
              />
              <Text>{value || placeholder}</Text>
            </Flex>
            <Palette size={16} />
          </Button>
        </Popover.Trigger>

        <Popover.Content
          // The theme's panel (it was a fixed dark slate, under light-mode text).
          width="320px"
          maxWidth="90vw"
          sideOffset={5}
        >
          <Flex direction="column" gap="3">
            {/* Hex Input */}
            <Flex direction="column" gap="2">
              <Text as="label" htmlFor={hexId} size="2" weight="medium">Hex Color</Text>
              <TextField.Root
                id={hexId}
                placeholder="#3B82F6"
                value={hexInput}
                onChange={handleHexInputChange}
                onBlur={handleHexInputBlur}
                pattern="^#[0-9A-Fa-f]{6}$"
                size="2"
              >
                <TextField.Slot>
                  <Box
                    width="20px"
                    height="20px"
                    className="border border-[var(--gray-6)] rounded-[var(--radius-2)]"
                    style={{
                      // lint:guard colour: a swatch of the colour typed.
                      backgroundColor: value,
                    }}
                  />
                </TextField.Slot>
              </TextField.Root>
            </Flex>

            {/* Color Grid */}
            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">Preset Colors</Text>
              <Grid columns="10" style={{ gap: '6px' }}>
                {colorPresets.map((color) => {
                  const isSelected = value === color;
                  
                  return (
                    <button
                      key={color}
                      type="button"
                      onClick={() => handleColorSelect(color)}
                      className={
                        // Selected: a ring of the panel's colour inside one of the accent's.
                        isSelected
                          ? 'border-[3px] border-[var(--color-panel-solid)] shadow-[0_0_0_2px_var(--accent-9)]'
                          : 'border border-[var(--gray-6)]'
                      }
                      style={{
                        width: '100%',
                        aspectRatio: '1',
                        // lint:guard colour: a swatch of the preset.
                        backgroundColor: color,
                        borderRadius: '6px',
                        cursor: 'pointer',
                        transition: 'transform 0.1s, border 0.1s',
                      }}
                      title={color}
                      aria-label={color}
                      aria-pressed={isSelected}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'scale(1.1)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                      }}
                    />
                  );
                })}
              </Grid>
            </Flex>

            {/* Footer */}
            <Flex justify="end" pt="2" className="border-t border-[var(--gray-6)]">
              <Button
                type="button"
                onClick={() => setIsOpen(false)}
                variant="soft"
                color="gray"
                size="1"
              >
                Close
              </Button>
            </Flex>
          </Flex>
        </Popover.Content>
      </Popover.Root>
    </Flex>
  );
};

export default RadixColorPicker;
