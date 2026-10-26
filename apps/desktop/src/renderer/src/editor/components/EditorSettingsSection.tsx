import type { EditorPreferences } from '@atlas/contracts';
import { useId } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEditorPreferences } from '../hooks/useEditorPreferences';

const THEMES: Record<EditorPreferences['theme'], string> = {
  dark: 'Dark',
  light: 'Light',
  'high-contrast': 'High contrast',
};
const AUTO_SAVE: Record<EditorPreferences['autoSave'], string> = {
  off: 'Off',
  'after-delay': 'After a delay',
  'on-focus-change': 'When the editor loses focus',
};
const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24];
const TAB_SIZES = [2, 4, 8];
const DELAYS = [500, 1000, 2000, 5000];

/** Code editor preferences (SDD-011 FR-1108). */
export function EditorSettingsSection() {
  const { preferences, loaded, error, update } = useEditorPreferences();
  const id = useId();

  const choice = <K extends keyof EditorPreferences>(
    key: K,
    label: string,
    options: [EditorPreferences[K], string][],
  ) => (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium" id={`${id}-${key}`}>
        {label}
      </span>
      <Select
        value={String(preferences[key])}
        onValueChange={(value) => {
          const option = options.find(([candidate]) => String(candidate) === value);
          if (option) void update({ [key]: option[0] });
        }}
      >
        <SelectTrigger className="w-full sm:w-56" aria-labelledby={`${id}-${key}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([value, text]) => (
            <SelectItem key={String(value)} value={String(value)}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const toggle = (key: keyof EditorPreferences, label: string, description?: string) => (
    <div className="flex items-start gap-2">
      <Checkbox
        id={`${id}-${key}`}
        checked={preferences[key] === true}
        onCheckedChange={(checked) => void update({ [key]: checked === true })}
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={`${id}-${key}`}>{label}</Label>
        {description && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
    </div>
  );

  return (
    <section
      className="bg-card flex flex-col gap-4 rounded-lg border p-4"
      aria-labelledby={`${id}-title`}
      data-testid="editor-settings"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="font-semibold">
          Editor
        </h2>
        <p className="text-muted-foreground text-xs">
          Used by the code editor. File contents are never stored by ATLAS; only which files were
          open.
        </p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!loaded ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {choice(
              'theme',
              'Theme',
              Object.entries(THEMES) as [EditorPreferences['theme'], string][],
            )}
            {choice(
              'fontSize',
              'Font size',
              FONT_SIZES.map((size) => [size, `${size} px`]),
            )}
            {choice(
              'tabSize',
              'Tab size',
              TAB_SIZES.map((size) => [size, String(size)]),
            )}
            {choice('insertSpaces', 'Indentation', [
              [true, 'Spaces'],
              [false, 'Tabs'],
            ])}
            {choice(
              'autoSave',
              'Auto save',
              Object.entries(AUTO_SAVE) as [EditorPreferences['autoSave'], string][],
            )}
            {preferences.autoSave === 'after-delay' &&
              choice(
                'autoSaveDelayMs',
                'Auto save delay',
                DELAYS.map((delay) => [delay, `${delay / 1000} s`]),
              )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {toggle('wordWrap', 'Wrap long lines')}
            {toggle('minimap', 'Show minimap')}
            {toggle(
              'autoReload',
              'Reload files changed on disk',
              'Only files without unsaved changes; edited files show a conflict instead.',
            )}
            {toggle('showHiddenFiles', 'Show hidden files', 'Names starting with a dot.')}
            {toggle(
              'showIgnoredFiles',
              'Show ignored files',
              'node_modules, build output and what the project ignores.',
            )}
          </div>
        </>
      )}
    </section>
  );
}
