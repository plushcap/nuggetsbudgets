import { Moon, Sun } from 'lucide-react';
import { Button, IconButton, Switch } from '@radix-ui/themes';
import { useTheme } from '../contexts/ThemeContext';

interface ThemeToggleProps {
  variant?: 'icon' | 'button' | 'switch';
  className?: string;
}

export function ThemeToggle({ variant = 'icon', className = '' }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  if (variant === 'icon') {
    return (
      <IconButton
        onClick={toggleTheme}
        variant="ghost"
        color="gray"
        className={className}
        aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
        title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      >
        {isDark ? (
          <Sun size={20} className="text-[var(--amber-12)]" />
        ) : (
          <Moon size={20} className="text-[var(--gray-11)]" />
        )}
      </IconButton>
    );
  }

  if (variant === 'button') {
    return (
      <Button
        onClick={toggleTheme}
        variant="soft"
        color="gray"
        className={className}
        aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      >
        {isDark ? (
          <>
            <Sun size={20} className="text-[var(--amber-12)]" />
            <span>Light Mode</span>
          </>
        ) : (
          <>
            <Moon size={20} className="text-[var(--gray-11)]" />
            <span>Dark Mode</span>
          </>
        )}
      </Button>
    );
  }

  // Switch variant
  return (
    <Switch
      checked={isDark}
      onCheckedChange={toggleTheme}
      className={className}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    />
  );
}
