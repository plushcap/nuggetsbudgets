/**
 * Radix Themes' `highContrast` prop, typed as Radix means it: an optional boolean.
 *
 * Why: Radix Themes 3.3.0 declares the prop as `{ type: 'boolean', className, default: undefined }`
 * (`props/high-contrast.prop.d.ts`). Its prop types (`GetPropDefType`, `props/prop-def.d.ts`)
 * read a definition as a boolean only if it extends `{ default?: boolean }`, which a required
 * `default: undefined` doesn't under `exactOptionalPropertyTypes` (tsconfig.app.json). So
 * `highContrast` types as `never`, and every `<Text highContrast>` or
 * `{...textColorProps(color)}` (utils/textColor.ts) is refused. Radix's own props are types,
 * not interfaces, so a module augmentation can't reach them; this file declares the module
 * instead. A TypeScript-only file: it changes no code, and the build imports Radix itself.
 *
 * How: an ambient `declare module '@radix-ui/themes'` (this file has no top-level import or
 * export, so it declares the module rather than augmenting it), which TypeScript reads an
 * import of the module against before the package's own index.d.ts. It re-exports all of
 * Radix from `@radix-ui/themes/components/index`, the same declarations by another path,
 * and declares again, over that, each component whose props have `highContrast`, with the
 * prop as `?: boolean`. A name declared here shadows the re-exported one. The rest keeps
 * Radix's own types: a string `highContrast`, an unknown colour or an explicit `undefined` is
 * still refused.
 *
 * Covered: every top-level component with the prop, and Callout. The other namespaced parts
 * with it (Select.Trigger, DropdownMenu.Content, Tabs.List, …) are not: a namespace declared
 * here replaces Radix's whole namespace, so it lists every part, and none of them is passed
 * the prop yet. To cover one, declare its namespace like Callout's.
 *
 * Dropping it: once Radix declares the prop's default as optional (or `GetPropDefType` reads
 * `default: undefined` as a boolean), delete this file and run `npm run type-check`. To check
 * a new Radix release, delete it, run `npx tsc --noEmit -p tsconfig.app.json`, and look for
 * "Type 'true' is not assignable to type 'never'".
 */

declare module '@radix-ui/themes' {
  import type { ForwardRefExoticComponent } from 'react';
  import type * as Radix from '@radix-ui/themes/components/index';

  export * from '@radix-ui/themes/components/index';

  /** P with `highContrast` as an optional boolean, for each member of a union of props. */
  type HighContrastProps<P> = P extends unknown
    ? 'highContrast' extends keyof P
      ? Omit<P, 'highContrast'> & { highContrast?: boolean }
      : P
    : never;

  /** A Radix component whose props take `highContrast` as an optional boolean. */
  type WithHighContrast<C> = C extends ForwardRefExoticComponent<infer P> ? ForwardRefExoticComponent<HighContrastProps<P>> : C;

  export const Avatar: WithHighContrast<typeof Radix.Avatar>;
  export type AvatarProps = HighContrastProps<Radix.AvatarProps>;
  export const Badge: WithHighContrast<typeof Radix.Badge>;
  export type BadgeProps = HighContrastProps<Radix.BadgeProps>;
  export const Blockquote: WithHighContrast<typeof Radix.Blockquote>;
  export type BlockquoteProps = HighContrastProps<Radix.BlockquoteProps>;
  export const Button: WithHighContrast<typeof Radix.Button>;
  export type ButtonProps = HighContrastProps<Radix.ButtonProps>;
  export const Checkbox: WithHighContrast<typeof Radix.Checkbox>;
  export type CheckboxProps = HighContrastProps<Radix.CheckboxProps>;
  export const Code: WithHighContrast<typeof Radix.Code>;
  export type CodeProps = HighContrastProps<Radix.CodeProps>;
  export const Heading: WithHighContrast<typeof Radix.Heading>;
  export type HeadingProps = HighContrastProps<Radix.HeadingProps>;
  export const IconButton: WithHighContrast<typeof Radix.IconButton>;
  export type IconButtonProps = HighContrastProps<Radix.IconButtonProps>;
  export const Link: WithHighContrast<typeof Radix.Link>;
  export type LinkProps = HighContrastProps<Radix.LinkProps>;
  export const Progress: WithHighContrast<typeof Radix.Progress>;
  export type ProgressProps = HighContrastProps<Radix.ProgressProps>;
  export const Radio: WithHighContrast<typeof Radix.Radio>;
  export type RadioProps = HighContrastProps<Radix.RadioProps>;
  export const Slider: WithHighContrast<typeof Radix.Slider>;
  export type SliderProps = HighContrastProps<Radix.SliderProps>;
  export const Switch: WithHighContrast<typeof Radix.Switch>;
  export type SwitchProps = HighContrastProps<Radix.SwitchProps>;
  export const Text: WithHighContrast<typeof Radix.Text>;
  export type TextProps = HighContrastProps<Radix.TextProps>;

  export namespace Callout {
    export const Root: WithHighContrast<typeof Radix.Callout.Root>;
    export type RootProps = HighContrastProps<Radix.Callout.RootProps>;
    export const Icon: typeof Radix.Callout.Icon;
    export type IconProps = Radix.Callout.IconProps;
    export const Text: WithHighContrast<typeof Radix.Callout.Text>;
    export type TextProps = HighContrastProps<Radix.Callout.TextProps>;
  }
}
