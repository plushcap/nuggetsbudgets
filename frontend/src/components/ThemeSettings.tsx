import React, { useId } from 'react';
import { Card, Flex, Box, Heading, Text, Select, Button, Grid, SegmentedControl } from '@radix-ui/themes';
import {
  useTheme,
  type Appearance,
  type AccentColor,
  type GrayColor,
  type ThemeRadius,
  type PanelBackground,
  type Scaling,
} from '../contexts/ThemeContext';

const ACCENTS: AccentColor[] = [
  'tomato', 'red', 'ruby', 'crimson', 'pink', 'plum', 'purple', 'violet', 'iris',
  'indigo', 'blue', 'cyan', 'teal', 'jade', 'green', 'grass', 'orange', 'brown',
  'sky', 'mint', 'lime', 'yellow', 'amber', 'gold', 'bronze', 'gray',
];
const GRAYS: GrayColor[] = ['auto', 'gray', 'mauve', 'slate', 'sage', 'olive', 'sand'];
const RADII: ThemeRadius[] = ['none', 'small', 'medium', 'large', 'full'];
const PANELS: PanelBackground[] = ['solid', 'translucent'];
const SCALINGS: Scaling[] = ['90%', '95%', '100%', '105%', '110%'];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Swatch preview for an accent color (data-driven color, inline style is required). */
const Swatch: React.FC<{ color: string }> = ({ color }) => (
  <Box
    as="span"
    aria-hidden
    display="inline-block"
    width="12px"
    height="12px"
    flexShrink="0"
    className="rounded-full"
    style={{
      // lint:guard colour: a swatch of each accent the picker offers.
      backgroundColor: `var(--${color}-9)`,
    }}
  />
);

/**
 * Runtime theme picker. Drives the Radix <Theme> via ThemeContext — every change
 * applies live and persists. Mounted on the General settings page.
 */
const ThemeSettings: React.FC = () => {
  const fieldId = useId();
  const {
    prefs,
    setTheme,
    setAccentColor,
    setGrayColor,
    setRadius,
    setPanelBackground,
    setScaling,
    resetThemePrefs,
  } = useTheme();

  return (
    <Card>
      <Flex direction="column" gap="5">
        <Box>
          <Heading size="4">Appearance &amp; Theme</Heading>
          <Text as="p" size="2" color="gray">
            Personalize colours, contrast, and shape. Changes apply instantly and are saved to this device.
          </Text>
        </Box>

        {/* Appearance */}
        <Flex direction="column" gap="2">
          <Text as="div" id={`${fieldId}-appearance`} size="2" weight="medium">
            Appearance
          </Text>
          <SegmentedControl.Root
            aria-labelledby={`${fieldId}-appearance`}
            value={prefs.appearance}
            onValueChange={(v) => setTheme(v as Appearance)}
          >
            <SegmentedControl.Item value="light">Light</SegmentedControl.Item>
            <SegmentedControl.Item value="dark">Dark</SegmentedControl.Item>
          </SegmentedControl.Root>
        </Flex>

        <Grid columns={{ initial: '1', sm: '2' }} gap="4">
          {/* Accent colour */}
          <Flex direction="column" gap="2">
            <Text as="label" htmlFor={`${fieldId}-accent`} size="2" weight="medium">
              Accent colour
            </Text>
            <Select.Root value={prefs.accentColor} onValueChange={(v) => setAccentColor(v as AccentColor)}>
              <Select.Trigger id={`${fieldId}-accent`} />
              <Select.Content>
                {ACCENTS.map((c) => (
                  <Select.Item key={c} value={c}>
                    <Flex align="center" gap="2">
                      <Swatch color={c} />
                      {cap(c)}
                    </Flex>
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          {/* Gray tone */}
          <Flex direction="column" gap="2">
            <Text as="label" htmlFor={`${fieldId}-gray`} size="2" weight="medium">
              Gray tone
            </Text>
            <Select.Root value={prefs.grayColor} onValueChange={(v) => setGrayColor(v as GrayColor)}>
              <Select.Trigger id={`${fieldId}-gray`} />
              <Select.Content>
                {GRAYS.map((c) => (
                  <Select.Item key={c} value={c}>
                    {cap(c)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          {/* Radius */}
          <Flex direction="column" gap="2">
            <Text as="label" htmlFor={`${fieldId}-radius`} size="2" weight="medium">
              Corner radius
            </Text>
            <Select.Root value={prefs.radius} onValueChange={(v) => setRadius(v as ThemeRadius)}>
              <Select.Trigger id={`${fieldId}-radius`} />
              <Select.Content>
                {RADII.map((r) => (
                  <Select.Item key={r} value={r}>
                    {cap(r)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          {/* Panel background */}
          <Flex direction="column" gap="2">
            <Text as="label" htmlFor={`${fieldId}-panel`} size="2" weight="medium">
              Panel background
            </Text>
            <Select.Root
              value={prefs.panelBackground}
              onValueChange={(v) => setPanelBackground(v as PanelBackground)}
            >
              <Select.Trigger id={`${fieldId}-panel`} />
              <Select.Content>
                {PANELS.map((p) => (
                  <Select.Item key={p} value={p}>
                    {cap(p)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          {/* Scaling */}
          <Flex direction="column" gap="2">
            <Text as="label" htmlFor={`${fieldId}-scaling`} size="2" weight="medium">
              Scaling
            </Text>
            <Select.Root value={prefs.scaling} onValueChange={(v) => setScaling(v as Scaling)}>
              <Select.Trigger id={`${fieldId}-scaling`} />
              <Select.Content>
                {SCALINGS.map((s) => (
                  <Select.Item key={s} value={s}>
                    {s}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
        </Grid>

        <Flex justify="end">
          <Button variant="soft" color="gray" onClick={resetThemePrefs}>
            Reset to defaults
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
};

export default ThemeSettings;
