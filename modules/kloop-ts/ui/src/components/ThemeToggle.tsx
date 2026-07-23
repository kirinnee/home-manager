import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../hooks/useTheme';
import { Button } from './Primitives';

export function ThemeToggle() {
  const [theme, toggle] = useTheme();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </Button>
  );
}
